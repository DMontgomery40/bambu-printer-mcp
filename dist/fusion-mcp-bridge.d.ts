import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/** The faust-machines commit the setup installs; move it only after the PRD §8.9 acceptance check passes. */
export declare const FUSION_MCP_PIN = "19b9f1e95192";
/** PRD §8.9: Blender's MCP add-on holds the add-in's own default, 9876, so Counterpart's Fusion uses 9877. */
export declare const FUSION_ADDIN_DEFAULT_PORT = 9877;
export declare const FUSION_MCP_DEFAULT_ARGS: readonly string[];
type Arguments = Record<string, unknown>;
/** The machine-facing seams: tests replace them with fakes. */
export type FusionSystem = {
    platform: NodeJS.Platform;
    /** Whether the Fusion360MCP add-in answers its ping on host:port within timeoutMs. */
    addinAnswers(host: string, port: number, timeoutMs: number): Promise<boolean>;
    /** Whether an Autodesk Fusion process is running. */
    fusionRunning(): Promise<boolean>;
    /** Start Autodesk Fusion with its add-in listening on port. */
    launch(port: number): Promise<void>;
    sleep(ms: number): Promise<void>;
    launchWaitMs: number;
};
/**
 * The add-in reads FUSION_MCP_PORT from Fusion's environment at the pin
 * (addon/Fusion360MCP.py), and an app started from the Dock gets no shell
 * environment, so the launch passes the port the bridge probes. `open --env`
 * applies only when it starts the app, which is the only time this runs.
 */
export declare function fusionLaunchArguments(port: number): string[];
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
        document_id: {
            type: string;
        };
        document_binding: {
            type: string;
            const: number;
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
        boundingBox: {
            type: string;
            description: string;
        };
        stlUnits: {
            type: string;
            enum: string[];
            description: string;
        };
        fusionSizeMm: {
            type: string;
            items: {
                type: string;
            };
            description: string;
        };
        warnings: {
            type: string;
            items: {
                type: string;
            };
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
    private boundArguments;
    call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult>;
    newDesign(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    export(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export {};
