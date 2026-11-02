/**
 * One camera connection per printer, held only while someone is watching (docs/CAMERA-STREAM.md).
 *
 * A stream keeps the newest JPEG in memory with an increasing `seq`. Callers long-poll
 * `frame()` for a newer frame, optionally only one that visibly changed, optionally downscaled.
 * The connection closes by itself `idleTimeoutMs` after the last call that touched it.
 */
import jpeg from "jpeg-js";

export type CameraTransport = "tcp-6000" | "rtsps-322";

/** Opens the printer's camera and reports each JPEG frame until `close()` is called. */
export interface CameraSource {
  close(): void;
}
export type OpenCameraSource = (handlers: {
  onFrame: (jpeg: Buffer) => void;
  onError: (error: Error) => void;
  onEnd: () => void;
}) => CameraSource;

export interface StreamFrameResult {
  status: "frame" | "unchanged" | "stopped" | "unavailable";
  seq: number;
  capturedAt?: string;
  width?: number;
  height?: number;
  format?: "image/jpeg";
  base64?: string;
  change?: number;
  reason?: "no-camera" | "auth" | "unreachable";
}

interface Frame { seq: number; jpeg: Buffer; capturedAtMs: number }

const THUMB_W = 32, THUMB_H = 18;
const HISTORY = 16;

/** Mean absolute difference of two 32×18 grayscale thumbnails, 0–1. */
export function thumbnailChange(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

/** A 32×18 grayscale thumbnail of a JPEG (box-averaged). */
export function thumbnail(jpegBytes: Buffer): Uint8Array {
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let ty = 0; ty < THUMB_H; ty++) {
    const y0 = Math.floor(ty * img.height / THUMB_H), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * img.height / THUMB_H));
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor(tx * img.width / THUMB_W), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * img.width / THUMB_W));
      let sum = 0, n = 0;
      // Sample every other pixel: plenty for a change signal, half the work.
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * img.width + x) * 4;
        sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; n++;
      }
      out[ty * THUMB_W + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

/** Downscale a JPEG to at most `maxWidth` wide (box filter), re-encoded at quality 70. */
export function downscale(jpegBytes: Buffer, maxWidth: number): { jpeg: Buffer; width: number; height: number } {
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  if (img.width <= maxWidth) return { jpeg: jpegBytes, width: img.width, height: img.height };
  const w = Math.max(1, Math.round(maxWidth)), h = Math.max(1, Math.round(img.height * w / img.width));
  const data = Buffer.alloc(w * h * 4);
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor(oy * img.height / h), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * img.height / h));
    for (let ox = 0; ox < w; ox++) {
      const x0 = Math.floor(ox * img.width / w), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * img.width / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (oy * w + ox) * 4;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
    }
  }
  return { jpeg: Buffer.from(jpeg.encode({ data, width: w, height: h }, 70).data), width: w, height: h };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  // Walk the markers to the first SOFn segment.
  let i = 2;
  while (i + 9 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1], len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return undefined;
}

export class CameraStream {
  readonly transport: CameraTransport;
  readonly fps: number;
  readonly startedAt = new Date().toISOString();
  #idleTimeoutMs: number;
  #open: OpenCameraSource;
  #source?: CameraSource;
  #latest?: Frame;
  #history = new Map<number, Frame>();
  #thumbs = new Map<number, Uint8Array>();
  #scaled = new Map<string, { jpeg: Buffer; width: number; height: number }>();
  #waiters = new Set<() => void>();
  #idleTimer?: ReturnType<typeof setTimeout>;
  #seq = 0;
  #skipFirst: boolean;
  #reconnected = false;
  #stopped = false;
  #unavailable?: StreamFrameResult["reason"];
  #onStopped: () => void;

  constructor(options: { transport: CameraTransport; fps: number; idleTimeoutMs: number; open: OpenCameraSource; skipFirstFrame: boolean; onStopped: () => void }) {
    this.transport = options.transport;
    this.fps = options.fps;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#open = options.open;
    this.#skipFirst = options.skipFirstFrame;
    this.#onStopped = options.onStopped;
    this.#connect();
    this.touch();
  }

  get stopped(): boolean { return this.#stopped; }

  /** Renews the idle timer; the stream closes this long after the last call that touched it. */
  touch(idleTimeoutMs?: number): void {
    if (idleTimeoutMs !== undefined) this.#idleTimeoutMs = idleTimeoutMs;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.stop(), this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#source?.close();
    this.#source = undefined;
    this.#wake();
    this.#onStopped();
  }

  #connect(): void {
    // The A1/P1 socket first replays the frame it buffered, which can be long out of date.
    let first = this.#skipFirst;
    this.#source = this.#open({
      onFrame: bytes => {
        if (first) { first = false; return; }
        const frame = { seq: ++this.#seq, jpeg: bytes, capturedAtMs: Date.now() };
        this.#latest = frame;
        this.#history.set(frame.seq, frame);
        if (this.#history.size > HISTORY) {
          const oldest = this.#history.keys().next().value as number;
          this.#history.delete(oldest); this.#thumbs.delete(oldest);
          for (const key of this.#scaled.keys()) if (key.startsWith(`${oldest}:`)) this.#scaled.delete(key);
        }
        this.#wake();
      },
      onError: error => this.#lost(/auth|payload size/i.test(error.message) ? "auth" : "unreachable"),
      onEnd: () => this.#lost("unreachable"),
    });
  }

