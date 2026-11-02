/**
 * Split the A1/P1 camera stream on port 6000 into JPEG frames. Each frame is
 * a 16-byte header (payload size LE, itrack, flags, reserved) and the JPEG.
 */
export function cameraFrameParser(onFrame: (jpeg: Buffer) => void, onError: (error: Error) => void): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);
  let failed = false;
  return chunk => {
    if (failed) return;
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 16) {
      const payloadSize = buffered.readUInt32LE(0);
      if (payloadSize <= 0 || payloadSize > 5_000_000) {
        failed = true;
        onError(new Error(`camera_snapshot: unreasonable payload size ${payloadSize} from header; auth likely failed.`));
        return;
      }
      if (buffered.length < 16 + payloadSize) return;
      const jpeg = buffered.subarray(16, 16 + payloadSize);
      buffered = buffered.subarray(16 + payloadSize);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        failed = true;
        onError(new Error(`camera_snapshot: payload does not start with JPEG SOI (FF D8); got ${jpeg[0].toString(16)} ${jpeg[1].toString(16)}.`));
        return;
      }
      onFrame(Buffer.from(jpeg));
    }
  };
}


/** The existing Bambu camera authentication packet, shared by snapshots and streams. */
export function cameraAuth(token: string): Buffer {
  const auth = Buffer.alloc(80, 0);
  auth.writeUInt32LE(0x40, 0); auth.writeUInt32LE(0x3000, 4);
  auth.write("bblp", 16, 4, "ascii");
  auth.write(token, 48, Math.min(32, Buffer.byteLength(token, "ascii")), "ascii");
  return auth;
}
