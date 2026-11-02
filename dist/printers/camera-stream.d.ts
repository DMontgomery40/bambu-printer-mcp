export type CameraTransport = "tcp-6000" | "rtsps-322";
export type CameraSource = {
    close(): void;
};
export type OpenCameraSource = (handlers: {
    onFrame(bytes: Buffer): void;
    onError(error: Error): void;
    onEnd(): void;
}) => CameraSource;
export type FrameOptions = {
    sinceSeq?: number;
    waitMs?: number;
    maxWidth?: number;
    maxBytes?: number;
    changedOnly?: boolean;
    minChange?: number;
    signal?: AbortSignal;
};
export type StreamFrameResult = {
    status: "frame" | "unchanged" | "stopped" | "unavailable";
    seq: number;
    capturedAt?: string;
    width?: number;
    height?: number;
    format?: "image/jpeg";
    base64?: string;
    change?: number;
    reason?: "auth" | "unreachable" | "no-camera";
};
export type StreamOptions = {
    transport: CameraTransport;
    fps: number;
    idleTimeoutMs: number;
    open: OpenCameraSource;
    skipFirstFrame: boolean;
};
export declare function thumbnailChange(a: Uint8Array, b: Uint8Array): number;
export declare class CameraStream {
    #private;
    private options;
    private nextSeq;
    private now;
    readonly startedAt: string;
    readonly transport: CameraTransport;
    readonly fps: number;
    constructor(options: StreamOptions, nextSeq: () => number, now?: () => number);
    get stopped(): boolean;
    start(): void;
    touch(idleTimeoutMs?: number): void;
    stop(): void;
    frame(options?: FrameOptions): Promise<StreamFrameResult>;
    latest(waitMs: number): Promise<Buffer | undefined>;
}
export declare class CameraStreams {
    #private;
    private now;
    constructor(now?: () => number);
    get(key: string): CameraStream | undefined;
    start(key: string, options: StreamOptions): {
        stream: CameraStream;
        status: "started" | "running";
    };
    stop(key: string): void;
    stopAll(): void;
}
