var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var _CameraStream_instances, _CameraStream_source, _CameraStream_timer, _CameraStream_generation, _CameraStream_processing, _CameraStream_lastAccepted, _CameraStream_latest, _CameraStream_references, _CameraStream_waiters, _CameraStream_stopped, _CameraStream_reconnected, _CameraStream_reason, _CameraStream_seq, _CameraStream_wake, _CameraStream_connect, _CameraStream_lost, _CameraStream_accept, _CameraStream_encoded, _CameraStream_result, _CameraStreams_streams, _CameraStreams_sequence;
/** One camera source per printer; bounded frames and native thumbnail processing. */
import sharp from "sharp";
sharp.cache({ memory: 8, files: 0, items: 32 });
export function thumbnailChange(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; i++)
        total += Math.abs(a[i] - b[i]);
    return total / (a.length * 255);
}
export class CameraStream {
    constructor(options, nextSeq, now = Date.now) {
        _CameraStream_instances.add(this);
        this.options = options;
        this.nextSeq = nextSeq;
        this.now = now;
        this.startedAt = new Date().toISOString();
        _CameraStream_source.set(this, void 0);
        _CameraStream_timer.set(this, void 0);
        _CameraStream_generation.set(this, 0);
        _CameraStream_processing.set(this, false);
        _CameraStream_lastAccepted.set(this, -Infinity);
        _CameraStream_latest.set(this, void 0);
        // Keep thumbnails of frames actually delivered, not every camera frame. A quiet view may keep
        // comparing with its first frame for hours; a rolling JPEG history would repeatedly resend it.
        _CameraStream_references.set(this, new Map());
        _CameraStream_waiters.set(this, new Set());
        _CameraStream_stopped.set(this, false);
        _CameraStream_reconnected.set(this, false);
        _CameraStream_reason.set(this, void 0);
        _CameraStream_seq.set(this, 0);
        this.transport = options.transport;
        this.fps = options.fps;
    }
    get stopped() { return __classPrivateFieldGet(this, _CameraStream_stopped, "f"); }
    start() { this.touch(); __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_connect).call(this); }
    touch(idleTimeoutMs) {
        if (__classPrivateFieldGet(this, _CameraStream_stopped, "f"))
            return;
        if (idleTimeoutMs !== undefined)
            this.options.idleTimeoutMs = idleTimeoutMs;
        clearTimeout(__classPrivateFieldGet(this, _CameraStream_timer, "f"));
        __classPrivateFieldSet(this, _CameraStream_timer, setTimeout(() => this.stop(), this.options.idleTimeoutMs), "f");
        __classPrivateFieldGet(this, _CameraStream_timer, "f").unref();
    }
    stop() {
        var _a;
        if (__classPrivateFieldGet(this, _CameraStream_stopped, "f"))
            return;
        __classPrivateFieldSet(this, _CameraStream_stopped, true, "f");
        __classPrivateFieldSet(this, _CameraStream_generation, (_a = __classPrivateFieldGet(this, _CameraStream_generation, "f"), _a++, _a), "f");
        clearTimeout(__classPrivateFieldGet(this, _CameraStream_timer, "f"));
        __classPrivateFieldGet(this, _CameraStream_source, "f")?.close();
        __classPrivateFieldSet(this, _CameraStream_source, undefined, "f");
        __classPrivateFieldSet(this, _CameraStream_latest, undefined, "f");
        __classPrivateFieldGet(this, _CameraStream_references, "f").clear();
        __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_wake).call(this);
    }
    async frame(options = {}) {
        const since = options.sinceSeq ?? 0, deadline = Date.now() + (options.waitMs ?? 0);
        this.touch();
        for (;;) {
            options.signal?.throwIfAborted();
            if (__classPrivateFieldGet(this, _CameraStream_reason, "f"))
                return { status: "unavailable", seq: __classPrivateFieldGet(this, _CameraStream_seq, "f"), reason: __classPrivateFieldGet(this, _CameraStream_reason, "f") };
            if (__classPrivateFieldGet(this, _CameraStream_stopped, "f"))
                return { status: "stopped", seq: __classPrivateFieldGet(this, _CameraStream_seq, "f") };
            const latest = __classPrivateFieldGet(this, _CameraStream_latest, "f");
            if (latest && latest.seq > since) {
                const reference = __classPrivateFieldGet(this, _CameraStream_references, "f").get(since);
                const change = reference ? thumbnailChange(latest.thumb, reference) : 1;
                if (options.changedOnly === false || change >= (options.minChange ?? 0.02))
                    return __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_result).call(this, latest, change, options.maxWidth, options.maxBytes);
            }
            const left = deadline - Date.now();
            if (left <= 0)
                return { status: "unchanged", seq: since, ...(latest ? { capturedAt: new Date(latest.at).toISOString() } : {}) };
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); __classPrivateFieldGet(this, _CameraStream_waiters, "f").delete(done); options.signal?.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, left);
                __classPrivateFieldGet(this, _CameraStream_waiters, "f").add(done);
                options.signal?.addEventListener("abort", done, { once: true });
            });
        }
    }
    async latest(waitMs) {
        const result = await this.frame({ waitMs, changedOnly: false });
        return result.status === "frame" ? Buffer.from(result.base64, "base64") : undefined;
    }
}
_CameraStream_source = new WeakMap(), _CameraStream_timer = new WeakMap(), _CameraStream_generation = new WeakMap(), _CameraStream_processing = new WeakMap(), _CameraStream_lastAccepted = new WeakMap(), _CameraStream_latest = new WeakMap(), _CameraStream_references = new WeakMap(), _CameraStream_waiters = new WeakMap(), _CameraStream_stopped = new WeakMap(), _CameraStream_reconnected = new WeakMap(), _CameraStream_reason = new WeakMap(), _CameraStream_seq = new WeakMap(), _CameraStream_instances = new WeakSet(), _CameraStream_wake = function _CameraStream_wake() { for (const wake of [...__classPrivateFieldGet(this, _CameraStream_waiters, "f")])
    wake(); }, _CameraStream_connect = function _CameraStream_connect() {
    var _a;
    const generation = __classPrivateFieldSet(this, _CameraStream_generation, (_a = __classPrivateFieldGet(this, _CameraStream_generation, "f"), ++_a), "f");
    let buffered, live = !this.options.skipFirstFrame;
    const current = () => !__classPrivateFieldGet(this, _CameraStream_stopped, "f") && generation === __classPrivateFieldGet(this, _CameraStream_generation, "f");
    try {
        const source = this.options.open({
            onFrame: bytes => {
                if (!current())
                    return;
                // P1/A1 replay their stale buffered frame, sometimes more than once.
                if (!live) {
                    if (!buffered) {
                        buffered = bytes;
                        return;
                    }
                    if (bytes.equals(buffered))
                        return;
                    buffered = undefined;
                    live = true;
                }
                if (__classPrivateFieldGet(this, _CameraStream_processing, "f") || this.now() - __classPrivateFieldGet(this, _CameraStream_lastAccepted, "f") < 1000 / this.fps)
                    return;
                __classPrivateFieldSet(this, _CameraStream_lastAccepted, this.now(), "f");
                __classPrivateFieldSet(this, _CameraStream_processing, true, "f");
                void __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_accept).call(this, bytes, generation).catch(() => { if (current())
                    __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_lost).call(this, "unreachable"); })
                    .finally(() => { __classPrivateFieldSet(this, _CameraStream_processing, false, "f"); });
            },
            onError: error => { if (current())
                __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_lost).call(this, /auth|payload size|401|403/i.test(error.message) ? "auth" : "unreachable"); },
            onEnd: () => { if (current())
                __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_lost).call(this, "unreachable"); },
        });
        // A transport may fail synchronously. Never keep its abandoned source after reconnect/stop.
        if (current())
            __classPrivateFieldSet(this, _CameraStream_source, source, "f");
        else
            source.close();
    }
    catch {
        if (current())
            __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_lost).call(this, "unreachable");
    }
}, _CameraStream_lost = function _CameraStream_lost(reason) {
    var _a;
    __classPrivateFieldSet(this, _CameraStream_generation, (_a = __classPrivateFieldGet(this, _CameraStream_generation, "f"), _a++, _a), "f");
    __classPrivateFieldGet(this, _CameraStream_source, "f")?.close();
    __classPrivateFieldSet(this, _CameraStream_source, undefined, "f");
    if (!__classPrivateFieldGet(this, _CameraStream_reconnected, "f") && reason !== "auth") {
        __classPrivateFieldSet(this, _CameraStream_reconnected, true, "f");
        __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_connect).call(this);
        return;
    }
    __classPrivateFieldSet(this, _CameraStream_reason, reason, "f");
    this.stop();
}, _CameraStream_accept = async function _CameraStream_accept(bytes, generation) {
    if (bytes.length > 5000000)
        throw Error("Camera JPEG too large");
    const decoder = sharp(bytes, { limitInputPixels: 8000000 });
    const metadata = await decoder.metadata();
    const thumb = await decoder.resize(32, 18, { fit: "fill" }).greyscale().raw().toBuffer();
    if (__classPrivateFieldGet(this, _CameraStream_stopped, "f") || generation !== __classPrivateFieldGet(this, _CameraStream_generation, "f"))
        return;
    __classPrivateFieldSet(this, _CameraStream_latest, { seq: __classPrivateFieldSet(this, _CameraStream_seq, this.nextSeq(), "f"), bytes, thumb, at: this.now(), width: metadata.width, height: metadata.height, scaled: new Map() }, "f");
    __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_wake).call(this);
}, _CameraStream_encoded = async function _CameraStream_encoded(frame, width, maxBytes) {
    // Start near the byte target instead of always encoding a full-size frame that will be
    // discarded. Source JPEG density is a cheap conservative estimate, not a size guarantee.
    if (maxBytes && frame.bytes.length > maxBytes)
        width = Math.min(width, Math.max(1, Math.floor(frame.width * Math.sqrt(maxBytes / frame.bytes.length) * 0.8)));
    // At most four native encodes. The final 1-pixel fallback guarantees a bounded result
    // even for pathological entropy; quality stays 70 and aspect ratio is preserved.
    for (let attempt = 0; attempt < 4; attempt++) {
        const encoded = await sharp(frame.bytes, { limitInputPixels: 8000000 }).resize({ width, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer({ resolveWithObject: true });
        if (!maxBytes || encoded.data.length <= maxBytes)
            return encoded;
        width = attempt === 2 ? 1 : Math.max(1, Math.floor(width * Math.min(0.8, Math.sqrt(maxBytes / encoded.data.length) * 0.9)));
    }
    throw new Error("Camera frame could not fit max_bytes");
}, _CameraStream_result = async function _CameraStream_result(frame, change, maxWidth, maxBytes) {
    let bytes = frame.bytes, width = frame.width, height = frame.height;
    if ((maxWidth && width > maxWidth) || (maxBytes && bytes.length > maxBytes)) {
        const key = `${maxWidth ?? width}:${maxBytes ?? 0}`;
        let scaled = frame.scaled.get(key);
        if (!scaled) {
            scaled = __classPrivateFieldGet(this, _CameraStream_instances, "m", _CameraStream_encoded).call(this, frame, Math.min(width, maxWidth ?? width), maxBytes);
            if (frame.scaled.size < 4)
                frame.scaled.set(key, scaled);
        }
        const resized = await scaled;
        bytes = resized.data;
        width = resized.info.width;
        height = resized.info.height;
    }
    if (__classPrivateFieldGet(this, _CameraStream_stopped, "f"))
        return __classPrivateFieldGet(this, _CameraStream_reason, "f") ? { status: "unavailable", seq: __classPrivateFieldGet(this, _CameraStream_seq, "f"), reason: __classPrivateFieldGet(this, _CameraStream_reason, "f") } : { status: "stopped", seq: __classPrivateFieldGet(this, _CameraStream_seq, "f") };
    __classPrivateFieldGet(this, _CameraStream_references, "f").set(frame.seq, frame.thumb);
    if (__classPrivateFieldGet(this, _CameraStream_references, "f").size > 256)
        __classPrivateFieldGet(this, _CameraStream_references, "f").delete(__classPrivateFieldGet(this, _CameraStream_references, "f").keys().next().value);
    return { status: "frame", seq: frame.seq, capturedAt: new Date(frame.at).toISOString(), width, height, format: "image/jpeg", base64: bytes.toString("base64"), change };
};
export class CameraStreams {
    constructor(now = Date.now) {
        this.now = now;
        _CameraStreams_streams.set(this, new Map());
        _CameraStreams_sequence.set(this, 0);
    }
    get(key) { return __classPrivateFieldGet(this, _CameraStreams_streams, "f").get(key); }
    start(key, options) {
        const existing = this.get(key);
        if (existing && !existing.stopped) {
            existing.touch(options.idleTimeoutMs);
            return { stream: existing, status: "running" };
        }
        const stream = new CameraStream(options, () => { var _a; return __classPrivateFieldSet(this, _CameraStreams_sequence, (_a = __classPrivateFieldGet(this, _CameraStreams_sequence, "f"), ++_a), "f"); }, this.now);
        __classPrivateFieldGet(this, _CameraStreams_streams, "f").set(key, stream);
        stream.start();
        return { stream, status: "started" };
    }
    stop(key) { this.get(key)?.stop(); }
    stopAll() { for (const stream of __classPrivateFieldGet(this, _CameraStreams_streams, "f").values())
        stream.stop(); __classPrivateFieldGet(this, _CameraStreams_streams, "f").clear(); }
}
_CameraStreams_streams = new WeakMap(), _CameraStreams_sequence = new WeakMap();
