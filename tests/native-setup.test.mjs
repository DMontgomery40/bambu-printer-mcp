import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import JSZip from "jszip";
import {
  PINNED, agentVersion, buildHelper, checkUpdate, extractPlugin, install, printParamsLayout, readLimited, verify,
} from "../scripts/setup-bambu-native.mjs";
import {
  BAMBU_NATIVE_CERTIFICATES, BAMBU_NATIVE_PINNED_PLUGIN, BAMBU_NATIVE_PLUGIN_LIBRARIES, bambuNativeHomeDir, bambuNativeHomeDir as nativeHomeDir, bambuNativeSetupCommand,
  isBambuNativePlatform, sha256Hex as sha256,
} from "../dist/bambu-native.js";

// No test here contacts Bambu, GitHub or a printer: downloads are served from
// memory and the plug-in is a placeholder byte string.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELPER_SOURCE = fs.readFileSync(path.join(ROOT, "native/bambu-native-print.cpp"), "utf8");
const canCompile = process.platform === "linux" && spawnSync(process.env.CXX || "c++", ["--version"]).status === 0;

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const PINNED_MEMBERS = { "libbambu_networking.so": sha256(Buffer.from("PLUGIN")), "libBambuSource.so": sha256(Buffer.from("SOURCE")) };

async function fixture({ members = { "libbambu_networking.so": "PLUGIN", "libBambuSource.so": "SOURCE", "liblive555.so": "UNUSED" } } = {}) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(members)) zip.file(name, content);
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const certificates = { "slicer_base64.cer": Buffer.from("SLICER CERT"), "printer.cer": Buffer.from("PRINTER CERT") };
  const pinned = {
    studioTag: "v99.00.00.01",
    plugin: { version: "99.00.00.02", url: "https://downloads.invalid/plugin.zip", sha256: sha256(archive), members: { ...PINNED_MEMBERS } },
    certificates: Object.fromEntries(Object.entries(certificates).map(([name, value]) => [name, sha256(value)])),
  };
  const requests = [];
  const fetchBytes = async url => {
    requests.push(url);
    if (url === pinned.plugin.url) return archive;
    const certificate = Object.keys(certificates).find(name => url.endsWith(`/v99.00.00.01/resources/cert/${name}`));
    if (certificate) return certificates[certificate];
    throw new Error(`unexpected download ${url}`);
  };
  const builds = [];
  const build = output => { builds.push(output); fs.writeFileSync(output, "#!/bin/sh\n", { mode: 0o755 }); };
  const checks = [];
  const check = paths => { checks.push(paths.plugin); };
  return { pinned, fetchBytes, requests, build, builds, check, checks, archive };
}

const quiet = () => {};
const mode = file => fs.statSync(file).mode & 0o777;

