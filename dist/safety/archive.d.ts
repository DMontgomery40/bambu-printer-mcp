import JSZip from 'jszip';
export declare const MAX_PRINT_FILE_BYTES: number;
/** Read no more than the fixed print-artifact limit, even if the file grows. */
export declare function readBoundedPrintFile(filePath: string): Promise<Buffer>;
/** Bounded native inflation prevents false size fields from making JSZip allocate
 * unbounded output. Populate JSZip only with the verified, uniquely named bytes. */
export declare function loadSafe3mfArchive(bytes: Buffer): Promise<JSZip>;
export declare function readSafe3mfArchive(filePath: string): Promise<{
    bytes: Buffer;
    zip: JSZip;
}>;
