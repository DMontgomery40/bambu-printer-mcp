import type { ReadRecordOptions } from "./flight-record.js";
export declare const FLIGHT_RECORD_PROPERTIES: {
    readonly job_id: {
        readonly type: "string";
        readonly description: "Saved record UUID; omit for the latest dispatched job on this printer.";
    };
    readonly include_frames: {
        readonly type: "boolean";
        readonly description: "Include up to four saved JPEGs (512 KiB each). Reads disk only.";
    };
    readonly measurements: {
        readonly type: "array";
        readonly maxItems: 4;
        readonly description: "Optional calibrated client height measurements for saved frames; no image interpretation or printer control is performed.";
        readonly items: {
            readonly type: "object";
            readonly properties: {
                readonly frameId: {
                    readonly type: "string";
                    readonly description: "The saved frame UUID returned in this job record.";
                };
                readonly visible: {
                    readonly type: "boolean";
                    readonly description: "The expected printed region and its maximum height are visible, unoccluded and in view.";
                };
                readonly observedHeightMm: {
                    readonly type: "number";
                    readonly minimum: 0;
                    readonly description: "Client-calibrated maximum deposited Z height of this plate in the visible expected object region; use the same region across frames.";
                };
                readonly uncertaintyMm: {
                    readonly type: "number";
                    readonly minimum: 0;
                    readonly description: "Estimated plus/minus error of the calibrated physical height measurement, in millimetres.";
                };
                readonly method: {
                    readonly type: "string";
                    readonly enum: readonly ["calibrated-height"];
                    readonly description: "An explicit calibrated height measurement from the client, never a pixel-change guess.";
                };
            };
            readonly required: readonly ["frameId", "visible", "observedHeightMm", "uncertaintyMm", "method"];
            readonly additionalProperties: false;
        };
    };
};
export declare const FLIGHT_RECORD_DESCRIPTION = "Counterpart contract (counterpart/1): read a bounded persistent per-job flight record from disk, including dispatched SHA-256, selected mapping, timestamped allowlisted printer-report changes, expected selected-plate layer geometry and sampled camera evidence. Survives restart. No printer connection, polling or controls. Firmware FINISH is separate from physical unknown/consistent/suspect_no_growth. Without usable calibrated client measurements physical stays unknown. Missing history is unavailable, never fetched from the printer.";
export declare const FLIGHT_RECORD_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        status: {
            type: string;
            enum: string[];
        };
        record: {
            type: string;
            additionalProperties: boolean;
        };
        physical: {
            type: string;
            properties: {
                status: {
                    type: string;
                    enum: string[];
                };
                evidence: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
                limitations: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
            };
            required: string[];
        };
    };
    required: string[];
};
export declare function flightReadOptions(args?: Record<string, unknown>): ReadRecordOptions;
