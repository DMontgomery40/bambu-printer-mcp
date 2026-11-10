/**
 * The sandboxed runner the printer MCP's cad_run can call: runs a part script in a child Node process
 *  - under Node's permission model: it may read only the kernel, the physics engine and the script, write
 *    only its output folder, and start no processes. Worker threads must be allowed because Node runs the
 *    module hooks on one; the script cannot reach worker_threads (the hooks refuse it), and the physics solve
 *    can run on worker threads here (--threads n), which its module hooks now admit; default 0 (the engine's pool
 *    can deadlock: see src/sizing.ts);
 *  - with module hooks that let the script import nothing but "counterpart-kernel" and keep the network
 *    modules out of reach of everything in the sandbox; network globals and process back doors removed;
 *  - with an empty environment, a heap cap, a resident-memory watchdog and a wall-clock limit.
 * Returns the CLI's receipt (the same JSON as `cli.js run`), or an error saying which limit stopped it.
 *   node dist/sandbox/run.js SCRIPT --out DIR [--set k=v ...] [--timeout 120] [--mem 3072] [--no-prove]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
/**
 * The Node command that runs one script in the sandbox: arguments for `node` and its environment. Pure, so a host that
 * already confines processes (the printer MCP runs it inside bubblewrap or Seatbelt, where forking is denied) can run
 * this one process itself. `inputs` are files the script may load by name with loadMesh (read-only).
 */
export function sandboxCommand(script, o) {
    const scriptAbs = realpathSync(resolve(script));
    mkdirSync(o.outDir, { recursive: true });
    const out = realpathSync(resolve(o.outDir));
    const memMB = o.memMB ?? 3072;
    const dist = join(ROOT, "dist"), pdist = join(ROOT, "physics", "dist"), pmat = join(ROOT, "physics", "materials");
    const inputs = Object.fromEntries(Object.entries(o.inputs ?? {}).map(([k, v]) => [k, realpathSync(resolve(v))]));
    const reads = [dist, existsSync(pdist) ? pdist : null, existsSync(pmat) ? pmat : null, scriptAbs, ...Object.values(inputs), ...(o.reads ?? []).map((r) => realpathSync(resolve(r)))].filter(Boolean);
    const roots = [dist, pdist].map((d) => pathToFileURL(d).href + "/");
    const argv = [
        // --no-warnings: Node's notice that --allow-worker needs care (it does: the hooks keep worker_threads from scripts)
        // would otherwise be the only text a host sees when a script is refused
        "--no-warnings", "--permission", ...reads.map((r) => `--allow-fs-read=${r}`), `--allow-fs-write=${out}`, "--allow-worker",
        `--max-old-space-size=${Math.max(256, memMB - 512)}`, "--import", pathToFileURL(join(dist, "sandbox", "preload.js")).href,
        join(dist, "cli.js"), "run", scriptAbs, "--out", out, ...(o.name ? ["--name", o.name] : []), ...(o.args ?? []),
    ];
    const env = { CP_SANDBOX_ROOTS: roots.join("|"), CP_SANDBOX_KERNEL: pathToFileURL(dist).href + "/", CP_SANDBOX_SCRIPT: pathToFileURL(scriptAbs).href, PHYSICS_THREADS: String(o.threads ?? 0), COUNTERPART_PHYSICS_THREADS: String(o.threads ?? 0), CP_INPUTS: JSON.stringify(inputs) };
    return { argv, env, reads, out };
}
export function runSandboxed(script, o) {
    const t0 = performance.now();
    const memMB = o.memMB ?? 3072, timeoutS = o.timeoutS ?? 120;
    const { argv, env, out } = sandboxCommand(script, o);
    return new Promise((res) => {
        const child = spawn(process.execPath, argv, { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "", limit, peak = 0;
        child.stdout.on("data", (b) => { stdout += b; if (stdout.length > 1 << 24)
            child.kill("SIGKILL"); });
        child.stderr.on("data", (b) => { stderr += b; if (stderr.length > 1 << 20)
            stderr = stderr.slice(-4096); });
        const timer = setTimeout(() => { limit = "time"; child.kill("SIGKILL"); }, timeoutS * 1000);
        const watch = setInterval(() => {
            try {
                const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"));
                if (m) {
                    const mb = Number(m[1]) / 1024;
                    peak = Math.max(peak, mb);
                    if (mb > memMB) {
                        limit = "memory";
                        child.kill("SIGKILL");
                    }
                }
            }
            catch { /* exited */ }
        }, 100);
        child.on("close", (code) => {
            clearTimeout(timer);
            clearInterval(watch);
            const ms = performance.now() - t0;
            if (limit)
                return res({ ok: false, limit, error: limit === "time" ? `stopped after ${timeoutS} s (the script did not finish)` : `stopped at ${Math.round(peak)} MB (limit ${memMB} MB)`, ms, peakRssMB: Math.round(peak) });
            let receipt;
            try {
                receipt = JSON.parse(stdout);
            }
            catch { /* not JSON */ }
            const r = receipt;
            if (code === 0 && r?.status === "ok")
                return res({ ok: true, receipt, ms, peakRssMB: Math.round(peak) });
            res({ ok: false, limit: "exit", receipt, error: r?.message ?? (stderr.split("\n").find((l) => /sandbox:|Error/.test(l)) ?? stderr.slice(-500)).trim(), ms, peakRssMB: Math.round(peak) });
        });
    });
}
if (process.argv[1] && process.argv[1].endsWith(join("sandbox", "run.js"))) {
    const a = process.argv.slice(2);
    const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
    const own = ["--out", "--timeout", "--mem", "--threads"];
    const pass = a.filter((x, i) => !own.includes(x) && !own.includes(a[i - 1]) && i > 0);
    const r = await runSandboxed(a[0], { outDir: get("--out") ?? "out/sandbox", args: pass, timeoutS: Number(get("--timeout") ?? 120), memMB: Number(get("--mem") ?? 3072), threads: get("--threads") !== undefined ? Number(get("--threads")) : undefined });
    console.log(JSON.stringify(r.ok ? r.receipt : { status: "error", code: "sandbox", limit: r.limit, message: r.error, ms: Math.round(r.ms), peak_rss_mb: r.peakRssMB }, null, 1));
    process.exit(r.ok ? 0 : 1);
}
void dirname;
