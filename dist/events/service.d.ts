import { EventStore, type PrintEvent } from "./store.js";
import { type CallbackSender } from "./webhook.js";
export declare class EventProtocolError extends Error {
    readonly code: number;
    readonly data?: Record<string, string> | undefined;
    constructor(code: number, message: string, data?: Record<string, string> | undefined);
}
export interface AuthContext {
    principal: string;
}
export type Authorize = (context: AuthContext, printer: string) => boolean | Promise<boolean>;
export declare const EVENT_DEFINITIONS: {
    name: "print.completed" | "print.problem";
    delivery: string[];
    description: string;
    inputSchema: {
        type: string;
        properties: {
            printer: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
    payloadSchema: {
        type: string;
        properties: {
            printer: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            jobId: {
                type: string;
            };
            test: {
                type: string;
                description: string;
            };
            reason: {
                type: string;
                enum: string[];
            };
            codes: {
                type: string;
                items: {
                    type: string;
                };
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
}[];
/** Embedding seam only: host MUST provide real MCP2 transport + authenticated owner.
 * Never register these methods or advertise MCP2 through the legacy SDK 1.x server.
 */
export declare class PrintEventService {
    readonly store: EventStore;
    private readonly authorize;
    private readonly sender;
    private readonly now;
    readonly printers: readonly string[];
    private readonly namesForPrinter;
    private deliveryWork?;
    private batchOffset;
    constructor(store: EventStore, authorize: Authorize, sender?: CallbackSender, now?: () => number, printers?: readonly string[], namesForPrinter?: (printer: string) => readonly string[]);
    handle(method: string, params: any, context: AuthContext): Promise<unknown>;
    private access;
    private truncated;
    private post;
    /** Host runs this periodically; no listener, timer, subscription, or outbound work starts on import. */
    deliverPending(): Promise<void>;
    private deliverBatch;
    private deliverOne;
    private retry;
}
/** Read-only legacy surface; these are stored observations, not ChatGPT subscriptions. */
export declare function listPrintEvents(store: EventStore, cursor?: unknown, limit?: unknown, printer?: string): {
    journalId: string | undefined;
    events: PrintEvent[];
    cursor: string;
    truncated: boolean;
};
/** Remote history never reveals another printer's sequence or retention activity. */
export declare function listPrinterEvents(store: EventStore, printer: string, cursor?: unknown, limit?: unknown): {
    events: {
        eventId: string;
        name: "print.completed" | "print.problem";
        timestamp: string;
        data: {
            printer: string;
            jobId: string;
            test?: boolean;
            reason?: "print_error" | "hms" | "failed";
            codes?: string[];
        };
        cursor: string | undefined;
    }[];
    cursor: string;
    truncated: boolean;
};
