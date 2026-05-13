import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";
import { BambuImplementation } from "../dist/printers/bambu.js";
import JSZip from "jszip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");

function createClient() {
  return new Client({
    name: "bambu-printer-mcp-behavior-tests",
    version: "0.0.1",
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      server.close((error) => {
        if (error) { reject(error); return; }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttpServerReady(endpoint, attempts = 40, delayMs = 150) {
  let lastStatus = "unreachable";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: "PUT" });
      lastStatus = String(response.status);
      if (response.status === 405 || response.status === 400) return;
    } catch {
      lastStatus = "unreachable";
    }
    await sleep(delayMs);
  }
  throw new Error(`HTTP server did not become ready in time (last status: ${lastStatus})`);
}

async function closeTransport(transport) {
  try { await transport.close(); } catch { }
}

async function terminateChildProcess(childProcess) {
  if (childProcess.exitCode !== null) return;
  childProcess.kill("SIGTERM");
  await Promise.race([
    once(childProcess, "exit"),
    sleep(2000).then(() => { if (childProcess.exitCode === null) childProcess.kill("SIGKILL"); }),
  ]);
}

function parseJsonResult(toolResult) {
  const text = toolResult.content?.[0]?.text;
  assert.equal(typeof text, "string", "Expected text result payload");
  return JSON.parse(text);
}

function assertCommonToolPresence(listToolsResult) {
  const names = listToolsResult.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_printer_status"));
  assert.ok(names.includes("get_stl_info"));
  assert.ok(names.includes("blender_mcp_edit_model"));
  assert.ok(names.includes("print_3mf"), "print_3mf tool must be registered");
  assert.ok(names.includes("print_3mf_bambu_network"), "print_3mf_bambu_network tool must be registered");
  assert.ok(names.includes("bambu_network_bridge_status"), "bambu_network_bridge_status tool must be registered");
  assert.ok(names.includes("bambu_network_call"), "bambu_network_call tool must be registered");
  assert.ok(names.includes("slice_stl"), "slice_stl tool must be registered");
}

function assertBambuStudioSlicerSupport(listToolsResult) {
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");
  const desc = sliceTool.inputSchema?.properties?.slicer_type?.description || "";
  assert.ok(
    desc.includes("bambustudio"),
    `slice_stl slicer_type description must mention bambustudio, got: ${desc}`
  );
  assert.ok(
    desc.includes("orcaslicer-bambulab"),
    `slice_stl slicer_type description must mention orcaslicer-bambulab, got: ${desc}`
  );
  const enumValues = sliceTool.inputSchema?.properties?.slicer_type?.enum || [];
  assert.ok(enumValues.includes("fulu-orca"), "slice_stl schema must expose the FULU alias");
}

async function createFakeBambuCompatibleSlicer(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-mcp-fake-slicer-"));
  const fakeSlicerPath = path.join(tempDir, "fake-slicer.mjs");
  const argsOutPath = path.join(tempDir, "args.json");

  await fs.writeFile(
    fakeSlicerPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_SLICER_ARGS_OUT) {
  fs.writeFileSync(process.env.FAKE_SLICER_ARGS_OUT, JSON.stringify(args, null, 2));
}

const exportIndex = args.indexOf("--export-3mf");
if (exportIndex === -1 || !args[exportIndex + 1]) {
  console.error("missing --export-3mf output");
  process.exit(64);
}

fs.writeFileSync(args[exportIndex + 1], "fake sliced 3mf");
`,
    "utf8"
  );
  await fs.chmod(fakeSlicerPath, 0o755);
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  return { fakeSlicerPath, argsOutPath, tempDir };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  assert.notEqual(index, -1, `Expected ${option} in args: ${args.join(" ")}`);
  assert.ok(index + 1 < args.length, `Expected value after ${option}`);
  return args[index + 1];
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function createFakeBambuNetworkBridge(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-mcp-fake-network-"));
  const fakeBridgePath = path.join(tempDir, "fake-bambu-network-bridge.mjs");
  const callsOutPath = path.join(tempDir, "bridge-calls.json");

  await fs.writeFile(
    fakeBridgePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const MAGIC = 0x52424a50;
const JSON_RESPONSE = 2;
let buffer = Buffer.alloc(0);
const calls = process.env.FAKE_BRIDGE_CALLS_OUT && fs.existsSync(process.env.FAKE_BRIDGE_CALLS_OUT)
  ? JSON.parse(fs.readFileSync(process.env.FAKE_BRIDGE_CALLS_OUT, "utf8"))
  : [];

function sendFrame(id, payloadObject) {
  const payload = Buffer.from(JSON.stringify(payloadObject), "utf8");
  const frame = Buffer.alloc(16 + payload.length);
  frame.writeUInt32LE(MAGIC, 0);
  frame.writeUInt32LE(JSON_RESPONSE, 4);
  frame.writeUInt32LE(id, 8);
  frame.writeUInt32LE(payload.length, 12);
  payload.copy(frame, 16);
  process.stdout.write(frame);
}

function record(method, payload) {
  calls.push({
    method,
    payload,
    expectedVersion: process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION || "",
  });
  if (process.env.FAKE_BRIDGE_CALLS_OUT) {
    fs.writeFileSync(process.env.FAKE_BRIDGE_CALLS_OUT, JSON.stringify(calls, null, 2));
  }
}

function responseFor(method, payload) {
  record(method, payload);
  if (method === "bridge.handshake") {
    if (process.env.FAKE_BRIDGE_REQUIRE_EXPECTED_VERSION === "1" && !process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION) {
      return {
        ok: true,
        network_loaded: false,
        source_loaded: true,
        network_actual_abi_version: "02.05.02.58",
        network_status: "expected ABI version empty",
        source_status: "ok",
        protocol: "fake-fulu"
      };
    }
    return {
      ok: true,
      network_loaded: true,
      source_loaded: true,
      network_abi_version: process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION || "",
      network_actual_abi_version: "02.05.02.58",
      network_status: "ok",
      source_status: "ok",
      protocol: "fake-fulu"
    };
  }
  if (method === "net.create_agent") {
    return { ok: true, value: 101 };
  }
  if (method === "net.is_user_login") {
    return { ok: true, value: true };
  }
  if (method === "net.get_user_selected_machine") {
    return { ok: true, value: "DEV123" };
  }
  if (method.startsWith("net.start")) {
    const value = process.env.FAKE_BRIDGE_START_VALUE !== undefined
      ? Number(process.env.FAKE_BRIDGE_START_VALUE)
      : 0;
    return { ok: true, value, job_id: payload.client_job_id };
  }
  return { ok: true, value: 0 };
}

function drain() {
  while (buffer.length >= 16) {
    if (buffer.readUInt32LE(0) !== MAGIC) {
      console.error("bad magic");
      process.exit(65);
    }
    const id = buffer.readUInt32LE(8);
    const size = buffer.readUInt32LE(12);
    if (buffer.length < 16 + size) return;
    const payload = buffer.subarray(16, 16 + size);
    buffer = buffer.subarray(16 + size);
    const request = JSON.parse(payload.toString("utf8"));
    sendFrame(id, responseFor(request.method, request.payload || {}));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
`,
    "utf8"
  );
  await fs.chmod(fakeBridgePath, 0o755);
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  return {
    tempDir,
    fakeBridgePath,
    callsOutPath,
    bridgeCommand: shellQuote(fakeBridgePath),
  };
}

