import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const module = await import("../dist/cad-engine.js").catch(() => ({}));

test("CAD engine exposes a read-only status before setup without starting Python", async (t) => {
  assert.equal(
    typeof module.CadEngine,
    "function",
    "CAD engine is not implemented",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new module.CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("status must not spawn");
      },
    },
  });
  const status = await engine.status();
  assert.equal(status.ready, false);
  assert.equal(status.configured, false);
  assert.equal(status.platform, "darwin");
});

test("CAD subprocess deadlines kill descendants and do not replay execution", async () => {
  const { runCadProcess } = await import("../dist/cad/process.js");
  await assert.rejects(
    runCadProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 60,
      env: { PATH: process.env.PATH },
    }),
    /timed out/,
  );
});

test("CAD confinement has no network or home mounts and refuses unsupported hosts", async () => {
  const { cadSandbox } = await import("../dist/cad/process.js");
  const roots = {
    data: "/srv/cad",
    job: "/work/job",
    assets: "/pkg/src/cad",
    python: "/srv/cad/runtime/bin/python",
    readonly: ["/work/job/a.py", "/work/job/a.parameters.json"],
  };
  const mac = await cadSandbox("darwin", roots);
  assert.equal(mac.command, "/usr/bin/sandbox-exec");
  assert.match(mac.args[1], /deny network/);
  assert.match(mac.args[1], /deny process-fork/);
  assert.match(mac.args[1], /deny mach-lookup/);
  const linux = await cadSandbox("linux", roots);
  assert.equal(linux.command, "bwrap");
  assert.ok(linux.args.includes("--unshare-all"));
  assert.ok(linux.args.includes("--die-with-parent"));
  assert.equal(linux.args.includes("/home"), false);
  await assert.rejects(cadSandbox("win32", roots), /confinement.*unavailable/i);
});

test("CAD run refuses outputs outside configured roots and symlink escapes before execution", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allowed"));
  await fs.mkdir(path.join(root, "outside"));
  await fs.symlink(
    path.join(root, "outside"),
    path.join(root, "allowed", "escape"),
  );
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [path.join(root, "allowed")],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("must not execute");
      },
    },
  });
  for (const dir of [
    path.join(root, "outside"),
    path.join(root, "allowed", "escape"),
  ])
    await assert.rejects(
      engine.run({
        script: "P={}\ndef build(): return None",
        output_dir: dir,
        name: "part",
      }),
      /allowed output/,
    );
});

test("CAD setup proves a fresh installation and status uses the verified marker", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const engine = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (args[0] === "venv") {
          await fs.mkdir(path.join(root, "runtime", "bin"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(root, "runtime", "bin", "python"),
            "stub",
          );
        }
        if (args.includes("smoke"))
          return {
            stdout: JSON.stringify({
              build123d: "0.13.0",
              python: "3.12",
              watertight: true,
              manifold: true,
              step_valid: true,
              solid_count: 1,
            }),
          };
        return { stdout: "" };
      },
    },
  });
  assert.equal((await engine.setup({})).ready, false);
  assert.equal(calls.length, 0);
  assert.equal((await engine.setup({ install: true })).ready, true);
  const count = calls.length;
  assert.equal((await engine.status()).ready, true);
  assert.equal(calls.length, count);
  assert.ok(calls.some((c) => c.args.includes("--managed-python")));
  assert.ok(calls.some((c) => c.file === "bwrap" && c.args.includes("smoke")));
  for (const c of calls) {
    assert.equal(c.options.env.BAMBU_TOKEN, undefined);
    assert.equal(c.options.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(c.options.env.TMPDIR.startsWith(root));
  }
});

test("CAD setup does not mark a runtime ready when confinement cannot start", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-no-sandbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const e = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file) => {
        if (file === "bwrap") throw Error("bwrap denied user namespace");
        return { stdout: "" };
      },
    },
  });
  await assert.rejects(e.setup({ install: true }), /bwrap denied/);
  assert.equal((await e.status()).ready, false);
});

