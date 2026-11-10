/** Stable CAD refusals use the same structuredContent shape as printer refusals. */
export declare const CAD_REFUSAL_CODES: readonly ["cad-uv-missing", "cad-data-volume-refused", "cad-setup-busy", "cad-operation-busy", "cad-queue-timeout", "cad-not-ready", "cad-confinement-unavailable", "cad-disabled", "cad-failed"];
export type CadRefusalCode = (typeof CAD_REFUSAL_CODES)[number];
export declare class CadRefusal extends Error {
    readonly code: CadRefusalCode;
    constructor(code: CadRefusalCode, message: string);
}
export declare function cadFailure(error: unknown, tool: string): {
    status: "error";
    code: "cad-uv-missing" | "cad-data-volume-refused" | "cad-setup-busy" | "cad-operation-busy" | "cad-queue-timeout" | "cad-not-ready" | "cad-confinement-unavailable" | "cad-disabled" | "cad-failed";
    message: string;
    tool: string;
    retryable: boolean;
    suggestion: string;
};