async function createPrintableThreeMF(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-mcp-printable-3mf-"));
  const threeMFPath = path.join(tempDir, "printable.3mf");
  const zip = new JSZip();
  zip.file(
    "3D/3dmodel.model",
    `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh><vertices></vertices><triangles></triangles></mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`
  );
  zip.file("Metadata/plate_1.gcode", "; fake gcode\\n");
  zip.file(
    "Metadata/project_settings.config",
    JSON.stringify({
      filament_settings_id: ["Generic PLA @BBL P1S"],
      filament_type: ["PLA"],
    })
  );
  await fs.writeFile(threeMFPath, await zip.generateAsync({ type: "nodebuffer" }));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });
  return threeMFPath;
}

// Canonical schema contracts for BambuStudio slicer options on slice_stl.
// Each entry: [property_name, expected_json_type, description_must_contain]
// Description fragments should be domain-stable keywords, not exact phrasing.
const BAMBU_SLICER_OPTION_CONTRACTS = [
  ["uptodate",              "boolean", "preset"],
  ["repetitions",           "number",  "copies"],
  ["orient",                "boolean", "orient"],
  ["arrange",               "boolean", "arrange"],
  ["ensure_on_bed",         "boolean", "bed"],
  ["clone_objects",         "string",  "clone"],
  ["skip_objects",          "string",  "skip"],
  ["load_filaments",        "string",  "filament"],
  ["load_filament_ids",     "string",  "filament"],
  ["enable_timelapse",      "boolean", "timelapse"],
  ["allow_mix_temp",        "boolean", "temperature"],
  ["scale",                 "number",  "scale"],
  ["rotate",                "number",  "z-axis"],
  ["rotate_x",              "number",  "x-axis"],
  ["rotate_y",              "number",  "y-axis"],
  ["min_save",              "boolean", "smaller"],
  ["skip_modified_gcodes",  "boolean", "gcode"],
  ["slice_plate",           "number",  "plate"],
];

