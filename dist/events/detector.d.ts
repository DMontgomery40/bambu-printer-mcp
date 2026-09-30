import { EventStore } from "./store.js";
/** Consumes internal normalized lifecycle reports; each source verifies its native signal. Never infers completion from progress. */
export declare class PrintEventDetector {
    readonly store: EventStore;
    readonly printer: string;
    private report;
    private connectedEpoch;
    constructor(store: EventStore, printer?: string);
    disconnected(): void;
    cancel(persist?: boolean): void;
    observe(update: Record<string, unknown>): void;
}
