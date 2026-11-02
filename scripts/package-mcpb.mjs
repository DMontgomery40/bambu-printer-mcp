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

function installCameraRuntimes(staging) {
  // The one downloadable MCPB is built on Linux and installed without npm on Macs
  // and Windows PCs. Ordinary npm ci only includes the build host's Sharp binaries.
  const targets = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64", "linuxmusl-arm64", "linuxmusl-x64"];
  const lock = JSON.parse(fs.readFileSync(path.join(staging, "package-lock.json"), "utf8"));
  const sharp = lock.packages["node_modules/sharp"];
  const dependencies = {}, packages = {};
  function include(name) {
    if (dependencies[name]) return;
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry?.integrity || !entry.resolved || sharp.optionalDependencies[name] !== entry.version) {
      throw new Error(`Missing locked Sharp runtime: ${name}`);
    }
    dependencies[name] = entry.version;
    // Required here so npm cannot silently omit a foreign-platform optional binary.
    packages[`node_modules/${name}`] = {...entry, optional: false};
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) include(dependency);
  }
  for (const target of targets) include(`@img/sharp-${target}`);
  const manifest = {name: "bambu-camera-runtimes", version: "1.0.0", private: true, dependencies};
  const native = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-native-"));
  try {
    fs.writeFileSync(path.join(native, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(native, "package-lock.json"), JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {"": manifest, ...packages},
    }));
    // --force permits foreign OS/CPU packages only in this isolated payload install.
    // Lockfile integrities still apply; no lifecycle scripts or version resolution run.
    runNpm(["ci", "--force", "--ignore-scripts", "--no-audit", "--no-fund"], native);
    for (const [name, version] of Object.entries(dependencies)) {
      const source = path.join(native, "node_modules", name);
      const installed = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
      if (installed.name !== name || installed.version !== version) throw new Error(`Wrong camera runtime: ${name}`);
      copyReleaseInput(source, path.join(staging, "node_modules", name));
    }
  } finally { fs.rmSync(native, {recursive: true, force: true}); }
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
    fs.mkdirSync(path.join(staging, "scripts"));
    copyReleaseInput(path.join(root, "scripts/install-patches.mjs"), path.join(staging, "scripts/install-patches.mjs"));
    fs.mkdirSync(path.join(staging, "native"));
    copyReleaseInput(path.join(root, "native/bambu-native-print.cpp"), path.join(staging, "native/bambu-native-print.cpp"));
    copyReleaseInput(path.join(root, "scripts/build-bambu-native.sh"), path.join(staging, "scripts/build-bambu-native.sh"));
    copyReleaseInput(path.join(root, "scripts/setup-bambu-native.mjs"), path.join(staging, "scripts/setup-bambu-native.mjs"));
    for (const name of ["CONTRIBUTORS", "CONTRIBUTORS.md"]) {
      if (fs.existsSync(path.join(root, name))) copyReleaseInput(path.join(root, name), path.join(staging, name));
    }
    if (!quiet) console.log("Installing production dependencies in an isolated extension directory...");
    // The normal postinstall applies patches; developer node_modules is untouched.
    runNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"], staging);
    installCameraRuntimes(staging);
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