test("printer model safety: schema requires bambu_model, rejects missing/invalid models", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "", // Explicitly empty to override dotenv .env file
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  assertBambuStudioSlicerSupport(listToolsResult);

  // --- Schema validation: bambu_model must be required on print_3mf and slice_stl ---
  const print3mfTool = listToolsResult.tools.find((t) => t.name === "print_3mf");
  assert.ok(print3mfTool, "print_3mf tool must exist");
  assert.ok(
    print3mfTool.inputSchema.properties.ams_mapping,
    "print_3mf must have ams_mapping property"
  );
  assert.ok(
    print3mfTool.inputSchema.properties.bambu_model,
    "print_3mf must have bambu_model property"
  );
  assert.ok(
    print3mfTool.inputSchema.required.includes("bambu_model"),
    "print_3mf must list bambu_model as required"
  );
  assert.ok(
    print3mfTool.inputSchema.properties.bed_type,
    "print_3mf must have bed_type property"
  );
  assert.deepEqual(
    print3mfTool.inputSchema.properties.bambu_model.enum,
    ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d"],
    "print_3mf bambu_model must enumerate all valid models"
  );

  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");
  assert.ok(
    sliceTool.inputSchema.properties.bambu_model,
    "slice_stl must have bambu_model property"
  );
  assert.ok(
    sliceTool.inputSchema.required.includes("bambu_model"),
    "slice_stl must list bambu_model as required"
  );

  // No 'type' param should exist on any tool (Bambu-only)
  for (const tool of listToolsResult.tools) {
    assert.ok(
      !tool.inputSchema?.properties?.type,
      `Tool ${tool.name} should not have a 'type' property (Bambu-only server)`
    );
  }

  // --- Runtime validation: print_3mf without bambu_model must error ---
  // The server will attempt elicitation, which fails in test (no client support),
  // then falls back to a clear error about bambu_model being required.
  const noModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf" },
  });
  assert.equal(noModelResult.isError, true, "print_3mf without bambu_model must error");
  const noModelError = noModelResult.content?.[0]?.text || "";
  assert.ok(
    noModelError.toLowerCase().includes("bambu_model") || noModelError.toLowerCase().includes("model"),
    `Error must mention model is required, got: ${noModelError}`
  );

  // --- Runtime validation: print_3mf with invalid model must error ---
  const badModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf", bambu_model: "ender3" },
  });
  assert.equal(badModelResult.isError, true, "print_3mf with invalid model must error");
  const badModelError = badModelResult.content?.[0]?.text || "";
  assert.ok(
    badModelError.includes("Invalid bambu_model"),
    `Error must reject invalid model, got: ${badModelError}`
  );

  // --- Runtime validation: print_3mf with valid model but missing file errors on file, not model ---
  const validModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf", bambu_model: "p1s" },
  });
  assert.equal(validModelResult.isError, true, "Missing file should still error");
  const validModelError = validModelResult.content?.[0]?.text || "";
  assert.ok(
    !validModelError.includes("bambu_model"),
    `Error with valid model should not be about model, got: ${validModelError}`
  );
});

