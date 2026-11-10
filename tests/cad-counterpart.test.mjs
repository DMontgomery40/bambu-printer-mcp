import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const confined = (() => {
  try {
    if (process.platform === "linux") { execFileSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" }); return true; }
    return process.platform === "darwin";
  } catch { return false; }
})();
const bracket = `import { bracket, part } from "counterpart-kernel";
export const P = { shelf: 120, height: 100, width: 25, kg: 3 };
export function build(P) { return part("bracket", bracket({ shelf: P.shelf, height: P.height, width: P.width, load: { kg: P.kg } })); }
`;
const hostile = `import { readFileSync } from "node:fs";
import { box, part } from "counterpart-kernel";
export const P = {};
export function build() { readFileSync("/etc/passwd"); return part("x", box({ size: [1, 1, 1] })); }
`;
const cube = (s, o) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]].map((p) => p.map((c, i) => c + o[i]));
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid c\n${f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid c\n`;
};

test(
  "the counterpart engine builds, proves, edits, refuses a hostile script and checks a fit through the MCP tools, with no Python runtime",
  { skip: !confined && "needs the OS confinement cad_run uses (bubblewrap or Seatbelt)", timeout: 600000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-counterpart-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const c = new Client({ name: "cad-counterpart-test", version: "1" });
    const tr = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_HOST: "127.0.0.1", TEMP_DIR: dir, CAD_DATA_DIR: path.join(dir, "cad-data") },
      stderr: "pipe",
    });
    tr.stderr?.on("data", () => {});
    t.after(() => c.close());
    await c.connect(tr);
    const call = async (name, args, ok = true) => {
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
      if (ok) assert.notEqual(r.isError, true, JSON.stringify(r).slice(0, 2000));
      return r;
    };
    const status = (await call("cad_status", {})).structuredContent;
    assert.equal(status.ready, false, "no Python runtime was installed");
    assert.equal(status.counterpart.ready, true, JSON.stringify(status.counterpart));

    const run = (await call("cad_run", { engine: "counterpart", script: bracket, output_dir: dir, name: "bracket" })).structuredContent;
    assert.equal(run.status, "completed");
    assert.equal(run.engine, "counterpart");
    assert.equal(run.valid, true);
    assert.equal(run.step, null);
    assert.match(run.step_unavailable, /no STEP/);
    for (const k of ["watertight", "manifold", "winding_consistent", "positive_volume"]) assert.equal(run.checks[k], true, k);
    assert.equal(run.solid_count, 1);
    assert.ok(run.volume_mm3 > 1000);
    for (const v of ["front", "back", "left", "right", "top", "bottom", "contact"]) await fs.access(run.renders[v]);
    await fs.access(run.stl); await fs.access(run.threemf);
    assert.ok(run.parts[0].physics.all_pass, JSON.stringify(run.parts[0].physics));
    assert.equal(run.parts[0].sized[0].feature, "bracket");
    assert.equal(JSON.parse(await fs.readFile(run.parameters, "utf8")).kg, 3);
    const manifest = JSON.parse(await fs.readFile(run.result_manifest, "utf8"));
    assert.equal(manifest.status, "completed");

    const edit = (await call("cad_run", { script_path: run.script, parameters: { kg: 6 }, output_dir: dir, name: "bracket-6kg" })).structuredContent;
    assert.equal(edit.engine, "counterpart", "a saved .mjs script selects its engine");
    assert.equal(JSON.parse(await fs.readFile(edit.parameters, "utf8")).kg, 6);
    assert.notEqual(edit.stl, run.stl);

    const bad = await call("cad_run", { engine: "counterpart", script: hostile, output_dir: dir, name: "hostile" }, false);
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad.structuredContent), /may import only/);

    await fs.writeFile(path.join(dir, "far.stl"), cube(10, [500, 0, 0]));
    await fs.writeFile(path.join(dir, "inside.stl"), cube(4, [2, 40, 10]));
    const clear = (await call("cad_check_fit", { engine: "counterpart", model: run.stl, reference: path.join(dir, "far.stl"), clearance_mm: 1 })).structuredContent;
    assert.equal(clear.clear, true);
    assert.equal(clear.interference_volume_mm3, 0);
    assert.ok(clear.minimum_gap_mm > 300);
    const hit = (await call("cad_check_fit", { engine: "counterpart", model: run.stl, reference: path.join(dir, "inside.stl") })).structuredContent;
    assert.equal(hit.clear, false);
    assert.ok(hit.interference_volume_mm3 > 1, JSON.stringify(hit));
  },
);
