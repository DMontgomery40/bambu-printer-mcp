#!/usr/bin/env node
/**
 * Smoke test: flattener -> BambuStudio CLI -> printable .gcode.3mf.
 *
 * Validates that the profile-flatten module produces configs the CLI
 * accepts well enough to emit a sliced 3MF with a non-empty
 * Metadata/plate_<n>.gcode entry.
 *
 * This is the unit-of-progress test for the CLI-slicing fix
 * (see https://github.com/bambulab/BambuStudio/issues/9636 +
 *      https://github.com/bambulab/BambuStudio/issues/9968).
 *
 * Usage:
 *   node scripts/test-cli-slice.mjs --model h2s [--filament "Bambu PLA Basic @BBL H2S"]
 *
 * Exits 0 on success, non-zero on any failure with a precise message.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { flattenForCli, detectProfilesRoot } from "../dist/slicer/profile-flatten.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

/* --- CLI args ------------------------------------------------------------ */

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { model: "h2s", filament: null, stl: null, keepTemp: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") out.model = args[++i];
    else if (a === "--filament") out.filament = args[++i];
    else if (a === "--stl") out.stl = args[++i];
    else if (a === "--keep-temp") out.keepTemp = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node scripts/test-cli-slice.mjs --model <h2s|h2d|x1c|p1s> [--filament NAME] [--stl PATH] [--keep-temp]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/* --- Per-model defaults -------------------------------------------------- */

const MODEL_DEFAULTS = {
  h2s: {
    machineLeaf: "Bambu Lab H2S 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL H2S",
    filamentLeaf: "Bambu PLA Basic @BBL H2S",
  },
  h2d: {
    machineLeaf: "Bambu Lab H2D 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL H2D",
    filamentLeaf: "Bambu PLA Basic @BBL H2D",
  },
  x1c: {
    machineLeaf: "Bambu Lab X1 Carbon 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL X1C",
    filamentLeaf: "Bambu PLA Basic @BBL X1C",
  },
  p1s: {
    machineLeaf: "Bambu Lab P1S 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL P1P",
    filamentLeaf: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
  },
};

/* --- Helpers ------------------------------------------------------------- */

function detectSlicerPath() {
  if (process.env.SLICER_PATH) return process.env.SLICER_PATH;
  if (process.env.BAMBU_STUDIO_PATH) return process.env.BAMBU_STUDIO_PATH;
  return "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
}

function runCli(slicerPath, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(slicerPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    proc.on("error", (err) => {
      resolve({ code: -1, signal: null, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

async function assertPrintable3MF(outputPath) {
  const buf = await fs.readFile(outputPath);
  const zip = await JSZip.loadAsync(buf);
  const gcodeEntry = Object.keys(zip.files).find((n) =>
    /^Metadata\/plate_\d+\.gcode$/.test(n)
  );
  if (!gcodeEntry) {
    const entries = Object.keys(zip.files).join(", ");
    throw new Error(
      `Output 3MF does not contain Metadata/plate_<n>.gcode. Entries: ${entries}`
    );
  }
  const gcode = await zip.files[gcodeEntry].async("uint8array");
  if (gcode.byteLength < 1024) {
    throw new Error(
      `Output gcode is suspiciously small (${gcode.byteLength} bytes). Slicer likely produced an empty file.`
    );
  }
  return { entry: gcodeEntry, sizeBytes: gcode.byteLength };
}

/* --- Main ---------------------------------------------------------------- */

async function main() {
  const args = parseArgs();
  const defaults = MODEL_DEFAULTS[args.model];
  if (!defaults) {
    console.error(
      `Unknown model "${args.model}". Supported: ${Object.keys(MODEL_DEFAULTS).join(", ")}`
    );
    process.exit(2);
  }

  const stlPath = args.stl ?? path.join(REPO_ROOT, "test", "sample_cube.stl");
  await fs.access(stlPath).catch(() => {
    throw new Error(`STL fixture not found: ${stlPath}`);
  });

  const slicerPath = detectSlicerPath();
  await fs.access(slicerPath).catch(() => {
    throw new Error(`BambuStudio CLI not found at ${slicerPath}. Set SLICER_PATH.`);
  });

  const profilesRoot = detectProfilesRoot(slicerPath);
  console.log(`[smoke] model=${args.model} slicer=${slicerPath}`);
  console.log(`[smoke] profilesRoot=${profilesRoot}`);

  // 1. Flatten.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-flat-"));
  console.log(`[smoke] flattening to ${tempDir}`);
  const flat = await flattenForCli({
    machineLeaf: defaults.machineLeaf,
    processLeaf: defaults.processLeaf,
    filamentLeaves: [args.filament ?? defaults.filamentLeaf],
    profilesRoot,
    tempDir,
  });
  console.log(`[smoke] flattened: machine=${path.basename(flat.machinePath)}`);
  console.log(`[smoke]            process=${path.basename(flat.processPath)}`);
  console.log(`[smoke]            filament=${flat.filamentPaths.map((p) => path.basename(p)).join(", ")}`);
  console.log(`[smoke]            cliOverlayApplied=${flat.meta.cliOverlayApplied}`);

  // 2. Invoke CLI.
  const outputPath = path.join(tempDir, "output.gcode.3mf");
  const cliArgs = [
    "--orient", "1",
    "--arrange", "1",
    "--load-settings", `${flat.machinePath};${flat.processPath}`,
    "--load-filaments", flat.filamentPaths.join(";"),
    "--slice", "0",
    "--debug", "2",
    "--export-3mf", outputPath,
    stlPath,
  ];
  console.log(`[smoke] invoking BambuStudio CLI...`);
  const t0 = Date.now();
  const result = await runCli(slicerPath, cliArgs, tempDir);
  const dt = Date.now() - t0;
  console.log(`[smoke] CLI exited code=${result.code} signal=${result.signal} dt=${dt}ms`);

  if (result.code !== 0) {
    console.error("[smoke] FAIL: CLI did not exit cleanly");
    console.error("--- stderr (last 2000 chars) ---");
    console.error(result.stderr.slice(-2000));
    console.error("--- stdout (last 2000 chars) ---");
    console.error(result.stdout.slice(-2000));
    if (!args.keepTemp) await fs.rm(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  // 3. Validate the output.
  try {
    await fs.access(outputPath);
  } catch {
    console.error(`[smoke] FAIL: CLI exited 0 but no output at ${outputPath}`);
    if (!args.keepTemp) await fs.rm(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  const verdict = await assertPrintable3MF(outputPath);
  console.log(`[smoke] OK: ${verdict.entry} present, ${verdict.sizeBytes} bytes of gcode`);

  if (args.keepTemp) {
    console.log(`[smoke] artifacts kept at ${tempDir}`);
  } else {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log("[smoke] PASS");
}

main().catch((err) => {
  console.error(`[smoke] FAIL: ${err.message}`);
  process.exit(1);
});