test("printer model safety: BAMBU_MODEL env var accepted as default", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  // With BAMBU_MODEL=p1s set in env, print_3mf should NOT error about missing model
  // (it will error about missing file instead)
  const result = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf" },
  });
  assert.equal(result.isError, true);
  const errorText = result.content?.[0]?.text || "";
  assert.ok(
    !errorText.includes("bambu_model") && !errorText.includes("BAMBU_MODEL"),
    `With BAMBU_MODEL env set, error should be about file not model, got: ${errorText}`
  );
});

test("stdio transport: initialize, list tools, call success + structured failure", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "bambu-printer-mcp");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  assert.equal(success.isError, undefined);
  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");
  assert.equal(successPayload.faceCount, 12);

  const failure = await client.callTool({
    name: "get_stl_info",
    arguments: {},
  });

  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent?.status, "error");
  assert.equal(typeof failure.structuredContent?.suggestion, "string");
});

test("FULU BambuNetwork bridge: status probe and raw calls use framed bridge protocol", async (t) => {
  const fakeBridge = await createFakeBambuNetworkBridge(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_BRIDGE_CALLS_OUT: fakeBridge.callsOutPath,
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const statusResult = await client.callTool({
    name: "bambu_network_bridge_status",
    arguments: {
      connect: true,
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
    },
  });

  assert.equal(statusResult.isError, undefined);
  const statusPayload = parseJsonResult(statusResult);
  assert.equal(statusPayload.configured, true);
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.agent, 101);
  assert.equal(statusPayload.handshake.network_loaded, true);
  assert.equal(statusPayload.handshake.source_loaded, true);

  const rawResult = await client.callTool({
    name: "bambu_network_call",
    arguments: {
      method: "net.is_user_login",
      payload: {},
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
    },
  });

  assert.equal(rawResult.isError, undefined);
  const rawPayload = parseJsonResult(rawResult);
  assert.equal(rawPayload.ok, true);
  assert.equal(rawPayload.value, true);

  const calls = JSON.parse(await fs.readFile(fakeBridge.callsOutPath, "utf8"));
  const methods = calls.map((call) => call.method);
  assert.deepEqual(
    methods.slice(0, 6),
    [
      "bridge.handshake",
      "net.create_agent",
      "net.set_config_dir",
      "net.init_log",
      "net.set_country_code",
      "net.start",
    ]
  );
  assert.ok(methods.includes("net.connect_server"), "Agent init must connect the restored BambuNetwork stack");
  const loginCall = calls.find((call) => call.method === "net.is_user_login");
  assert.equal(loginCall.payload.agent, 101);
});

