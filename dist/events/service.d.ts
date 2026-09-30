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
export type Authorize = (context: AuthContext, printer: "default") => boolean | Promise<boolean>;
export declare const EVENT_DEFINITIONS: {
    name: "print.completed" | "print.problem";
    delivery: string[];
    description: string;
    inputSchema: {
        type: string;
        properties: {
            printer: {
                type: string;
                enum: string[];
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
                enum: string[];
            };
            jobId: {
                type: string;
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
    private queue;
    constructor(store: EventStore, authorize: Authorize, sender?: CallbackSender, now?: () => number);
    private serialized;
    handle(method: string, params: any, context: AuthContext): Promise<unknown>;
    private access;
    private truncated;
    private post;
    /** Host runs this periodically; no listener, timer, subscription, or outbound work starts on import. */
    deliverPending(): Promise<void>;
    private retry;
}
/** Read-only legacy surface; these are stored observations, not ChatGPT subscriptions. */
export declare function listPrintEvents(store: EventStore, cursor?: unknown, limit?: unknown): {
    events: PrintEvent[];
    cursor: string;
    truncated: boolean;
};
