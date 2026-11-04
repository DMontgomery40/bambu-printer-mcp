/**
 * MCP tool annotations (spec 2025-03-26 and later), one entry per tool, chosen from
 * what the tool's handler actually does. Clients and Counterpart's remote endpoint
 * read them to decide which tools a device may call, so every listed tool must have
 * one (tests/tool-annotations.test.mjs).
 *
 * readOnlyHint: changes nothing outside this server (printer, files, other apps).
 * destructiveHint: may delete, overwrite, end or irreversibly change something.
 * idempotentHint: repeating the call with the same arguments has no further effect.
 * openWorldHint: reaches something outside this server and its files: the printer,
 *   Bambu Cloud, a remote slicer, or another application (Blender, Fusion, Bambu Connect).
 */
export interface ToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
}
export declare const TOOL_ANNOTATIONS: Record<string, ToolAnnotations>;
/** The tool with its annotations. A tool missing from the table is a bug caught by the tests. */
export declare function withAnnotations<T extends {
    name: string;
}>(tool: T): T & {
    annotations?: ToolAnnotations;
};
