#!/usr/bin/env node
// Install the optional X2D native transport on Linux: build the helper from
// this package's source and install Bambu's networking plug-in plus the slicer
// certificates under one private directory. Every download is pinned to an
// exact version and SHA-256. `--check-update` reports newer plug-ins and
// whether their PrintParams layout still matches the helper; it never installs
// an unpinned plug-in, because a layout change would corrupt print parameters.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
// The server owns the install layout; reuse it so setup and server cannot drift.
import {
  BAMBU_NATIVE_CERTIFICATES, BAMBU_NATIVE_PINNED_PLUGIN, BAMBU_NATIVE_PLUGIN_LIBRARIES, BAMBU_NATIVE_SOURCE, bambuNativeHomeDir,
  bambuNativeManagedPaths, sha256File, sha256Hex as sha256,
} from "../dist/bambu-native.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = path.join(PACKAGE_ROOT, "scripts/build-bambu-native.sh");
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

// Bambu Studio v02.08.02.61 declares network agent 02.08.02.54 with the same
// PrintParams layout as native/bambu-native-print.cpp. The server owns the
// version and library checksums; this adds where to download them from.
export const PINNED = Object.freeze({
  studioTag: "v02.08.02.61",
  plugin: Object.freeze({
    version: BAMBU_NATIVE_PINNED_PLUGIN.version,
    url: `https://public-cdn.bblmw.com/upgrade/studio/plugins/${BAMBU_NATIVE_PINNED_PLUGIN.version}/f1a94b8828/linux_${BAMBU_NATIVE_PINNED_PLUGIN.version}.zip`,
    sha256: "a7ea8ccec85ab5a7b8959a5697f7be957d58da82e67aad1cb0ad9b3cdf5baed6",
    // The networking plug-in opens the eMMC file tunnel through libBambuSource
    // in its own directory; without it uploads fail with -4.
    members: BAMBU_NATIVE_PINNED_PLUGIN.sha256,
  }),
  certificates: Object.freeze({
    "slicer_base64.cer": "f504dc1c37bc9741b7a95198914e67f3f6f1d917b1e45eaa14b9e84eb7b51ec8",
    "printer.cer": "36f2bcee347ec7adce719b5fd350099591a4d3d0ec4e039c7019890d78e152a0",
  }),
});

const certificateUrl = (tag, name) =>
  `https://raw.githubusercontent.com/bambulab/BambuStudio/${tag}/resources/cert/${name}`;
const networkingHeaderUrl = (tag) =>
  `https://raw.githubusercontent.com/bambulab/BambuStudio/${tag}/src/slic3r/Utils/bambu_networking.hpp`;


function managedPaths(home) {
  return bambuNativeManagedPaths({ ...process.env, BAMBU_NATIVE_HOME: home });
}

function assertSha256(buffer, expected, label) {
  const actual = sha256(buffer);
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}. Nothing was installed.`);
  }
}

/** Read a response body, aborting as soon as it exceeds the limit. */
export async function readLimited(response, limit, url) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`Download too large (${declared} bytes): ${url}`);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body ?? []) {
    received += chunk.length;
    if (received > limit) throw new Error(`Download exceeded ${limit} bytes: ${url}`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function defaultFetchBytes(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
    return await readLimited(response, MAX_DOWNLOAD_BYTES, url);
  } finally {
    // Also cancels a body left unread after an oversized response.
    clearTimeout(timer);
    controller.abort();
  }
}

/** Write through a sibling temporary file so readers never see partial content. */
function writeFileAtomic(target, buffer, mode) {
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(temporary, buffer, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function fileMatches(file, expected) {
  try {
    return fs.statSync(file).isFile() && sha256File(file) === expected;
  } catch {
    return false;
  }
}

/** Extract exactly the pinned libraries from Bambu's archive, each verified. */
export async function extractPlugin(archive, expectedMembers) {
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const extracted = new Map();
  for (const [name, expected] of Object.entries(expectedMembers)) {
    // JSZip rewrites unsafe names such as "../x" to "x"; match the raw name so
    // only a genuine top-level member is accepted.
    const matches = Object.values(zip.files)
      .filter(entry => !entry.dir && (entry.unsafeOriginalName ?? entry.name) === name);
    if (matches.length !== 1) throw new Error(`Plug-in archive must contain exactly one top-level ${name}.`);
    const member = await matches[0].async("nodebuffer");
    assertSha256(member, expected, name);
    extracted.set(name, member);
  }
  return extracted;
}

export function assertSupportedHost(platform = process.platform, arch = process.arch) {
  if (platform !== "linux") {
    throw new Error("This setup is for Linux. On macOS, install Bambu Studio and run `npm run build:native` in the package directory.");
  }
  // Bambu publishes its Linux networking plug-in for x86-64 only.
  if (arch !== "x64") throw new Error(`Bambu's Linux networking plug-in is only published for x86-64; this host is ${arch}.`);
}

