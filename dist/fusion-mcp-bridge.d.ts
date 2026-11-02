import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/** The faust-machines commit the setup installs; move it only after the PRD §8.9 acceptance check passes. */
export declare const FUSION_MCP_PIN = "19b9f1e95192";
export declare const FUSION_MCP_DEFAULT_ARGS: readonly string[];
type Arguments = Record<string, unknown>;
/** The machine-facing seams: tests replace them with fakes. */
export type FusionSystem = {
    platform: NodeJS.Platform;
    /** Whether the Fusion360MCP add-in answers its ping on host:port within timeoutMs. */
    addinAnswers(host: string, port: number, timeoutMs: number): Promise<boolean>;
    /** Whether an Autodesk Fusion process is running. */
    fusionRunning(): Promise<boolean>;
    /** Start Autodesk Fusion. */
    launch(): Promise<void>;
    sleep(ms: number): Promise<void>;
    launchWaitMs: number;
};
export declare const defaultFusionSystem: FusionSystem;
export declare const FUSION_STATUS_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        configured: {
            type: string;
            description: string;
        };
        connected: {
            type: string;
            description: string;
        };
        addinReachable: {
            type: string;
            description: string;
        };
        fusionRunning: {
            type: string;
        };
        tools: {
            type: string;
            items: {
                type: string;
                properties: {
                    name: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        launched: {
            type: string;
            description: string;
        };
        transport: {
            type: string;
        };
        pin: {
            type: string;
            description: string;
        };
        server: {
            type: string;
        };
        error: {
            type: string;
        };
    };
    required: string[];
};
/** fusion_mcp_call passes the remote result through: its structuredContent, else an empty object. */
export declare const FUSION_CALL_OUTPUT_SCHEMA: {
    type: "object";
};
export declare const FUSION_NEW_DESIGN_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        status: {
            type: string;
            const: string;
        };
        document: {
            type: string;
        };
        parametric: {
            type: string;
        };
    };
    required: string[];
};
export declare const FUSION_EXPORT_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        status: {
            type: string;
            const: string;
        };
        stl: {
            type: string;
            description: string;
        };
        f3d: {
            type: string;
            description: string;
        };
        parameters: {
            type: string;
            description: string;
        };
        body: {
            type: string;
        };
        triangles: {
            type: string;
            minimum: number;
        };
        bytes: {
            type: string;
            minimum: number;
        };
        parameterCount: {
            type: string;
            minimum: number;
        };
    };
    required: string[];
};
export declare class FusionMcpBridge {
    private readonly system;
    private live?;
    private connecting?;
    constructor(system?: FusionSystem);
    /** Close the stdio session, if any; the next call reconnects. */
    close(): Promise<void>;
    private open;
    /**
     * The live session, starting one if needed. A start is shared by every caller
     * that arrives while it runs, so it has its own deadline (the longer of the
     * caller's and FUSION_MCP_TIMEOUT_MS) and no caller's signal; each caller
     * waits on it with its own deadline and cancellation.
     */
    private session;
    /** One request with a deadline. An interrupted request is never retried; the session is closed instead. */
    private request;
    private invoke;
    /** A faust tool that must succeed; its failure text is Fusion's own and contains no secrets of ours. */
    private must;
    status(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult>;
    newDesign(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    export(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export {};