test("print_3mf_bambu_network builds FULU PrintParams and one-based plate indexes", async (t) => {
  const fakeBridge = await createFakeBambuNetworkBridge(t);
  const threeMFPath = await createPrintableThreeMF(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_BRIDGE_CALLS_OUT: fakeBridge.callsOutPath,
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const result = await client.callTool({
    name: "print_3mf_bambu_network",
    arguments: {
      three_mf_path: threeMFPath,
      bambu_model: "p1s",
      connection_type: "cloud",
      dev_id: "DEV123",
      bed_type: "textured_plate",
      plate_index: 0,
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
      use_ams: true,
      ams_mapping: [2],
      bed_leveling: false,
      flow_calibration: false,
      vibration_calibration: true,
      timelapse: true,
      client_job_id: 4242,
    },
  });

  assert.equal(result.isError, undefined);
  const payload = parseJsonResult(result);
  assert.equal(payload.status, "success");
  assert.equal(payload.bridgeMethod, "net.start_print");
  assert.equal(payload.clientJobId, 4242);
  assert.equal(payload.bridgePlateIndex, 1);
  assert.equal(payload.params.plate_index, 1);
  assert.equal(payload.params.password, "");
  assert.equal(payload.params.task_bed_leveling, false);
  assert.equal(payload.params.task_flow_cali, false);
  assert.equal(payload.params.task_vibration_cali, true);
  assert.equal(payload.params.task_record_timelapse, true);

  const calls = JSON.parse(await fs.readFile(fakeBridge.callsOutPath, "utf8"));
  const startPrintCall = calls.find((call) => call.method === "net.start_print");
  assert.ok(startPrintCall, "print_3mf_bambu_network must invoke net.start_print by default for cloud");
  assert.equal(startPrintCall.payload.agent, 101);
  assert.equal(startPrintCall.payload.client_job_id, 4242);
  assert.equal(startPrintCall.payload.params.dev_id, "DEV123");
  assert.equal(startPrintCall.payload.params.filename, threeMFPath);
  assert.equal(startPrintCall.payload.params.config_filename, threeMFPath);
  assert.equal(startPrintCall.payload.params.plate_index, 1);
  assert.equal(startPrintCall.payload.params.connection_type, "cloud");
  assert.equal(startPrintCall.payload.params.task_bed_type, "textured_plate");
  assert.equal(startPrintCall.payload.params.task_use_ams, true);
  assert.equal(startPrintCall.payload.params.ams_mapping, "[2]");

  const singleFilamentResult = await client.callTool({
    name: "print_3mf_bambu_network",
    arguments: {
      three_mf_path: threeMFPath,
      bambu_model: "p1s",
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
      connection_type: "lan",
      bambu_network_method: "start_local_print",
      host: "192.0.2.1",
      dev_id: "DEV123",
      bambu_token: "ACCESS",
      use_ams: true,
    },
  });

  assert.equal(singleFilamentResult.isError, undefined);
  const updatedCalls = JSON.parse(await fs.readFile(fakeBridge.callsOutPath, "utf8"));
  const latestStartPrintCall = updatedCalls.filter((call) => call.method === "net.start_local_print").at(-1);
  assert.ok(latestStartPrintCall, "print_3mf_bambu_network must call start_local_print");
  assert.equal(latestStartPrintCall.payload.params.task_use_ams, true);
  assert.equal(latestStartPrintCall.payload.params.ams_mapping, "[0]");
});

test("BambuNetwork bridge status supports split macOS plugin/runtime layout", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-mcp-macos-bridge-"));
  const pluginDir = path.join(tempDir, "plugins");
  const runtimeDir = path.join(tempDir, "runtime");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });

  const pluginFiles = [
    "pjarczak-bambu-linux-host-wrapper",
    "install_runtime_macos.sh",
    "verify_runtime_macos.sh",
  ];
  const runtimeFiles = [
    "libbambu_networking.so",
    "libBambuSource.so",
    "pjarczak_bambu_linux_host",
    "pjarczak_bambu_linux_host_abi1",
    "pjarczak_bambu_linux_host_abi0",
    "ca-certificates.crt",
    "slicer_base64.cer",
  ];

  for (const file of pluginFiles) {
    await fs.writeFile(path.join(pluginDir, file), "");
  }
  for (const file of runtimeFiles) {
    await fs.writeFile(path.join(runtimeDir, file), "");
  }

  const previousPluginDir = process.env.BAMBU_NETWORK_PLUGIN_DIR;
  const previousRuntimeDir = process.env.PJARCZAK_MAC_RUNTIME_DIR;
  process.env.BAMBU_NETWORK_PLUGIN_DIR = pluginDir;
  process.env.PJARCZAK_MAC_RUNTIME_DIR = runtimeDir;

  t.after(async () => {
    if (previousPluginDir === undefined) delete process.env.BAMBU_NETWORK_PLUGIN_DIR;
    else process.env.BAMBU_NETWORK_PLUGIN_DIR = previousPluginDir;
    if (previousRuntimeDir === undefined) delete process.env.PJARCZAK_MAC_RUNTIME_DIR;
    else process.env.PJARCZAK_MAC_RUNTIME_DIR = previousRuntimeDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const status = new BambuNetworkBridge().getStatus();

  assert.equal(status.runtime.macosPluginDir, pluginDir);
  assert.equal(status.runtime.macosRuntimeDir, runtimeDir);
  assert.deepEqual(status.runtime.macosMissingPluginFiles, []);
  assert.deepEqual(status.runtime.macosMissingRuntimeFiles, []);
  assert.ok(
    status.runtime.suggestedMacCommand.includes(path.join(pluginDir, "pjarczak-bambu-linux-host-wrapper")),
    "suggested macOS command must use the wrapper from the plugin directory"
  );
  assert.ok(
    status.runtime.suggestedMacCommand.includes(path.join(runtimeDir, "pjarczak_bambu_linux_host")),
    "suggested macOS command must pass the runtime host path to the wrapper"
  );
});