  #lost(reason: NonNullable<StreamFrameResult["reason"]>): void {
    if (this.#stopped) return;
    this.#source?.close();
    this.#source = undefined;
    if (!this.#reconnected && reason !== "auth") { this.#reconnected = true; this.#connect(); return; }
    this.#unavailable = reason;
    this.#wake();
    this.stop();
  }

  #wake(): void { for (const wake of [...this.#waiters]) wake(); }

  #thumb(frame: Frame): Uint8Array {
    let t = this.#thumbs.get(frame.seq);
    if (!t) { t = thumbnail(frame.jpeg); this.#thumbs.set(frame.seq, t); }
    return t;
  }

  #changeSince(frame: Frame, sinceSeq: number): number {
    const reference = this.#history.get(sinceSeq);
    if (!reference) return 1; // nothing to compare with: treat as changed
    return thumbnailChange(this.#thumb(frame), this.#thumb(reference));
  }

  async frame(options: { sinceSeq?: number; waitMs?: number; maxWidth?: number; changedOnly?: boolean; minChange?: number } = {}): Promise<StreamFrameResult> {
    const sinceSeq = options.sinceSeq ?? 0, changedOnly = options.changedOnly ?? true, minChange = options.minChange ?? 0.02;
    const deadline = Date.now() + Math.min(Math.max(options.waitMs ?? 0, 0), 10_000);
    this.touch();
    for (;;) {
      if (this.#unavailable) return { status: "unavailable", seq: this.#seq, reason: this.#unavailable };
      if (this.#stopped) return { status: "stopped", seq: this.#seq };
      const latest = this.#latest;
      if (latest && latest.seq > sinceSeq) {
        const change = sinceSeq > 0 ? this.#changeSince(latest, sinceSeq) : 1;
        if (!changedOnly || change >= minChange) return this.#result(latest, change, options.maxWidth);
      }
      const left = deadline - Date.now();
      if (left <= 0) return { status: "unchanged", seq: this.#seq, ...(latest ? { capturedAt: new Date(latest.capturedAtMs).toISOString() } : {}) };
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, left);
        function done() { clearTimeout(timer); waiters.delete(done); resolve(); }
        const waiters = this.#waiters; waiters.add(done);
      });
    }
  }

  /** The newest frame as is (for camera_snapshot), waiting briefly for the first one. */
  async latest(waitMs: number): Promise<Buffer | undefined> {
    const result = await this.frame({ sinceSeq: 0, waitMs, changedOnly: false });
    return result.status === "frame" && result.base64 ? Buffer.from(result.base64, "base64") : undefined;
  }

  #result(frame: Frame, change: number, maxWidth?: number): StreamFrameResult {
    let bytes = frame.jpeg, size = jpegSize(frame.jpeg);
    if (maxWidth && maxWidth > 0 && (!size || size.width > maxWidth)) {
      const key = `${frame.seq}:${Math.round(maxWidth)}`;
      let scaled = this.#scaled.get(key);
      if (!scaled) { scaled = downscale(frame.jpeg, maxWidth); this.#scaled.set(key, scaled); }
      bytes = scaled.jpeg; size = { width: scaled.width, height: scaled.height };
    }
    return {
      status: "frame", seq: frame.seq, capturedAt: new Date(frame.capturedAtMs).toISOString(),
      ...(size ? { width: size.width, height: size.height } : {}),
      format: "image/jpeg", base64: bytes.toString("base64"), change: Math.round(change * 1000) / 1000,
    };
  }
}

/** Streams keyed per printer (serial, else host), so one process never mixes printers up. */
export class CameraStreams {
  readonly #streams = new Map<string, CameraStream>();

  get(key: string): CameraStream | undefined {
    const stream = this.#streams.get(key);
    return stream && !stream.stopped ? stream : undefined;
  }

  start(key: string, options: { transport: CameraTransport; fps: number; idleTimeoutMs: number; open: OpenCameraSource; skipFirstFrame: boolean }): { stream: CameraStream; status: "started" | "running" } {
    const running = this.get(key);
    if (running) { running.touch(options.idleTimeoutMs); return { stream: running, status: "running" }; }
    const stream = new CameraStream({ ...options, onStopped: () => { if (this.#streams.get(key) === stream) this.#streams.delete(key); } });
    this.#streams.set(key, stream);
    return { stream, status: "started" };
  }

  stop(key: string): void { this.#streams.get(key)?.stop(); }

  stopAll(): void { for (const stream of [...this.#streams.values()]) stream.stop(); }
}
