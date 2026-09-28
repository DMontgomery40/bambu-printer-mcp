import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { packageMcpb } from "../scripts/package-mcpb.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCPB archive preserves runtime and licenses without local secrets or pruning developer dependencies", { timeout: 180_000 }, async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json", "manifest.json", "dist", "src", "patches", "native", "LICENSE", "README.md"]) {
    fs.cpSync(path.join(ROOT, name), path.join(fixture, name), { recursive: true });
  }
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts/install-patches.mjs"), path.join(fixture, "scripts/install-patches.mjs"));
  fs.copyFileSync(path.join(ROOT, "scripts/build-bambu-native.zsh"), path.join(fixture, "scripts/build-bambu-native.zsh"));
  for (const name of ["native/local-secret.txt", "bambu certs/embedded-key.pem", "bambu-mcp-config.json", "temp/private-model.stl", ".env.production", "unrelated.txt", "node_modules/typescript/developer-marker"]) {
    const destination = path.join(fixture, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "PRIVATE_PACKAGING_SENTINEL");
  }
  fs.writeFileSync(path.join(fixture, "CONTRIBUTORS.md"), "Packaging test contributor\n");
  const beforePackage = fs.readFileSync(path.join(fixture, "package.json"), "utf8");
  const beforeLock = fs.readFileSync(path.join(fixture, "package-lock.json"), "utf8");
  const outputPath = path.join(fixture, "test.mcpb");
  packageMcpb({ root: fixture, outputPath, quiet: true });

  const archive = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (const name of ["manifest.json", "package.json", "dist/index.js", "src/index.ts", "patches/bambu-node+3.22.21.patch", "scripts/install-patches.mjs", "scripts/build-bambu-native.zsh", "native/bambu-native-print.cpp", "LICENSE", "README.md", "CONTRIBUTORS.md", "node_modules/mqtt/LICENSE.md", "node_modules/bambu-node/LICENSE", "node_modules/three/LICENSE", "node_modules/basic-ftp/LICENSE.txt"]) {
    assert.ok(archive.file(name), `missing release file: ${name}`);
  }
  for (const name of Object.keys(archive.files)) {
    assert.doesNotMatch(name, /^(?:bambu certs\/|bambu-mcp-config\.json|temp\/|native\/(?!bambu-native-print\.cpp$)|\.env|unrelated\.txt|node_modules\/typescript\/)/);
  }
  assert.equal(fs.readFileSync(path.join(fixture, "node_modules/typescript/developer-marker"), "utf8"), "PRIVATE_PACKAGING_SENTINEL");
  assert.equal(fs.readFileSync(path.join(fixture, "package.json"), "utf8"), beforePackage);
  assert.equal(fs.readFileSync(path.join(fixture, "package-lock.json"), "utf8"), beforeLock);
  const manifest = JSON.parse(await archive.file("manifest.json").async("string"));
  assert.equal(manifest.version, JSON.parse(beforePackage).version);

  const installed = path.join(fixture, "installed-extension");
  for (const [name, entry] of Object.entries(archive.files)) {
    if (entry.dir) continue;
    const destination = path.join(installed, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, await entry.async("nodebuffer"));
  }
  const launchDirectory = path.join(fixture, "extension-host-cwd");
  fs.mkdirSync(launchDirectory);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installed, manifest.server.entry_point)],
    cwd: launchDirectory,
    env: {
      PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1",
      BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", TEMP_DIR: "",
      BAMBU_CLIENT_CERT: path.join(fixture, "no-client-cert"),
      BAMBU_CLIENT_KEY: path.join(fixture, "no-client-key"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcpb-package-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "bambu-printer-mcp");
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "print_3mf"));
    assert.equal(fs.existsSync(path.join(launchDirectory, "temp")), false, "extension startup must not create a cwd-relative temp directory");
  } finally {
    await client.close();
  }
});

test("npm version updates the extension manifest without requiring a Git checkout", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-version-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts/sync-manifest-version.mjs"), path.join(fixture, "scripts/sync-manifest-version.mjs"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
    name: "mcpb-version-test", version: "1.2.3", type: "module",
    scripts: { version: "node scripts/sync-manifest-version.mjs" },
  }));
  fs.writeFileSync(path.join(fixture, "manifest.json"), JSON.stringify({ version: "1.2.3" }));
  const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(path.dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));
  execFileSync(process.execPath, [npmCli, "version", "patch", "--no-git-tag-version"], { cwd: fixture, stdio: "pipe" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "package.json"))).version, "1.2.4");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "manifest.json"))).version, "1.2.4");
});
