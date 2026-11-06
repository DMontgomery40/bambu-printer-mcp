import { Readable } from "node:stream";
import type { Client as FTPClient } from "basic-ftp";

/** Bytes per write on the FTPS data socket; matches fs.createReadStream's default. */
export const FTP_UPLOAD_CHUNK_BYTES = 64 * 1024;

function* chunks(bytes: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

/**
 * Store bytes on the printer in small writes.
 *
 * basic-ftp's TransferWatchdog reports a stall ("Timeout (data socket)") when
 * the data socket's bytesWritten stops changing while data is still queued.
 * Readable.from(buffer) hands the whole file over as one write, which counts in
 * bytesWritten at once; while the printer drains it at SD-card speed (a few
 * hundred KB/s on a P1S) the count never moves, so a multi-megabyte job is
 * declared stalled after the timeout although its bytes are still flowing.
 * Small writes move the count as each one completes, so the watchdog only fires
 * when the printer stops taking data. The bytes are the ones already read and
 * inspected; nothing is re-read from disk.
 */
export async function uploadBytes(client: FTPClient, bytes: Buffer, remotePath: string, chunkBytes = FTP_UPLOAD_CHUNK_BYTES): Promise<void> {
  await client.uploadFrom(Readable.from(chunks(bytes, chunkBytes)), remotePath);
}
