export declare const CAMERA_STREAM_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            bambu_model: {
                type: string;
                description: string;
            };
            fps: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            idle_timeout_ms: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            host: {
                type: string;
                description: string;
            };
            bambu_serial: {
                type: string;
                description: string;
            };
            bambu_token: {
                type: string;
                description: string;
            };
        };
        additionalProperties: boolean;
    };
    outputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                enum: string[];
                const?: undefined;
            };
            transport: {
                type: string;
                enum: string[];
            };
            fps: {
                type: string;
            };
            startedAt: {
                type: string;
            };
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            since_seq: {
                type: string;
                minimum: number;
                default: number;
                description: string;
            };
            wait_ms: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            max_width: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            max_bytes: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            changed_only: {
                type: string;
                default: boolean;
                description: string;
            };
            min_change: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            host: {
                type: string;
                description: string;
            };
            bambu_serial: {
                type: string;
                description: string;
            };
            bambu_token: {
                type: string;
                description: string;
            };
        };
        additionalProperties: boolean;
    };
    outputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                enum: string[];
            };
            seq: {
                type: string;
                minimum: number;
            };
            capturedAt: {
                type: string;
            };
            width: {
                type: string;
            };
            height: {
                type: string;
            };
            format: {
                type: string;
                const: string;
            };
            base64: {
                type: string;
            };
            change: {
                type: string;
            };
            reason: {
                type: string;
                enum: string[];
            };
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            host: {
                type: string;
                description: string;
            };
            bambu_serial: {
                type: string;
                description: string;
            };
            bambu_token: {
                type: string;
                description: string;
            };
        };
        additionalProperties: boolean;
    };
    outputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                const: string;
                enum?: undefined;
            };
            transport?: undefined;
            fps?: undefined;
            startedAt?: undefined;
        };
        required: string[];
    };
})[];
export declare function cameraNumber(value: unknown, fallback: number, min: number, max: number, name: string, integer?: boolean): number;
