#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = packageJson.version;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

// npm's version commit must contain the manifest alongside package and lockfile.
// --no-git-tag-version keeps this hook free of index changes, too.
if (process.env.npm_lifecycle_event === "version" && process.env.npm_config_git_tag_version !== "false") {
  let gitRoot;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // npm version also works outside a Git checkout.
  }
  if (gitRoot && fs.realpathSync(gitRoot) === fs.realpathSync(root)) {
    execFileSync("git", ["add", "--", "manifest.json"], { cwd: root, stdio: "inherit" });
  }
}