test("BambuNetwork bridge auto-retries with reported ABI version", async (t) => {
  const fakeBridge = await createFakeBambuNetworkBridge(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_BRIDGE_CALLS_OUT: fakeBridge.callsOutPath,
      FAKE_BRIDGE_REQUIRE_EXPECTED_VERSION: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const statusResult = await client.callTool({
    name: "bambu_network_bridge_status",
    arguments: {
      connect: true,
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
    },
  });

  assert.equal(statusResult.isError, undefined);
  const statusPayload = parseJsonResult(statusResult);
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.handshake.network_loaded, true);
  assert.equal(statusPayload.handshake.network_abi_version, "02.05.02.58");

  const calls = JSON.parse(await fs.readFile(fakeBridge.callsOutPath, "utf8"));
  const handshakeCalls = calls.filter((call) => call.method === "bridge.handshake");
  assert.equal(handshakeCalls.length, 2);
  assert.equal(handshakeCalls[0].expectedVersion, "");
  assert.equal(handshakeCalls[1].expectedVersion, "02.05.02.58");
});

test("print_3mf_bambu_network treats non-zero BambuNetwork return codes as failures", async (t) => {
  const fakeBridge = await createFakeBambuNetworkBridge(t);
  const threeMFPath = await createPrintableThreeMF(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_BRIDGE_CALLS_OUT: fakeBridge.callsOutPath,
      FAKE_BRIDGE_START_VALUE: "-4030",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const result = await client.callTool({
    name: "print_3mf_bambu_network",
    arguments: {
      three_mf_path: threeMFPath,
      bambu_model: "p1s",
      bridge_command: fakeBridge.bridgeCommand,
      bambu_network_config_dir: fakeBridge.tempDir,
      country_code: "US",
      connection_type: "lan",
      bambu_network_method: "start_local_print",
      host: "192.0.2.1",
      dev_id: "DEV123",
      bambu_token: "ACCESS",
      use_ams: true,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || "", /non-zero result -4030/);
});

test("Bambu print_3mf honors explicit AMS for single-filament projects", async (t) => {
  const threeMFPath = await createPrintableThreeMF(t);
  const bambu = new BambuImplementation();
  const published = [];
  let uploadArgs = null;

  bambu.ftpUpload = async (...args) => {
    uploadArgs = args;
  };
  bambu.getPrinter = async () => ({
    publish: async (command) => {
      published.push(command);
    },
  });

  const result = await bambu.print3mf("192.0.2.1", "SERIAL", "TOKEN", {
    projectName: "benchy",
    filePath: threeMFPath,
    plateIndex: 0,
    useAMS: true,
    bedType: "textured_plate",
  });

  assert.equal(result.status, "success");
  assert.ok(uploadArgs, "print_3mf must upload the project before publishing");
  assert.equal(uploadArgs[3], "/cache/printable.3mf");
  assert.equal(published.length, 1);
  assert.equal(published[0].print.command, "project_file");
  assert.equal(published[0].print.url, "ftp://printable.3mf");
  assert.equal(published[0].print.use_ams, true);
  assert.deepEqual(
    published[0].print.ams_mapping,
    [-1, -1, -1, -1, 0],
    "single-filament AMS print should use Bambu's slot-0 default mapping"
  );
  assert.equal(published[0].print.param, "Metadata/plate_1.gcode");
});

test("streamable-http transport: initialize, list tools, call success + origin rejection", async (t) => {
  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const childProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT: "streamable-http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_ALLOWED_ORIGINS: "http://localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrOutput = "";
  childProcess.stderr?.on("data", (chunk) => { stderrOutput += chunk.toString(); });

  t.after(async () => { await terminateChildProcess(childProcess); });

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await waitForHttpServerReady(endpoint);
  await client.connect(transport);

  assert.equal(client.getServerVersion()?.name, "bambu-printer-mcp");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");

  const forbiddenOriginResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://malicious.local",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: { name: "origin-test-client", version: "1.0.0" },
      },
    }),
  });

  assert.equal(
    forbiddenOriginResponse.status,
    403,
    `Expected 403 for forbidden origin. stderr: ${stderrOutput}`
  );

  const wrongPathResponse = await fetch(`http://127.0.0.1:${port}/not-mcp`, { method: "POST" });
  assert.equal(wrongPathResponse.status, 404);
});