test("pinned plug-in, certificates and studio tag are internally consistent", () => {
  assert.match(PINNED.plugin.url, new RegExp(`/${PINNED.plugin.version.replaceAll(".", "\\.")}/[0-9a-f]+/linux_${PINNED.plugin.version.replaceAll(".", "\\.")}\\.zip$`));
  assert.deepEqual(Object.keys(PINNED.plugin.members), [...BAMBU_NATIVE_PLUGIN_LIBRARIES], "setup installs the libraries the server requires");
  assert.equal(PINNED.plugin.members, BAMBU_NATIVE_PINNED_PLUGIN.sha256, "setup and server share one set of pinned checksums");
  assert.equal(PINNED.plugin.version, BAMBU_NATIVE_PINNED_PLUGIN.version);
  for (const digest of [PINNED.plugin.sha256, ...Object.values(PINNED.plugin.members), ...Object.values(PINNED.certificates)]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(Object.keys(PINNED.certificates).sort(), [...BAMBU_NATIVE_CERTIFICATES].sort(), "setup installs what the server requires");
  assert.match(PINNED.studioTag, /^v\d{2}\.\d{2}\.\d{2}\.\d{2}$/);
});

test("install verifies downloads, writes a private layout and a receipt", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
  const f = await fixture();
  const result = await install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" });
  assert.equal(fs.readFileSync(result.plugin, "utf8"), "PLUGIN");
  assert.equal(fs.readFileSync(path.join(home, "plugins/libBambuSource.so"), "utf8"), "SOURCE", "the tunnel library sits beside the plug-in");
  assert.equal(fs.readFileSync(path.join(home, "cert/printer.cer"), "utf8"), "PRINTER CERT");
  assert.equal(mode(home), 0o700);
  for (const directory of ["bin", "plugins", "cert", "config"]) assert.equal(mode(path.join(home, directory)), 0o700);
  for (const file of ["plugins/libbambu_networking.so", "cert/printer.cer", "cert/slicer_base64.cer", "install.json"]) {
    assert.equal(mode(path.join(home, file)), 0o600, file);
  }
  assert.deepEqual(f.builds, [path.join(home, "bin/bambu-native-print")]);
  assert.deepEqual(f.checks, [path.join(home, "plugins/libbambu_networking.so")], "the installed plug-in is load-checked");
  const receipt = JSON.parse(fs.readFileSync(path.join(home, "install.json"), "utf8"));
  assert.equal(receipt.pluginVersion, "99.00.00.02");
  assert.equal(receipt.helperSourceSha256, sha256(Buffer.from(HELPER_SOURCE)));
  assert.deepEqual(verify({ home, pinned: f.pinned, check: f.check }), { ok: true, home, pluginVersion: "99.00.00.02", problems: [] });
  assert.deepEqual(fs.readdirSync(path.join(home, "plugins")).sort(), ["libBambuSource.so", "libbambu_networking.so"],
    "only pinned libraries are extracted and no temporary files remain");
});

test("a rerun keeps verified downloads, rebuilds the helper and repairs tampered files", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
  const f = await fixture();
  const options = { home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" };
  await install(options);
  const firstDownloads = f.requests.length;
  await install(options);
  assert.equal(f.requests.length, firstDownloads, "verified files are not downloaded again");
  assert.equal(f.builds.length, 2, "the helper always matches the installed package source");

  fs.writeFileSync(path.join(home, "plugins/libbambu_networking.so"), "TAMPERED");
  fs.rmSync(path.join(home, "cert/printer.cer"));
  const report = verify({ home, pinned: f.pinned, check: f.check });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /libbambu_networking\.so/.test(problem)));
  assert.ok(report.problems.some(problem => /printer\.cer/.test(problem)));
  await install(options);
  assert.equal(verify({ home, pinned: f.pinned, check: f.check }).ok, true);
  assert.equal(f.requests.length, firstDownloads + 2, "only the damaged plug-in and certificate are fetched");
});

for (const [label, mutate, message] of [
  ["archive checksum", pinned => { pinned.plugin.sha256 = "0".repeat(64); }, /Plug-in archive checksum mismatch/],
  ["plug-in checksum", pinned => { pinned.plugin.members["libbambu_networking.so"] = "0".repeat(64); }, /libbambu_networking\.so checksum mismatch/],
  ["tunnel library checksum", pinned => { pinned.plugin.members["libBambuSource.so"] = "0".repeat(64); }, /libBambuSource\.so checksum mismatch/],
  ["certificate checksum", pinned => { pinned.certificates["printer.cer"] = "0".repeat(64); }, /printer\.cer checksum mismatch/],
]) {
  test(`a ${label} mismatch installs and builds nothing`, async t => {
    const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
    const f = await fixture();
    mutate(f.pinned);
    await assert.rejects(install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" }), message);
    assert.deepEqual(f.builds, []);
    assert.deepEqual(fs.readdirSync(path.join(home, "plugins")), []);
    assert.deepEqual(fs.readdirSync(path.join(home, "cert")), []);
    assert.equal(fs.existsSync(path.join(home, "install.json")), false);
  });
}

for (const [label, members] of [
  ["missing plug-in", { "libBambuSource.so": "SOURCE" }],
  ["nested plug-in path", { "plugins/libbambu_networking.so": "PLUGIN", "libBambuSource.so": "SOURCE" }],
  ["path traversal", { "../libbambu_networking.so": "PLUGIN", "libBambuSource.so": "SOURCE" }],
]) {
  test(`extraction rejects an archive with a ${label}`, async () => {
    const f = await fixture({ members });
    await assert.rejects(extractPlugin(f.archive, PINNED_MEMBERS), /exactly one top-level libbambu_networking\.so/);
  });
}

for (const [platform, arch, message] of [["darwin", "arm64", /This setup is for Linux/], ["win32", "x64", /This setup is for Linux/], ["linux", "arm64", /only published for x86-64/]]) {
  test(`setup refuses ${platform}/${arch} before creating files or downloading`, async t => {
    const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
    const f = await fixture();
    await assert.rejects(install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform, arch }), message);
    assert.equal(fs.existsSync(home), false);
    assert.deepEqual(f.requests, []);
  });
}

