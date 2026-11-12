/** Pure assessment of explicit client measurements, not an embedded vision model or success gate. */
export interface EvidenceFrame {
    role?: "baseline" | "first_layer" | "periodic" | "height";
    stage?: string;
    imageContentIndex?: number;
    id: string;
    capturedAt: string;
    reportAt: string;
    layer: number;
    expectedHeightMm: number;
    checkpoint: number;
    status: "captured" | "unavailable";
    reason?: string;
    sha256?: string;
    base64?: string;
}
export declare function frameMatchesReport(frame: EvidenceFrame): boolean;
export interface HeightMeasurement {
    frameId: string;
    visible: boolean;
    observedHeightMm: number;
    uncertaintyMm: number;
    method: string;
}
export interface PhysicalEvidence {
    observedLayer?: number;
    assessment?: {
        required: boolean;
        frameId: string;
        referenceFrameIds: string[];
        layer: number;
        expectedHeightMm: number;
        expectedFootprintMm: [number, number, number, number];
        instruction: string;
    };
    status: "unknown" | "consistent" | "suspect_no_growth" | "suspect_no_extrusion";
    evidence: string[];
    limitations: string[];
}
export declare function assessPhysical(frames: EvidenceFrame[], measurements?: HeightMeasurement[]): PhysicalEvidence;
export declare const PHYSICAL_EVIDENCE_SCHEMA: {
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
