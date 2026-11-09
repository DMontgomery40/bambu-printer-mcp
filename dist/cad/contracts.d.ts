/** cad/1 is an optional engine owned by the printer MCP. Readiness comes from cad_status, not the capability. */
export declare function cadEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare const CAD_CAPABILITY: {
    readonly contract: "cad/1";
    readonly status: "cad_status";
    readonly setup: "cad_setup";
    readonly run: "cad_run";
    readonly checkFit: "cad_check_fit";
    readonly prompt: "cad_design";
};
export declare const CAD_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            install?: undefined;
            inputs?: undefined;
            mode?: undefined;
            script?: undefined;
            script_path?: undefined;
            parameters?: undefined;
            output_dir?: undefined;
            name?: undefined;
            timeout_ms?: undefined;
            model?: undefined;
            reference?: undefined;
            transform?: undefined;
            clearance_mm?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    outputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            install: {
                type: string;
                default: boolean;
                description: string;
            };
            inputs?: undefined;
            mode?: undefined;
            script?: undefined;
            script_path?: undefined;
            parameters?: undefined;
            output_dir?: undefined;
            name?: undefined;
            timeout_ms?: undefined;
            model?: undefined;
            reference?: undefined;
            transform?: undefined;
            clearance_mm?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    outputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            inputs: {
                type: string;
                maxItems: number;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                        };
                        path: {
                            type: string;
                        };
                    };
                    required: string[];
                    additionalProperties: boolean;
                };
                description: string;
            };
            mode: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            script: {
                type: string;
                maxLength: number;
                description: string;
            };
            script_path: {
                type: string;
                description: string;
            };
            parameters: {
                type: string;
                additionalProperties: boolean;
                description: string;
            };
            output_dir: {
                type: string;
                description: string;
            };
            name: {
                type: string;
                maxLength: number;
                description: string;
            };
            timeout_ms: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            install?: undefined;
            model?: undefined;
            reference?: undefined;
            transform?: undefined;
            clearance_mm?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    outputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            model: {
                type: string;
                description: string;
            };
            reference: {
                type: string;
                description: string;
            };
            transform: {
                type: string;
                description: string;
                properties: {
                    translation_mm: {
                        type: string;
                        items: {
                            type: string;
                        };
                        minItems: number;
                        maxItems: number;
                    };
                    rotation_deg: {
                        type: string;
                        items: {
                            type: string;
                        };
                        minItems: number;
                        maxItems: number;
                    };
                };
                additionalProperties: boolean;
            };
            clearance_mm: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            timeout_ms: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            install?: undefined;
            inputs?: undefined;
            mode?: undefined;
            script?: undefined;
            script_path?: undefined;
            parameters?: undefined;
            output_dir?: undefined;
            name?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    outputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
})[];
export declare const CAD_DESIGN_PROMPT: {
    name: string;
    title: string;
    description: string;
    text: string;
};
