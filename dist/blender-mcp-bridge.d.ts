import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
type Arguments = Record<string, unknown>;
export declare class BlenderMcpBridge {
    private session;
    private invoke;
    status(args: Arguments, signal?: AbortSignal): Promise<unknown>;
    call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult>;
    edit(args: Arguments, legacyCommand?: string, signal?: AbortSignal): Promise<unknown>;
}
export {};
