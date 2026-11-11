import { type VisualSubmission, type VisualObservation } from "./visual-evidence.js";
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
    outcome: "unconfirmed" | "accepted" | "observed-active";
    acceptedAt?: string;
}
export interface FlightRecord {
    version: 1;
    seenActive: boolean;
    owner?: {
        pid: number;
        token: string;
    };
    endedAt?: string;
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
    droppedFrames: number;
    sampledCheckpoints?: number[];
    visualObservations?: VisualObservation[];
    omittedReports?: number;
    omittedGeometryLayers?: number;
    storage: "durable" | "volatile";
}
export interface ReadRecordOptions {
    evidenceOnly?: boolean;
    frameIds?: string[];
    listJobs?: boolean;
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
    private readonly recentReports;
    private warned;
    private readonly ownerToken;
    constructor(options?: {
        dir?: string;
        now?: () => number;
        maxEvents?: number;
        maxJobs?: number;
        maxBytes?: number;
        maxCaptureMs?: number;
    });
    begin(key: string, input: FlightDispatch): string;
    accept(key: string, jobName: string): boolean;
    observe(key: string, raw: Record<string, any>, at?: number): void;
    /** Progress may expose saved evidence only for the job in this returned report. */
    physicalForReport(key: string, raw: Record<string, any> | null | undefined): import("./physical-evidence.js").PhysicalEvidence;
    read(key: string, options?: ReadRecordOptions): {
        physical: import("./physical-evidence.js").PhysicalEvidence;
        jobs?: {
            id: string;
            dispatchedAt: string;
            sha256: string;
            outcome: "accepted" | "unconfirmed" | "observed-active";
        }[] | undefined;
        contract: "counterpart/1";
        status: "unavailable";
    } | {
        record: FlightRecord;
        physical: import("./physical-evidence.js").PhysicalEvidence;
        jobs?: {
            id: string;
            dispatchedAt: string;
            sha256: string;
            outcome: "accepted" | "unconfirmed" | "observed-active";
        }[] | undefined;
        contract: "counterpart/1";
        status: "recorded";
    };
    /** Persist only the client's frame-bound visual observation, without printer I/O or journal ownership changes. */
    submitVisual(key: string, input: VisualSubmission): {
        physical: import("./physical-evidence.js").PhysicalEvidence;
        jobs?: {
            id: string;
            dispatchedAt: string;
            sha256: string;
            outcome: "accepted" | "unconfirmed" | "observed-active";
        }[] | undefined;
        contract: "counterpart/1";
        status: "unavailable";
    } | {
        record: FlightRecord;
        physical: import("./physical-evidence.js").PhysicalEvidence;
        jobs?: {
            id: string;
            dispatchedAt: string;
            sha256: string;
            outcome: "accepted" | "unconfirmed" | "observed-active";
        }[] | undefined;
        contract: "counterpart/1";
        status: "recorded";
    };
    private visualFile;
    private visuals;
    private trimFrames;
    /** Called only after existing reports/reads, never on a timer; a sample cannot block the print. */
    sample(key: string, capture: (capturedAfter: string) => Promise<{
        base64?: string;
        capturedAt?: string;
    }>): Promise<void>;
    /** One process writes a dispatched job; fresh observations can take over after its process exits. */
    private canWrite;
    private jobSummaries;
    private file;
    private frameFile;
    private files;
    private get;
    private save;
    private prune;
}
