#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "3.22.21";

try {
  // npm can hoist this dependency beside our installed package. Resolve from
  // this script, never from the caller's cwd or a guessed node_modules path.
  const dependencyRoot = fs.realpathSync(path.dirname(require.resolve("bambu-node/package.json")));
  const dependency = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "package.json"), "utf8"));
  if (dependency.name !== "bambu-node" || dependency.version !== version) {
    throw new Error(`Expected bambu-node@${version}; found ${dependency.name}@${dependency.version}.`);
  }

  const { parsePatchFile } = require("patch-package/dist/patch/parse.js");
  const { executeEffects } = require("patch-package/dist/patch/apply.js");
  const { reversePatch } = require("patch-package/dist/patch/reverse.js");
  const patchFile = path.join(packageRoot, "patches", `bambu-node+${version}.patch`);
  const targets = new Map([
    ["node_modules/bambu-node/dist/index.js", "dist/index.js"],
    ["node_modules/bambu-node/dist/index.d.ts", "dist/index.d.ts"],
  ]);
  const effects = parsePatchFile(fs.readFileSync(patchFile, "utf8")).map((effect) => {
    const relative = targets.get(effect.path);
    if (effect.type !== "patch" || !relative) {
      throw new Error("The bundled patch contains an unexpected operation or target.");
    }
    targets.delete(effect.path);
    const destination = path.join(dependencyRoot, relative);
    if (fs.realpathSync(destination) !== destination || !fs.statSync(destination).isFile()) {
      throw new Error(`Refusing to patch a symlink or non-file target: ${relative}`);
    }
    return { ...effect, path: relative };
  });
  if (targets.size !== 0) throw new Error("The bundled patch is missing required targets.");

  const options = { cwd: dependencyRoot, bestEffort: false };
  let alreadyApplied = false;
  try {
    executeEffects(reversePatch(effects), { ...options, dryRun: true });
    alreadyApplied = true;
  } catch {
    // A reverse dry run only succeeds if every required change is present.
  }
  if (!alreadyApplied) {
    try {
      // Validate every file before allowing any write. Never accept a partial
      // patch: the status parser and protocol changes are runtime requirements.
      executeEffects(effects, { ...options, dryRun: true });
      executeEffects(effects, { ...options, dryRun: false });
    } catch {
      throw new Error(`Unable to apply the required bambu-node@${version} patch. Reinstall dependencies from the release package.`);
    }
  }
  console.log(`bambu-node@${version} compatibility patch ${alreadyApplied ? "already applied" : "applied"}.`);
} catch (error) {
  console.error(`bambu-printer-mcp postinstall failed: ${error.message}`);
  process.exitCode = 1;
}
