/**
 * The Counterpart tool contract (counterpart/1): output schemas shared by the
 * tool list and the tests. mcp-3D-printer-server declares the same results.
 * Extra properties stay allowed so either server can add fields without
 * breaking clients that validate against an older schema.
 */
export const COUNTERPART_CONTRACT = "counterpart/1";
export const PRINTER_KINDS = ["bambu", "octoprint", "klipper", "prusa", "duet", "repetier", "creality"];
export const PRINT_STATES = ["idle", "preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"];
export const PROBLEM_SEVERITIES = ["fatal", "error", "warning", "info"];
const temperature = {
    type: "object",
    properties: { actual: { type: "number" }, target: { type: "number" } },
    required: ["actual", "target"],
};
export const PRINTER_INFO_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        contract: { type: "string", const: COUNTERPART_CONTRACT },
        server: {
            type: "object",
            properties: { name: { type: "string" }, version: { type: "string" } },
            required: ["name", "version"],
        },
        printer: {
            type: "object",
            properties: {
                kind: { type: "string", enum: [...PRINTER_KINDS] },
                model: { type: "string" },
                serial: { type: "string" },
                host: { type: "string" },
                name: { type: "string" },
            },
            required: ["kind", "host"],
        },
        capabilities: {
            type: "object",
            properties: {
                cad: { type: "object", properties: { contract: { type: "string", const: "cad/1" }, status: { type: "string" }, setup: { type: "string" }, run: { type: "string" }, checkFit: { type: "string" }, prompt: { type: "string" } }, required: ["contract", "status", "setup", "run", "checkFit", "prompt"] },
                progress: { type: "boolean" },
                layers: { type: "boolean" },
                camera: { type: "string", enum: ["bambu-tcp", "rtsp", "http-snapshot", "none"] },
                cameraStream: { type: "boolean" },
                filaments: { type: "string", enum: ["ams", "single", "none"] },
                pause: { type: "boolean" },
                resume: { type: "boolean" },
                cancel: { type: "boolean" },
                print3mf: { type: "boolean" },
                gcode: { type: "boolean" },
                slicing: {
                    type: "object",
                    required: ["supports", "copies", "orient"],
                    properties: { supports: { type: "boolean" }, copies: { type: "boolean" }, orient: { type: "boolean" } },
                },
            },
            required: ["progress", "layers", "camera", "filaments", "pause", "resume", "cancel", "print3mf", "gcode"],
        },
    },
    required: ["contract", "server", "printer", "capabilities"],
};
export const PRINT_PROGRESS_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        contract: { type: "string", const: COUNTERPART_CONTRACT },
        observedAt: { type: "string", description: "When the printer reported this (MQTT report time), ISO 8601." },
        state: { type: "string", enum: [...PRINT_STATES] },
        job: {
            type: "object",
            properties: {
                name: { type: "string" },
                id: { type: "string" },
                progress: { type: "number", minimum: 0, maximum: 100 },
                elapsedSec: { type: "number", minimum: 0 },
                remainingSec: { type: "number", minimum: 0 },
                layer: { type: "integer", minimum: 0 },
                totalLayers: { type: "integer", minimum: 0 },
                stage: { type: "string" },
            },
            required: ["name"],
        },
        temps: {
            type: "object",
            properties: { nozzle: temperature, bed: temperature, chamber: { type: "number" } },
        },
        activeFilament: {
            type: "object",
            properties: {
                slot: { type: "string" },
                material: { type: "string" },
                color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
            },
        },
        problems: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    code: { type: "string" },
                    severity: { type: "string", enum: [...PROBLEM_SEVERITIES] },
                    message: { type: "string" },
                    url: { type: "string" },
                },
                required: ["code", "severity", "message"],
            },
        },
    },
    required: ["contract", "observedAt", "state", "problems"],
};
export const MAKE_3MF_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        contract: { type: "string", const: COUNTERPART_CONTRACT },
        path: { type: "string", description: "Absolute path of the written 3MF." },
        objects: { type: "integer", minimum: 1, description: "Objects in the 3MF: one assembly." },
        filaments: { type: "integer", minimum: 1, description: "Highest filament number any part uses; pass that many load_filaments to slice_stl." },
        parts: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    stl_path: { type: "string" },
                    filament: { type: "integer", minimum: 1 },
                    triangles: { type: "integer", minimum: 1 },
                },
                required: ["name", "stl_path", "filament", "triangles"],
            },
        },
    },
    required: ["contract", "path", "objects", "filaments", "parts"],
};