test("verify flags a helper built from a different package source", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
  const f = await fixture();
  await install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" });
  const receiptPath = path.join(home, "install.json");
  fs.writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(receiptPath, "utf8")), helperSourceSha256: "old" }));
  assert.deepEqual(verify({ home, pinned: f.pinned, check: f.check }).problems, ["the helper was built from a different package version; rerun setup"]);
});

test("PrintParams layout ignores comments and defaults but detects layout changes", () => {
  const helper = printParamsLayout(HELPER_SOURCE);
  assert.equal(helper.length, 46);
  assert.equal(helper[0], "std::string dev_id");
  assert.ok(helper.includes("int extruder_cali_manual_mode"));
  const header = `struct PrintParams {\n    /* identity */\n    std::string dev_id; // device\n    int auto_bed_leveling{ 0 };\n    bool task_use_ams = true;\n};`;
  assert.deepEqual(printParamsLayout(header), ["std::string dev_id", "int auto_bed_leveling", "bool task_use_ams"]);
  const variants = [
    header.replace("bool task_use_ams", "int task_use_ams"),
    header.replace("    int auto_bed_leveling{ 0 };\n", "    int auto_bed_leveling{ 0 };\n    int added_field;\n"),
    header.replace("    std::string dev_id; // device\n    int auto_bed_leveling{ 0 };\n", "    int auto_bed_leveling{ 0 };\n    std::string dev_id;\n"),
  ];
  for (const variant of variants) assert.notDeepEqual(printParamsLayout(variant), printParamsLayout(header));
  assert.throws(() => printParamsLayout("struct Other {};"), /PrintParams not found/);
  assert.equal(agentVersion('#define BAMBU_NETWORK_AGENT_VERSION         "02.08.02.54"'), "02.08.02.54");
});

function updateFetcher({ tag, offered, header }) {
  return async (url, headers = {}) => {
    if (url.startsWith("https://api.github.com/")) return Buffer.from(JSON.stringify({ tag_name: tag }));
    if (url.startsWith("https://api.bambulab.com/")) {
      assert.equal(headers["X-BBL-OS-Type"], "linux");
      assert.match(url, new RegExp(`cloud=${tag.slice(1, 9).replaceAll(".", "\\.")}\\.00$`));
      return Buffer.from(JSON.stringify({ resources: [{ type: "slicer/plugins/cloud", version: offered, url: "https://downloads.invalid/new.zip" }] }));
    }
    if (url.endsWith(`/${tag}/src/slic3r/Utils/bambu_networking.hpp`)) return Buffer.from(header);
    throw new Error(`unexpected request ${url}`);
  };
}

test("update check reports an unchanged pinned release as current", async () => {
  const header = `#define BAMBU_NETWORK_AGENT_VERSION "${PINNED.plugin.version}"\nnamespace BBL {\n${/struct PrintParams[\s\S]*?\n\};/.exec(HELPER_SOURCE)[0]}\n}`;
  const report = await checkUpdate({ fetchBytes: updateFetcher({ tag: PINNED.studioTag, offered: PINNED.plugin.version, header }) });
  assert.equal(report.upToDate, true);
  assert.equal(report.headerMatchesOffered, true);
  assert.equal(report.printParamsLayoutMatches, true);
  assert.deepEqual(report.layoutDifferences, { helperOnly: [], releaseOnly: [] });
});

