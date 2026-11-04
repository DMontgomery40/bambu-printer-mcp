/**
 * Split the A1/P1 camera stream on port 6000 into JPEG frames. Each frame is
 * a 16-byte header (payload size LE, itrack, flags, reserved) and the JPEG.
 */
export declare function cameraFrameParser(onFrame: (jpeg: Buffer) => void, onError: (error: Error) => void): (chunk: Buffer) => void;
/** The existing Bambu camera authentication packet, shared by snapshots and streams. */
export declare function cameraAuth(token: string): Buffer;
