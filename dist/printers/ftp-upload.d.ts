import type { Client as FTPClient } from "basic-ftp";
/** Bytes per write on the FTPS data socket; matches fs.createReadStream's default. */
export declare const FTP_UPLOAD_CHUNK_BYTES: number;
/**
 * How long a print upload may wait for the printer to take more data before it is
 * reported as stalled. A P1S writing a large file to its SD card pauses mid-file
 * for longer than the 15 s used for FTP commands: an 18.4 MB plate stopped at
 * 13.3 MB for over 15 s (2026-11-06), while 4.6 and 11.5 MB files went through
 * at 130-160 KiB/s. A printer that has really stopped is still reported, after this.
 */
export declare const FTP_UPLOAD_STALL_MS = 120000;
/**
 * Store bytes on the printer in small writes, allowing the printer's SD card to pause.
 *
 * basic-ftp's TransferWatchdog reports a stall ("Timeout (data socket)") when
 * the data socket's bytesWritten stops changing while data is still queued.
 * Readable.from(buffer) hands the whole file over as one write, which counts in
 * bytesWritten at once, so small writes are used: the count moves as each one
 * completes. The watchdog's limit is the client's timeout, read when the transfer
 * starts; it is raised to stallMs for this transfer (and the wait for the
 * printer's 226 after it) and restored afterwards, so other commands keep theirs.
 * The bytes are the ones already read and inspected; nothing is re-read from disk.
 */
export declare function uploadBytes(client: FTPClient, bytes: Buffer, remotePath: string, { chunkBytes, stallMs, onProgress }?: {
    chunkBytes?: number;
    stallMs?: number;
    onProgress?: (sent: number, total: number) => void;
}): Promise<void>;