test("update check flags a newer plug-in whose PrintParams layout changed", async () => {
  const struct = /struct PrintParams[\s\S]*?\n\};/.exec(HELPER_SOURCE)[0].replace("std::string dev_id;", "std::string dev_id;\n    int new_field;");
  const report = await checkUpdate({ fetchBytes: updateFetcher({ tag: "v02.09.00.10", offered: "02.09.00.03", header: `#define BAMBU_NETWORK_AGENT_VERSION "02.09.00.03"\n${struct}` }) });
  assert.equal(report.upToDate, false);
  assert.equal(report.latest.plugin, "02.09.00.03");
  assert.equal(report.printParamsLayoutMatches, false);
  assert.deepEqual(report.layoutDifferences, { helperOnly: [], releaseOnly: ["int new_field"] });
});

test("the Linux native home directory follows BAMBU_NATIVE_HOME, XDG_CONFIG_HOME and HOME", () => {
  // The compiled-helper test below checks the C++ side against these same values.
  assert.equal(bambuNativeHomeDir({ HOME: "/home/a" }), "/home/a/.config/bambu-printer-mcp/bambu-native");
  assert.equal(bambuNativeHomeDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }), "/xdg/bambu-printer-mcp/bambu-native");
  assert.equal(bambuNativeHomeDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg", BAMBU_NATIVE_HOME: "/custom/native" }), "/custom/native");
  assert.equal(bambuNativeHomeDir({ HOME: "/home/a", XDG_CONFIG_HOME: "", BAMBU_NATIVE_HOME: "" }),
    "/home/a/.config/bambu-printer-mcp/bambu-native", "empty values count as unset, as in the helper");
  assert.equal(isBambuNativePlatform("linux", "x64"), true);
  assert.equal(isBambuNativePlatform("linux", "arm64"), false, "Bambu publishes no arm64 Linux plug-in");
  assert.equal(isBambuNativePlatform("darwin", "arm64"), true);
  assert.equal(isBambuNativePlatform("win32", "x64"), false);
});

