/** Reuse a stream, but never relabel a known pre-boundary cached image as a later layer. */
interface StreamFrame {
    status: string;
    seq: number;
    capturedAt?: string;
    base64?: string;
}
interface FrameSource {
    frame(options: {
        sinceSeq?: number;
        waitMs?: number;
        changedOnly?: boolean;
    }): Promise<StreamFrame>;
}
export declare function snapshotFrame(source: FrameSource, timeoutMs: number, capturedAfter?: string): Promise<StreamFrame>;
export {};
