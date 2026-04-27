import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import JSZip from "jszip";
import { analyze3MFAmsRequirements, analyzeCollarCharm3MF } from "../dist/3mf_parser.js";

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
  assert.ok(names.includes("resolve_3mf_ams_slots"));
  assert.ok(names.includes("get_stl_info"));
  assert.ok(names.includes("blender_mcp_edit_model"));
  assert.ok(names.includes("print_3mf"), "print_3mf tool must be registered");
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
    print3mfTool.inputSchema.properties.auto_match_ams,
    "print_3mf must have auto_match_ams property"
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
  const collarCharmTool = listToolsResult.tools.find((t) => t.name === "print_collar_charm");
  assert.ok(collarCharmTool, "print_collar_charm tool must exist");
  assert.ok(
    collarCharmTool.inputSchema.properties.template_name,
    "print_collar_charm must accept template_name"
  );
  assert.ok(
    collarCharmTool.inputSchema.properties.source_path,
    "print_collar_charm must accept source_path"
  );
  assert.ok(
    collarCharmTool.inputSchema.properties.bambu_model,
    "print_collar_charm must have bambu_model property"
  );
  assert.deepEqual(
    print3mfTool.inputSchema.properties.bambu_model.enum,
    ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
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

test("3MF AMS requirement analysis maps plate filament_ids to slice_info tray_info_idx", async () => {
  const fixture = path.join(REPO_ROOT, "tests/fixtures/h2d_gui_sliced");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", fs.readFileSync(path.join(fixture, "plate_1.json"), "utf8"));
  zip.file("Metadata/slice_info.config", fs.readFileSync(path.join(fixture, "slice_info.config"), "utf8"));
  const tempPath = path.join(os.tmpdir(), `ams-requirements-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    const requirements = await analyze3MFAmsRequirements(tempPath, 0);
    assert.deepEqual(requirements.usedFilamentPositions, [4]);
    assert.deepEqual(requirements.filaments, [
      {
        filamentPosition: 4,
        filamentId: 5,
        tray_info_idx: "GFG02",
        type: "PETG",
        color: "#FFFFFF",
      },
    ]);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
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

test("collar charm analysis resolves smaller object to inner black tray and larger object to outer white tray", async () => {
  const zip = new JSZip();
  zip.file(
    "Metadata/plate_1.json",
    JSON.stringify({
      bbox_objects: [
        { area: 900, name: "outer_ring.stl" },
        { area: 125, name: "inner_letter.stl" }
      ],
      filament_ids: [7, 3],
      version: 2
    })
  );
  const tempPath = path.join(os.tmpdir(), `collar-charm-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    const analysis = await analyzeCollarCharm3MF(tempPath, 0);
    assert.deepEqual(analysis.usedFilamentPositions, [7, 3]);
    assert.deepEqual(analysis.amsSlots, [5, 1], "ams_slots must line up with used filament order");
    assert.equal(analysis.roles.find((role) => role.role === "inner")?.name, "inner_letter.stl");
    assert.equal(analysis.roles.find((role) => role.role === "outer")?.name, "outer_ring.stl");
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test("collar charm analysis rejects projects that do not resolve to exactly two objects", async () => {
  const zip = new JSZip();
  zip.file(
    "Metadata/plate_1.json",
    JSON.stringify({
      bbox_objects: [{ area: 500, name: "only_one.stl" }],
      filament_ids: [0],
      version: 2
    })
  );
  const tempPath = path.join(os.tmpdir(), `collar-charm-invalid-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    await assert.rejects(
      () => analyzeCollarCharm3MF(tempPath, 0),
      /requires exactly 2 plate objects/i
    );
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
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

  const listResourcesResult = await client.listResources();
  const resourceUris = listResourcesResult.resources.map((resource) => resource.uri);
  assert.ok(resourceUris.some((uri) => uri.endsWith("/hms")), "HMS diagnostics resource must be listed");

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