test("compiled Linux helper resolves plug-in, certificate and config defaults", { skip: !canCompile && "requires Linux and a C++ compiler" }, async t => {
  const directory = tempDir(t, "bambu-native-paths-");
  const driver = path.join(directory, "driver.cpp");
  const executable = path.join(directory, "paths");
  fs.writeFileSync(driver, `
#define main unused_native_main
#include ${JSON.stringify(path.join(ROOT, "native/bambu-native-print.cpp"))}
#undef main
int main() { std::cout << defaultPluginPath() << "\\n" << defaultConfigDir() << "\\n" << defaultCertDir() << std::endl; }
`);
  const compiled = spawnSync(process.env.CXX || "c++", ["-std=c++17", driver, "-o", executable, "-ldl", "-pthread"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = env => spawnSync(executable, [], { encoding: "utf8", env }).stdout.trim().split("\n");
  const expected = home => [path.join(home, "plugins/libbambu_networking.so"), path.join(home, "config"), path.join(home, "cert")];
  const home = path.join(directory, "home");
  // Only the pinned plug-in is ever a default, even when Bambu Studio has its own copy.
  const studioPlugin = path.join(home, ".config/BambuStudio/plugins/libbambu_networking.so");
  fs.mkdirSync(path.dirname(studioPlugin), { recursive: true });
  fs.writeFileSync(studioPlugin, "UNPINNED");
  assert.deepEqual(run({ HOME: home }), expected(nativeHomeDir({ HOME: home })));
  const custom = path.join(directory, "custom");
  assert.deepEqual(run({ HOME: home, BAMBU_NATIVE_HOME: custom }), expected(custom));
  const xdg = path.join(directory, "xdg");
  assert.deepEqual(run({ HOME: home, XDG_CONFIG_HOME: xdg }), expected(nativeHomeDir({ HOME: home, XDG_CONFIG_HOME: xdg })));
  assert.deepEqual(run({ HOME: home, BAMBU_NATIVE_HOME: "", XDG_CONFIG_HOME: "" }), expected(nativeHomeDir({ HOME: home })));
  // Without HOME, the helper uses the same passwd home as Node's os.homedir().
  assert.deepEqual(run({}), expected(nativeHomeDir({ HOME: os.homedir() })));
  assert.deepEqual(run({ HOME: home, BAMBU_NATIVE_CONFIG_DIR: "/explicit/config", BAMBU_NATIVE_CERT_DIR: "/explicit/cert" }).slice(1), ["/explicit/config", "/explicit/cert"]);
});

test("build script produces a working helper and leaves nothing behind on failure", { skip: !canCompile && "requires Linux and a C++ compiler" }, async t => {
  const directory = tempDir(t, "bambu-native-build-");
  const output = path.join(directory, "nested/bin/bambu-native-print");
  buildHelper(output);
  assert.notEqual(fs.statSync(output).mode & 0o111, 0);
  const usage = spawnSync(output, [], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: bambu-native-print --check-plugin\|--probe/);

  const failed = path.join(directory, "failed/bambu-native-print");
  const result = spawnSync("/bin/sh", [path.join(ROOT, "scripts/build-bambu-native.sh"), "--output", failed], {
    encoding: "utf8", env: { ...process.env, CXX: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(failed)), [], "a failed compile leaves no partial helper");
  const badArgument = spawnSync("/bin/sh", [path.join(ROOT, "scripts/build-bambu-native.sh"), "--output"], { encoding: "utf8" });
  assert.equal(badArgument.status, 2);
});

test("setup CLI verify reports a missing installation without network access", async t => {
  const home = path.join(tempDir(t, "bambu-native-cli-"), "missing");
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/setup-bambu-native.mjs"), "--verify", "--home", home], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  const usage = spawnSync(process.execPath, [path.join(ROOT, "scripts/setup-bambu-native.mjs"), "--verify", "--check-update"], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: bambu-printer-mcp-native-setup/);
});

test("downloads are capped while streaming, with or without a length header", async () => {
  const stream = (chunks, headers = {}) => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { headers });
  assert.deepEqual(await readLimited(stream([Buffer.from("ab"), Buffer.from("cd")]), 4, "u"), Buffer.from("abcd"));
  await assert.rejects(readLimited(stream([Buffer.alloc(3), Buffer.alloc(3)]), 4, "u"), /exceeded 4 bytes/);
  await assert.rejects(readLimited(stream([Buffer.alloc(1)], { "content-length": "99" }), 4, "u"), /too large \(99 bytes\)/);
});

test("the server refuses a managed helper built from another package version", { skip: process.platform === "win32" && "POSIX helper" }, async t => {
  const directory = tempDir(t, "bambu-native-stale-");
  const f = await fixture();
  const home = path.join(directory, "home");
  await install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" });
  // Run in a child so the mocked platform stays isolated from this process.
  const probe = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    const native = await import(${JSON.stringify(new URL("../dist/bambu-native.js", import.meta.url).href)});
    let error = "";
    try { native.assertBambuNativeAvailable(); } catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ controls: native.bambuNativeControlsAvailable(), error }));
  `], { encoding: "utf8", env: { ...process.env, BAMBU_NATIVE_HOME: home, BAMBU_NATIVE_HELPER: "", BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN: "1",
    BAMBU_NATIVE_PLUGIN: "", BAMBU_NATIVE_CERT_DIR: "", BAMBU_NATIVE_CONFIG_DIR: "" } });
  const current = JSON.parse(probe().stdout);
  assert.deepEqual(current, { controls: true, error: "" });
  const receiptPath = path.join(home, "install.json");
  fs.writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(receiptPath, "utf8")), helperSourceSha256: "old" }));
  const stale = JSON.parse(probe().stdout);
  assert.equal(stale.controls, false, "a stale helper must not take over stop or pause");
  assert.match(stale.error, /built from a different bambu-printer-mcp version/);
});

test("extraction requires the tunnel library beside the plug-in", async () => {
  const f = await fixture({ members: { "libbambu_networking.so": "PLUGIN" } });
  await assert.rejects(extractPlugin(f.archive, PINNED_MEMBERS), /exactly one top-level libBambuSource\.so/);
});

test("a plug-in that cannot load leaves no receipt, so the server keeps MQTT controls", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
  const f = await fixture();
  const options = { home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, log: quiet, platform: "linux", arch: "x64" };
  await install({ ...options, check: f.check });
  assert.ok(fs.existsSync(path.join(home, "install.json")));
  const failing = () => { throw new Error("The installed Bambu plug-in cannot be loaded on this host: libssl.so.1.1 missing"); };
  await assert.rejects(install({ ...options, check: failing }), /cannot be loaded on this host/);
  assert.equal(fs.existsSync(path.join(home, "install.json")), false, "a previous receipt is withdrawn");
  const report = verify({ home, pinned: f.pinned, check: failing });
  assert.equal(report.ok, false);
});

test("setup never changes the permissions of an existing home directory", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "shared");
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const f = await fixture();
  await install({ home, pinned: f.pinned, fetchBytes: f.fetchBytes, build: f.build, check: f.check, log: quiet, platform: "linux", arch: "x64" });
  assert.equal(mode(home), 0o755);
  for (const directory of ["bin", "plugins", "cert", "config"]) assert.equal(mode(path.join(home, directory)), 0o700);
});

test("the setup hint names the server's own package version", () => {
  assert.equal(bambuNativeSetupCommand("1.2.3", { HOME: "/h" }), "npx -y -p bambu-printer-mcp@1.2.3 bambu-printer-mcp-native-setup");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.equal(bambuNativeSetupCommand(undefined, { HOME: "/h" }), `npx -y -p bambu-printer-mcp@${version} bambu-printer-mcp-native-setup`);
  // A server with its own install directory names it, so the hint installs where the server looks.
  assert.equal(bambuNativeSetupCommand("1.2.3", { HOME: "/h", BAMBU_NATIVE_HOME: "/srv/bambu native" }),
    'npx -y -p bambu-printer-mcp@1.2.3 bambu-printer-mcp-native-setup --home "/srv/bambu native"');
  assert.match(bambuNativeSetupCommand("1.2.3", { HOME: "/h", XDG_CONFIG_HOME: "/xdg" }), /--home "\/xdg\/bambu-printer-mcp\/bambu-native"$/);
});

test("compiled helper's offline plug-in check reports an unloadable plug-in", { skip: !canCompile && "requires Linux and a C++ compiler" }, async t => {
  const directory = tempDir(t, "bambu-native-check-");
  const helper = path.join(directory, "bambu-native-print");
  buildHelper(helper);
  const missing = spawnSync(helper, ["--check-plugin"], { encoding: "utf8", env: { HOME: directory, BAMBU_NATIVE_PLUGIN: path.join(directory, "none.so") } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /could not load Bambu networking plug-in/);
  assert.doesNotMatch(missing.stdout, /plugin=ok/);
});

test("an interrupted reinstall withdraws the receipt before replacing files", async t => {
  const home = path.join(tempDir(t, "bambu-native-setup-"), "home");
  const f = await fixture();
  const options = { home, pinned: f.pinned, fetchBytes: f.fetchBytes, check: f.check, log: quiet, platform: "linux", arch: "x64" };
  await install({ ...options, build: f.build });
  assert.ok(fs.existsSync(path.join(home, "install.json")));
  // A newer pin whose certificate cannot be written: the old receipt must not
  // keep vouching for a half-replaced installation.
  const newer = structuredClone(f.pinned);
  newer.certificates["printer.cer"] = sha256(Buffer.from("NEW PRINTER CERT"));
  const fetchNewer = async url => url.endsWith("/printer.cer") ? Buffer.from("NEW PRINTER CERT") : f.fetchBytes(url);
  fs.rmSync(path.join(home, "cert/printer.cer"));
  fs.mkdirSync(path.join(home, "cert/printer.cer"));
  await assert.rejects(install({ ...options, pinned: newer, fetchBytes: fetchNewer, build: f.build }));
  assert.equal(fs.existsSync(path.join(home, "install.json")), false);
});

test("setup CLI does not take another option as the --home directory", async t => {
  const cwd = tempDir(t, "bambu-native-cli-");
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/setup-bambu-native.mjs"), "--home", "--verify"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: bambu-printer-mcp-native-setup/);
  assert.deepEqual(fs.readdirSync(cwd), [], "no directory named after the option is created");
});
