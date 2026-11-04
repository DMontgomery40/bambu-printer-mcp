import tls from "node:tls";
import { spawn } from "node:child_process";
import { cameraAuth, cameraFrameParser } from "./camera-wire.js";
/** Reuses the snapshot protocol/parser; the socket lives until its stream closes it. */
export function openTcpCameraSource(host, token, handlers, port = 6000) {
    let closed = false;
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => socket.write(cameraAuth(token)));
    const fail = (error) => { if (!closed)
        handlers.onError(error); };
    socket.setTimeout(15000, () => fail(new Error("Camera stream timed out")));
    socket.on("data", cameraFrameParser(bytes => { if (!closed)
        handlers.onFrame(bytes); }, fail));
    socket.on("error", fail);
    socket.on("close", () => { if (!closed)
        handlers.onEnd(); });
    return { close() { closed = true; socket.destroy(); } };
}
/** ffmpeg's MJPEG output has no per-frame process or temporary file. */
export function mjpegParser(onFrame, onError) {
    let buffer = Buffer.alloc(0), failed = false;
    return chunk => {
        if (failed)
            return;
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
            if (start < 0) {
                buffer = buffer.subarray(Math.max(0, buffer.length - 1));
                return;
            }
            if (start)
                buffer = buffer.subarray(start);
            const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
            if (end >= 0) {
                onFrame(Buffer.from(buffer.subarray(0, end + 2)));
                buffer = buffer.subarray(end + 2);
                continue;
            }
            if (buffer.length > 5000000) {
                failed = true;
                onError(new Error("Camera JPEG too large"));
            }
            return;
        }
    };
}
export function openRtspCameraSource(host, token, fps, handlers, ffmpegPath = "ffmpeg") {
    const url = `rtsps://bblp:${encodeURIComponent(token)}@${host}:322/streaming/live/1`;
    const child = spawn(ffmpegPath, ["-tls_verify", "0", "-rtsp_transport", "tcp", "-i", url,
        "-an", "-vf", `fps=${fps}`, "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "-loglevel", "error", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let closed = false, denied = false;
    let timer;
    const fail = (error) => { if (!closed)
        handlers.onError(error); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error("RTSP camera stream timed out")), 15000); timer.unref(); };
    arm();
    child.stdout.on("data", mjpegParser(bytes => { arm(); if (!closed)
        handlers.onFrame(bytes); }, fail));
    // Drain stderr but never expose the credential-bearing URL in ffmpeg diagnostics.
    child.stderr.on("data", bytes => { if (/401|403|Unauthorized|Forbidden/i.test(String(bytes)))
        denied = true; });
    child.once("error", () => fail(new Error("RTSP camera process could not start")));
    child.once("exit", () => { clearTimeout(timer); if (!closed)
        denied ? fail(new Error("RTSP camera authentication failed")) : handlers.onEnd(); });
    return { close() { closed = true; clearTimeout(timer); child.kill("SIGKILL"); } };
}
