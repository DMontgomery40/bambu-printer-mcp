import {trackedMkdtempSync} from './support/temp.mjs';
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
  const fixture = trackedMkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json", "manifest.json", "dist", "src", "patches", "native", "LICENSE", "README.md"]) {
    fs.cpSync(path.join(ROOT, name), path.join(fixture, name), { recursive: true });
  }
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts/install-patches.mjs"), path.join(fixture, "scripts/install-patches.mjs"));
  fs.copyFileSync(path.join(ROOT, "scripts/build-bambu-native.sh"), path.join(fixture, "scripts/build-bambu-native.sh"));
  fs.copyFileSync(path.join(ROOT, "scripts/setup-bambu-native.mjs"), path.join(fixture, "scripts/setup-bambu-native.mjs"));
  for (const name of ["native/local-secret.txt", "bambu certs/embedded-key.pem", "bambu-mcp-config.json", "temp/private-model.stl", ".env.production", "unrelated.txt", "node_modules/typescript/developer-marker"]) {
    const destination = path.join(fixture, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "PRIVATE_PACKAGING_SENTINEL");
  }
  fs.writeFileSync(path.join(fixture, "CONTRIBUTORS.md"), "Packaging test contributor\n");
  const beforePackage = fs.readFileSync(path.join(fixture, "package.json"), "utf8");
  const beforeLock = fs.readFileSync(path.join(fixture, "package-lock.json"), "utf8");
  const outputPath = path.join(fixture, "test.mcpb");
  // Release CI runs this same test against the Linux-built asset on other hosts.
  if (process.env.MCPB_TEST_ARCHIVE) fs.copyFileSync(process.env.MCPB_TEST_ARCHIVE, outputPath);
  else packageMcpb({ root: fixture, outputPath, quiet: true });

  const archive = await JSZip.loadAsync(fs.readFileSync(outputPath));
  // A single release asset must also start on hosts other than the packaging runner.
  const lock = JSON.parse(beforeLock);
  for (const target of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64", "linuxmusl-arm64", "linuxmusl-x64"]) {
    const name = `@img/sharp-${target}`;
    const metadata = archive.file(`node_modules/${name}/package.json`);
    assert.ok(metadata, `missing native camera runtime for ${target}`);
    const pkg = JSON.parse(await metadata.async("string"));
    assert.equal(pkg.version, lock.packages[`node_modules/${name}`].version);
    assert.ok(archive.file(`node_modules/${name}/${pkg.exports["./sharp.node"].replace(/^\.\//, "")}`));
    assert.ok(Object.keys(archive.files).some(file => file.startsWith(`node_modules/${name}/`) && file.endsWith(".node")), `missing native binary for ${target}`);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      const dependencyMetadata = archive.file(`node_modules/${dependency}/package.json`);
      assert.ok(dependencyMetadata, `missing ${target} shared library`);
      const library = JSON.parse(await dependencyMetadata.async("string"));
      assert.equal(library.version, lock.packages[`node_modules/${dependency}`].version);
      assert.ok(archive.file(`node_modules/${dependency}/${library.exports["./binary"].replace(/^\.\//, "")}`));
    }
  }
  for (const name of ["manifest.json", "package.json", "dist/index.js", "src/index.ts", "patches/bambu-node+3.22.21.patch", "scripts/install-patches.mjs", "scripts/build-bambu-native.sh", "scripts/setup-bambu-native.mjs", "native/bambu-native-print.cpp", "LICENSE", "README.md", "CONTRIBUTORS.md", "node_modules/mqtt/LICENSE.md", "node_modules/bambu-node/LICENSE", "node_modules/three/LICENSE", "node_modules/basic-ftp/LICENSE.txt"]) {
    assert.ok(archive.file(name), `missing release file: ${name}`);
  }
  for (const name of Object.keys(archive.files)) {
    assert.doesNotMatch(name, /studio-control|launch-bambu|call-bambu|cgevent|LOCAL-X2D|local-x2d/);
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
  const imageSize = execFileSync(process.execPath, ["--input-type=commonjs", "-e", `
    const sharp = require('sharp');
    sharp({create: {width: 32, height: 18, channels: 3, background: '#245678'}})
      .jpeg().toBuffer().then(bytes => sharp(bytes).metadata())
      .then(info => process.stdout.write(JSON.stringify([info.width, info.height])))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `], {cwd: installed, encoding: "utf8", timeout: 15000});
  assert.deepEqual(JSON.parse(imageSize), [32, 18], "the extracted native camera runtime must encode and decode");
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
    const self = await client.callTool({ name: "counterpart_self_check", arguments: {} });
    assert.notEqual(self.isError, true, JSON.stringify(self));
    assert.equal(self.structuredContent?.ok, true, JSON.stringify(self.structuredContent));
    assert.equal(fs.existsSync(path.join(launchDirectory, "temp")), false, "extension startup must not create a cwd-relative temp directory");
  } finally {
    await client.close();
  }
});

test("npm version updates the extension manifest without requiring a Git checkout", (t) => {
  const fixture = trackedMkdtempSync(path.join(os.tmpdir(), "bambu-mcpb-version-"));
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