test("slice_stl schema: all BambuStudio slicer options present with correct types and descriptions", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");

  const props = sliceTool.inputSchema?.properties || {};

  // Matrix test: every BambuStudio slicer option must be present, typed correctly,
  // and have a meaningful description.
  for (const [propName, expectedType, descFragment] of BAMBU_SLICER_OPTION_CONTRACTS) {
    assert.ok(
      props[propName],
      `slice_stl must have property "${propName}"`
    );
    assert.equal(
      props[propName].type,
      expectedType,
      `slice_stl.${propName} must be type "${expectedType}", got "${props[propName].type}"`
    );
    assert.ok(
      props[propName].description?.toLowerCase().includes(descFragment),
      `slice_stl.${propName} description must mention "${descFragment}", got: "${props[propName].description}"`
    );
  }

  // Original core params must still be present (regression guard)
  for (const coreParam of ["stl_path", "bambu_model", "slicer_type", "slicer_path", "slicer_profile", "nozzle_diameter"]) {
    assert.ok(props[coreParam], `slice_stl must retain core property "${coreParam}"`);
  }

  // bambu_model and stl_path must remain required
  assert.ok(
    sliceTool.inputSchema.required.includes("bambu_model"),
    "bambu_model must be required"
  );
  assert.ok(
    sliceTool.inputSchema.required.includes("stl_path"),
    "stl_path must be required"
  );

  // New slicer options must NOT be required (they are all optional)
  for (const [propName] of BAMBU_SLICER_OPTION_CONTRACTS) {
    assert.ok(
      !sliceTool.inputSchema.required?.includes(propName),
      `Slicer option "${propName}" must not be required`
    );
  }
});

