/**
 * Runs first in every sandboxed process (and its worker threads): registers the module hooks and removes
 * the ways out that Node's permission model leaves open (network globals, getBuiltinModule, process.kill).
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
const roots = (process.env.CP_SANDBOX_ROOTS ?? "").split("|").filter(Boolean);
register(new URL("./hooks.js", import.meta.url), { data: { roots, kernel: process.env.CP_SANDBOX_KERNEL, script: process.env.CP_SANDBOX_SCRIPT } });
const g = globalThis;
for (const k of ["fetch", "WebSocket", "EventSource", "Request", "Response", "Headers", "FormData", "XMLHttpRequest"]) {
    try {
        delete g[k];
    }
    catch {
        g[k] = undefined;
    }
}
const deny = (name) => () => { throw new Error(`sandbox: process.${name} is not available to part scripts`); };
const p = process;
for (const k of ["getBuiltinModule", "kill", "dlopen", "_linkedBinding", "binding", "setuid", "setgid", "chdir"]) {
    try {
        Object.defineProperty(p, k, { value: deny(k), writable: false, configurable: false });
    }
    catch { /* not present */ }
}
void pathToFileURL;
