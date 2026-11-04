import type { OpenCameraSource } from "./camera-stream.js";
type Handlers = Parameters<OpenCameraSource>[0];
/** Reuses the snapshot protocol/parser; the socket lives until its stream closes it. */
export declare function openTcpCameraSource(host: string, token: string, handlers: Handlers, port?: number): ReturnType<OpenCameraSource>;
/** ffmpeg's MJPEG output has no per-frame process or temporary file. */
export declare function mjpegParser(onFrame: (bytes: Buffer) => void, onError: (error: Error) => void): (chunk: Buffer) => void;
export declare function openRtspCameraSource(host: string, token: string, fps: number, handlers: Handlers, ffmpegPath?: string): ReturnType<OpenCameraSource>;
export {};
