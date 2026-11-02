/**
 * The Counterpart tool contract (counterpart/1): output schemas shared by the
 * tool list and the tests. mcp-3D-printer-server declares the same results.
 * Extra properties stay allowed so either server can add fields without
 * breaking clients that validate against an older schema.
 */
export declare const COUNTERPART_CONTRACT = "counterpart/1";
export declare const PRINTER_KINDS: readonly ["bambu", "octoprint", "klipper", "prusa", "duet", "repetier", "creality"];
export declare const PRINT_STATES: readonly ["idle", "preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"];
export declare const PROBLEM_SEVERITIES: readonly ["fatal", "error", "warning", "info"];
export type PrintState = typeof PRINT_STATES[number];
export type ProblemSeverity = typeof PROBLEM_SEVERITIES[number];
export type Problem = {
    code: string;
    severity: ProblemSeverity;
    message: string;
    url?: string;
};
export type Temperature = {
    actual: number;
    target: number;
};
export type PrintProgress = {
    contract: typeof COUNTERPART_CONTRACT;
    observedAt: string;
    state: PrintState;
    job?: {
        name: string;
        id?: string;
        progress?: number;
        elapsedSec?: number;
        remainingSec?: number;
        layer?: number;
        totalLayers?: number;
        stage?: string;
    };
    temps?: {
        nozzle?: Temperature;
        bed?: Temperature;
        chamber?: number;
    };
    activeFilament?: {
        slot?: string;
        material?: string;
        color?: string;
    };
    problems: Problem[];
};
export type PrinterInfo = {
    contract: typeof COUNTERPART_CONTRACT;
    server: {
        name: string;
        version: string;
    };
    printer: {
        kind: typeof PRINTER_KINDS[number];
        model?: string;
        serial?: string;
        host: string;
        name?: string;
    };
    capabilities: {
        progress: boolean;
        layers: boolean;
        camera: "bambu-tcp" | "rtsp" | "http-snapshot" | "none";
        filaments: "ams" | "single" | "none";
        pause: boolean;
        resume: boolean;
        cancel: boolean;
        print3mf: boolean;
        gcode: boolean;
    };
};
export declare const PRINTER_INFO_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        server: {
            type: string;
            properties: {
                name: {
                    type: string;
                };
                version: {
                    type: string;
                };
            };
            required: string[];
        };
        printer: {
            type: string;
            properties: {
                kind: {
                    type: string;
                    enum: ("bambu" | "octoprint" | "klipper" | "prusa" | "duet" | "repetier" | "creality")[];
                };
                model: {
                    type: string;
                };
                serial: {
                    type: string;
                };
                host: {
                    type: string;
                };
                name: {
                    type: string;
                };
            };
            required: string[];
        };
        capabilities: {
            type: string;
            properties: {
                progress: {
                    type: string;
                };
                layers: {
                    type: string;
                };
                camera: {
                    type: string;
                    enum: string[];
                };
                filaments: {
                    type: string;
                    enum: string[];
                };
                pause: {
                    type: string;
                };
                resume: {
                    type: string;
                };
                cancel: {
                    type: string;
                };
                print3mf: {
                    type: string;
                };
                gcode: {
                    type: string;
                };
            };
            required: string[];
        };
    };
    required: string[];
};
export declare const PRINT_PROGRESS_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        observedAt: {
            type: string;
            description: string;
        };
        state: {
            type: string;
            enum: ("failed" | "cancelled" | "idle" | "offline" | "preparing" | "printing" | "paused" | "finished" | "busy")[];
        };
        job: {
            type: string;
            properties: {
                name: {
                    type: string;
                };
                id: {
                    type: string;
                };
                progress: {
                    type: string;
                    minimum: number;
                    maximum: number;
                };
                elapsedSec: {
                    type: string;
                    minimum: number;
                };
                remainingSec: {
                    type: string;
                    minimum: number;
                };
                layer: {
                    type: string;
                    minimum: number;
                };
                totalLayers: {
                    type: string;
                    minimum: number;
                };
                stage: {
                    type: string;
                };
            };
            required: string[];
        };
        temps: {
            type: string;
            properties: {
                nozzle: {
                    type: string;
                    properties: {
                        actual: {
                            type: string;
                        };
                        target: {
                            type: string;
                        };
                    };
                    required: string[];
                };
                bed: {
                    type: string;
                    properties: {
                        actual: {
                            type: string;
                        };
                        target: {
                            type: string;
                        };
                    };
                    required: string[];
                };
                chamber: {
                    type: string;
                };
            };
        };
        activeFilament: {
            type: string;
            properties: {
                slot: {
                    type: string;
                };
                material: {
                    type: string;
                };
                color: {
                    type: string;
                    pattern: string;
                };
            };
        };
        problems: {
            type: string;
            items: {
                type: string;
                properties: {
                    code: {
                        type: string;
                    };
                    severity: {
                        type: string;
                        enum: ("error" | "info" | "fatal" | "warning")[];
                    };
                    message: {
                        type: string;
                    };
                    url: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
export declare const MAKE_3MF_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        path: {
            type: string;
            description: string;
        };
        objects: {
            type: string;
            minimum: number;
            description: string;
        };
        filaments: {
            type: string;
            minimum: number;
            description: string;
        };
        parts: {
            type: string;
            items: {
                type: string;
                properties: {
                    name: {
                        type: string;
                    };
                    stl_path: {
                        type: string;
                    };
                    filament: {
                        type: string;
                        minimum: number;
                    };
                    triangles: {
                        type: string;
                        minimum: number;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
