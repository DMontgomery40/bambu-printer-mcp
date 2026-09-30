/** Parses newly received P1/A1 camera bytes. The first frame can be firmware cached. */
export class CameraFrameReader {
  private pending = Buffer.alloc(0);
  private first?: Buffer;
  framesObserved = 0;
  constructor(private readonly requireFresh = true) {}
  push(data: Buffer): Buffer | undefined {
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length >= 16) {
      const size = this.pending.readUInt32LE(0);
      if (size < 4 || size > 5_000_000) throw new Error("camera_snapshot: unreasonable payload size; auth likely failed");
      if (this.pending.length < 16 + size) return;
      const jpeg = Buffer.from(this.pending.subarray(16, 16 + size));
      this.pending = this.pending.subarray(16 + size);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[size - 2] !== 0xff || jpeg[size - 1] !== 0xd9) {
        throw new Error("camera_snapshot: invalid JPEG frame");
      }
      this.framesObserved++;
      if (!this.requireFresh) return jpeg;
      if (!this.first) this.first = jpeg;
      else if (!jpeg.equals(this.first)) return jpeg;
    }
    return;
  }
}

import type { TLSSocket } from "node:tls";
/** New socket only. No file/cache input; no frame is returned if acquisition times out. */
export function readLiveCameraFrame(socket: Pick<TLSSocket, "on" | "once" | "off" | "write" | "destroy">,
  auth: Buffer, timeoutMs: number, requireFresh = true): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const reader = new CameraFrameReader(requireFresh);
    let settled = false;
    const finish = (error?: Error, frame?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.off("data", onData); socket.off("error", onError); socket.off("end", onEnd);
      socket.destroy();
      if (error) reject(error); else resolve(frame!);
    };
    const onData = (data: Buffer) => { try { const jpeg = reader.push(data); if (jpeg) finish(undefined, jpeg); } catch(error) { finish(error as Error); } };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("camera_snapshot: connection ended before a fresh JPEG frame arrived; refusing cached fallback"));
    const timer = setTimeout(() => finish(new Error(`camera_snapshot: ${requireFresh ? "fresh capture unavailable (no changed live frame); refusing cached fallback" : "timed out"} after ${timeoutMs}ms`)), timeoutMs);
    socket.once("secureConnect", () => { if (!settled) socket.write(auth); });
    socket.on("data", onData); socket.on("error", onError); socket.on("end", onEnd);
  });
}
