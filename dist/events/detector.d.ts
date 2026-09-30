import { EventStore } from "./store.js";
/** Consumes only actual push_status reports; no progress-based completion inference. */
export declare class PrintEventDetector {
    readonly store: EventStore;
    private report;
    private connectedEpoch;
    constructor(store: EventStore);
    disconnected(): void;
    cancel(persist?: boolean): void;
    observe(update: Record<string, unknown>): void;
}
