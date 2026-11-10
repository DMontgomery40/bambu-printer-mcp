/**
 * A second code-CAD engine for cad_run and cad_check_fit, chosen per call with `engine: "counterpart"`: the Counterpart
 * kernel, vendored as a built bundle with no dependencies (vendor/counterpart-kernel). Scripts are JavaScript modules
 * (`export const P = {...}; export function build(P)`), run by Node in two layers of confinement: this MCP's own OS
 * sandbox (bubblewrap or Seatbelt, as for Python) around one Node process under the kernel's permission model, which
 * lets the script import only the kernel, read only its declared inputs and write only its job folder. No Python
 * runtime or setup is needed. Each run also proves the requirements the kernel's features state (the physics block).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cadSandbox, type CadSystem } from "./process.js";

export const COUNTERPART_DIR = fileURLToPath(
  new URL("../../vendor/counterpart-kernel/", import.meta.url),
);
const MIN_NODE = 22;

export interface CounterpartStatus {
  ready: boolean;
  version: string | null;
  node: string;
  error?: string;
}
export async function counterpartStatus(): Promise<CounterpartStatus> {
  const node = process.versions.node;
  let version: string | null = null;
  try {
    version = JSON.parse(
      await fs.readFile(path.join(COUNTERPART_DIR, "package.json"), "utf8"),
    ).version;
  } catch {
    return { ready: false, version, node, error: "The counterpart engine is not bundled with this installation." };
  }
  if (Number(node.split(".")[0]) < MIN_NODE)
    return { ready: false, version, node, error: `The counterpart engine needs Node.js ${MIN_NODE} or newer (its permission model); this server runs ${node}.` };
  return { ready: true, version, node };
}

/** The directories Node itself lives in, which the OS sandbox must let it read and execute. */
async function nodeRoots(): Promise<string[]> {
  const real = await fs.realpath(process.execPath);
  return [path.dirname(path.dirname(real))];
}

async function confinedNode(
  system: CadSystem,
  r: { data: string; job: string; readonly: string[]; inputs: string[] },
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const node = await fs.realpath(process.execPath);
  const sandbox = await cadSandbox(system.platform, {
    data: r.data,
    job: r.job,
    assets: COUNTERPART_DIR,
    python: node,
    readonly: r.readonly,
    inputs: [...r.inputs, ...(await nodeRoots())],
  });
  return system.run(sandbox.command, [...sandbox.args, node, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: r.job, TMPDIR: path.join(r.job, "tmp"), ...env },
    cwd: r.job,
    timeoutMs,
    signal,
  });
}

/** Build the script: STL, 3MF, the part records and the proofs; returns the kernel's receipt. */
export async function counterpartBuild(
  system: CadSystem,
  o: { data: string; job: string; name: string; script: string; parameters: string; inputs: Record<string, string>; readonly: string[]; inputDirs: string[]; timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const { sandboxCommand } = await import(path.join(COUNTERPART_DIR, "dist", "sandbox", "run.js"));
  const out = path.join(o.job, "out");
  const cmd = sandboxCommand(o.script, {
    outDir: out,
    name: o.name,
    inputs: o.inputs,
    reads: [o.parameters],
    args: ["--params", o.parameters],
    memMB: 3072,
    threads: 0, // the physics engine's thread pool can deadlock (Counterpart kernel lab, round 3): one thread until it is fixed
  });
  await fs.mkdir(path.join(o.job, "tmp"), { recursive: true, mode: 0o700 });
  let r: { stdout: string; stderr?: string };
  try {
    r = await confinedNode(system, { data: o.data, job: o.job, readonly: o.readonly, inputs: o.inputDirs }, cmd.argv, cmd.env, o.timeoutMs, o.signal);
  } catch (e) {
    // a refused or failing script exits 1 with the kernel's own JSON reason on stdout: report that reason
    const text = e instanceof Error ? e.message : String(e);
    const m = /\{\s*"status":\s*"error"[\s\S]*\}/.exec(text);
    if (m) { try { const j = JSON.parse(m[0]); throw new Error(`The script failed (${j.code}): ${j.message}`); } catch (inner) { if (inner instanceof SyntaxError) throw e; throw inner; } }
    throw e;
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(r.stdout);
  } catch {
    throw new Error(`The counterpart engine returned no receipt: ${(r.stderr ?? r.stdout).slice(-2000)}`);
  }
  if (receipt.status !== "ok") throw new Error(`The script failed: ${String(receipt.message ?? "unknown error")}`);
  return receipt;
}

/** The trusted inspection (no user code): measures the exported STL and renders the six views and a contact sheet. */
export async function counterpartInspect(
  system: CadSystem,
  o: { data: string; job: string; name: string; stl: string; readonly: string[]; timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const r = await confinedNode(system, { data: o.data, job: o.job, readonly: o.readonly, inputs: [] },
    [path.join(COUNTERPART_DIR, "dist", "mcp", "inspect.js"), o.stl, o.job, o.name], {}, o.timeoutMs, o.signal);
  return JSON.parse(r.stdout);
}

/** cad_check_fit on the kernel: exact mesh-boolean interference and BVH surface distance. */
export async function counterpartFit(
  system: CadSystem,
  o: { data: string; job: string; request: string; readonly: string[]; timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const r = await confinedNode(system, { data: o.data, job: o.job, readonly: o.readonly, inputs: [] },
    [path.join(COUNTERPART_DIR, "dist", "mcp", "fit.js"), o.request], {}, o.timeoutMs, o.signal);
  return JSON.parse(r.stdout);
}
