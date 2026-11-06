import type { Client as FTPClient } from "basic-ftp";
/** Bytes per write on the FTPS data socket; matches fs.createReadStream's default. */
export declare const FTP_UPLOAD_CHUNK_BYTES: number;
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
export declare function uploadBytes(client: FTPClient, bytes: Buffer, remotePath: string, chunkBytes?: number): Promise<void>;
