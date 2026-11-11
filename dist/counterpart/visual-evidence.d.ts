import type { EvidenceFrame, PhysicalEvidence } from "./physical-evidence.js";
import type { PrintGeometry } from "./print-geometry.js";
export declare const VISIBILITIES: readonly ["clear", "dark", "occluded", "out_of_view", "unknown"];
export type Visibility = (typeof VISIBILITIES)[number];
export interface VisualSubmission {
    jobId: string;
    artifactSha256: string;
    frameId: string;
    imageSha256: string;
    visibility: Visibility;
    footprintVisible: boolean;
    deposition: "absent" | "present" | "unknown";
    attempted: boolean;
    referenceFrameId?: string;
    referenceVisibility?: Visibility;
    referenceEmpty?: boolean;
}
export interface VisualObservation extends VisualSubmission {
    at: string;
    source: "client-vision";
}
export declare function validateVisualSubmission(v: VisualSubmission): VisualSubmission;
export declare function assessVisual(frames: EvidenceFrame[], observations: VisualObservation[], expected?: PrintGeometry): PhysicalEvidence | undefined;
export declare function assessmentRequest(frames: EvidenceFrame[], observations: VisualObservation[], expected?: PrintGeometry): {
    required: boolean;
    frameId: string;
    referenceFrameIds: string[];
    layer: number;
    expectedHeightMm: number;
    expectedFootprintMm: [number, number, number, number];
    instruction: string;
} | undefined;
export declare function physicalProblems(physical: PhysicalEvidence): {
    code: string;
    severity: "error";
    message: string;
}[];
