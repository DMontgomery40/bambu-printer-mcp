/**
 * How Counterpart's remote endpoint (`/v1/mcp`) offers each tool to a paired device, declared by this server so a
 * new tool or argument needs no Counterpart release. Sent as each listed tool's `_meta["counterpart/remote"]`:
 *
 * - `scope`: the least device scope that may call the tool: read < design < control < print < raw. The table keeps
 *   the classes Counterpart gave these tools by hand before this version, so no paired device gained or lost a tool;
 *   `tests/tool-annotations.test.mjs` holds the name floors (a print start is at least print, a raw call raw).
 * - `raisedBy`: boolean arguments that, when true, need a higher scope (`launch` starts Fusion).
 * - `arguments`: argument names that are not plain values, matched at any depth of a call's arguments:
 *   `config`: this server's configuration chooses it (the printer it targets, its account, hardware and programs),
 *   so a device may not set it; `config-top`: the same, as a top-level argument only (`type`, the printer type);
 *   `path`: a local file or folder the tool reads; `output`: one it writes. Any other argument is a plain value.
 *   A tool that forwards an open object (an arbitrary RPC payload or another server's tool arguments) declares every
 *   configuration name, since any of them may appear inside it.
 */
export type RemoteScope = "read" | "design" | "control" | "print" | "raw";
export type ArgumentKind = "config" | "config-top" | "path" | "output";
export interface RemoteDeclaration {
    scope: RemoteScope;
    raisedBy?: Record<string, RemoteScope>;
    arguments?: Record<string, ArgumentKind>;
}
export declare const REMOTE_META_KEY = "counterpart/remote";
export declare const REMOTE_SCOPES: Readonly<Record<string, RemoteScope>>;
/**
 * Overrides of a server's own configuration (both printer MCPs use the same names): the printer it targets, its
 * account and credentials, its hardware, and the programs it runs.
 */
export declare const CONFIG_ARGUMENTS: ReadonlySet<string>;
/** The argument kinds of one tool, read from its own input schema. */
export declare function remoteArguments(tool: {
    name: string;
    inputSchema?: unknown;
}): Record<string, ArgumentKind>;
/** The declaration for one tool; a tool missing from REMOTE_SCOPES (a bug the tests catch) is raw. */
export declare function remoteDeclaration(tool: {
    name: string;
    inputSchema?: unknown;
}): RemoteDeclaration;
/** The tool with its declaration in `_meta`. */
export declare function withRemote<T extends {
    name: string;
    inputSchema?: unknown;
    _meta?: Record<string, unknown>;
}>(tool: T): T & {
    _meta: Record<string, unknown>;
};
