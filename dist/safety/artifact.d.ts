export declare function cancelPendingPrinterOperations(_host: string, serial: string): void;
export declare function withPrinterOperation<T>(_host: string, serial: string, operation: (assertActive: () => void) => Promise<T>): Promise<T>;
/** Inspect and send a private copy, so changes to the user's source cannot change the job. */
export declare function withPrintSnapshot<T>(source: string, operation: (snapshot: string) => Promise<T>, retainUntilExit?: boolean): Promise<T>;
export declare function uniquePrintName(filename: string): string;
export declare function normalizedRemotePath(filename: string): string;
