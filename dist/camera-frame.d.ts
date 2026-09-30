/** Parses newly received P1/A1 camera bytes. The first frame can be firmware cached. */
export declare class CameraFrameReader {
    private readonly requireFresh;
    private pending;
    private first?;
    framesObserved: number;
    constructor(requireFresh?: boolean);
    push(data: Buffer): Buffer | undefined;
}
import type { TLSSocket } from "node:tls";
/** New socket only. No file/cache input; no frame is returned if acquisition times out. */
export declare function readLiveCameraFrame(socket: Pick<TLSSocket, "on" | "once" | "off" | "write" | "destroy">, auth: Buffer, timeoutMs: number, requireFresh?: boolean): Promise<Buffer>;
