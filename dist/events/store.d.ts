export interface PrintEvent {
    eventId: string;
    name: "print.completed" | "print.problem";
    timestamp: string;
    data: {
        printer: "default";
        jobId: string;
        reason?: "print_error" | "hms" | "failed";
        codes?: string[];
    };
    cursor: string;
}
export interface ObservationState {
    fingerprint?: string;
    fingerprintSource?: "subtask_id" | "task_id" | "gcode_file";
    jobId?: string;
    active: boolean;
    cancelled: boolean;
    terminal: boolean;
    problems: string[];
}
export interface Subscription {
    id: string;
    owner: string;
    name: PrintEvent["name"];
    url: string;
    secret: string;
    previousSecret?: string;
    rotateUntil?: number;
    expires: number;
    position: number;
    verifiedAt?: number;
    attempts: number;
    retryAt: number;
    stopped?: boolean;
}
interface Data {
    version: 1;
    sequence: number;
    history: PrintEvent[];
    sourceCursor?: string;
    observation: ObservationState;
    subscriptions: Subscription[];
}
/** Private, bounded single-writer journal. Never place it inside a repository/package. */
export declare class EventStore {
    readonly filename: string;
    readonly limit: number;
    readonly data: Data;
    private readonly lock;
    private closed;
    constructor(filename: string, limit?: number);
    save(): void;
    append(event: Omit<PrintEvent, "cursor">): PrintEvent;
    close(): void;
}
export {};
