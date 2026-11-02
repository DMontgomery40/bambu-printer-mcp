import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
type Arguments = Record<string, unknown>;
export type StlBoundingBox = {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
};
export declare function regularStl(filePath: string): Promise<{
    bytes: number;
    triangles: number;
}>;
/** regularStl plus the mesh's bounding box in the STL's own units (rounded to 1e-4). */
export declare function stlMetadata(filePath: string): Promise<{
    bytes: number;
    triangles: number;
    bounding_box: StlBoundingBox;
}>;
export declare class BlenderMcpBridge {
    private session;
    private invoke;
    status(args: Arguments, signal?: AbortSignal): Promise<unknown>;
    call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult>;
    edit(args: Arguments, legacyCommand?: string, signal?: AbortSignal): Promise<unknown>;
}
export {};
