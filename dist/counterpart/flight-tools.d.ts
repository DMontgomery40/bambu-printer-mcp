import type { ReadRecordOptions } from "./flight-record.js";
export declare const FLIGHT_RECORD_PROPERTIES: {
    readonly view: {
        readonly type: "string";
        readonly enum: readonly ["record", "evidence"];
        readonly description: "Full journal (default), or compact vision evidence with omission counts. Image format defaults to evidence view to avoid sending a large journal to the worker.";
    };
    readonly frame_format: {
        readonly type: "string";
        readonly enum: readonly ["base64", "images"];
        readonly description: "Return requested JPEGs once as structured base64 (default) or normal MCP image content for a vision worker.";
    };
    readonly frame_ids: {
        readonly type: "array";
        readonly maxItems: 4;
        readonly items: {
            readonly type: "string";
        };
        readonly description: "At most four saved frame IDs to retrieve; defaults to the pending assessment and baseline candidates, or recent evidence.";
    };
    readonly list_jobs: {
        readonly type: "boolean";
        readonly description: "Include the retained job IDs, dispatch times, artifact hashes and outcomes for this printer, so an older job can be selected.";
    };
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
export declare const FLIGHT_RECORD_DESCRIPTION = "Counterpart contract (counterpart/1): read a bounded persistent per-job flight record from disk, including dispatched SHA-256, selected mapping, timestamped allowlisted printer-report changes, expected sliced layer geometry and sampled camera evidence. Survives restart. No printer connection, polling or controls. Firmware FINISH is separate from physical unknown/consistent/suspect_no_growth/suspect_no_extrusion. Inspect pending visual assessment requests with the client worker; clear empty-footprint observations can flag no extrusion without an empty-bed reference. Missing history is unavailable, never fetched from the printer.";
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
        jobs: {
            type: string;
            maxItems: number;
            items: {
                type: string;
                properties: {
                    id: {
                        type: string;
                    };
                    dispatchedAt: {
                        type: string;
                    };
                    sha256: {
                        type: string;
                    };
                    outcome: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        physical: {
            type: string;
            properties: {
                status: {
                    type: string;
                    enum: string[];
                };
                observedLayer: {
                    type: string;
                    minimum: number;
                };
                assessment: {
                    type: string;
                    additionalProperties: boolean;
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
/** Image bytes appear once: normal MCP images for vision, or structuredContent base64. */
export declare function flightRecordResult<T extends {
    contract: string;
    record?: {
        frames: Array<{
            base64?: string;
            imageContentIndex?: number;
        }>;
    };
}>(view: T, asImages?: boolean): {
    content: ({
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    })[];
    structuredContent: T;
};
export declare const PRINT_EVIDENCE_GUIDANCE = " When monitoring a print, firmware layer counters do not verify deposition. Follow physical.assessment requests at the first layer and later checkpoints: fetch counterpart_print_record with frame_format images, inspect the expected footprint with the client vision worker, then submit counterpart_print_assess. A clear empty footprint after attempted printing is suspect_no_extrusion; no baseline is required for that direct observation. Dark/occluded/unlocatable views are unknown. Never announce a first layer is down from counters alone. Do not stop or pause automatically.";
export declare const FLIGHT_ASSESS_DESCRIPTION = "Counterpart contract (counterpart/1): save a client vision worker observation against an exact saved job/artifact/frame hash. Local evidence only; no camera request, model call or printer controls. Clear visible empty expected footprint after attempted deposition reports suspect_no_extrusion, even without a usable baseline. Dark/occluded/unknown stays unknown; visible material does not verify success. Persists across restart; repeat observations are idempotent.";
export declare const FLIGHT_ASSESS_PROPERTIES: {
    job_id: {
        type: string;
        description: string;
    };
    artifact_sha256: {
        type: string;
        description: string;
    };
    frame_id: {
        type: string;
        description: string;
    };
    image_sha256: {
        type: string;
        description: string;
    };
    visibility: {
        type: string;
        enum: ("dark" | "clear" | "unknown" | "occluded" | "out_of_view")[];
        description: string;
    };
    footprint_visible: {
        type: string;
        description: string;
    };
    deposition: {
        type: string;
        enum: string[];
        description: string;
    };
    attempted: {
        type: string;
        description: string;
    };
    reference_frame_id: {
        type: string;
        description: string;
    };
    reference_visibility: {
        type: string;
        enum: ("dark" | "clear" | "unknown" | "occluded" | "out_of_view")[];
        description: string;
    };
    reference_empty: {
        type: string;
        description: string;
    };
};
export declare const FLIGHT_ASSESS_REQUIRED: string[];
export declare function visualSubmission(args?: Record<string, unknown>): import("./visual-evidence.js").VisualSubmission;
