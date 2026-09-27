import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(path.dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: "false" },
  });
}

function assertPatchedParser(packageRoot) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const require = createRequire(process.argv[1] + "/package.json");
    try {
      const { BambuClient, PrinterModel, GCodeFileCommand } = await import(pathToFileURL(require.resolve("bambu-node")));
      for (const [prefix, model] of [["239", "H2C"], ["094", "H2D"], ["093", "H2S"], ["31B", "H2DPRO"], ["22E", "P2S"]]) {
        assert.equal(PrinterModel[model], model);
        const printer = new BambuClient({ host: "127.0.0.1", serialNumber: prefix + "TEST", accessToken: "test" });
        await printer.onMessage(JSON.stringify({ info: { command: "get_version", module: [{ name: "ota", sn: prefix + "TEST" }] } }), "test/report");
        assert.equal(printer.data.model, model);
        for (const state of ["PAUSE", "FINISH", "IDLE"]) {
          await printer.onMessage(JSON.stringify({ print: { command: "push_status", gcode_state: state } }), "test/report");
          assert.equal(printer.status, state);
        }
      }
      let published;
      await new GCodeFileCommand({ fileName: "test.gcode" }).invoke({ publish: async (payload) => { published = payload; } });
      assert.equal(typeof published.print.sequence_id, "string");
      console.log("Installed parser and command patches verified without printer connections");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `, packageRoot], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function assertIdempotent(packageRoot, cwd) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const dependency = path.dirname(require.resolve("bambu-node/package.json"));
  const targets = ["dist/index.js", "dist/index.d.ts"].map((name) => path.join(dependency, name));
  const before = targets.map((name) => fs.readFileSync(name));
  execFileSync(process.execPath, [path.join(packageRoot, "scripts/install-patches.mjs")], { cwd, stdio: "pipe" });
  targets.forEach((name, index) => assert.deepEqual(fs.readFileSync(name), before[index], "re-running postinstall must not change an already patched dependency"));
  assertPatchedParser(packageRoot);
  return { dependency, targets };
}

test("published tarball patches the resolved dependency in local, global, and npm-exec installs", { timeout: 240_000 }, async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-npm-install-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", fixture], ROOT));
  const tarball = path.join(fixture, packed[0].filename);
  const local = path.join(fixture, "local");
  const global = path.join(fixture, "global");
  const execCwd = path.join(fixture, "exec-cwd");
  fs.mkdirSync(execCwd);
  fs.writeFileSync(path.join(execCwd, "user-config.json"), "DO_NOT_CHANGE");

  await t.test("local dependency install with a hoisted bambu-node", () => {
    npm(["install", "--prefix", local, "--no-audit", "--no-fund", tarball], fixture);
    const packageRoot = path.join(local, "node_modules/bambu-printer-mcp");
    const require = createRequire(path.join(packageRoot, "package.json"));
    assert.equal(fs.realpathSync(require.resolve("bambu-node/package.json")), fs.realpathSync(path.join(local, "node_modules/bambu-node/package.json")));
    assertPatchedParser(packageRoot);
    const { targets } = assertIdempotent(packageRoot, execCwd);
    const declarations = fs.readFileSync(targets[1]);
    fs.writeFileSync(targets[0], "incompatible dependency contents\n");
    const failed = spawnSync(process.execPath, [path.join(packageRoot, "scripts/install-patches.mjs")], { cwd: execCwd, encoding: "utf8" });
    assert.notEqual(failed.status, 0, "incompatible patches must fail installation");
    assert.match(failed.stderr, /Unable to apply.*bambu-node/i);
    assert.deepEqual(fs.readFileSync(targets[1]), declarations, "failed preflight must not partially patch other files");
  });

  await t.test("global install with dependencies nested under the package", () => {
    npm(["install", "--global", "--prefix", global, "--no-audit", "--no-fund", tarball], fixture);
    const globalModules = npm(["root", "--global", "--prefix", global], fixture).trim();
    const packageRoot = path.join(globalModules, "bambu-printer-mcp");
    assertPatchedParser(packageRoot);
    assertIdempotent(packageRoot, execCwd);
  });

  await t.test("npm exec installs and patches its cached package", () => {
    const cache = path.join(fixture, "npm-cache");
    const output = npm(["exec", "--yes", "--cache", cache, `--package=${tarball}`, "--", "node", "-e", 'console.log("NPM_EXEC_PATH=" + process.env.PATH)'], execCwd);
    const execPath = output.split(/\r?\n/).find((line) => line.startsWith("NPM_EXEC_PATH="))?.slice("NPM_EXEC_PATH=".length);
    assert.ok(execPath, output);
    const bin = execPath.split(path.delimiter).find((entry) => entry.startsWith(cache) && path.basename(entry) === ".bin");
    assert.ok(bin, "npm exec must use the isolated cache installation");
    const packageRoot = path.join(path.dirname(bin), "bambu-printer-mcp");
    assertPatchedParser(packageRoot);
    assertIdempotent(packageRoot, execCwd);
  });
  assert.equal(fs.readFileSync(path.join(execCwd, "user-config.json"), "utf8"), "DO_NOT_CHANGE");
});