test("slice_stl uses Bambu-compatible 3MF CLI for Orca and FULU aliases", async (t) => {
  const { fakeSlicerPath, argsOutPath, tempDir } = await createFakeBambuCompatibleSlicer(t);
  const profileSearchDir = path.join(tempDir, "empty-profile-search");
  await fs.mkdir(profileSearchDir, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_SLICER_ARGS_OUT: argsOutPath,
      BAMBU_SLICER_PROFILE_DIRS: profileSearchDir,
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const aliases = ["orcaslicer", "orcaslicer-bambulab", "fulu-orca"];

  for (const slicerType of aliases) {
    await fs.rm(argsOutPath, { force: true });

    const result = await client.callTool({
      name: "slice_stl",
      arguments: {
        stl_path: SAMPLE_STL,
        bambu_model: "p1s",
        slicer_type: slicerType,
        slicer_path: fakeSlicerPath,
        orient: true,
        arrange: false,
        ensure_on_bed: true,
        min_save: true,
        skip_modified_gcodes: true,
        allow_mix_temp: true,
        load_filaments: "pla_basic.json;petg_basic.json",
        load_filament_ids: "1,2",
        clone_objects: "1,2",
        skip_objects: "3,5",
        slice_plate: 1,
      },
    });

    assert.equal(result.isError, undefined, `slice_stl should accept ${slicerType}`);
    const outputPath = result.content?.[0]?.text || "";
    assert.ok(outputPath.endsWith("_sliced.3mf"), `Expected sliced 3MF output, got: ${outputPath}`);

    const args = JSON.parse(await fs.readFile(argsOutPath, "utf8"));
    assert.equal(optionValue(args, "--slice"), "1");
    assert.ok(args.includes("--export-3mf"), "Bambu-compatible slicers must export 3MF");
    assert.ok(!args.includes("--output"), "Orca/FULU must not use generic G-code --output flow");
    assert.ok(args.includes("--allow-newer-file"), "Downloaded/newer 3MF compatibility flag must be present");
    assert.ok(args.includes("--ensure-on-bed"));
    assert.ok(args.includes("--min-save"));
    assert.ok(args.includes("--skip-modified-gcodes"));
    assert.ok(args.includes("--allow-mix-temp"));
    assert.equal(optionValue(args, "--orient"), "1");
    assert.equal(optionValue(args, "--arrange"), "0");
    assert.equal(optionValue(args, "--load-filaments"), "pla_basic.json;petg_basic.json");
    assert.equal(optionValue(args, "--load-filament-ids"), "1,2");
    assert.equal(optionValue(args, "--clone-objects"), "1,2");
    assert.equal(optionValue(args, "--skip-objects"), "3,5");

    const loadSettings = optionValue(args, "--load-settings");
    assert.ok(loadSettings.endsWith("_printer_preset.json"), `Expected generated printer preset JSON, got: ${loadSettings}`);
    const generatedSettings = JSON.parse(await fs.readFile(loadSettings, "utf8"));
    assert.equal(generatedSettings.type, "machine");
    assert.equal(generatedSettings.from, "system");
    assert.equal(generatedSettings.name, "Bambu Lab P1S 0.4 nozzle");
    assert.equal(generatedSettings.printer_settings_id, "Bambu Lab P1S 0.4 nozzle");
  }
});

test("slice_stl uses installed Bambu printer profile when available", async (t) => {
  const { fakeSlicerPath, argsOutPath, tempDir } = await createFakeBambuCompatibleSlicer(t);
  const profileSearchDir = path.join(tempDir, "profiles");
  const installedProfilePath = path.join(profileSearchDir, "Bambu Lab P1S 0.4 nozzle.json");
  await fs.mkdir(profileSearchDir, { recursive: true });
  await fs.writeFile(
    installedProfilePath,
    JSON.stringify({
      type: "machine",
      from: "system",
      name: "Bambu Lab P1S 0.4 nozzle",
      inherits: "fdm_bbl_3dp_001_common",
    }),
    "utf8"
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      FAKE_SLICER_ARGS_OUT: argsOutPath,
      BAMBU_SLICER_PROFILE_DIRS: profileSearchDir,
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const result = await client.callTool({
    name: "slice_stl",
    arguments: {
      stl_path: SAMPLE_STL,
      bambu_model: "p1s",
      slicer_type: "bambustudio",
      slicer_path: fakeSlicerPath,
      slice_plate: 1,
    },
  });

  assert.equal(result.isError, undefined);

  const args = JSON.parse(await fs.readFile(argsOutPath, "utf8"));
  assert.equal(optionValue(args, "--load-settings"), installedProfilePath);
});

test("tool schema invariant: every tool property has a description", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();

  // Every tool must have a description, and every property must have a description.
  // This is critical for LLM tool-use (codemode) -- missing descriptions degrade tool selection.
  for (const tool of listToolsResult.tools) {
    assert.ok(
      tool.description && tool.description.length > 10,
      `Tool "${tool.name}" must have a meaningful description`
    );

    const props = tool.inputSchema?.properties || {};
    for (const [propName, propSchema] of Object.entries(props)) {
      assert.ok(
        propSchema.description && propSchema.description.length > 5,
        `${tool.name}.${propName} must have a description (got: "${propSchema.description || ""}")`
      );
    }
  }
});
