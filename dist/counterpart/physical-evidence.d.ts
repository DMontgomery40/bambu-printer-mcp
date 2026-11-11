/** Pure assessment of explicit client measurements, not an embedded vision model or success gate. */
export interface EvidenceFrame {
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
export interface HeightMeasurement {
    frameId: string;
    visible: boolean;
    observedHeightMm: number;
    uncertaintyMm: number;
    method: string;
}
export interface PhysicalEvidence {
    status: "unknown" | "consistent" | "suspect_no_growth";
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
