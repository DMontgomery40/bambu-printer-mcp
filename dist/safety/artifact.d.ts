export declare function cancelPendingPrinterOperations(_host: string, serial: string): void;
export declare function withPrinterOperation<T>(_host: string, serial: string, operation: (assertActive: () => void) => Promise<T>): Promise<T>;
/**
 * Inspect and send a private copy, so changes to the user's source cannot change the job. `root` is where the copy
 * goes (the system temporary folder unless the bridge host needs it in a folder its container mounts).
 */
export declare function withPrintSnapshot<T>(source: string, operation: (snapshot: string, retainForDispatchedUpload: () => void) => Promise<T>, root?: string): Promise<T>;
export declare function uniquePrintName(filename: string): string;
export declare function normalizedRemotePath(filename: string): string;
