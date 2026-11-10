/**
 * Module hooks for the sandboxed runner: a part script may import only the kernel. The kernel's own files
 * (dist/) and the physics engine's (physics/dist/) may import Node's built-ins except the network ones;
 * nothing in the sandbox can import net, http(s), tls, dgram, dns, child_process, cluster, inspector,
 * vm, wasi or module (createRequire would bypass this hook).
 */
let ROOTS = [];
let KERNEL = "";
let SCRIPT = "";
export async function initialize(data) { ROOTS = data.roots; KERNEL = data.kernel; SCRIPT = data.script; }
const DENY = new Set(["net", "http", "https", "http2", "tls", "dgram", "dns", "child_process", "cluster", "inspector", "vm", "wasi", "module", "repl", "trace_events", "diagnostics_channel"]);
export async function resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    const trusted = ROOTS.some((r) => parent.startsWith(r));
    const bare = specifier.replace(/^node:/, "");
    if (specifier.startsWith("node:") || /^[a-z_]+(\/[a-z_]+)?$/.test(specifier) && !specifier.startsWith("counterpart")) {
        if (DENY.has(bare.split("/")[0]))
            throw new Error(`sandbox: "${specifier}" is not available to part scripts or the kernel`);
        if (!trusted)
            throw new Error(`sandbox: a part script may import only "counterpart-kernel" (it asked for "${specifier}")`);
        return next(specifier, context);
    }
    if (specifier === "counterpart-kernel" || specifier === "counterpart-kernel/exact")
        return { url: KERNEL + (specifier.endsWith("/exact") ? "exact/api.js" : "index.js"), shortCircuit: true };
    if (/^(data|http|https|blob):/.test(specifier))
        throw new Error(`sandbox: "${specifier.slice(0, 40)}" cannot be imported`);
    const r = await next(specifier, context);
    // the kernel may import its own files and the one script it runs; a script may import only the kernel's files
    if (r.url === SCRIPT && (trusted || !parent))
        return r;
    // an entry with no parent inside a trusted root is a worker the physics engine started (scripts cannot reach
    // worker_threads): round 2 refused it, the worker died, and the engine's pool waited for it forever
    if (!parent && ROOTS.some((root) => r.url.startsWith(root)))
        return r;
    if (r.url.startsWith(KERNEL) || (trusted && ROOTS.some((root) => r.url.startsWith(root))))
        return r;
    throw new Error(`sandbox: a part script may import only "counterpart-kernel" (it asked for "${specifier}")`);
}
