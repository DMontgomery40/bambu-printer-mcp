import { EventStore } from "./store.js";
import { PrintEventDetector } from "./detector.js";
export type ObservePrinter = (printer: any, host: string, serial: string) => void;
export declare const PRINT_EVENTS_TOOL: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            cursor: {
                type: string;
                description: string;
            };
            limit: {
                description: string;
                type: string;
                minimum: number;
                maximum: number;
                default: number;
            };
        };
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        openWorldHint: boolean;
    };
};
/** Opt-in passive capture from existing connections only. Never creates a printer connection. */
export declare class PrintEventRuntime {
    readonly store: EventStore;
    private readonly host;
    private readonly serial;
    readonly printer: string;
    readonly detector: PrintEventDetector;
    private failed;
    constructor(store: EventStore, host: string, serial: string, printer?: string);
    private safely;
    readonly attach: ObservePrinter;
    cancel(host: string, serial: string, persist?: boolean): void;
    persist(): void;
    list(args: any): {
        journalId: string | undefined;
        events: import("./store.js").PrintEvent[];
        cursor: string;
        truncated: boolean;
    };
    close(): void;
}
export declare function createPrintEventRuntime(host: string, serial: string): PrintEventRuntime | undefined;