export function buildHelper(output, { runner = execFileSync } = {}) {
  runner("/bin/sh", [BUILD_SCRIPT, "--output", output], { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
}

/**
 * Load the installed plug-in and its tunnel library through the helper,
 * offline. Missing system libraries surface here instead of on a stop command.
 */
export function checkPlugin(paths, { runner = execFileSync } = {}) {
  try {
    runner(paths.helper, ["--check-plugin"], {
      env: { ...process.env, BAMBU_NATIVE_PLUGIN: paths.plugin }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`The installed Bambu plug-in cannot be loaded on this host: ${detail}`);
  }
}

export async function install({
  home = bambuNativeHomeDir(),
  pinned = PINNED,
  fetchBytes = defaultFetchBytes,
  build = buildHelper,
  check = checkPlugin,
  log = message => console.error(message),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  assertSupportedHost(platform, arch);
  const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!sameNames(Object.keys(pinned.certificates), BAMBU_NATIVE_CERTIFICATES) ||
    !sameNames(Object.keys(pinned.plugin.members), BAMBU_NATIVE_PLUGIN_LIBRARIES)) {
    throw new Error("Pinned files must match the plug-in libraries and certificates the server requires.");
  }
  const paths = managedPaths(home);
  const directories = [path.dirname(paths.helper), path.dirname(paths.plugin), paths.certDir, paths.configDir];
  // Only restrict a directory this setup creates; never change an existing one.
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
  }
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  // Fetch and verify everything before replacing any installed file.
  const pluginDirectory = path.dirname(paths.plugin);
  let libraries = new Map();
  if (Object.entries(pinned.plugin.members).every(([name, expected]) => fileMatches(path.join(pluginDirectory, name), expected))) {
    log(`Plug-in ${pinned.plugin.version} already installed and verified.`);
  } else {
    log(`Downloading Bambu networking plug-in ${pinned.plugin.version}...`);
    const archive = await fetchBytes(pinned.plugin.url);
    assertSha256(archive, pinned.plugin.sha256, "Plug-in archive");
    libraries = await extractPlugin(archive, pinned.plugin.members);
  }
  const certificates = [];
  for (const [name, expected] of Object.entries(pinned.certificates)) {
    const target = path.join(paths.certDir, name);
    if (fileMatches(target, expected)) continue;
    log(`Downloading ${name} from Bambu Studio ${pinned.studioTag}...`);
    const buffer = await fetchBytes(certificateUrl(pinned.studioTag, name));
    assertSha256(buffer, expected, name);
    certificates.push([target, buffer]);
  }

  // Withdraw the receipt before replacing anything: until a complete, checked
  // installation is written again, the server refuses this helper.
  fs.rmSync(paths.receipt, { force: true });

  // Rebuild every time so the helper always matches this package's source.
  const helper = paths.helper;
  log("Building the native helper...");
  build(helper);
  if (!fs.statSync(helper).isFile()) throw new Error(`Helper build did not produce ${helper}.`);

  for (const [name, buffer] of libraries) writeFileAtomic(path.join(pluginDirectory, name), buffer, 0o600);
  for (const [target, buffer] of certificates) writeFileAtomic(target, buffer, 0o600);
  log("Checking that the plug-in loads...");
  check(paths);
  const receipt = {
    pluginVersion: pinned.plugin.version,
    pluginLibraries: pinned.plugin.members,
    studioTag: pinned.studioTag,
    helperSourceSha256: sha256File(BAMBU_NATIVE_SOURCE),
    installedAt: new Date().toISOString(),
  };
  writeFileAtomic(paths.receipt, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
  log(`Installed the X2D native transport in ${home}.`);
  if (path.resolve(home) !== path.resolve(bambuNativeHomeDir())) {
    log(`Set BAMBU_NATIVE_HOME=${home} in the MCP server's environment so it uses this installation.`);
  }
  return { home, helper, plugin: paths.plugin, receipt };
}

/** Report installed files against the pinned versions; never contacts the network. */
export function verify({ home = bambuNativeHomeDir(), pinned = PINNED, check = checkPlugin } = {}) {
  const problems = [];
  const paths = managedPaths(home);
  const helper = paths.helper;
  try {
    if ((fs.statSync(helper).mode & 0o111) === 0) problems.push(`${helper} is not executable`);
  } catch {
    problems.push(`${helper} is missing`);
  }
  for (const [name, expected] of Object.entries(pinned.plugin.members)) {
    if (!fileMatches(path.join(path.dirname(paths.plugin), name), expected)) {
      problems.push(`${name} is missing or not the pinned ${pinned.plugin.version}`);
    }
  }
  for (const [name, expected] of Object.entries(pinned.certificates)) {
    if (!fileMatches(path.join(paths.certDir, name), expected)) problems.push(`${name} is missing or modified`);
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(paths.receipt, "utf8"));
    if (receipt.helperSourceSha256 !== sha256File(BAMBU_NATIVE_SOURCE)) {
      problems.push("the helper was built from a different package version; rerun setup");
    }
  } catch {
    problems.push("install.json is missing or unreadable");
  }
  if (problems.length === 0) {
    try {
      check(paths);
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { ok: problems.length === 0, home, pluginVersion: pinned.plugin.version, problems };
}

/**
 * Normalize the members of `struct PrintParams` so layout-relevant changes
 * (added, removed, reordered or retyped fields) are detected while comments
 * and default initializers are ignored.
 */
export function printParamsLayout(source) {
  const match = /struct\s+PrintParams\s*\{([\s\S]*?)\n\s*\};/.exec(source);
  if (!match) throw new Error("struct PrintParams not found");
  return match[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split(";")
    .map(member => member.replace(/\{[^}]*\}\s*$/, "").replace(/=[^]*$/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function agentVersion(header) {
  return /#define\s+BAMBU_NETWORK_AGENT_VERSION\s+"([0-9.]+)"/.exec(header)?.[1];
}

function studioRequestVersion(tag) {
  const match = /^v?(\d{2})\.(\d{2})\.(\d{2})\.\d{2}$/.exec(tag);
  if (!match) throw new Error(`Unexpected Bambu Studio release tag: ${tag}`);
  return `${match[1]}.${match[2]}.${match[3]}.00`;
}

export async function checkUpdate({ fetchBytes = defaultFetchBytes, pinned = PINNED, helperSource = fs.readFileSync(BAMBU_NATIVE_SOURCE, "utf8") } = {}) {
  const release = JSON.parse((await fetchBytes("https://api.github.com/repos/bambulab/BambuStudio/releases/latest",
    { Accept: "application/vnd.github+json" })).toString("utf8"));
  const tag = String(release.tag_name || "");
  const requestVersion = studioRequestVersion(tag);
  const resource = JSON.parse((await fetchBytes(
    `https://api.bambulab.com/v1/iot-service/api/slicer/resource?slicer/plugins/cloud=${requestVersion}`,
    {
      "X-BBL-Client-Type": "slicer",
      "X-BBL-Client-Name": "BambuStudio",
      "X-BBL-Client-Version": tag.replace(/^v/, ""),
      "X-BBL-OS-Type": "linux",
    }
  )).toString("utf8"));
  const offered = resource.resources?.find(entry => entry.type === "slicer/plugins/cloud");
  if (!offered?.version || !offered?.url) throw new Error("Bambu's plug-in service returned no Linux plug-in.");
  const header = (await fetchBytes(networkingHeaderUrl(tag))).toString("utf8");
  const headerAgent = agentVersion(header);
  const helperLayout = printParamsLayout(helperSource);
  const releaseLayout = printParamsLayout(header);
  const layoutMatches = JSON.stringify(helperLayout) === JSON.stringify(releaseLayout);
  return {
    pinned: { studioTag: pinned.studioTag, plugin: pinned.plugin.version },
    latest: { studioTag: tag, plugin: offered.version, url: offered.url, headerAgentVersion: headerAgent },
    upToDate: offered.version === pinned.plugin.version,
    // The header describes its own agent version; a different offered plug-in
    // is unverified even when the layout matches.
    headerMatchesOffered: headerAgent === offered.version,
    printParamsLayoutMatches: layoutMatches,
    // Members present on one side only; a pure reordering shows as a mismatch with both lists empty.
    layoutDifferences: {
      helperOnly: helperLayout.filter(member => !releaseLayout.includes(member)),
      releaseOnly: releaseLayout.filter(member => !helperLayout.includes(member)),
    },
  };
}

function usage() {
  return [
    "usage: bambu-printer-mcp-native-setup [--verify | --check-update] [--home DIR]",
    "  (default)        build the helper and install the pinned plug-in and certificates",
    "  --verify         check the installed files without network access",
    "  --check-update   report newer Bambu plug-ins and helper layout compatibility",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let mode = "install";
  let home;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--verify" || argument === "--check-update") {
      if (mode !== "install") throw new Error(usage());
      mode = argument.slice(2);
    } else if (argument === "--home" && argv[index + 1] && !argv[index + 1].startsWith("-")) {
      home = path.resolve(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      return 0;
    } else {
      throw new Error(usage());
    }
  }
  if (mode === "verify") {
    const result = verify({ home: home ?? bambuNativeHomeDir() });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (mode === "check-update") {
    const result = await checkUpdate();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const result = await install({ home: home ?? bambuNativeHomeDir() });
  console.log(JSON.stringify({ status: "installed", ...result }, null, 2));
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
