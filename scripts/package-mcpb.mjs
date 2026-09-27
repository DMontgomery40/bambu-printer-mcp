#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCPB_VERSION = "2.1.2";

function copyReleaseInput(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Release inputs must not be symbolic links: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyReleaseInput(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode & 0o777);
  } else {
    throw new Error(`Unsupported release input: ${source}`);
  }
}

function runNpm(args, cwd) {
  // Invoking npm's JavaScript entry point avoids shell quoting and npm.cmd on Windows.
  const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"
  ));
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message || result.signal || result.status}\n${(result.stderr || result.stdout || "").slice(-12000)}`);
  }
}

export function packageMcpb({ root = ROOT, outputPath = path.join(root, "bambu-printer-mcp.mcpb"), quiet = false } = {}) {
  root = path.resolve(root);
  outputPath = path.resolve(outputPath);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.version !== packageJson.version) {
    throw new Error("manifest.json version must match package.json; run npm version or scripts/sync-manifest-version.mjs first.");
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-package-"));
  try {
    // Never pack the working tree: .gitignore is not read by mcpb, and local
    // printer credentials, certificates, and models can live beside the source.
    for (const name of ["package.json", "package-lock.json", "manifest.json", "dist", "src", "patches", "LICENSE", "README.md"]) {
      copyReleaseInput(path.join(root, name), path.join(staging, name));
    }
    for (const name of ["CONTRIBUTORS", "CONTRIBUTORS.md"]) {
      if (fs.existsSync(path.join(root, name))) copyReleaseInput(path.join(root, name), path.join(staging, name));
    }
    if (!quiet) console.log("Installing production dependencies in an isolated extension directory...");
    // The normal postinstall applies patches; developer node_modules is untouched.
    runNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"], staging);
    const cli = ["exec", "--yes", `--package=@anthropic-ai/mcpb@${MCPB_VERSION}`, "--", "mcpb"];
    runNpm([...cli, "validate", "manifest.json"], staging);
    runNpm([...cli, "pack", ".", outputPath], staging);
    if (!quiet) console.log(`Created ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
    return { outputPath, version: manifest.version };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    packageMcpb();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
