import type { PrintGeometry } from "./print-geometry.js";
import { type EvidenceFrame, type HeightMeasurement } from "./physical-evidence.js";
export type { PrintGeometry, HeightMeasurement };
export declare const flightKey: (host: string, serial: string) => string;
/** An allowlist, not a recursive dump/redactor. Unknown fields and arbitrary strings never reach disk. */
export declare function flightSnapshot(raw: Record<string, any>): Record<string, unknown>;
export interface FlightDispatch {
    sha256: string;
    jobName: string;
    mapping?: number[];
    materials?: string[];
    plate?: {
        index: number;
        sha256: string;
    };
    expected?: PrintGeometry;
}
interface StoredDispatch extends Omit<FlightDispatch, "jobName" | "expected"> {
    jobHash: string;
}
export interface FlightRecord {
    version: 1;
    id: string;
    printerKey: string;
    dispatchedAt: string;
    dispatch: StoredDispatch;
    expected?: PrintGeometry;
    reports: Array<{
        seq: number;
        at: string;
        changes: Record<string, unknown>;
    }>;
    latest: Record<string, unknown>;
    droppedReports: number;
    nextSeq: number;
    frames: EvidenceFrame[];
    skippedCheckpoints: number[];
    storage: "durable" | "volatile";
}
export interface ReadRecordOptions {
    jobId?: string;
    includeFrames?: boolean;
    measurements?: HeightMeasurement[];
}
export declare class FlightRecords {
    private readonly dir;
    private readonly now;
    private readonly maxEvents;
    private readonly maxJobs;
    private readonly maxBytes;
    private readonly maxCaptureMs;
    private readonly cache;
    private readonly pending;
    private warned;
    constructor(options?: {
        dir?: string;
        now?: () => number;
        maxEvents?: number;
        maxJobs?: number;
        maxBytes?: number;
        maxCaptureMs?: number;
    });
    begin(key: string, input: FlightDispatch): string;
    observe(key: string, raw: Record<string, any>, at?: number): void;
    read(key: string, options?: ReadRecordOptions): {
        contract: "counterpart/1";
        status: "unavailable";
        physical: import("./physical-evidence.js").PhysicalEvidence;
        record?: undefined;
    } | {
        contract: "counterpart/1";
        status: "recorded";
        record: FlightRecord;
        physical: import("./physical-evidence.js").PhysicalEvidence;
    };
    /** Called only after existing reports/reads, never on a timer; a sample cannot block the print. */
    sample(key: string, capture: () => Promise<{
        base64?: string;
        capturedAt?: string;
    }>): Promise<void>;
    private file;
    private frameFile;
    private files;
    private get;
    private save;
    private prune;
}
