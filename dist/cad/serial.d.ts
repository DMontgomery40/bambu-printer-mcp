/** One dispatched operation per environment; runs and fit checks queue across processes and never replay. */
export declare function withCadLock<T>(data: string, options: {
    operation: "setup" | "run" | "fit";
    deadline?: number;
    signal?: AbortSignal;
}, work: (waitedMs: number) => Promise<T>): Promise<T>;