test("CAD parameter edits retain the prior checkpoint and use separate build and inspection processes", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let engine;
  const system = {
    platform: "linux",
    run: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "venv") {
        await fs.mkdir(path.join(root, "runtime", "bin"), { recursive: true });
        await fs.writeFile(path.join(root, "runtime", "bin", "python"), "stub");
      }
      if (args.includes("smoke"))
        return {
          stdout: JSON.stringify({
            build123d: "0.13.0",
            watertight: true,
            manifold: true,
            step_valid: true,
            solid_count: 1,
          }),
        };
      if (args.includes("parameters"))
        return {
          stdout: JSON.stringify({
            width: 10,
            height: 20,
            ...JSON.parse(
              await fs.readFile(
                JSON.parse(await fs.readFile(args.at(-1), "utf8")).parameters,
                "utf8",
              ),
            ),
          }),
        };
      if (args.includes("build")) {
        const q = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
        await fs.writeFile(path.join(q.output, q.name + ".stl"), "stl");
        await fs.writeFile(path.join(q.output, q.name + ".step"), "step");
        return { stdout: "user output is NOT a receipt" };
      }
      if (args.includes("inspect"))
        return {
          stdout: JSON.stringify({
            valid: true,
            bounds_mm: [
              [0, 0, 0],
              [10, 20, 30],
            ],
            solid_count: 1,
            checks: { watertight: true, manifold: true },
            renders: {},
          }),
        };
      return { stdout: "" };
    },
  };
  engine = new CadEngine({ dataDir: root, outputRoots: [root], system });
  await engine.setup({ install: true });
  const first = await engine.run({
    script: 'P={"width":10,"height":20}\ndef build(): pass',
    parameters: { width: 11 },
    output_dir: root,
    name: "part",
  });
  const second = await engine.run({
    script_path: first.script,
    parameters: { height: 21 },
    output_dir: root,
    name: "part",
  });
  assert.notEqual(first.script, second.script);
  assert.deepEqual(JSON.parse(await fs.readFile(second.parameters, "utf8")), {
    width: 11,
    height: 21,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(first.parameters, "utf8")), {
    width: 11,
    height: 20,
  });
  assert.equal(calls.filter((c) => c.args.includes("build")).length, 2);
  assert.equal(calls.filter((c) => c.args.includes("inspect")).length, 2);
});

test("a stalled macOS import is repaired once, only for owned native regular files", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-signatures-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  let imports = 0;
  const signed = [];
  const e = new CadEngine({
    dataDir: data,
    outputRoots: [root],
    system: {
      platform: "darwin",
      run: async (file, args) => {
        if (args[0] === "venv") {
          await fs.mkdir(path.join(data, "runtime", "bin"), {
            recursive: true,
          });
          await fs.mkdir(path.join(data, "runtime", "lib"));
          await fs.writeFile(
            path.join(data, "runtime", "bin", "python"),
            "stub",
          );
          await fs.writeFile(
            path.join(data, "runtime", "lib", "native.so"),
            "native",
          );
          await fs.writeFile(path.join(root, "outside.so"), "untouched");
          await fs.symlink(
            path.join(root, "outside.so"),
            path.join(data, "runtime", "lib", "foreign.so"),
          );
        }
        if (args.includes("imports") && ++imports === 1)
          throw Error("CAD process timed out");
        if (file === "/usr/bin/codesign") signed.push(args.at(-1));
        if (args.includes("smoke"))
          return {
            stdout: JSON.stringify({
              build123d: "0.13.0",
              watertight: true,
              manifold: true,
              step_valid: true,
              solid_count: 1,
            }),
          };
        return { stdout: "" };
      },
    },
  });
  const result = await e.setup({ install: true });
  assert.equal(result.repaired_native_files, 1);
  assert.equal(imports, 2);
  assert.deepEqual(signed, [path.join(data, "runtime", "lib", "native.so")]);
});

test("deadline termination removes an actual spawned descendant PID", async (t) => {
  const { runCadProcess } = await import("../dist/cad/process.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-child-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "pid");
  const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000)`;
  await assert.rejects(
    runCadProcess(process.execPath, ["-e", code, file], {
      timeoutMs: 5000,
      env: { PATH: process.env.PATH },
    }),
    /timed out/,
  );
  const pid = Number(await fs.readFile(file, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1, "fixture must record its descendant before the deadline");
  let alive = true;
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(alive, false, `descendant ${pid} survived`);
});

test("declared CAD input snapshots exclude files outside the allowed roots", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-inputs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allowed"));
  await fs.writeFile(path.join(root, "private.stl"), "private");
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [path.join(root, "allowed")],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("must not spawn");
      },
    },
  });
  await assert.rejects(
    engine.run({
      script: "P={}\ndef build(): pass",
      inputs: { scan: path.join(root, "private.stl") },
      mode: "mesh",
      output_dir: path.join(root, "allowed"),
      name: "part",
    }),
    /allowed output/,
  );
});
