import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { bridgeAmsMapping2Entry, hasAmsMappingInput, normalizeAmsMappingObject, normalizeBridgeAmsTrayValue } from "../dist/ams-mapping.js";
import { buildBambuConnectImportUrl } from "../dist/bambu-connect.js";
import {
  buildBambuNativeFanCommand,
  buildBambuNativeTemperatureCommand,
  isBambuNativePlatform,
  uploadWithBambuNative,
  validateBambuNativeControlMessage,
} from "../dist/bambu-native.js";
import { UNPINNED_PLUGIN_ENV, createFakeNativeHome } from "./fixtures/native-home.mjs";
import { analyze3MFAmsRequirements, analyze3MFPlateObjects, analyzeCollarCharm3MF } from "../dist/3mf_parser.js";
import { BambuImplementation, cameraFrameParser } from "../dist/printers/bambu.js";
import { BambuNetworkBridge, LOCAL_PRINT_TIMING, linuxPluginLibraryEnv } from "../dist/bambu-network-bridge.js";
import { BAMBU_NETWORK_CERTIFICATES } from "../dist/bambu-network-certs.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";

// These tests read what the stand-in slicers were given, so no slice is reused (src/slicer/slice-cache.ts)
// unless a test asks; it also keeps test slices out of the real ~/.cache.
process.env.SLICE_CACHE ??= "off";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");
const EXPECTED_BAMBU_MODELS = ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2dpro", "h2s", "h2c", "x2d"];

async function writeSliced3mfFixture({
  name = "h2-project-filament",
  bambuModel = "h2s",
  bedType = "Supertack Plate",
  projectFilamentIds = ["GFG02", "GFG01", "GFL00", "GFL03"],
  projectFilamentColors = ["#FFFFFF", "#FF911A80", "#DCF478", "#DCF478"],
  projectFilamentTypes = ["PETG", "PETG", "PLA", "PLA"],
  plateFilamentIds = [1],
} = {}) {
  const zip = new JSZip();
  const nozzleDiameters = ["h2d", "h2dpro", "h2c"].includes(bambuModel) ? ["0.4", "0.4"] : ["0.4"];
  const gcode = [
    `; printer_model = ${bambuModel}`,
    `; nozzle_diameter = ${nozzleDiameters.join(";")}`,
    `; curr_bed_type = ${bedType}`,
    `; filament_ids = ${projectFilamentIds.join(";")}`,
    `; filament_colour = ${projectFilamentColors.join(";")}`,
    `; filament_type = ${projectFilamentTypes.join(";")}`,
    ...(nozzleDiameters.length === 2 ? [`; filament_map = ${projectFilamentTypes.map((_, i) => i === 1 ? 2 : 1).join(",")}`, "; physical_extruder_map = 1,0"] : []),
    "G1 X0 Y0",
    "",
  ].join("\n");
  const md5 = createHash("md5").update(Buffer.from(gcode)).digest("hex");
  zip.file("Metadata/plate_1.gcode", gcode);
  zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: bambuModel, nozzle_diameter: nozzleDiameters, filament_type: projectFilamentTypes, curr_bed_type: bedType }));
  zip.file("Metadata/plate_1.gcode.md5", md5);
  zip.file(
    "3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="cube.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>'
  );
  zip.file(
    "Metadata/plate_1.json",
    JSON.stringify({
      filament_ids: plateFilamentIds,
      bbox_objects: [{ id: 1, name: "cube.stl", area: 1 }],
      version: 2,
    })
  );
  const tempPath = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.gcode.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));
  return tempPath;
}

function stubFreshSafetyStatus(bambu, model) {
  bambu.getSafetyStatus = async () => {
    const now = Date.now();
    return {
      connected: true, model, status: "IDLE",
      raw: { model, gcode_state: "IDLE", nozzle_diameter: "0.4", nozzle_type: "hardened_steel", device: { nozzle: { info: ["h2d", "h2dpro", "h2c"].includes(model) ? [{ id: 0, diameter: 0.4, type: "HH01", stat: 0 }, { id: 1, diameter: 0.4, type: "HH01", stat: 0 }] : [{ id: 0, diameter: 0.4, type: "HH01", stat: 0 }] } }, print_error: 0, hms: [],
        ams: { tray_now: "254", ams: [
          { id: "0", tray: [{ id: "1", tray_type: "PETG", nozzle_temp_min: "220", nozzle_temp_max: "260" }, { id: "2", tray_type: "PETG", nozzle_temp_min: "220", nozzle_temp_max: "260" }] },
          { id: "3", tray: [{ id: "3", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] },
          // Each AMS-HT is its own unit (id 128 + n) with one tray, id 0.
          { id: "128", tray: [{ id: "0", tray_type: "PETG", nozzle_temp_min: "220", nozzle_temp_max: "260" }] },
          { id: "131", tray: [{ id: "0", tray_type: "PETG", nozzle_temp_min: "220", nozzle_temp_max: "260" }] },
        ] },
      },
      observation: { source: "mqtt", requestedAt: now, receivedAt: now, identitySource: "report" },
    };
  };
}

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
  assert.ok(names.includes("list_3mf_plate_objects"));
  assert.ok(names.includes("set_fan_speed"));
  assert.ok(names.includes("set_light"));
  assert.ok(names.includes("clear_hms_errors"));
  assert.ok(names.includes("set_print_speed"));
  assert.ok(names.includes("set_airduct_mode"));
  assert.ok(names.includes("reread_ams_rfid"));
  assert.ok(names.includes("x2d_native_control"));
  assert.ok(names.includes("skip_objects"));
  assert.ok(names.includes("get_stl_info"));
  assert.ok(names.includes("blender_mcp_edit_model"));
  assert.ok(names.includes("print_3mf"), "print_3mf tool must be registered");
  assert.ok(names.includes("print_3mf_bambu_network"), "print_3mf_bambu_network tool must be registered");
  assert.ok(names.includes("bambu_network_bridge_status"), "bambu_network_bridge_status tool must be registered");
  assert.ok(names.includes("bambu_network_call"), "bambu_network_call tool must be registered");
  assert.ok(names.includes("bambu_connect_import_file"), "bambu_connect_import_file tool must be registered");
  assert.ok(names.includes("upload_gcode"), "upload_gcode tool must be registered");
  assert.ok(names.includes("start_print"), "start_print compatibility alias must be registered");
  assert.ok(names.includes("start_print_job"), "start_print_job tool must be registered");
  assert.ok(names.includes("slice_stl"), "slice_stl tool must be registered");
}

test("Bambu Connect handoff builds the official encoded import URL without opening the app", () => {
  const filePath = path.join(os.tmpdir(), `bambu-connect-url-${Date.now()}.gcode.3mf`);
  fs.writeFileSync(filePath, "fixture");

  try {
    const importUrl = buildBambuConnectImportUrl({
      filePath,
      name: "X2D 云端测试",
      version: "1.0.0",
    });
    const parsed = new URL(importUrl);
    assert.equal(parsed.protocol, "bambu-connect:");
    assert.equal(parsed.hostname, "import-file");
    assert.equal(parsed.searchParams.get("path"), path.resolve(filePath));
    assert.equal(parsed.searchParams.get("name"), "X2D 云端测试");
    assert.equal(parsed.searchParams.get("version"), "1.0.0");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("X2D native control accepts Studio device commands but rejects unrelated device JSON", () => {
  const pause = validateBambuNativeControlMessage(
    JSON.stringify({ print: { command: "pause", sequence_id: "1", param: "" } })
  );
  assert.equal(pause.command, "pause");

  const load = validateBambuNativeControlMessage(
    JSON.stringify({ print: { command: "ams_change_filament", sequence_id: "2", ams_id: 0, slot_id: 1, target: 1 } })
  );
  assert.equal(load.command, "ams_change_filament");

  const calibrate = validateBambuNativeControlMessage(
    JSON.stringify({ print: { command: "gcode_line", sequence_id: "3", param: "M620 C0 \n" } })
  );
  assert.equal(calibrate.command, "gcode_line");

  const fanCommand = buildBambuNativeFanCommand("right_auxiliary", 0, "fan-test");
  const fan = validateBambuNativeControlMessage(fanCommand.messageJson);
  assert.equal(fan.command, "set_fan");
  assert.deepEqual(JSON.parse(fan.messageJson), {
    print: { command: "set_fan", sequence_id: "fan-test", fan_index: 10, speed: 0 },
  });

  const temperatureCommand = buildBambuNativeTemperatureCommand("bed", 55.4, "temp-test");
  assert.deepEqual(JSON.parse(temperatureCommand.messageJson), {
    print: { command: "set_bed_temp", sequence_id: "temp-test", temp: 55 },
  });

  for (const message of [
    { print: { command: "ams_filament_setting", sequence_id: "4", ams_id: 0, slot_id: 1, tray_id: 1, tray_info_idx: "GFA00", setting_id: "GFSA00", tray_color: "FFFFFFFF", nozzle_temp_min: 190, nozzle_temp_max: 240, tray_type: "PLA" } },
    { print: { command: "extrusion_cali_get", sequence_id: "5", filament_id: "GFA00", nozzle_diameter: "0.4" } },
    { print: { command: "extrusion_cali_sel", sequence_id: "6", tray_id: 1, ams_id: 0, slot_id: 1, cali_idx: -1, filament_id: "GFA00", nozzle_diameter: "0.4" } },
    { print: { command: "gcode_file", sequence_id: "6b", param: "/usr/etc/print/auto_cali_for_user.gcode" } },
    { print: { command: "set_ctt", sequence_id: "6c", temp: 40 } },
    { system: { command: "ledctrl", sequence_id: "7", led_node: "chamber_light", led_mode: "off" } },
    { camera: { command: "ipcam_resolution_set", sequence_id: "8", resolution: "1080p" } },
    { xcam: { command: "xcam_control_set", sequence_id: "9", module_name: "fod_check", control: true } },
  ]) {
    assert.doesNotThrow(() => validateBambuNativeControlMessage(JSON.stringify(message)));
  }

  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "set_bed_temp", temp: 120 } })),
    /sequence_id/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "gcode_line", param: "M104 S300" } })),
    /limited to AMS/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "gcode_file", param: "/tmp/arbitrary.gcode" } })),
    /built-in user calibration/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ system: { command: "reboot" } })),
    /not allowed/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ upgrade: { command: "start" } })),
    /not allowed/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "set_fan", sequence_id: "1", fan_index: 0, speed: 0 } })),
    /fan_index/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "set_fan", sequence_id: "1", fan_index: 1, speed: 11 } })),
    /10% steps/i
  );
  assert.throws(
    () => validateBambuNativeControlMessage(JSON.stringify({ print: { command: "set_fan", sequence_id: "1", fan_index: 1, speed: 0, gcode: "M104 S300" } })),
    /unsupported fields/i
  );
});

test("X2D public task and AMS tools dispatch through the native helper, including AMS-HT id 128", { skip: !isBambuNativePlatform() }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-native-control-"));
  const helperPath = path.join(tempDir, "fake-native-helper.mjs");
  fs.writeFileSync(
    helperPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ mode: process.argv[2], message: JSON.parse(process.env.BAMBU_NATIVE_COMMAND_JSON) }));",
      "",
    ].join("\n")
  );
  fs.chmodSync(helperPath, 0o755);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(`import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)}; BambuImplementation.prototype.getStatus = async () => ({connected:true,status:"IDLE"});`)}`, SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "x2d",
      BAMBU_NATIVE_HELPER: helperPath,
      BAMBU_NATIVE_HOME: createFakeNativeHome(tempDir),
      ...UNPINNED_PLUGIN_ENV,
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await client.connect(transport);

  const pause = parseJsonResult(await client.callTool({ name: "pause_print", arguments: {} }));
  assert.equal(pause.route, "bambu:///local");
  assert.equal(JSON.parse(pause.updates[0]).message.print.command, "pause");

  const fanOff = parseJsonResult(
    await client.callTool({ name: "set_fan_speed", arguments: { fan: "part", speed: 0, confirm_during_print: true } })
  );
  const fanMessage = JSON.parse(fanOff.updates[0]).message.print;
  assert.equal(fanOff.route, "bambu:///local");
  assert.equal(fanOff.fan, "part");
  assert.equal(fanOff.fan_index, 1);
  assert.equal(fanOff.speed, 0);
  assert.equal(fanMessage.command, "set_fan");
  assert.equal(fanMessage.fan_index, 1);
  assert.equal(fanMessage.speed, 0);

  const amsSetting = {
    print: {
      command: "ams_filament_setting",
      sequence_id: "ams-setting-test",
      ams_id: 0,
      slot_id: 1,
      tray_id: 1,
      tray_info_idx: "GFA00",
      setting_id: "GFSA00",
      tray_color: "FFFFFFFF",
      nozzle_temp_min: 190,
      nozzle_temp_max: 240,
      tray_type: "PLA",
    },
  };
  const amsSettingResult = parseJsonResult(
    await client.callTool({ name: "x2d_native_control", arguments: { message_json: JSON.stringify(amsSetting) } })
  );
  assert.equal(amsSettingResult.route, "bambu:///local");
  assert.deepEqual(JSON.parse(amsSettingResult.updates[0]).message, amsSetting);

  const paSelection = {
    print: {
      command: "extrusion_cali_sel",
      sequence_id: "pa-selection-test",
      tray_id: 1,
      ams_id: 0,
      slot_id: 1,
      cali_idx: -1,
      filament_id: "GFA00",
      nozzle_diameter: "0.4",
    },
  };
  const paSelectionResult = parseJsonResult(
    await client.callTool({ name: "x2d_native_control", arguments: { message_json: JSON.stringify(paSelection) } })
  );
  assert.equal(paSelectionResult.route, "bambu:///local");
  assert.deepEqual(JSON.parse(paSelectionResult.updates[0]).message, paSelection);

  const drying = parseJsonResult(
    await client.callTool({ name: "set_ams_drying", arguments: { action: "stop", ams_id: 128 } })
  );
  const dryingMessage = JSON.parse(drying.updates[0]).message.print;
  assert.equal(dryingMessage.command, "ams_control");
  assert.equal(dryingMessage.ams_id, 128);
  assert.equal(dryingMessage.param, "stop_drying");

  const rfid = parseJsonResult(
    await client.callTool({ name: "reread_ams_rfid", arguments: { ams_id: 128, slot_id: 0 } })
  );
  const rfidMessage = JSON.parse(rfid.updates[0]).message.print;
  assert.equal(rfidMessage.command, "ams_get_rfid");
  assert.equal(rfidMessage.ams_id, 128);
  assert.equal(rfidMessage.slot_id, 0);
});

test("native upload forwards helper progress before returning the final result", { skip: !isBambuNativePlatform() }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-native-progress-"));
  const helperPath = path.join(tempDir, "fake-native-helper.mjs");
  fs.writeFileSync(
    helperPath,
    [
      "#!/usr/bin/env node",
      "console.log('native_update status=1 code=12 msg=12%');",
      "console.log('native_update status=1 code=68 msg=68%');",
      "console.log('native_upload result=0');",
      "",
    ].join("\n")
  );
  fs.chmodSync(helperPath, 0o755);

  const previousHelper = process.env.BAMBU_NATIVE_HELPER;
  const previousHome = process.env.BAMBU_NATIVE_HOME;
  process.env.BAMBU_NATIVE_HELPER = helperPath;
  process.env.BAMBU_NATIVE_HOME = createFakeNativeHome(tempDir);
  process.env.BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN = "1";
  t.after(() => {
    delete process.env.BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN;
    if (previousHelper === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previousHelper;
    if (previousHome === undefined) delete process.env.BAMBU_NATIVE_HOME;
    else process.env.BAMBU_NATIVE_HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const progress = [];
  const result = await uploadWithBambuNative(
    {
      host: "127.0.0.1",
      serial: "TEST_SERIAL",
      token: "TEST_TOKEN",
      filePath: "/tmp/test.3mf",
      projectName: "test.3mf",
      presetName: "test_plate_1",
      plateIndex: 0,
      bedType: "textured_plate",
      useAMS: false,
    },
    (line) => progress.push(line)
  );

  assert.equal(result.status, "success");
  assert.deepEqual(progress, [
    "native_update status=1 code=12 msg=12%",
    "native_update status=1 code=68 msg=68%",
    "native_upload result=0",
  ]);

  const uploadPath = path.join(tempDir, "test.txt");
  fs.writeFileSync(uploadPath, "upload fixture");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "x2d",
      BAMBU_NATIVE_HELPER: helperPath,
      BAMBU_NATIVE_HOME: createFakeNativeHome(tempDir),
      ...UNPINNED_PLUGIN_ENV,
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => closeTransport(transport));
  await client.connect(transport);

  // Observe wire order: the SDK defers progress handlers but removes them
  // synchronously on a response, losing callbacks when both share one read.
  const wireMessages = [];
  const receive = transport.onmessage;
  transport.onmessage = (message, ...rest) => {
    wireMessages.push(message);
    receive(message, ...rest);
  };
  const uploadResult = parseJsonResult(await client.callTool(
    {
      name: "upload_file",
      arguments: {
        file_path: uploadPath,
        filename: "test.txt",
        bambu_model: "x2d",
        connection_mode: "bambu_native",
      },
    },
    undefined,
    { onprogress: () => {} }
  ));
  assert.equal(uploadResult.status, "success");
  assert.deepEqual(wireMessages.map(message => message.method === "notifications/progress"
    ? message.params.message : Object.hasOwn(message, "result") ? "response" : message.method), [
    "native_update status=1 code=12 msg=12%",
    "native_update status=1 code=68 msg=68%",
    "response",
  ]);
});

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
  ["bed_type",              "string",  "bed"],
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
    EXPECTED_BAMBU_MODELS,
    "print_3mf bambu_model must enumerate all valid models"
  );
  const toolsWithModel = listToolsResult.tools
    .filter((tool) => Array.isArray(tool.inputSchema?.properties?.bambu_model?.enum))
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(
    toolsWithModel,
    [
      "get_printer_filaments",
      "inspect_print_file",
      "print_3mf",
      "print_3mf_bambu_network",
      "print_collar_charm",
      "resolve_3mf_ams_slots",
      "set_temperature",
      "slice_stl",
      "slice_with_template",
      "start_print",
      "start_print_job",
      "upload_file",
      "upload_gcode",
    ],
    "all tools that expose bambu_model must be covered by the model enum invariant"
  );
  for (const toolName of toolsWithModel) {
    const tool = listToolsResult.tools.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} tool must exist`);
    assert.deepEqual(
      tool.inputSchema.properties.bambu_model.enum,
      EXPECTED_BAMBU_MODELS,
      `${toolName} bambu_model must enumerate all valid models`
    );
  }

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

  const speedTool = listToolsResult.tools.find((t) => t.name === "set_print_speed");
  assert.ok(speedTool, "set_print_speed tool must exist");
  assert.ok(speedTool.inputSchema.properties.mode, "set_print_speed must accept mode");
  assert.ok(speedTool.inputSchema.required.includes("mode"), "set_print_speed.mode must be required");

  const airductTool = listToolsResult.tools.find((t) => t.name === "set_airduct_mode");
  assert.ok(airductTool, "set_airduct_mode tool must exist");
  assert.deepEqual(
    airductTool.inputSchema.properties.mode.enum,
    ["cooling", "heating"],
    "set_airduct_mode must enumerate cooling/heating"
  );

  const rfidTool = listToolsResult.tools.find((t) => t.name === "reread_ams_rfid");
  assert.ok(rfidTool, "reread_ams_rfid tool must exist");
  assert.ok(rfidTool.inputSchema.required.includes("ams_id"), "reread_ams_rfid.ams_id must be required");
  assert.ok(rfidTool.inputSchema.required.includes("slot_id"), "reread_ams_rfid.slot_id must be required");

  const uploadGcodeTool = listToolsResult.tools.find((t) => t.name === "upload_gcode");
  assert.ok(uploadGcodeTool, "upload_gcode tool must exist");
  assert.ok(uploadGcodeTool.inputSchema.properties.gcode_path, "upload_gcode must accept gcode_path");
  assert.deepEqual(uploadGcodeTool.inputSchema.required, ["filename"]);

  const startPrintTool = listToolsResult.tools.find((t) => t.name === "start_print");
  assert.ok(startPrintTool, "start_print compatibility alias must exist");
  assert.ok(startPrintTool.inputSchema.required.includes("bambu_model"));

  const networkPrintTool = listToolsResult.tools.find((t) => t.name === "print_3mf_bambu_network");
  assert.ok(networkPrintTool, "print_3mf_bambu_network tool must exist");
  assert.ok(networkPrintTool.inputSchema.required.includes("bambu_model"));
  assert.equal(networkPrintTool.inputSchema.properties.plate_index.type, "number");

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

  // --- Runtime validation: every valid model, including H2C, passes model validation ---
  for (const bambuModel of EXPECTED_BAMBU_MODELS) {
    const validModelResult = await client.callTool({
      name: "print_3mf",
      arguments: { three_mf_path: "/tmp/nonexistent_test.3mf", bambu_model: bambuModel },
    });
    assert.equal(validModelResult.isError, true, "Missing file should still error");
    const validModelError = validModelResult.content?.[0]?.text || "";
    assert.ok(
      !validModelError.includes("bambu_model"),
      `Error with valid model ${bambuModel} should not be about model, got: ${validModelError}`
    );
  }
});

test("printer status maps the Bambu Studio N6 model id to X2D", async () => {
  const bambu = new BambuImplementation();
  bambu.printerStore = {
    waitForInitialReport: async () => ({ gcode_state: "IDLE", model_id: "N6" }),
  };
  bambu.getPrinter = async () => ({
    data: { gcode_state: "IDLE", model_id: "N6" },
    publish: async () => {},
  });

  const status = await bambu.getStatus("127.0.0.1", "TEST_SERIAL", "TEST_TOKEN");
  assert.equal(status.model, "X2D");
});

test("printer status preserves unknown reported identity despite a configured model", async () => {
  const previousModels = [process.env.BAMBU_PRINTER_MODEL, process.env.BAMBU_MODEL];

  try {
    for (const configuredKey of ["BAMBU_PRINTER_MODEL", "BAMBU_MODEL"]) {
      process.env.BAMBU_PRINTER_MODEL = "";
      process.env.BAMBU_MODEL = "";
      process.env[configuredKey] = "x2d";
      for (const modelId of ["", "UNRECOGNIZED_MODEL"]) {
        const data = { gcode_state: "IDLE", model_id: modelId };
        const bambu = new BambuImplementation();
        bambu.printerStore = { waitForInitialReport: async () => data };
        bambu.getPrinter = async () => ({ data, publish: async () => {} });

        const status = await bambu.getStatus("127.0.0.1", "TEST_SERIAL", "TEST_TOKEN");
        assert.equal(status.model, "Unknown", `${configuredKey} must not replace reported model_id ${JSON.stringify(modelId)}`);
      }
    }
  } finally {
    ["BAMBU_PRINTER_MODEL", "BAMBU_MODEL"].forEach((key, index) => {
      if (previousModels[index] === undefined) delete process.env[key];
      else process.env[key] = previousModels[index];
    });
  }
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

test("3MF AMS requirement analysis falls back when slice_info.config is not XML", async () => {
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0, 2] }));
  zip.file("Metadata/slice_info.config", "not xml at all");
  const tempPath = path.join(os.tmpdir(), `ams-bad-slice-info-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    const requirements = await analyze3MFAmsRequirements(tempPath, 0);
    assert.deepEqual(requirements.usedFilamentPositions, [0, 2]);
    assert.deepEqual(
      requirements.filaments.map((filament) => ({
        filamentPosition: filament.filamentPosition,
        tray_info_idx: filament.tray_info_idx,
        type: filament.type,
        color: filament.color,
      })),
      [
        { filamentPosition: 0, tray_info_idx: null, type: null, color: null },
        { filamentPosition: 2, tray_info_idx: null, type: null, color: null },
      ]
    );
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test("skip-object listing gives every copy its own identify_id from slice_info, never paired by position", async () => {
  // Bambu Studio's GUI slice (h2d_gui_sliced): 20 copies of two objects, so names repeat and
  // plate_1.json's bbox_objects carry internal ids (6495, 6476, ...) the printer doesn't know.
  const fixture = path.join(REPO_ROOT, "tests/fixtures/h2d_gui_sliced");
  const sliceInfo = fs.readFileSync(path.join(fixture, "slice_info.config"), "utf8");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", fs.readFileSync(path.join(fixture, "plate_1.json"), "utf8"));
  zip.file("Metadata/slice_info.config", sliceInfo);
  const tempPath = path.join(os.tmpdir(), `plate-objects-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));
  try {
    const plateObjects = await analyze3MFPlateObjects(tempPath, 0);
    const expected = [...sliceInfo.matchAll(/<object identify_id="(\d+)" name="([^"]+)"/g)].map(m => [Number(m[1]), m[2]]);
    assert.equal(expected.length, 20);
    assert.deepEqual(plateObjects.objects.map(o => [o.id, o.name]), expected);
    assert.equal(plateObjects.labelObjectEnabled, true);
    // Copies share a name, so no first-layer box can be told apart for them.
    assert.ok(plateObjects.objects.every(o => o.area === null && o.bbox === null && o.skipped === false));
    // Plate 2 was not sliced in this file: no ids, rather than plate 1's.
    await assert.rejects(analyze3MFPlateObjects(tempPath, 1), /Plate 2 was not sliced/);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test("skip-object listing of a Bambu Studio CLI slice with three copies", async () => {
  // Bambu Studio 02.08.02.61 CLI slice of three cube copies (Nov 6 2026): slice_info identify_ids 15, 26, 37;
  // plate_1.json bbox_objects ids 50, 51, 52 are internal object ids.
  const file = path.join(REPO_ROOT, "tests/fixtures/studio-02.08.02.61/p1s-three-copies.3mf");
  const plateObjects = await analyze3MFPlateObjects(file, 0);
  assert.deepEqual(plateObjects.objects.map(o => [o.id, o.name, o.area]), [[15, "cube.stl_1", 400], [26, "cube.stl_2", 400], [37, "cube.stl_3", 400]]);
  assert.ok(plateObjects.objects.every(o => Array.isArray(o.bbox) && o.bbox.length === 4));
  // The wipe tower's box is never a skippable object, even when plate_N.json lists one.
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const plate = JSON.parse(await zip.file("Metadata/plate_1.json").async("string"));
  plate.bbox_objects.push({ id: 1001, name: "wipe_tower", area: 100, bbox: [0, 0, 10, 10] });
  zip.file("Metadata/plate_1.json", JSON.stringify(plate));
  const withTower = path.join(os.tmpdir(), `plate-objects-tower-${Date.now()}.3mf`);
  fs.writeFileSync(withTower, await zip.generateAsync({ type: "nodebuffer" }));
  try {
    assert.deepEqual((await analyze3MFPlateObjects(withTower, 0)).objects.map(o => o.id), [15, 26, 37]);
  } finally {
    fs.rmSync(withTower, { force: true });
  }
});

test("skip-object listing refuses a 3MF without slice_info instead of offering internal bbox ids", async () => {
  const fixture = path.join(REPO_ROOT, "tests/fixtures/h2d_gui_sliced");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", fs.readFileSync(path.join(fixture, "plate_1.json"), "utf8"));
  const tempPath = path.join(os.tmpdir(), `plate-objects-bbox-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));
  try {
    await assert.rejects(analyze3MFPlateObjects(tempPath, 0), /slice_info\.config/);
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
    assert.deepEqual(analysis.amsSlots, [4, 0], "ams_slots must line up with zero-based used filament order");
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

test("H2 family print_3mf rejects pre-sliced filament jobs without explicit AMS mapping", async (t) => {
  const threeMfPath = await writeSliced3mfFixture({ plateFilamentIds: [1] });
  t.after(() => { fs.rmSync(threeMfPath, { force: true }); });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_PRINTER_HOST: "127.0.0.1",
      BAMBU_PRINTER_SERIAL: "0938TEST0000000",
      BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN",
      BAMBU_PRINTER_MODEL: "h2s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  for (const bambuModel of ["h2s", "h2d", "h2dpro", "h2c"]) {
    const result = await client.callTool({
      name: "print_3mf",
      arguments: {
        three_mf_path: threeMfPath,
        bambu_model: bambuModel,
        bed_type: "supertack_plate",
      },
    });

    assert.equal(result.isError, true, `${bambuModel} should reject unmapped filament jobs`);
    const errorText = result.content?.[0]?.text || "";
    assert.match(errorText, /require ams_slots, ams_mapping, or auto_match_ams/i);
    assert.match(errorText, /project filament positions \[1\]/i);
    assert.doesNotMatch(errorText, /ECONNREFUSED|control socket/i);
  }
});

test("H2 ams_slots expand into project-level ams_mapping and ams_mapping2", async () => {
  const threeMfPath = await writeSliced3mfFixture({ plateFilamentIds: [1] });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, "h2s");
  let uploaded = false;
  let publishedPayload = null;

  bambu.ftpUpload = async () => {
    uploaded = true;
  };
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishedPayload = payload;
    },
  });

  try {
    const result = await bambu.print3mf("127.0.0.1", "0938TEST0000000", "TEST_TOKEN", {
      projectName: "cube",
      bambuModel: "h2s",
      filePath: threeMfPath,
      plateIndex: 0,
      useAMS: true,
      amsSlots: [1],
      bedType: "supertack_plate",
    });

    assert.equal(uploaded, true, "print3mf should upload before publishing");
    assert.equal(result.status, "success");
    assert.ok(publishedPayload?.print, "project_file payload should be published");
    assert.equal(publishedPayload.print.command, "project_file");
    assert.equal(publishedPayload.print.param, "Metadata/plate_1.gcode");
    assert.deepEqual(publishedPayload.print.ams_mapping, [-1, 1, -1, -1]);
    assert.deepEqual(publishedPayload.print.ams_mapping2, [
      { ams_id: 255, slot_id: 255 },
      { ams_id: 0, slot_id: 1 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
    ]);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

test("H2C model routes project files through the H2 print path independent of serial prefix", async () => {
  const threeMfPath = await writeSliced3mfFixture({ bambuModel: "h2c", bedType: "Textured PEI Plate", plateFilamentIds: [1] });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, "h2c");
  let uploadedPath = null;
  let publishedPayload = null;

  bambu.ftpUpload = async (_host, _token, _filePath, remotePath) => {
    uploadedPath = remotePath;
  };
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishedPayload = payload;
    },
  });

  try {
    const result = await bambu.print3mf("127.0.0.1", "01P00TEST0000000", "TEST_TOKEN", {
      projectName: "h2c-cube",
      filePath: threeMfPath,
      bambuModel: "h2c",
      plateIndex: 0,
      useAMS: true,
      amsSlots: [1],
      bedType: "textured_plate",
    });

    assert.equal(result.status, "success");
    assert.equal(path.posix.dirname(uploadedPath), "/");
    assert.ok(path.posix.basename(uploadedPath).endsWith(`-${path.basename(threeMfPath)}`));
    assert.equal(uploadedPath, `/${result.remoteProjectPath}`);
    assert.ok(publishedPayload?.print, "H2C should publish a project_file payload");
    assert.equal(publishedPayload.print.command, "project_file");
    assert.match(publishedPayload.print.url, /^ftp:\/\/\//);
    assert.deepEqual(publishedPayload.print.ams_mapping, [-1, 1, -1, -1]);
    assert.deepEqual(publishedPayload.print.ams_mapping2, [
      { ams_id: 255, slot_id: 255 },
      { ams_id: 0, slot_id: 1 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
    ]);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

async function captureP2SPrint({ serial, bambuModel }) {
  const threeMfPath = await writeSliced3mfFixture({ name: "p2s-cube", bambuModel: bambuModel ?? "p2s", plateFilamentIds: [1] });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, bambuModel ?? "p2s");
  let uploadedPath = null;
  const published = [];

  bambu.ftpUpload = async (_host, _token, _filePath, remotePath) => {
    uploadedPath = remotePath;
  };
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      published.push(payload);
    },
  });

  try {
    const result = await bambu.print3mf("127.0.0.1", serial, "TEST_TOKEN", {
      projectName: "p2s-cube",
      filePath: threeMfPath,
      bambuModel,
      plateIndex: 0,
      useAMS: bambuModel !== "p1s",
      ...(bambuModel !== "p1s" ? { amsSlots: [1] } : {}),
      bedType: "supertack_plate",
    });
    const fileName = path.posix.basename(uploadedPath);
    assert.ok(fileName.endsWith(`-${path.basename(threeMfPath)}`));
    assert.equal(uploadedPath, `/${result.remoteProjectPath}`);
    return { result, uploadedPath, published, fileName };
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
}

test("P2S pre-sliced .gcode.3mf uses H2-style project_file from /cache instead of gcode_file", async () => {
  const { result, uploadedPath, published, fileName } = await captureP2SPrint({
    serial: "TESTSERIAL00000",
    bambuModel: "p2s",
  });

  assert.equal(result.status, "success");
  assert.equal(uploadedPath, `/cache/${fileName}`);
  assert.equal(published.length, 1, "P2S should publish exactly one command");
  const cmd = published[0].print;
  assert.equal(cmd.command, "project_file", "P2S rejects gcode_file with 0500-4002");
  assert.equal(cmd.url, `ftp:///cache/${fileName}`);
  assert.equal(cmd.file, fileName);
  assert.equal(cmd.param, "Metadata/plate_1.gcode");
  assert.notEqual(cmd.task_id, "0", "P2S needs non-zero submission ids");
  assert.deepEqual(cmd.ams_mapping, [-1, 1, -1, -1]);
  assert.deepEqual(cmd.ams_mapping2, [
    { ams_id: 255, slot_id: 255 },
    { ams_id: 0, slot_id: 1 },
    { ams_id: 255, slot_id: 255 },
    { ams_id: 255, slot_id: 255 },
  ]);
});

test("P2S serial prefix does not replace an explicit print model", async () => {
  await assert.rejects(captureP2SPrint({ serial: "22E00TEST000000" }), /model.*required|provide.*model|explicit.*model/i);
});

test("P1S pre-sliced .gcode.3mf still uses gcode_file from /cache", async () => {
  const { published, uploadedPath, fileName } = await captureP2SPrint({
    serial: "TESTSERIAL00000",
    bambuModel: "p1s",
  });

  assert.equal(uploadedPath, `/cache/${fileName}`);
  assert.equal(published.length, 1);
  assert.equal(published[0].print.command, "gcode_file");
  assert.equal(published[0].print.param, `cache/${fileName}`);
});

test("H2 two-color ams_slots expand at sparse project-level filament positions", async () => {
  const threeMfPath = await writeSliced3mfFixture({
    name: "h2d-two-color-project-filament",
    bedType: "Textured PEI Plate",
    projectFilamentIds: ["GFG01", "GFG02", "GFG60", "GFG02", "GFG02", "GFG60", "GFG02", "GFL01"],
    projectFilamentColors: ["#FF911A80", "#39541A", "#F72323", "#000000", "#FFFFFF", "#0D6284", "#000000", "#46A8F9"],
    projectFilamentTypes: ["PETG", "PETG", "PETG", "PETG", "PETG", "PETG", "PETG", "PLA"],
    plateFilamentIds: [3, 4],
  });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, "h2s");
  let publishedPayload = null;

  bambu.ftpUpload = async () => {};
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishedPayload = payload;
    },
  });

  try {
    const result = await bambu.print3mf("127.0.0.1", "0938TEST0000000", "TEST_TOKEN", {
      projectName: "h2d-two-color",
      bambuModel: "h2s",
      filePath: threeMfPath,
      plateIndex: 0,
      useAMS: true,
      amsSlots: [1, 2],
      bedType: "textured_plate",
    });

    assert.equal(result.status, "success");
    assert.ok(publishedPayload?.print, "project_file payload should be published");
    assert.deepEqual(publishedPayload.print.ams_mapping, [-1, -1, -1, 1, 2, -1, -1, -1]);
    assert.deepEqual(publishedPayload.print.ams_mapping2, [
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 0, slot_id: 1 },
      { ams_id: 0, slot_id: 2 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
    ]);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

test("H2 ams_mapping2 preserves external spool and HT tray encodings", async () => {
  const threeMfPath = await writeSliced3mfFixture({
    name: "h2-external-and-ht-mapping",
    projectFilamentIds: ["GFG01", "GFG02", "GFG60", "GFL01"],
    projectFilamentColors: ["#111111", "#222222", "#333333", "#444444"],
    projectFilamentTypes: ["PETG", "PETG", "PETG", "PLA"],
    plateFilamentIds: [0, 1, 2, 3],
  });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, "h2s");
  let publishedPayload = null;

  bambu.ftpUpload = async () => {};
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishedPayload = payload;
    },
  });

  try {
    await bambu.print3mf("127.0.0.1", "0938TEST0000000", "TEST_TOKEN", {
      projectName: "h2-external-and-ht",
      bambuModel: "h2s",
      filePath: threeMfPath,
      plateIndex: 0,
      useAMS: true,
      amsMapping: [254, 128, 131, 15],
      bedType: "supertack_plate",
    });

    assert.ok(publishedPayload?.print, "project_file payload should be published");
    assert.deepEqual(publishedPayload.print.ams_mapping, [254, 128, 131, 15]);
    assert.deepEqual(publishedPayload.print.ams_mapping2, [
      { ams_id: 254, slot_id: 254 },
      { ams_id: 128, slot_id: 0 },
      { ams_id: 131, slot_id: 0 },
      { ams_id: 3, slot_id: 3 },
    ]);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

test("ams_mapping object preserves filament-position order instead of tray sorting", () => {
  assert.deepEqual(
    normalizeAmsMappingObject({ 0: 4, 1: 1 }),
    [4, 1],
    "filament position 0 must stay mapped to tray 4 even though tray 1 sorts first"
  );
  assert.deepEqual(
    normalizeAmsMappingObject({ 10: "2", 2: "5" }),
    [5, 2],
    "numeric object keys must drive position order before tray value order"
  );
});

test("dual-nozzle tray values admit 255 as the right/main external spool; single-nozzle values do not", () => {
  assert.equal(normalizeBridgeAmsTrayValue(255, "ams_slots[0]", { dualNozzle: true }), 255);
  assert.equal(normalizeBridgeAmsTrayValue("254", "ams_slots[0]", { dualNozzle: true }), 254);
  assert.throws(() => normalizeBridgeAmsTrayValue(255, "ams_slots[0]"), /128-254/);
  assert.throws(() => normalizeBridgeAmsTrayValue(255, "ams_slots[0]", {}), /128-254/);
  assert.throws(() => normalizeBridgeAmsTrayValue(256, "ams_slots[0]", { dualNozzle: true }), /255/);
  assert.deepEqual(normalizeAmsMappingObject({ 0: 255, 1: 0 }, "ams_mapping", { dualNozzle: true }), [255, 0]);
  assert.throws(() => normalizeAmsMappingObject({ 0: 255, 1: 0 }), /128-254/);
  // Bambu Studio sends virtual trays as ams_id 254/255 with slot_id 0; unused stays {255,255}.
  assert.deepEqual(bridgeAmsMapping2Entry(255, true), { ams_id: 255, slot_id: 0 });
  assert.deepEqual(bridgeAmsMapping2Entry(255, false), { ams_id: 255, slot_id: 255 });
  assert.deepEqual(bridgeAmsMapping2Entry(254, true), { ams_id: 254, slot_id: 0 });
  assert.deepEqual(bridgeAmsMapping2Entry(-1, true), { ams_id: 255, slot_id: 255 });
});

test("AMS-HT trays map to their own unit with slot 0, as Bambu Studio's GetTrayIndexMap does", () => {
  // Bambu Studio 02.08.02.61 DevFilaSystem.cpp:367-368: an AMS-HT (N3S) tray index is its ams_id; one slot, 0.
  for (const dual of [false, true]) {
    assert.deepEqual(bridgeAmsMapping2Entry(128, dual), { ams_id: 128, slot_id: 0 });
    assert.deepEqual(bridgeAmsMapping2Entry(129, dual), { ams_id: 129, slot_id: 0 });
    assert.deepEqual(bridgeAmsMapping2Entry(131, dual), { ams_id: 131, slot_id: 0 });
    // Four-slot AMS units keep ams_id * 4 + slot_id (DevFilaSystem.cpp:371-372).
    assert.deepEqual(bridgeAmsMapping2Entry(0, dual), { ams_id: 0, slot_id: 0 });
    assert.deepEqual(bridgeAmsMapping2Entry(7, dual), { ams_id: 1, slot_id: 3 });
    assert.deepEqual(bridgeAmsMapping2Entry(15, dual), { ams_id: 3, slot_id: 3 });
  }
  // External spools are unchanged.
  assert.deepEqual(bridgeAmsMapping2Entry(254, false), { ams_id: 254, slot_id: 254 });
  assert.deepEqual(bridgeAmsMapping2Entry(254, true), { ams_id: 254, slot_id: 0 });
  assert.deepEqual(bridgeAmsMapping2Entry(255, true), { ams_id: 255, slot_id: 0 });
});

for (const model of ["h2d", "h2dpro"]) test(`${model} project_file uses official virtual-spool wire mapping and validates nozzle binding`, async () => {
  const threeMfPath = await writeSliced3mfFixture({ name: "h2d-dual-external", bambuModel: model, bedType: "Textured PEI Plate", projectFilamentTypes: ["PLA", "PLA", "PLA", "PLA"], plateFilamentIds: [0, 1] });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, model);
  const baseStatus = bambu.getSafetyStatus;
  let virSlot = [{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PLA" }];
  bambu.getSafetyStatus = async (...args) => { const status = await baseStatus(...args); status.raw.vir_slot = virSlot; return status; };
  let publishedPayload = null;
  bambu.ftpUpload = async () => {};
  bambu.getPrinter = async () => ({ publish: async (payload) => { publishedPayload = payload; } });
  try {
    await bambu.print3mf("127.0.0.1", "0948TEST0000000", "TEST_TOKEN", { projectName: "dual-external", bambuModel: model, filePath: threeMfPath, plateIndex: 0, useAMS: true, amsMapping: [254, 255, -1, -1], bedType: "Textured PEI Plate" });
    assert.deepEqual(publishedPayload.print.ams_mapping, [-1, -1, -1, -1]);
    assert.deepEqual(publishedPayload.print.ams_mapping2, [
      { ams_id: 254, slot_id: 0 },
      { ams_id: 255, slot_id: 0 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 255, slot_id: 255 },
    ]);
    publishedPayload = null;
    await bambu.print3mf("127.0.0.1", "0948TEST0000000", "TEST_TOKEN", { projectName: "dual-external-slots", bambuModel: model, filePath: threeMfPath, plateIndex: 0, useAMS: false, amsSlots: [254, 255], bedType: "Textured PEI Plate" });
    assert.deepEqual(publishedPayload.print.ams_mapping, [-1, -1, -1, -1]);
    publishedPayload = null;
    await assert.rejects(bambu.print3mf("127.0.0.1", "0948TEST0000000", "TEST_TOKEN", { projectName: "wrong-nozzle", bambuModel: model, filePath: threeMfPath, plateIndex: 0, useAMS: false, amsSlots: [255, 254], bedType: "Textured PEI Plate" }), /nozzle|binding/i);
    assert.equal(publishedPayload, null);
    publishedPayload = null;
    virSlot = [{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PETG" }];
    await assert.rejects(bambu.print3mf("127.0.0.1", "0948TEST0000000", "TEST_TOKEN", { projectName: "dual-external-bad", bambuModel: model, filePath: threeMfPath, plateIndex: 0, useAMS: true, amsMapping: [254, 255, -1, -1], bedType: "Textured PEI Plate" }), /PETG|material/i);
    assert.equal(publishedPayload, null, "a contradicted main external spool must not publish");
    await assert.rejects(bambu.print3mf("127.0.0.1", "0948TEST0000000", "TEST_TOKEN", { projectName: "dual-external-range", bambuModel: model, filePath: threeMfPath, plateIndex: 0, useAMS: true, amsMapping: [254, 256, -1, -1], bedType: "Textured PEI Plate" }), /255/);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

test("single-nozzle H2S project_file keeps rejecting tray 255", async () => {
  const threeMfPath = await writeSliced3mfFixture({ name: "h2s-255" });
  const bambu = new BambuImplementation(async () => true);
  stubFreshSafetyStatus(bambu, "h2s");
  let published = false;
  bambu.ftpUpload = async () => {};
  bambu.getPrinter = async () => ({ publish: async () => { published = true; } });
  try {
    await assert.rejects(bambu.print3mf("127.0.0.1", "0938TEST0000000", "TEST_TOKEN", { projectName: "h2s-255", bambuModel: "h2s", filePath: threeMfPath, plateIndex: 0, useAMS: true, amsMapping: [-1, 255, -1, -1], bedType: "supertack_plate" }), /128-254/);
    await assert.rejects(bambu.print3mf("127.0.0.1", "0938TEST0000000", "TEST_TOKEN", { projectName: "h2s-255-slots", bambuModel: "h2s", filePath: threeMfPath, plateIndex: 0, useAMS: true, amsSlots: [255], bedType: "supertack_plate" }), /128-254/);
    assert.equal(published, false);
  } finally {
    fs.rmSync(threeMfPath, { force: true });
  }
});

test("ams_mapping input treats empty arrays and objects as absent", () => {
  assert.equal(hasAmsMappingInput(undefined), false);
  assert.equal(hasAmsMappingInput(null), false);
  assert.equal(hasAmsMappingInput([]), false);
  assert.equal(hasAmsMappingInput({}), false);
  assert.equal(hasAmsMappingInput([4]), true);
  assert.equal(hasAmsMappingInput({ 0: 4 }), true);
});

test("BambuNetwork print rejects invalid ams_slots values before bridge payload", async (t) => {
  const threeMfPath = await writeSliced3mfFixture({ name: "bridge-invalid-ams-slots" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_SERIAL: "TEST_DEV",
      BAMBU_PRINTER_SERIAL: "TEST_DEV",
      BAMBU_PRINTER_HOST: "127.0.0.1",
      BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "h2s",
      BAMBU_NETWORK_BRIDGE_COMMAND: "/definitely/missing/bambu-network-bridge",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(() => fs.rmSync(threeMfPath, { force: true }));
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  for (const invalidSlot of [null, "", "not-a-slot", 1.5, 16]) {
    const result = await client.callTool({
      name: "print_3mf_bambu_network",
      arguments: {
        three_mf_path: threeMfPath,
        bambu_model: "h2s",
        dev_id: "TEST_DEV",
        connection_type: "cloud",
        ams_slots: [invalidSlot],
      },
    });

    assert.equal(result.isError, true, `invalid ams_slots value should fail: ${JSON.stringify(invalidSlot)}`);
    const errorText = result.content?.[0]?.text || "";
    assert.match(errorText, /ams_slots\[0\].*integer/i);
    assert.doesNotMatch(errorText, /BAMBU_NETWORK_BRIDGE_COMMAND|FULU BambuNetwork bridge/i);
  }

  const emptyMappingResult = await client.callTool({
    name: "print_3mf_bambu_network",
    arguments: {
      three_mf_path: threeMfPath,
      bambu_model: "h2s",
      dev_id: "TEST_DEV",
      connection_type: "cloud",
      ams_mapping: [],
      ams_slots: [null],
    },
  });
  assert.equal(emptyMappingResult.isError, true);
  const emptyMappingErrorText = emptyMappingResult.content?.[0]?.text || "";
  assert.match(emptyMappingErrorText, /ams_slots\[0\].*integer/i);
  assert.doesNotMatch(emptyMappingErrorText, /BAMBU_NETWORK_BRIDGE_COMMAND|FULU BambuNetwork bridge/i);
});

// FULU BambuNetwork bridge process behaviour, through a real child process.
// The fake host reproduces what the real v1.0.0 host and plug-in did on a P1S;
// the opt-in test below runs the real host when FULU_HOST_DIR is configured.
const FAKE_FULU_HOST = path.join(__dirname, "fixtures", "fake-fulu-host.mjs");
const FAST_LOCAL_PRINT = Object.freeze({ connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, retryWaitMs: 20 });
const FAST_CONTROL = Object.freeze({ ...FAST_LOCAL_PRINT, certificateWaitMs: 100, attempts: 3, deliveryMs: 50 });
const LOCAL_PRINTER = Object.freeze({ devId: "01PTEST", devIp: "192.0.2.10", username: "bblp", password: "SECRET", useSsl: true });
const shellQuoteArg = value => `'${String(value).replace(/'/g, "'\\''")}'`;

// Every variable the fake bridge touches, restored once per test so several bridges in one test
// cannot restore each other's values out of order.
const FAKE_FULU_ENV = ["FAKE_FULU_WITH_RECORD_RESULT", "FAKE_FULU_START_PRINT_RESULT", "BAMBU_NETWORK_BRIDGE_COMMAND", "BAMBU_NETWORK_CONFIG_DIR", "FAKE_FULU_LOG", "PJARCZAK_BAMBU_PLUGIN_DIR",
  "BAMBU_NETWORK_USER_INFO", "BAMBU_NETWORK_CERT_DIR", "PJARCZAK_BAMBU_NETWORK_SO", "PJARCZAK_BAMBU_SOURCE_SO",
  "FAKE_FULU_EXIT_CODE", "FAKE_FULU_PUBLISH_FAILURES", "FAKE_FULU_UNSUPPORTED", "FAKE_FULU_CONNECT_STATUS", "FAKE_FULU_CONTROL_RESULT",
  "FAKE_FULU_CERT_EVENT", "FAKE_FULU_CERT_DELAY_MS", "FAKE_FULU_REQUIRE_CERT_READY", "FAKE_FULU_CONTROL_FAILURES",
  "FAKE_FULU_REFUSE", "FAKE_FULU_LOGGED_IN", "FAKE_FULU_CLOUD_CERT_ON_INSTALL", "FAKE_FULU_CLOUD_REQUIRE_CERT",
  "BAMBU_NETWORK_BRIDGE_IMAGE", "BAMBU_NETWORK_BRIDGE_DOCKER", "BAMBU_NETWORK_BRIDGE_DOCKER_HOST", "BAMBU_NETWORK_BRIDGE_COLIMA",
  "BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE", "BAMBU_NETWORK_BRIDGE_COLIMA_HOME", "FAKE_DOCKER_DIR", "TMPDIR"];
const fakeFuluEnvSnapshots = new WeakSet();

async function fakeFuluBridge(t, env = {}, { wrapped = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-fulu-"));
  const logPath = path.join(dir, "host.jsonl");
  let command = `${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}`;
  if (wrapped) {
    const wrapper = path.join(dir, "fulu-host-wrapper.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\n${command} "$@" | cat\n`, { mode: 0o755 });
    command = shellQuoteArg(wrapper);
  }
  if (!fakeFuluEnvSnapshots.has(t)) {
    fakeFuluEnvSnapshots.add(t);
    const saved = Object.fromEntries(FAKE_FULU_ENV.map(name => [name, process.env[name]]));
    t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  }
  const vars = { ...Object.fromEntries(FAKE_FULU_ENV.map(name => [name, undefined])),
    BAMBU_NETWORK_BRIDGE_COMMAND: command, BAMBU_NETWORK_CONFIG_DIR: path.join(dir, "config"), FAKE_FULU_LOG: logPath, PJARCZAK_BAMBU_PLUGIN_DIR: path.join(dir, "plugins"), ...env };
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const bridge = new BambuNetworkBridge();
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { bridge, dir, calls, methods: () => calls().filter(entry => entry.method).map(entry => entry.method) };
}

const controlSends = (calls, command = "stop") => calls().filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === command);


// A stand-in for `docker` (and `colima`): logs its arguments, answers `info` once Colima has started,
// and runs the fake host for `run`, with the container's -e settings and only after every -v folder exists.
function fakeContainerTools(dir) {
  const docker = path.join(dir, "docker"), colima = path.join(dir, "colima");
  fs.writeFileSync(docker, `#!${process.execPath}
// CommonJS: an extensionless script is CommonJS on Node 18.
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const dir = process.env.FAKE_DOCKER_DIR, args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "docker.jsonl"), JSON.stringify(args) + "\\n");
const at = args[0] === "--host" ? 2 : 0;
if (args[at] === "info") process.exit(fs.existsSync(path.join(dir, "up")) ? 0 : 1);
if (args[at] === "rm" || args[at] === "stop") process.exit(0);
const env = { ...process.env };
for (let i = at; i < args.length; i++) {
  if (args[i] === "-v" && !fs.existsSync(args[i + 1].split(":")[0])) process.exit(125);
  if (args[i] === "-e") { const [name, ...value] = args[i + 1].split("="); env[name] = value.length ? value.join("=") : process.env[name]; }
}
const child = spawn(process.execPath, [${JSON.stringify(FAKE_FULU_HOST)}], { env, stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  fs.writeFileSync(colima, `#!/bin/sh\nprintf '%s|%s\\n' "$COLIMA_HOME" "$*" >> "$FAKE_DOCKER_DIR/colima.log"\ntouch "$FAKE_DOCKER_DIR/up"\n`, { mode: 0o755 });
  return { docker, colima };
}

test("the FULU host runs in its Docker image, mounting this server's own config folder, where print snapshots go", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker, colima } = fakeContainerTools(tools);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-container-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // The VM shares neither /tmp nor /var/folders, so the server's TMPDIR is never mounted.
  const tmp = path.join(work, "tmp"), config = path.join(work, "home", ".config", "mcp-3d-printer-server", "bambu-network");
  fs.mkdirSync(tmp);
  const { bridge, methods, calls } = await fakeFuluBridge(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined, BAMBU_NETWORK_CONFIG_DIR: config, TMPDIR: tmp,
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, BAMBU_NETWORK_BRIDGE_DOCKER_HOST: "unix:///colima/bambu-fulu/docker.sock",
    BAMBU_NETWORK_BRIDGE_COLIMA: colima, BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE: "bambu-fulu", BAMBU_NETWORK_BRIDGE_COLIMA_HOME: "/Volumes/Spillover/colima", FAKE_DOCKER_DIR: tools,
  });

  const status = bridge.getStatus();
  assert.equal(status.configured, true);
  assert.match(status.command, /^'[^']*docker' '--host' 'unix:\/\/\/colima\/bambu-fulu\/docker.sock' 'run'/);

  await bridge.ensureAgent();
  assert.ok(methods().includes("net.create_agent"));
  assert.equal(calls().find(c => c.method === "net.create_agent").payload.log_dir, config, "the host writes to the folder the server mounted");
  // Docker didn't answer, so the profile was started once, in its own COLIMA_HOME, without taking over Docker's context.
  assert.deepEqual(fs.readFileSync(path.join(tools, "colima.log"), "utf8").trim().split("\n"), ["/Volumes/Spillover/colima|start --profile bambu-fulu --activate=false"]);
  const runs = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("run"));
  assert.equal(runs.length, 1);
  const run = runs[0];
  const mounts = run.flatMap((arg, i) => arg === "-v" ? [run[i + 1]] : []);
  // The real folder, mounted at the path the host is told about (on macOS, /var is a link to /private/var).
  assert.deepEqual(mounts, [`${fs.realpathSync(config)}:${config}:rw`],
    "this server's config folder (mcp-3d-printer-server's own, here), which holds the print snapshots too");
  const { bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  assert.equal(bridgeSnapshotRoot(), path.join(config, "print-snapshots"), "print snapshots go where the host can read them");
  assert.ok(fs.statSync(path.join(config, "print-snapshots")).isDirectory());
  for (const value of ["PJARCZAK_BAMBU_PLUGIN_DIR=/plugins", "PJARCZAK_BAMBU_NETWORK_SO=/plugins/libbambu_networking.so", "SSL_CERT_FILE=/fulu/ca-certificates.crt",
    "PJARCZAK_BAMBU_COUNTRY_CODE", "PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION"]) {
    assert.ok(run.some((arg, i) => arg === "-e" && run[i + 1] === value), value);
  }
  assert.deepEqual(run.slice(-4), ["bpm-fulu-e2e:runtime", "/bin/sh", "-c", "/fulu/pjarczak_bambu_linux_host | cat"]);
  assert.deepEqual(run.slice(0, 3), ["--host", "unix:///colima/bambu-fulu/docker.sock", "run"]);
  // An init process forwards stop's SIGTERM to the host, and stop removes the container by its own name.
  assert.ok(run.includes("--init"));
  const name = run[run.indexOf("--name") + 1];
  assert.match(name, /^bambu-fulu-host-\d+-[0-9a-f]{8}$/);
  await bridge.stop();
  const removed = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("rm"));
  // Once before run (a container a dropped client left under this name), once on stop.
  assert.deepEqual(removed, [["--host", "unix:///colima/bambu-fulu/docker.sock", "rm", "-f", name], ["--host", "unix:///colima/bambu-fulu/docker.sock", "rm", "-f", name]]);
  const stopped = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("stop"));
  assert.equal(stopped.length, 2, "each removal stops the host first, with time to exit");
});

test("the FULU container mounts a symlinked config folder at the path the host is given, uses the Colima profile's socket, and clears stale snapshots", async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-container-paths-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const real = path.join(work, "real-config"), linked = path.join(work, "linked-config");
  fs.mkdirSync(real);
  fs.symlinkSync(real, linked);
  const { bridgeContainer, bridgeContainerMounts, bridgeContainerArgs, bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  const env = { BAMBU_NETWORK_BRIDGE_IMAGE: "fulu:runtime", BAMBU_NETWORK_CONFIG_DIR: linked, BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE: "fulu", BAMBU_NETWORK_BRIDGE_COLIMA_HOME: "/colima-home" };
  // A profile started with --activate=false doesn't become Docker's default, so its own socket is used.
  const container = bridgeContainer(env);
  assert.equal(container.dockerHost, "unix:///colima-home/fulu/docker.sock");
  assert.equal(bridgeContainer({ ...env, BAMBU_NETWORK_BRIDGE_DOCKER_HOST: "tcp://elsewhere:2375" }).dockerHost, "tcp://elsewhere:2375", "an explicit host wins");
  assert.equal(bridgeContainer({ BAMBU_NETWORK_BRIDGE_IMAGE: "fulu:runtime" }).dockerHost, undefined, "no profile, no host: Docker's own default");
  // A snapshot a killed server left more than a day ago is removed; a recent one (an upload in flight) stays.
  const snapshots = path.join(real, "print-snapshots");
  fs.mkdirSync(path.join(snapshots, "bambu-print-old"), { recursive: true });
  fs.mkdirSync(path.join(snapshots, "bambu-print-new"));
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(snapshots, "bambu-print-old"), dayAgo, dayAgo);
  // The host is told the linked path (log_dir, snapshots), so the real folder is mounted there.
  const mounts = bridgeContainerMounts(linked, env);
  assert.deepEqual(mounts, [`${fs.realpathSync(real)}:${linked}`]);
  const args = bridgeContainerArgs(container, mounts, "bambu-fulu-host-test");
  assert.ok(args.some((arg, i) => args[i - 1] === "-v" && arg === `${fs.realpathSync(real)}:${linked}:rw`));
  assert.equal(bridgeSnapshotRoot(env), path.join(linked, "print-snapshots"));
  assert.deepEqual(fs.readdirSync(snapshots), ["bambu-print-new"], "the first look at the folder cleared it");
});

test("concurrent calls on a cold Docker-backed bridge start one container", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  fs.writeFileSync(path.join(tools, "up"), "");
  const { bridge, methods } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined,
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  // A status probe and a print reaching the bridge at once: each would otherwise remove the other's container.
  await Promise.all([bridge.ensureAgent(), bridge.ensureAgent(), bridge.ensureAgent()]);
  const logged = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(logged.filter(args => args.includes("run")).length, 1, "one container");
  assert.equal(logged.filter(args => args.includes("rm")).length, 1, "removed once, before it started, never while it ran");
  assert.equal(logged.filter(args => args.includes("stop")).length, 1);
  assert.ok(methods().includes("net.create_agent"));
});

test("stop returns even when a descendant of the bridge's shell keeps its pipes open", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A descendant of the shell (as a docker client can be) keeps the bridge's stdout and stderr open after the host
  // has gone, so the shell's "close" never comes. Before, stop waited for it for ever.
  const pidFile = path.join(dir, "holder.pid");
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: `sleep 30 < /dev/null & echo $! > ${shellQuoteArg(pidFile)}; ${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}` });
  await bridge.ensureAgent();
  const holder = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(holder, "SIGKILL"); } catch { /* gone */ } });
  const started = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - started < 8000, `stop is bounded (${Date.now() - started} ms)`);
  assert.doesNotThrow(() => process.kill(holder, 0), "the pipes were still held, so close never came");
  // A bridge started afterwards works: nothing from the old one reaches it.
  await bridge.ensureAgent();
});

test("a relative config folder reaches the containerized host as the absolute path that was mounted", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  fs.writeFileSync(path.join(tools, "up"), "");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-relative-"));
  const previous = process.cwd();
  process.chdir(work);
  t.after(() => { process.chdir(previous); fs.rmSync(work, { recursive: true, force: true }); });
  const { bridge, calls } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined,
    BAMBU_NETWORK_CONFIG_DIR: "relative-config", BAMBU_NETWORK_CERT_DIR: "relative-certs",
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  await bridge.ensureAgent();
  const config = path.join(fs.realpathSync(work), "relative-config");
  const agent = calls().find(c => c.method === "net.create_agent").payload;
  assert.equal(path.isAbsolute(agent.log_dir), true, agent.log_dir);
  assert.equal(fs.realpathSync(agent.log_dir), config, "the folder the host is told about is the one mounted");
  const run = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find(args => args.includes("run"));
  const mounts = run.flatMap((arg, i) => arg === "-v" ? [run[i + 1].split(":")[1]] : []);
  assert.ok(mounts.includes(agent.log_dir), `${agent.log_dir} is mounted: ${mounts}`);
  const certs = calls().find(c => c.method === "net.set_cert_file")?.payload.folder;
  if (certs) assert.ok(path.isAbsolute(certs) && mounts.some(dir => certs === dir || certs.startsWith(dir + path.sep)), certs);
});

test("the FULU container says plainly when Docker isn't running and no Colima profile is set", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime",
    BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  await assert.rejects(bridge.ensureAgent(), /Docker didn't answer .* Start Docker, or set BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE/);
  const logged = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8");
  assert.doesNotMatch(logged, /"run"/, "nothing ran");
  assert.equal(fs.existsSync(path.join(tools, "colima.log")), false);
});

test("an explicit bridge command still wins over the Docker image", async t => {
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: "/nonexistent/docker" });
  assert.doesNotMatch(bridge.getStatus().command, /docker/);
  const { bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  assert.equal(bridgeSnapshotRoot(), undefined, "a native host reads snapshots from the system temporary folder");
  await bridge.ensureAgent();
});

// P1S 01.10, Nov 3: valid RSA signatures with IDs outside Studio's 20000–29999
// window receive 0502400A. Numeric IDs fail too. Exercise the actual LAN/cloud sends.
test("FULU controls keep unique string IDs in the Studio window, including wrap and retry", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "1", FAKE_FULU_LOGGED_IN: "1"});
  for (const command of ["pause", "resume", "stop"]) {
    assert.equal((await bridge.sendLocalPrintCommand(LOCAL_PRINTER, command, {}, undefined, FAST_CONTROL)).confirmed, true);
    assert.equal((await bridge.sendCloudPrintCommand("01PTEST", command, {}, undefined, FAST_CONTROL)).confirmed, true);
  }
  const ids = calls().filter(c => ["net.send_message", "net.send_message_to_printer"].includes(c.method))
    .map(c => JSON.parse(c.payload.msg).print?.sequence_id).filter(v => v !== undefined);
  assert.equal(new Set(ids).size, ids.length, "every send, including retries, has a fresh ID");
  for (const id of ids) assert.match(id, /^2[0-9]{4}$/);

  // Skip transport/session time to drive the real dispatch through a full counter wrap.
  const wrapping = new BambuNetworkBridge();
  let messages = [], sent = [];
  wrapping.withLocalSession = async (_p, _o, _a, _t, body) => {
    messages = [];
    return body({certificateReadyWithin: async () => true, settle: async () => {}, controlMessages: messages});
  };
  wrapping.callWithAgent = async (_method, payload) => {
    const print = JSON.parse(payload.msg).print;
    sent.push(print.sequence_id);
    messages.push(JSON.stringify({print: {...print, result: "success"}}));
    return {ok: true, value: 0};
  };
  for (let i = 0; i < 10001; i++) {
    assert.equal((await wrapping.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {trace: () => {}}, undefined, FAST_CONTROL)).confirmed, true);
  }
  for (const id of sent) assert.match(id, /^2[0-9]{4}$/);
  assert.equal(new Set(sent.slice(0, 10000)).size, 10000);
  assert.equal(sent[0], sent[10000], "wrap stays inside the accepted window");
});

test("an accepted control keeps the connection open while it reaches the printer, then disconnects", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, {...FAST_CONTROL, deliveryMs: 200});
  const recorded = calls(), sent = recorded.findIndex(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "stop");
  const disconnect = recorded.findIndex(c => c.method === "net.disconnect_printer");
  assert.ok(sent >= 0 && disconnect > sent);
  assert.ok(recorded.slice(sent + 1, disconnect).filter(c => c.method === "bridge.poll_events").length >= 2, "still connected and reading the printer before disconnecting");
});

test("FULU Stop sends once when this printer's certificate is reported ready", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_REQUIRE_CERT_READY: "1", FAKE_FULU_CERT_DELAY_MS: "30"});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 1);
  assert.equal(controlSends(calls).length, 1);
});

// Nov 3 on the real P1S: FULU never sent device_cert_installed for a control session, and the
// previous wait refused to send at all. FULU's own app just sends; a bridge that never says ready still gets one try.
for (const event of ["missing", "other-printer"]) test(`FULU Stop still sends when no certificate message arrives (${event})`, async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CERT_EVENT: event});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.status, "success");
  assert.equal(controlSends(calls).length, 1);
});

test("a control refused with SEND_MSG_FAILED is retried only after the certificate is reinstalled", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "1"});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 2);
  const recorded = calls();
  const sends = recorded.map((c, i) => [c, i]).filter(([c]) => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "pause").map(([, i]) => i);
  assert.equal(sends.length, 2);
  assert.ok(recorded.slice(sends[0], sends[1]).some(c => c.method === "net.install_device_cert"), "reinstalled between the two sends");
});

test("a control that keeps failing stops after three tries with the plug-in code", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "9"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /did not accept stop .*plug-in code -4/);
  assert.equal(controlSends(calls).length, 3);
});

test("any other plug-in return is final: the control is never replayed", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_RESULT: "-1"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /plug-in code -1/);
  assert.equal(controlSends(calls).length, 1);
});

// Nov 3, the real P1S (cloud-bound, Developer Mode off): every LAN Stop/Pause got a signed reply
// with err_code 84033546 and Counterpart still said "Stop sent." The refusal must reach the caller.
test("a refused control reports verification failure without claiming third-party controls are impossible", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_REFUSE: "84033546"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL),
    /refused Stop \(error 0502400A\): .*command verification failed/);
});

test("any other refusal keeps the printer's own error code", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_REFUSE: "50348044"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /refused Stop over the local network \(error 0300400C\)\. Nothing changed/);
});

test("a control the printer answers is reported as accepted, sent with flag 0", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.confirmed, true);
  assert.match(result.message, /accepted Pause/);
  assert.equal(controlSends(calls, "pause")[0].payload.flag, 0);
});

test("a cloud control is sent the way Bambu Studio sends it to a cloud-bound printer, held open for the answer", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  const result = await bridge.sendCloudPrintCommand("01PTEST", "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.confirmed, true);
  const recorded = calls().filter(c => c.method);
  const send = recorded.findIndex(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "stop");
  const before = method => recorded.findIndex(c => c.method === method);
  assert.ok(before("net.set_user_selected_machine") < send && before("net.add_subscribe") < send);
  assert.ok(recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false) < send, "cloud certificate before the control");
  assert.ok(recorded.findIndex(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).pushing?.command === "pushall") < send, "printer state requested first");
  const sent = recorded[send].payload;
  assert.deepEqual([sent.dev_id, sent.qos, sent.flag], ["01PTEST", 1, 0]);
  assert.equal(recorded.some(c => c.method === "net.connect_printer"), false, "no LAN session for a cloud control");
});

// Nov 3, the real P1S: net.start_print returned -3140 (ENC_FLAG_NOT_READY) when called with no cloud session.
test("a cloud print starts only after the printer's cloud session and certificate, as Bambu Studio does", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  await bridge.startCloudPrint("01PTEST", "net.start_print", {client_job_id: 7, params: {dev_id: "01PTEST"}}, {}, () => {}, {connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, certificateWaitMs: 500});
  const recorded = calls().filter(c => c.method);
  const print = recorded.findIndex(c => c.method === "net.start_print");
  assert.ok(print > recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false));
  assert.ok(recorded.slice(0, print).some(c => c.method === "bridge.poll_events"));
});

// Nov 4: net.start_print on the real P1S always returned -3120 (HTTP 403 "internal blocking"). Bambu Studio
// sends a cloud-bound printer it can reach on the LAN with record first (PrintJob.cpp), then start_print.
const FAST_CLOUD = {connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, certificateWaitMs: 500};
const cloudJob = {client_job_id: 7, params: {dev_id: "01PTEST", comments: ""}};
test("a cloud print goes with record first and stops there when it works, as Bambu Studio does", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob, {}, () => {}, FAST_CLOUD, "net.start_print");
  assert.equal(sent.result.value, 0);
  assert.equal(sent.firstFailure, undefined);
  const recorded = calls().filter(c => c.method);
  assert.ok(recorded.findIndex(c => c.method === "net.start_local_print_with_record") > recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false));
  assert.equal(recorded.some(c => c.method === "net.start_print"), false);
  assert.equal(recorded.some(c => c.method === "net.connect_printer"), false, "sent in the cloud session, not a LAN session");
});

test("a cloud print whose recorded send fails is sent once through the cloud, marked as Studio marks it", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_WITH_RECORD_RESULT: "-2120"});
  const checked = [];
  const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob,
    {beforeDispatch: async method => { checked.push(method); }}, () => {}, FAST_CLOUD, "net.start_print");
  assert.equal(sent.firstFailure, -2120);
  assert.equal(sent.result.value, 0);
  const prints = calls().filter(c => c.method === "net.start_print");
  assert.equal(prints.length, 1);
  assert.equal(prints[0].payload.params.comments, "failed(-2120)");
  assert.deepEqual(checked.filter(m => m.includes("start_")), ["net.start_local_print_with_record", "net.start_print"], "the printer is checked again before the second send");
});

test("a cloud print sends no second job after a failure that may have reached the printer, or one Studio stops on", async t => {
  for (const failure of ["-26", "-4030", "-1", "-2100", "-2040"]) {
    const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_WITH_RECORD_RESULT: failure});
    const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob, {}, () => {}, FAST_CLOUD, "net.start_print");
    assert.equal(sent.result.value, Number(failure));
    assert.equal(calls().some(c => c.method === "net.start_print"), false, `no second job after ${failure}`);
    await bridge.stop();
  }
});

test("a cloud print sends nothing when the plug-in is not signed in", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  await assert.rejects(bridge.startCloudPrint("01PTEST", "net.start_print", {client_job_id: 7, params: {}}, {}, () => {}), /not signed in to Bambu Cloud/);
  assert.equal(calls().some(c => c.method === "net.start_print"), false);
});

test("a cloud control refused by the printer fails with its error code", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_REFUSE: "84033546"});
  await assert.rejects(bridge.sendCloudPrintCommand("01PTEST", "pause", {}, undefined, FAST_CONTROL), /refused Pause \(error 0502400A\): .*command verification failed/);
});

// Nov 3, the real P1S over Bambu Cloud: pause returned -2 while the certificate was still installing;
// the second send after device_cert_installed was accepted.
test("a cloud control sent before the certificate is installed is sent again once it is", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_CLOUD_REQUIRE_CERT: "1", FAKE_FULU_CLOUD_CERT_ON_INSTALL: "2"});
  const result = await bridge.sendCloudPrintCommand("01PTEST", "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 2);
  assert.equal(result.confirmed, true);
  const recorded = calls().filter(c => c.method);
  const sends = recorded.filter(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "pause");
  assert.equal(sends.length, 2);
  assert.equal(recorded.filter(c => c.method === "net.install_device_cert").length, 2, "the certificate is installed again before the second send");
});

test("a cloud control is not resent after a final plug-in error", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_CLOUD_REQUIRE_CERT: "1", FAKE_FULU_CLOUD_CERT_ON_INSTALL: "99"});
  await assert.rejects(bridge.sendCloudPrintCommand("01PTEST", "stop", {}, undefined, FAST_CONTROL), /Bambu Cloud did not accept stop .*plug-in code -2/);
  assert.equal(calls().filter(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "stop").length, FAST_CONTROL.attempts);
});

test("control diagnostics go to control-trace.log without the access code", async t => {
  const {bridge, dir} = await fakeFuluBridge(t, {});
  await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  const trace = fs.readFileSync(path.join(dir, "config", "control-trace.log"), "utf8");
  assert.match(trace, /"step":"send","command":"stop","attempt":1,"code":0/);
  assert.match(trace, /"step":"certificate"/);
  assert.doesNotMatch(trace, new RegExp(LOCAL_PRINTER.password));
});

for (const [connection, stopResult] of [["0", "0"], ["1", "0"], ["0", "-4030"], ["0", "-4"]]) {
  test(`cancel_print uses the configured authenticated FULU session (connection ${connection}, stop ${stopResult})`, async t => {
    const { calls } = await fakeFuluBridge(t, { FAKE_FULU_CONNECT_STATUS: connection, FAKE_FULU_CONTROL_RESULT: stopResult });
    const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
    const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, SERVER_ENTRY],
      env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s" },
      stderr: "pipe",
    });
    t.after(async () => { await closeTransport(transport); });
    const client = createClient();
    await client.connect(transport);
    const result = await client.callTool({ name: "cancel_print", arguments: { connection_mode: "bambu_network", connection_type: "lan" } });
    const recorded = calls();
    const commands = recorded.filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "stop");
    if (connection === "0" && stopResult === "0") {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.qos, 1);
      assert.equal(commands[0].payload.dev_id, "01PTEST");
      assert.equal(commands[0].payload.flag, 0);
      assert.equal(JSON.parse(commands[0].payload.msg).print.param, "");
      assert.ok(recorded.findIndex(c => c.method === "net.install_device_cert") < recorded.indexOf(commands[0]));
    } else {
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), connection === "1" ? /LAN connection/ : /did not accept stop over the authenticated FULU LAN connection/);
      // -4 and -4030 mean the plug-in sent nothing: retried after a certificate reinstall, three tries in all.
      assert.equal(commands.length, connection === "1" ? 0 : 3);
    }
  });
}

// The bug this guards: print_3mf honoured BAMBU_DEFAULT_CONNECTION_MODE while
// every control ignored it, so a FULU-authenticated print got plain-MQTT Stop
// and Pause that the printer rejected (HMS 0500_0500_0001_0007).
for (const [tool, command] of [["cancel_print", "stop"], ["pause_print", "pause"]]) {
  test(`${tool} follows the server's configured print route with no route arguments`, async t => {
    const { calls } = await fakeFuluBridge(t);
    const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
    const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
    const transport = new StdioClientTransport({command: process.execPath, args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, SERVER_ENTRY],
      env: {...process.env, MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s",
        BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network", BAMBU_DEFAULT_CONNECTION_TYPE: "lan"}, stderr: "pipe"});
    t.after(async () => { await closeTransport(transport); });
    const client = createClient(); await client.connect(transport);
    const result = await client.callTool({name: tool, arguments: {}});
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const sent = calls().filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === command);
    assert.equal(sent.length, 1, "one authenticated control, never replayed");
  });
}

test("a configured FULU cloud route sends nothing when the plug-in is not signed in, and never plain MQTT", async t => {
  const { calls } = await fakeFuluBridge(t);
  const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
  const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
  const transport = new StdioClientTransport({command: process.execPath, args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, SERVER_ENTRY],
    env: {...process.env, MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s",
      BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network"}, stderr: "pipe"});
  t.after(async () => { await closeTransport(transport); });
  const client = createClient(); await client.connect(transport);
  for (const tool of ["cancel_print", "pause_print"]) {
    const result = await client.callTool({name: tool, arguments: {}});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /not signed in to Bambu Cloud/);
    assert.doesNotMatch(JSON.stringify(result), /Legacy MQTT/);
  }
  assert.equal(calls().filter(c => c.method === "net.send_message_to_printer" || c.method === "net.send_message").length, 0);
});

test("an optional FULU install does not change default or explicitly direct Stop", async t => {
  const { calls } = await fakeFuluBridge(t);
  const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
  const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.cancelJob = async (_h, _s, _t, dispatch) => dispatch ? dispatch() : {status: "success", route: "direct"};`;
  const transport = new StdioClientTransport({command: process.execPath, args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, SERVER_ENTRY],
    env: {...process.env, MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s"}, stderr: "pipe"});
  t.after(async () => { await closeTransport(transport); });
  const client = createClient(); await client.connect(transport);
  for (const args of [{}, {connection_mode: "lan_mqtt_ftps"}]) {
    const result = parseJsonResult(await client.callTool({name: "cancel_print", arguments: args}));
    assert.equal(result.route, "direct");
  }
  assert.equal(calls().length, 0);
});

test("FULU host plug-in library paths are named in PJARCZAK_BAMBU_PLUGIN_DIR on Linux only", () => {
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins" }, "linux"), {
    PJARCZAK_BAMBU_NETWORK_SO: path.resolve("/opt/fulu/plugins", "libbambu_networking.so"),
    PJARCZAK_BAMBU_SOURCE_SO: path.resolve("/opt/fulu/plugins", "libBambuSource.so"),
  });
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "plugins" }, "linux").PJARCZAK_BAMBU_NETWORK_SO, path.resolve("plugins", "libbambu_networking.so"));
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins", PJARCZAK_BAMBU_NETWORK_SO: "/custom/net.so" }, "linux"), {
    PJARCZAK_BAMBU_SOURCE_SO: path.resolve("/opt/fulu/plugins", "libBambuSource.so"),
  });
  // macOS wrappers run the host in a Linux guest that may not see host paths.
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins" }, "darwin"), {});
  assert.deepEqual(linuxPluginLibraryEnv({}, "linux"), {});
});

test("FULU host exit 101 names the socket-stdout bug and its wrapper", async (t) => {
  const { bridge } = await fakeFuluBridge(t, { FAKE_FULU_EXIT_CODE: "101" });
  await assert.rejects(bridge.ensureAgent(), error => {
    assert.match(error.message, /exited \(code=101/);
    assert.match(error.message, /could not reopen its stdout/);
    assert.match(error.message, /OrcaSlicer-bambulab\/issues\/50/);
    assert.match(error.message, /docs\/FULU\.md#linux/);
    return true;
  });
});

test("a FULU host that cannot open its networking library stops before agent creation with the fix", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t, { PJARCZAK_BAMBU_PLUGIN_DIR: undefined });
  await assert.rejects(bridge.ensureAgent(), /could not open its networking library \(validate failed: file open failed\)\. Set PJARCZAK_BAMBU_PLUGIN_DIR/);
  assert.deepEqual(methods(), ["bridge.handshake"]);
});

test("FULU agent setup passes Bambu's pinned certificates, works through a cat wrapper and stops cleanly", async (t) => {
  const { bridge, dir, calls } = await fakeFuluBridge(t, {}, { wrapped: true });
  const { agent } = await bridge.ensureAgent();
  assert.equal(agent, 1);
  const entries = calls();
  const methods = entries.filter(entry => entry.method).map(entry => entry.method);
  assert.ok(methods.indexOf("net.set_cert_file") > methods.indexOf("net.init_log"));
  assert.ok(methods.indexOf("net.set_cert_file") < methods.indexOf("net.start"));
  for (const callback of ["net.set_queue_on_main_fn", "net.set_on_local_connect_fn"]) assert.ok(methods.includes(callback), callback);
  // FULU's GUI identifies itself (init_http_extra_header) after set_cert_file and before start.
  assert.ok(methods.indexOf("net.set_extra_http_header") > methods.indexOf("net.set_cert_file"));
  assert.ok(methods.indexOf("net.set_extra_http_header") < methods.indexOf("net.start"));
  const { headers } = entries.find(entry => entry.method === "net.set_extra_http_header").payload;
  assert.equal(headers["X-BBL-Client-Name"], "BambuStudio");
  assert.equal(headers["X-BBL-Client-Version"], "02.05.02.51");
  assert.equal(headers["X-BBL-Client-Type"], "slicer");
  assert.equal(headers["X-BBL-OS-Type"], "linux");
  assert.match(headers["X-BBL-Device-ID"], /^[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(path.join(dir, "config", "client-device-id"), "utf8").trim(), headers["X-BBL-Device-ID"]);
  const certFolder = entries.find(entry => entry.method === "net.set_cert_file").payload;
  assert.deepEqual({ folder: certFolder.folder, filename: certFolder.filename }, { folder: path.join(dir, "config", "cert"), filename: "slicer_base64.cer" });
  for (const [name, { sha256 }] of Object.entries(BAMBU_NETWORK_CERTIFICATES)) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(certFolder.folder, name))).digest("hex"), sha256, name);
  }
  if (process.platform === "linux") {
    assert.deepEqual(entries[0].env, {
      PJARCZAK_BAMBU_PLUGIN_DIR: path.join(dir, "plugins"),
      PJARCZAK_BAMBU_NETWORK_SO: path.join(dir, "plugins", "libbambu_networking.so"),
      PJARCZAK_BAMBU_SOURCE_SO: path.join(dir, "plugins", "libBambuSource.so"),
    });
  }
  const pid = bridge.getStatus().pid;
  const started = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - started < 1500, "stop must not wait for the SIGKILL fallback");
  await sleep(100);
  assert.equal(fs.readFileSync(path.join(dir, "host.jsonl"), "utf8").includes('"start":true'), true);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the wrapper shell must not outlive stop()");
});

test("bridge status reports the certificate folder and keeps macOS discovery hints on macOS", async (t) => {
  const { bridge, dir } = await fakeFuluBridge(t);
  const status = bridge.getStatus();
  assert.equal(status.runtime.certDir, path.join(dir, "config", "cert"));
  if (process.platform === "darwin") assert.equal(typeof status.runtime.macosRuntimeDir, "string");
  else assert.equal(status.runtime.macosRuntimeDir, undefined, "macOS paths are not Linux or Windows requirements");
  if (process.platform === "linux") assert.equal(status.runtime.pluginLibraries.PJARCZAK_BAMBU_NETWORK_SO, path.join(dir, "plugins", "libbambu_networking.so"));
  assert.equal(status.runtime.suggestedMacCommand, undefined, "a wrapper command is only suggested when the wrapper exists");
});

test("FULU LAN prints open the plug-in's own session and install the printer certificate before printing", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t);
  const { result, jobUpdates } = await bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 7, params: { dev_id: "01PTEST" } }, {}, () => {}, FAST_LOCAL_PRINT);
  assert.deepEqual(result, { ok: true, value: 0, job_id: 7 });
  assert.deepEqual(jobUpdates, [{ status: 1, code: 100, msg: "0.0M/0.0M" }]);
  const order = methods();
  const at = method => order.indexOf(method);
  assert.ok(at("net.set_cert_file") < at("net.connect_printer"));
  assert.ok(at("net.connect_printer") < at("net.install_device_cert"));
  assert.ok(at("net.install_device_cert") < order.indexOf("net.send_message_to_printer"));
  assert.ok(order.indexOf("net.send_message_to_printer") < at("net.start_local_print"));
  assert.equal(order.filter(method => method === "net.start_local_print").length, 1);
  assert.equal(order.at(-2), "net.disconnect_printer", "the session closes after the print");
});

test("a synchronous -4030 is retried once after the certificate exchange and then reported", async (t) => {
  const once = await fakeFuluBridge(t, { FAKE_FULU_PUBLISH_FAILURES: "1" });
  const recovered = await once.bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 8, params: {} }, {}, () => {}, FAST_LOCAL_PRINT);
  assert.equal(recovered.result.value, 0);
  assert.equal(once.methods().filter(method => method === "net.start_local_print").length, 2);

  const twice = await fakeFuluBridge(t, { FAKE_FULU_PUBLISH_FAILURES: "2" });
  const dispatched = [];
  const failed = await twice.bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 9, params: {} }, {
    beforeDispatch: async method => { if (method === "net.start_local_print") dispatched.push(method); },
  }, () => {}, FAST_LOCAL_PRINT);
  assert.equal(failed.result.value, -4030);
  assert.equal(twice.methods().filter(method => method === "net.start_local_print").length, 2, "never more than one retry");
  assert.equal(dispatched.length, 2, "each attempt passes the caller's fresh pre-dispatch check");
  assert.deepEqual(failed.jobUpdates.filter(update => update.code === -4030).map(update => update.msg), ["send msg failed", "send msg failed"]);
});

// Codex review on #69: the plug-in has one LAN connection and the host one event queue,
// so concurrent sessions for different printers must not consume each other's reports.
test("concurrent LAN prints to different printers run one session at a time on a shared bridge", async (t) => {
  const { bridge, calls } = await fakeFuluBridge(t);
  const printers = ["01PFIRST", "01PSECOND"].map(devId => ({ ...LOCAL_PRINTER, devId }));
  const results = await Promise.all(printers.map((printer, index) =>
    bridge.startLocalPrint(printer, "net.start_local_print", { client_job_id: 20 + index, params: { dev_id: printer.devId } }, {}, () => {}, FAST_LOCAL_PRINT)));
  assert.deepEqual(results.map(({ result }) => result.value), [0, 0]);
  const sequence = calls().filter(entry => ["net.connect_printer", "net.start_local_print", "net.disconnect_printer"].includes(entry.method))
    .map(entry => `${entry.method}:${entry.payload.dev_id ?? entry.payload.params?.dev_id ?? ""}`);
  assert.deepEqual(sequence, [
    "net.connect_printer:01PFIRST", "net.start_local_print:01PFIRST", "net.disconnect_printer:",
    "net.connect_printer:01PSECOND", "net.start_local_print:01PSECOND", "net.disconnect_printer:",
  ]);
});

test("a LAN printer the plug-in cannot verify stops before any print or disconnect", async (t) => {
  const emptyCertDir = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-no-printer-cert-"));
  t.after(() => fs.rmSync(emptyCertDir, { recursive: true, force: true }));
  const { bridge, methods } = await fakeFuluBridge(t, { BAMBU_NETWORK_CERT_DIR: emptyCertDir });
  await assert.rejects(
    bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 10, params: {} }, {}, () => {}, FAST_LOCAL_PRINT),
    /LAN connection to printer 01PTEST at 192\.0\.2\.10 failed\. .*No print command was sent/
  );
  assert.equal(methods().includes("net.start_local_print"), false);
  assert.equal(methods().includes("net.disconnect_printer"), false, "the real host crashes when disconnecting a session that never connected");
});

test("cancellation during a LAN session stops before the print command", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t);
  let active = true;
  await assert.rejects(bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 11, params: {} }, {
    beforeDispatch: async method => { if (method === "net.send_message_to_printer") active = false; },
  }, () => { if (!active) throw new Error("cancelled by stop"); }, FAST_LOCAL_PRINT), /cancelled by stop/);
  assert.equal(methods().includes("net.start_local_print"), false);
  assert.ok(methods().includes("net.disconnect_printer"), "an established session is still closed");
});

test("a host without the LAN-session calls still serves cloud and probes, and refuses LAN prints before connecting", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t, { FAKE_FULU_UNSUPPORTED: "net.set_cert_file" });
  const { agent } = await bridge.ensureAgent();
  assert.equal(agent, 1, "cloud jobs and status probes keep working");
  await assert.rejects(
    bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 12, params: {} }, {}, () => {}, FAST_LOCAL_PRINT),
    /did not accept the certificate folder or local-connection callbacks a LAN print needs\. .*no print command was sent/
  );
  assert.equal(methods().includes("net.connect_printer"), false, "the real host crashes connecting without a certificate folder");
});

// Opt-in: the real FULU host and plug-in. FULU_HOST_DIR holds pjarczak_bambu_linux_host
// (x86-64 Linux), FULU_PLUGIN_DIR the 02.05.02.5x plug-in. With FULU_TEST_PRINTER_HOST,
// FULU_TEST_PRINTER_SERIAL and FULU_TEST_PRINTER_ACCESS_CODE it also opens and closes a
// real LAN session. It never prints.
const realFulu = process.env.FULU_HOST_DIR && process.env.FULU_PLUGIN_DIR && process.platform === "linux" && process.arch === "x64";
test("real FULU host: agent setup and LAN session through the documented cat wrapper", { skip: !realFulu && "set FULU_HOST_DIR and FULU_PLUGIN_DIR on x86-64 Linux" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-fulu-"));
  const wrapper = path.join(dir, "fulu-host-wrapper.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\n${shellQuoteArg(path.join(process.env.FULU_HOST_DIR, "pjarczak_bambu_linux_host"))} "$@" | cat\n`, { mode: 0o755 });
  const { bridge } = await fakeFuluBridge(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: shellQuoteArg(wrapper), PJARCZAK_BAMBU_PLUGIN_DIR: process.env.FULU_PLUGIN_DIR,
    BAMBU_NETWORK_CONFIG_DIR: path.join(dir, "config"), FAKE_FULU_LOG: undefined,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { handshake } = await bridge.ensureAgent();
  assert.equal(handshake.network_loaded, true, JSON.stringify(handshake));
  const { FULU_TEST_PRINTER_HOST: devIp, FULU_TEST_PRINTER_SERIAL: devId, FULU_TEST_PRINTER_ACCESS_CODE: password } = process.env;
  if (!devIp || !devId || !password) return t.diagnostic("no FULU_TEST_PRINTER_* configured; skipped the LAN session");
  const connected = await bridge.withLocalSession({ devId, devIp, username: "bblp", password, useSsl: true }, {}, () => {}, LOCAL_PRINT_TIMING, async () => "connected");
  assert.equal(connected, "connected");
});

test("sliceSTL allows slicer executables resolved from PATH", async (t) => {
  if (process.platform === "win32") {
    t.skip("PATH executable resolution test uses a POSIX executable shim");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "path-slicer-"));
  const binDir = path.join(tempRoot, "bin");
  const commandName = `fake-prusaslicer-${process.pid}-${Date.now()}`;
  const commandPath = path.join(binDir, commandName);
  const originalPath = process.env.PATH || "";
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--output\" ]; then",
      "    shift",
      "    printf 'G1 X0\\n' > \"$1\"",
      "    exit 0",
      "  fi",
      "  shift",
      "done",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const manipulator = new STLManipulator(tempRoot);
  const outputPath = await manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", commandName);

  assert.equal(outputPath, path.join(tempRoot, "sample_cube.gcode"));
  assert.equal(fs.readFileSync(outputPath, "utf8"), "G1 X0\n");
});

test("sliceSTL names a slicer crash signal or exit code and keeps the end of its output", { skip: process.platform === "win32" }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crashing-slicer-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const slicer = (name, body) => {
    const file = path.join(tempRoot, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const manipulator = new STLManipulator(tempRoot);
  // FULU OrcaSlicer-bambulab v1.0.0 prints nothing to stderr and segfaults.
  await assert.rejects(manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", slicer("segfaulting-slicer", 'echo "loading model"\nkill -SEGV $$')),
    error => {
      assert.match(error.message, /Slicer failed: the slicer crashed with SIGSEGV\./);
      assert.match(error.message, /Slicer output: loading model$/);
      return true;
    });
  await assert.rejects(manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", slicer("refusing-slicer", 'echo "Some objects are located over the boundary of the heated bed." >&2\nexit 206')),
    error => {
      assert.match(error.message, /Slicer failed: the slicer exited with code 206\./);
      assert.equal(error.message.split("located over the boundary of the heated bed").length, 2, "stderr appears once");
      return true;
    });
});

test("camera_snapshot routes H2 series through RTSP (verified live on Parker H2S)", async () => {
  const bambu = new BambuImplementation(async () => true);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
  let rtspCalls = 0;
  let tcpCalls = 0;
  bambu.fetchRtspCameraFrame = async () => { rtspCalls++; return fakeJpeg; };
  bambu.fetchTcpCameraFrame = async () => { tcpCalls++; return fakeJpeg; };

  for (const model of ["h2", "h2s", "h2d", "h2c", "h2dpro", "x2d"]) {
    const out = await bambu.cameraSnapshot("127.0.0.1", "S", "T", { bambuModel: model });
    assert.equal(out.status, "success", `${model} should succeed via RTSP`);
    assert.equal(out.transport, "rtsps-322", `${model} transport should be rtsps-322`);
  }
  assert.equal(rtspCalls, 6, "RTSP path should run once per H2/X2D variant");
  assert.equal(tcpCalls, 0, "TCP-on-6000 path should not run for H2");
});

test("camera_snapshot routes X1/P2S through RTSP", async () => {
  const bambu = new BambuImplementation(async () => true);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xab, 0xcd, 0xff, 0xd9]);
  bambu.fetchRtspCameraFrame = async () => fakeJpeg;
  bambu.fetchTcpCameraFrame = async () => {
    throw new Error("RTSP models must not reach the TCP wire path");
  };

  for (const model of ["x1", "x1c", "x1carbon", "x1e", "p2s"]) {
    const out = await bambu.cameraSnapshot("127.0.0.1", "S", "T", { bambuModel: model });
    assert.equal(out.transport, "rtsps-322", `${model} should use rtsps-322`);
    assert.equal(out.format, "image/jpeg");
    assert.deepEqual(Buffer.from(out.base64, "base64"), fakeJpeg);
  }
});

test("camera_snapshot rejects unknown model strings", async () => {
  const bambu = new BambuImplementation(async () => true);
  await assert.rejects(
    bambu.cameraSnapshot("127.0.0.1", "S", "T", { bambuModel: "ender3" }),
    /not a known Bambu Lab printer model/i
  );
});

test("camera_snapshot requires a model before choosing a wire protocol", async () => {
  const bambu = new BambuImplementation(async () => true);
  bambu.fetchTcpCameraFrame = async () => {
    throw new Error("missing model must not default to TCP");
  };
  bambu.fetchRtspCameraFrame = async () => {
    throw new Error("missing model must not default to RTSP");
  };

  await assert.rejects(
    bambu.cameraSnapshot("127.0.0.1", "S", "T", {}),
    /requires bambu_model or BAMBU_MODEL/i
  );
});

test("camera_snapshot supported models reach the wire path (mocked) and decode a JPEG frame", async () => {
  const bambu = new BambuImplementation(async () => true);

  // Stub the private wire fetcher so we can verify the routing without
  // talking to a real printer. Returns a tiny synthetic JPEG.
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0xff, 0xd9]);
  bambu.fetchTcpCameraFrame = async () => fakeJpeg;

  for (const model of ["a1", "a1mini", "p1s", "p1p"]) {
    const out = await bambu.cameraSnapshot("127.0.0.1", "S", "T", { bambuModel: model });
    assert.equal(out.status, "success", `${model} should succeed`);
    assert.equal(out.format, "image/jpeg");
    assert.equal(out.sizeBytes, fakeJpeg.length);
    assert.equal(out.base64, fakeJpeg.toString("base64"));
  }
});

// The A1/P1 camera stream on port 6000: 16-byte header (payload size LE) + JPEG.
const cameraFrame = (marker, size = 64) => {
  const jpeg = Buffer.alloc(size, marker);
  jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[size - 2] = 0xff; jpeg[size - 1] = 0xd9;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(size, 0);
  header.writeUInt32LE(1, 8);
  return { jpeg, wire: Buffer.concat([header, jpeg]) };
};

test("camera frame parser splits frames across arbitrary chunk boundaries and rejects bad headers", () => {
  const first = cameraFrame(0x11, 70);
  const second = cameraFrame(0x22, 90);
  const stream = Buffer.concat([first.wire, second.wire]);
  const frames = [];
  const parse = cameraFrameParser(jpeg => frames.push(jpeg), error => assert.fail(error.message));
  for (let offset = 0; offset < stream.length; offset += 7) parse(stream.subarray(offset, offset + 7));
  assert.deepEqual(frames, [first.jpeg, second.jpeg]);

  const errors = [];
  const bad = cameraFrameParser(() => assert.fail("no frame"), error => errors.push(error.message));
  bad(Buffer.alloc(16));
  bad(cameraFrame(0x33).wire);
  assert.deepEqual(errors, ["camera_snapshot: unreasonable payload size 0 from header; auth likely failed."]);
});

// Issue reported by the maintainer on a P1S: the first frame after connecting is the
// printer's buffered frame and can show a finished part that was removed long ago.
test("camera_snapshot over TCP skips the printer's buffered first frame and refuses when no live frame follows", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camera-tls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=printer", "-days", "1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { encoding: "utf8" });
  if (created.status !== 0) return t.skip(`openssl unavailable: ${created.stderr || created.error}`);
  const tls = await import("node:tls");
  const buffered = cameraFrame(0x0b, 80);
  const live = cameraFrame(0x1e, 80);
  const auths = [];
  let sendLive = true;
  // A stalled camera can replay the buffered frame more than once.
  const server = tls.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, socket => {
    socket.once("data", auth => {
      auths.push(auth);
      socket.write(buffered.wire);
      setTimeout(() => socket.writable && socket.write(buffered.wire), 20);
      if (sendLive) setTimeout(() => socket.writable && socket.write(live.wire), 60);
    });
    socket.on("error", () => {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const bambu = new BambuImplementation(async () => true);

  const frame = await bambu.fetchTcpCameraFrame("127.0.0.1", "ACCESS01", 3000, port);
  assert.deepEqual(frame, live.jpeg, "the buffered frame must not be returned");
  assert.equal(auths[0].length, 80);
  assert.equal(auths[0].subarray(16, 20).toString("ascii"), "bblp");
  assert.equal(auths[0].subarray(48, 56).toString("ascii"), "ACCESS01");

  sendLive = false;
  await assert.rejects(bambu.fetchTcpCameraFrame("127.0.0.1", "ACCESS01", 400, port),
    /timed out after 400ms after only the printer's buffered frame, which may be stale; no live frame arrived/);
});

test("camera_snapshot RTSP path: ffmpeg ENOENT yields a clear, actionable error", async () => {
  const bambu = new BambuImplementation(async () => true);
  // Don't mock fetchRtspCameraFrame -- exercise it with a bogus binary
  // path and confirm the surfacing.
  await assert.rejects(
    bambu.cameraSnapshot("127.0.0.1", "S", "T", {
      bambuModel: "h2s",
      ffmpegPath: "/no/such/ffmpeg-binary",
    }),
    /ffmpeg binary not found.*brew install ffmpeg/i
  );
});

test("camera_snapshot save_path writes the jpeg to disk", async (t) => {
  const bambu = new BambuImplementation(async () => true);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0x42, 0x42, 0xff, 0xd9]);
  bambu.fetchTcpCameraFrame = async () => fakeJpeg;

  const outPath = path.join(os.tmpdir(), `snap-${Date.now()}.jpg`);
  t.after(() => { fs.rmSync(outPath, { force: true }); });

  const out = await bambu.cameraSnapshot("127.0.0.1", "S", "T", {
    bambuModel: "p1s",
    savePath: outPath,
  });

  assert.equal(out.savedTo, outPath);
  const onDisk = fs.readFileSync(outPath);
  assert.deepEqual(Buffer.from(onDisk), fakeJpeg);
});

test("delete_printer_file requires confirm:true and skips FTP when omitted", async () => {
  const bambu = new BambuImplementation(async () => true);
  let ftpCalled = false;
  bambu.ftpDelete = async () => {
    ftpCalled = true;
  };

  const result = await bambu.deleteFile(
    "127.0.0.1",
    "0938TEST",
    "TEST_TOKEN",
    "stale.gcode.3mf",
    false
  );

  assert.equal(ftpCalled, false, "ftpDelete must not run without confirm:true");
  assert.equal(result.status, "skipped");
  assert.equal(result.deleted, false);
  assert.match(result.message, /requires confirm:true/);
});

test("delete_printer_file treats loose confirm values as not confirmed", async () => {
  const bambu = new BambuImplementation(async () => true);
  let ftpCalls = 0;
  bambu.ftpDelete = async () => {
    ftpCalls++;
  };

  for (const confirm of [undefined, null, false, "false", "true", 1]) {
    const result = await bambu.deleteFile(
      "127.0.0.1",
      "0938TEST",
      "TEST_TOKEN",
      "stale.gcode.3mf",
      confirm
    );
    assert.equal(result.status, "skipped", `confirm=${JSON.stringify(confirm)} must not delete`);
    assert.equal(result.deleted, false, `confirm=${JSON.stringify(confirm)} must report no deletion`);
  }

  assert.equal(ftpCalls, 0, "ftpDelete must only run for literal confirm:true");
});

test("delete_printer_file rejects path traversal", async () => {
  const bambu = new BambuImplementation(async () => true);
  bambu.ftpDelete = async () => {
    throw new Error("ftpDelete should not be reached on traversal input");
  };

  await assert.rejects(
    bambu.deleteFile("127.0.0.1", "S", "T", "../../etc/passwd", true),
    /path traversal segments are not allowed/i
  );
});

test("delete_printer_file rejects directories outside cache/timelapse/logs", async () => {
  const bambu = new BambuImplementation(async () => true);
  bambu.ftpDelete = async () => {
    throw new Error("ftpDelete should not be reached for disallowed parent");
  };

  await assert.rejects(
    bambu.deleteFile("127.0.0.1", "S", "T", "userdata/secrets.bin", true),
    /refusing to delete outside cache\/, timelapse\/, logs\//i
  );
});

test("delete_printer_file with confirm:true normalizes bare names to cache/ and calls ftpDelete with absolute path", async () => {
  const bambu = new BambuImplementation(async () => true);
  let ftpArgs = null;
  bambu.ftpDelete = async (host, token, remote) => {
    ftpArgs = { host, token, remote };
  };

  const result = await bambu.deleteFile(
    "192.168.1.50",
    "0938TEST",
    "ACCESS_TOKEN",
    "old_print.gcode.3mf",
    true
  );

  assert.deepEqual(ftpArgs, {
    host: "192.168.1.50",
    token: "ACCESS_TOKEN",
    remote: "/cache/old_print.gcode.3mf",
  });
  assert.equal(result.status, "success");
  assert.equal(result.deleted, true);
  assert.equal(result.remotePath, "cache/old_print.gcode.3mf");
});

test("delete_printer_file accepts explicit timelapse/ and logs/ paths", async () => {
  const bambu = new BambuImplementation(async () => true);
  const calls = [];
  bambu.ftpDelete = async (_host, _token, remote) => {
    calls.push(remote);
  };

  await bambu.deleteFile("h", "s", "t", "timelapse/2026-04-26_12-00.mp4", true);
  await bambu.deleteFile("h", "s", "t", "logs/printer.log", true);

  assert.deepEqual(calls, ["/timelapse/2026-04-26_12-00.mp4", "/logs/printer.log"]);
});

test("set_ams_drying rejects invalid action values", async () => {
  const bambu = new BambuImplementation(async () => true);
  bambu.getPrinter = async () => ({
    publish: async () => {},
  });

  await assert.rejects(
    bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "toggle", 0),
    /must be one of: start, stop/i
  );
  await assert.rejects(
    bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "", 0),
    /must be one of: start, stop/i
  );
});

test("set_ams_drying rejects invalid ams_id values", async () => {
  const bambu = new BambuImplementation(async () => true);
  bambu.getPrinter = async () => ({
    publish: async () => {},
  });

  await assert.rejects(
    bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "start", -1),
    /must be an integer from 0 to 3/i
  );
  await assert.rejects(
    bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "start", 4),
    /must be an integer from 0 to 3/i
  );
  await assert.rejects(
    bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "start", -999),
    /must be an integer from 0 to 3/i
  );
});

test("set_ams_drying sends correct MQTT command for start", async () => {
  const bambu = new BambuImplementation(async () => true);
  let publishPayload = null;
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishPayload = payload;
    },
  });

  const result = await bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "start", 1);

  assert.deepEqual(publishPayload, {
    print: {
      command: "ams_control",
      ams_id: 1,
      param: "start_drying",
      sequence_id: "0",
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.action, "start");
  assert.equal(result.ams_id, 1);
  assert.match(result.message, /started.*AMS 1/i);
});

test("set_ams_drying sends correct MQTT command for stop", async () => {
  const bambu = new BambuImplementation(async () => true);
  let publishPayload = null;
  bambu.getPrinter = async () => ({
    publish: async (payload) => {
      publishPayload = payload;
    },
  });

  const result = await bambu.setAmsDrying("127.0.0.1", "SERIAL", "TOKEN", "stop", 0);

  assert.deepEqual(publishPayload, {
    print: {
      command: "ams_control",
      ams_id: 0,
      param: "stop_drying",
      sequence_id: "0",
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.action, "stop");
  assert.equal(result.ams_id, 0);
  assert.match(result.message, /stopped.*AMS 0/i);
});

test("Bambu report snapshots are cleared with connection state", () => {
  const bambu = new BambuImplementation(async () => true);
  const store = bambu.printerStore;
  const key = "127.0.0.1-SERIAL-TOKEN";

  store.updateReportSnapshot(key, {
    gcode_state: "FINISH",
    ams: { ams: [{ tray: [{ tray_info_idx: "STALE" }] }] },
  });

  assert.equal(
    store.getCachedReport("127.0.0.1", "SERIAL", "TOKEN")?.ams?.ams?.[0]?.tray?.[0]?.tray_info_idx,
    "STALE"
  );

  store.clearPrinterState(key);

  assert.equal(
    store.getCachedReport("127.0.0.1", "SERIAL", "TOKEN"),
    null,
    "disconnect/error cleanup must drop stale MQTT snapshots as well as promises"
  );
});

async function writeTemplate3mfFixture(
  templateDir,
  baseName = "template-process",
  processName = "Template Process",
  layerHeight = "0.16"
) {
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({
    type: "process",
    name: processName,
    from: "project",
    layer_height: layerHeight,
  }));
  zip.file(
    "3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="template.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>'
  );
  const templatePath = path.join(templateDir, `${baseName}.3mf`);
  fs.writeFileSync(templatePath, await zip.generateAsync({ type: "nodebuffer" }));
  return templatePath;
}

function writeTemplateJsonFixture(
  templateDir,
  baseName,
  processName,
  layerHeight = "0.12"
) {
  const templatePath = path.join(templateDir, `${baseName}.json`);
  fs.writeFileSync(templatePath, JSON.stringify({
    type: "process",
    name: processName,
    from: "User",
    layer_height: layerHeight,
  }));
  return templatePath;
}

// `result` names a real Bambu Studio result.json in tests/fixtures/studio-result
// for the fake CLI to write to its --outputdir; a nonzero `exitCode` fails the run.
async function createFakeBambuSlicer({ result, exitCode = 0, machine = {} } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcp-template-slicer-"));
  const fakeSlicerPath = path.join(tempDir, "fake-slicer.mjs");
  const argsOutPath = path.join(tempDir, "args.json");
  // The fake executable has no app bundle. Give profile preparation a complete,
  // explicit tree so these tests do not depend on an installed BambuStudio.
  const profilesRoot = path.join(tempDir, "profiles");
  for (const kind of ["machine", "process", "filament"]) {
    fs.mkdirSync(path.join(profilesRoot, "BBL", kind), { recursive: true });
  }
  fs.writeFileSync(path.join(profilesRoot, "BBL", "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab P1S": { downward_check: { "Bambu Lab P1S 0.4 nozzle": ["Bambu Lab A1 0.4 nozzle"] } },
  } }));
  const writeProfile = (kind, profile) => fs.writeFileSync(
    path.join(profilesRoot, "BBL", kind, `${profile.name}.json`), JSON.stringify(profile)
  );
  writeProfile("machine", { name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start", ...machine });
  writeProfile("process", { name: "Behavior process", layer_height: "0.2" });
  writeProfile("filament", { name: "Behavior filament", filament_type: ["PLA"] });
  fs.writeFileSync(
    fakeSlicerPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsOutPath)}, JSON.stringify(args));
const outputDir = args[args.indexOf("--outputdir") + 1] || path.dirname(args[args.indexOf("--export-3mf") + 1]);
const exportArg = args[args.indexOf("--export-3mf") + 1];
const outputPath = path.isAbsolute(exportArg) ? exportArg : path.join(outputDir, exportArg);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
${result ? `fs.copyFileSync(${JSON.stringify(fileURLToPath(new URL(`./fixtures/studio-result/${result}`, import.meta.url)))}, path.join(outputDir, "result.json"));` : ""}
${exitCode ? `process.exit(${exitCode});` : ""}
fs.writeFileSync(outputPath, "fake sliced 3mf");
`
  );
  fs.chmodSync(fakeSlicerPath, 0o755);
  return { tempDir, fakeSlicerPath, argsOutPath, profilesRoot };
}

test("slice_with_template prefers named template settings over BAMBU_SLICER_PROFILE default", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  await writeTemplate3mfFixture(templateDir);
  const defaultProfilePath = path.join(fakeSlicer.tempDir, "default-profile.json");
  fs.writeFileSync(defaultProfilePath, JSON.stringify({ name: "default should not win" }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      BAMBU_SLICER_PROFILE: defaultProfilePath,
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "template-process",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
      use_printer_filaments: false,
    },
  });

  assert.equal(result.isError, undefined);
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const settingsValue = slicerArgs[slicerArgs.indexOf("--load-settings") + 1];
  const processPath = settingsValue.split(";").at(-1);
  const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
  assert.equal(processSettings.name, "Template Process");
  assert.equal(processSettings.layer_height, "0.16");
  assert.ok(!settingsValue.includes(defaultProfilePath), "server-level BAMBU_SLICER_PROFILE must not override a named template");
});

async function sliceWithFakeBambuSlicer(t, options) {
  const fakeSlicer = await createFakeBambuSlicer(options);
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: fakeSlicer.tempDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      BAMBU_SLICER_PROFILE: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      TEMP_DIR: path.join(fakeSlicer.tempDir, "out"),
      SLICER_TYPE: "bambustudio",
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_stl",
    arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, ...options?.arguments },
  });
  return options?.withSlicer ? { result, fakeSlicer } : result;
}

// Slicing the same model the same way again reuses the kept slice (src/slicer/slice-cache.ts): the slicer
// doesn't run, and the result, Studio's result.json included, is the first slice's. Anything that shapes the
// slice (here the model's bytes) slices again, and SLICE_CACHE=off always slices.
test("slice_stl reuses an identical earlier slice, and slices again when an input changes", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer({ result: "p1s-floating-cantilever.json" });
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const model = path.join(fakeSlicer.tempDir, "model.stl");
  fs.copyFileSync(SAMPLE_STL, model);
  const connect = async (extra = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER_ENTRY], cwd: fakeSlicer.tempDir,
      env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_SLICER_PROFILE: "",
        BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot, TEMP_DIR: path.join(fakeSlicer.tempDir, "out"), SLICER_TYPE: "bambustudio",
        MCP_ALLOW_EXECUTABLE_ARG: "1", SLICE_CACHE: "on", SLICE_CACHE_DIR: path.join(fakeSlicer.tempDir, "cache"), ...extra },
      stderr: "pipe",
    });
    const client = createClient();
    t.after(async () => { await closeTransport(transport); });
    await client.connect(transport);
    return client;
  };
  const slice = client => client.callTool({ name: "slice_stl",
    arguments: { stl_path: model, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false } });
  const ran = () => { const yes = fs.existsSync(fakeSlicer.argsOutPath); fs.rmSync(fakeSlicer.argsOutPath, { force: true }); return yes; };
  const client = await connect();
  const first = await slice(client);
  assert.equal(first.isError, undefined, first.content?.[0]?.text);
  assert.equal(ran(), true);
  fs.rmSync(first.structuredContent.path);
  // A new server process (an MCP restart) still has it.
  const again = await slice(await connect());
  assert.equal(again.isError, undefined, again.content?.[0]?.text);
  assert.equal(ran(), false, "the slicer did not run again");
  assert.equal(fs.readFileSync(again.structuredContent.path, "utf8"), "fake sliced 3mf");
  assert.deepEqual(again.structuredContent.slicer_result, first.structuredContent.slicer_result, "Studio's words come back with it");
  fs.appendFileSync(model, " ");
  assert.equal((await slice(client)).isError, undefined);
  assert.equal(ran(), true, "a changed model slices again");
  assert.equal((await slice(await connect({ SLICE_CACHE: "off" }))).isError, undefined);
  assert.equal(ran(), true, "SLICE_CACHE=off always slices");
});

const studioResult = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/studio-result/${name}`, import.meta.url), "utf8"));

// Nov 6: opening Counterpart's Print sheet started four slices of one model at once, each named model.3mf. They all
// wrote TEMP_DIR/model_sliced.3mf and TEMP_DIR/result.json, and each run deleted the result.json the others were about
// to read. Overlapping slices of same-named inputs now each get their own folder, sliced file and result.json.
async function startOverlapSlicer(t, { holdMs = 0, env = {} } = {}) {
  const fakeSlicer = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const pids = path.join(fakeSlicer.tempDir, "pids");
  fs.mkdirSync(pids);
  const fixtures = fileURLToPath(new URL("./fixtures/studio-result/", import.meta.url));
  // Writes result.json first, waits (so overlapping runs interleave), then the sliced file: a model in a folder named
  // "refused" fails the way Studio's empty-layer refusal does; any other succeeds with a cantilever warning.
  fs.writeFileSync(fakeSlicer.fakeSlicerPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.writeFileSync(path.join(${JSON.stringify(pids)}, String(process.pid)), args.join("\\n"));
const outputDir = args[args.indexOf("--outputdir") + 1];
const input = args.at(-1);
const refused = path.basename(path.dirname(input)) === "refused";
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(path.join(${JSON.stringify(fixtures)}, refused ? "p1s-empty-layers.json" : "p1s-floating-cantilever.json"), path.join(outputDir, "result.json"));
await new Promise(resolve => setTimeout(resolve, ${holdMs} || 400));
if (refused) process.exit(156);
fs.writeFileSync(path.join(outputDir, args[args.indexOf("--export-3mf") + 1]), "sliced " + input);
`);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], cwd: fakeSlicer.tempDir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_SLICER_PROFILE: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot, TEMP_DIR: path.join(fakeSlicer.tempDir, "out"), SLICER_TYPE: "bambustudio",
      MCP_ALLOW_EXECUTABLE_ARG: "1", SLICE_CACHE: "on", SLICE_CACHE_DIR: path.join(fakeSlicer.tempDir, "cache"), ...env },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const model = (folder, extra = "") => {
    const file = path.join(fakeSlicer.tempDir, folder, "model.stl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.readFileSync(SAMPLE_STL, "utf8") + extra);
    return file;
  };
  const slice = (stl_path, options) => client.callTool({ name: "slice_stl",
    arguments: { stl_path, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false } }, undefined, options);
  return { fakeSlicer, pids, model, slice, cache: path.join(fakeSlicer.tempDir, "cache") };
}

test("overlapping slices of same-named models each keep their own sliced file and result.json", async (t) => {
  const { model, slice, fakeSlicer } = await startOverlapSlicer(t);
  const inputs = [model("first"), model("refused", " "), model("third", "  "), model("fourth", "   ")];
  const results = await Promise.all(inputs.map(input => slice(input)));
  const [first, refused, third, fourth] = results;
  // The refusal is its own: Studio's empty-layer words, never a neighbour's success.
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.structuredContent.slicer_result, studioResult("p1s-empty-layers.json"));
  assert.equal(refused.structuredContent.slicer_report.failed, true);
  const paths = new Set();
  for (const [index, result] of [[0, first], [2, third], [3, fourth]]) {
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.deepEqual(result.structuredContent.slicer_result, studioResult("p1s-floating-cantilever.json"));
    assert.equal(result.structuredContent.slicer_report.failed, false);
    // Each returned file is the one sliced from its own model.
    assert.equal(fs.readFileSync(result.structuredContent.path, "utf8"), `sliced ${inputs[index]}`);
    assert.match(result.structuredContent.path, /model_sliced\.3mf$/);
    paths.add(result.structuredContent.path);
  }
  assert.equal(paths.size, 3, "every slice has its own output path");
  // The refused slice's folder is gone; the three that worked keep theirs.
  assert.equal(fs.readdirSync(path.join(fakeSlicer.tempDir, "out", "slices")).length, 3);
  // Profiles generated for these slices are whole JSON files, never half-written by a neighbour.
  for (const name of fs.readdirSync(path.join(fakeSlicer.tempDir, "out")).filter(name => name.endsWith(".json")))
    JSON.parse(fs.readFileSync(path.join(fakeSlicer.tempDir, "out", name), "utf8"));
  assert.deepEqual(fs.readdirSync(path.join(fakeSlicer.tempDir, "out")).filter(name => name.endsWith(".partial")), []);
});

test("an identical slice still reuses the kept one from its own folder", async (t) => {
  const { model, slice, pids } = await startOverlapSlicer(t);
  const input = model("again");
  const first = await slice(input);
  assert.equal(first.isError, undefined, first.content?.[0]?.text);
  const again = await slice(input);
  assert.equal(again.isError, undefined, again.content?.[0]?.text);
  assert.equal(fs.readdirSync(pids).length, 1, "the slicer ran once; the second slice was restored from the cache");
  assert.notEqual(again.structuredContent.path, first.structuredContent.path);
  assert.equal(fs.readFileSync(again.structuredContent.path, "utf8"), `sliced ${input}`);
});

// A client that no longer wants a slice (Counterpart's sheet moved on to newer settings) cancels the call: the
// slicer is stopped, and nothing half-finished is kept for reuse.
test("a cancelled slice_stl call stops the slicer and keeps nothing", async (t) => {
  const { model, slice, pids, cache, fakeSlicer } = await startOverlapSlicer(t, { holdMs: 30000 });
  const controller = new AbortController();
  const call = slice(model("cancelled"), { signal: controller.signal });
  call.catch(() => undefined);
  const started = Date.now();
  while (!fs.readdirSync(pids).length && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 50));
  const [pid] = fs.readdirSync(pids).map(Number);
  assert.ok(pid, "the slicer started");
  controller.abort();
  await assert.rejects(call);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stopping = Date.now();
  while (alive() && Date.now() - stopping < 5000) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the slicer process was stopped");
  const slices = path.join(fakeSlicer.tempDir, "out", "slices");
  assert.deepEqual(fs.existsSync(slices) ? fs.readdirSync(slices) : [], [], "the cancelled slice's folder is removed");
  assert.deepEqual(fs.existsSync(cache) ? fs.readdirSync(cache).filter(name => /^[0-9a-f]{64}$/.test(name)) : [], []);
});

// Bambu Studio 02.08.02.61 sliced the fin-down stove gap filler for a P1S and
// warned about a floating cantilever; slice_stl used to drop that warning.
test("slice_stl returns Bambu Studio's result.json, warnings included, in structuredContent", async (t) => {
  const result = await sliceWithFakeBambuSlicer(t, { result: "p1s-floating-cantilever.json" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, result.structuredContent.path);
  assert.match(result.structuredContent.path, /_sliced\.3mf$/);
  assert.deepEqual(result.structuredContent.slicer_result, studioResult("p1s-floating-cantilever.json"));
  assert.match(result.structuredContent.slicer_result.sliced_plates[0].warning_message, /floating cantilever/);
  // Its verdict and words, so a client never reads result.json's format (Counterpart PRD §8.0 item 9).
  assert.equal(result.structuredContent.slicer_report.failed, false);
  assert.match(result.structuredContent.slicer_report.message, /floating cantilever/);
});

// Bambu Studio's auto-orient tilted the gap filler and failed with return
// code -100 (exit 156) and an empty-layer list per plate.
// A person is told a plain sentence; Studio's own words follow for the log, and stay whole in slicer_message.
test("a failed slice_stl leads with a plain sentence, keeps Bambu Studio's words and carries its result.json", async (t) => {
  const result = await sliceWithFakeBambuSlicer(t, { result: "p1s-empty-layers.json", exitCode: 156 });
  const expected = studioResult("p1s-empty-layers.json");
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.slicer_result, expected);
  const plain = "The slicer couldn't slice this model. Its own message is kept for the log.";
  const studioWords = `${expected.error_string}\n${expected.sliced_plates[0].warning_message.trim()}\n`;
  assert.ok(result.content[0].text.startsWith(`${plain}\nThe slicer said: ${studioWords}`), result.content[0].text);
  assert.match(result.content[0].text, /Slicer failed: the slicer exited with code 156 \(Failed slicing the model\./);
  assert.ok(result.structuredContent.message.startsWith(`${plain}\nThe slicer said: ${studioWords}`));
  assert.equal(result.structuredContent.slicer_report.failed, true);
  assert.equal(result.structuredContent.slicer_report.message, plain);
  assert.ok(result.structuredContent.slicer_report.slicer_message.startsWith(expected.error_string));
});

// The CLI's own return code fails the slice even when the process exits 0.
test("slice_stl fails when Bambu Studio's result.json reports an error but the CLI exits 0", async (t) => {
  const result = await sliceWithFakeBambuSlicer(t, { result: "p1s-empty-layers.json" });
  const expected = studioResult("p1s-empty-layers.json");
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.slicer_result, expected);
  assert.ok(result.content[0].text.startsWith(`The slicer couldn't slice this model. Its own message is kept for the log.\nThe slicer said: ${expected.error_string}\n`), result.content[0].text);
  assert.match(result.content[0].text, /exited with code 0, but its result\.json reports return_code -100\.$/);
});

// A slicer that writes no result.json keeps the old shape: no slicer_result.
test("slice_stl without a result.json returns the path and no slicer_result", async (t) => {
  const result = await sliceWithFakeBambuSlicer(t, {});
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent, { path: result.content[0].text });
});

// Studio's empty-plate refusal reaches a person as a sentence; its words stay in slicer_message for the log.
test("a slice_stl refusal with no result.json still carries a plain slicer_report", async (t) => {
  const result = await sliceWithFakeBambuSlicer(t, { exitCode: 206 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.slicer_report.failed, true);
  assert.equal(result.structuredContent.slicer_report.message, "Nothing on this plate can be printed: no part sits fully on the bed. A part is off the plate or across its edge, or the model is bigger than the bed.");
  assert.match(result.structuredContent.slicer_report.slicer_message, /a plate is empty or has no object fully inside it/);
  assert.ok(result.content[0].text.startsWith(result.structuredContent.slicer_report.message), result.content[0].text);
});

// A closed binary STL of axis-aligned boxes, each its own shell.
function boxesStl(boxes) {
  const corners = ([x0, y0, z0], [x1, y1, z1]) => [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + boxes.length * faces.length * 50);
  buffer.writeUInt32LE(boxes.length * faces.length, 80);
  let offset = 84;
  for (const [min, max] of boxes) {
    const vertices = corners(min, max);
    for (const face of faces) {
      offset += 12;
      for (const vertex of face) for (const value of vertices[vertex]) { buffer.writeFloatLE(value, offset); offset += 4; }
      offset += 2;
    }
  }
  return buffer;
}

// The real Bambu Studio CLI, where it is installed (CI skips): a T standing on
// its stem, its 60 mm cap 26 mm up, slices with a floating-cantilever warning.
const installedStudio = process.env.BAMBU_STUDIO_CLI || "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
test("the installed Bambu Studio's floating-cantilever warning reaches sliceSTLWithResult's slicer_result", {
  skip: !fs.existsSync(installedStudio) && "Bambu Studio is not installed",
  timeout: 300_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-result-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tee = path.join(directory, "tee.stl");
  fs.writeFileSync(tee, boxesStl([[[-2, 0, 0], [2, 40, 26]], [[-30, 0, 26], [30, 40, 30]]]));
  const sliced = await new STLManipulator(directory).sliceSTLWithResult(
    tee, "bambustudio", installedStudio, undefined, undefined, "Bambu Lab P1S 0.4 nozzle", { bedType: "textured_plate" });
  assert.ok(fs.existsSync(sliced.path));
  assert.equal(sliced.slicer_result.return_code, 0);
  assert.deepEqual(sliced.slicer_result.sliced_plates.map(plate => plate.warning_message),
    ["It seems object tee.stl has floating cantilever. Please re-orient the object or enable support generation."]);
});

test("slice_stl writes enable_support, support_type and support_threshold_angle over the resolved process preset", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], cwd: fakeSlicer.tempDir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_SLICER_PROFILE: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot, TEMP_DIR: path.join(fakeSlicer.tempDir, "out"), SLICER_TYPE: "bambustudio", MCP_ALLOW_EXECUTABLE_ARG: "1" },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "slice_stl").inputSchema.properties;
  assert.deepEqual([schema.enable_support.type, schema.support_type.enum, schema.support_threshold_angle.type],
    ["boolean", ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"], "integer"]);
  const result = await client.callTool({ name: "slice_stl", arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s",
    slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, enable_support: true, support_type: "tree(auto)", support_threshold_angle: 35 } });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const processPath = slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";").at(-1);
  const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
  assert.deepEqual([processSettings.enable_support, processSettings.support_type, processSettings.support_threshold_angle, processSettings.layer_height],
    ["1", "tree(auto)", "35", "0.2"], "only the support keys change; the rest of the preset stays as resolved");
  const refused = await client.callTool({ name: "slice_stl", arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s",
    slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, support_type: "organic" } });
  assert.equal(refused.isError, true);
});

test("slice_stl's quality and strength become the slicer's own layer height, walls and infill for the nozzle in use", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], cwd: fakeSlicer.tempDir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_SLICER_PROFILE: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot, TEMP_DIR: path.join(fakeSlicer.tempDir, "out"), SLICER_TYPE: "bambustudio", MCP_ALLOW_EXECUTABLE_ARG: "1" },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "slice_stl").inputSchema.properties;
  assert.deepEqual([schema.quality.enum, schema.strength.enum], [["draft", "standard", "fine"], ["standard", "strong", "max"]]);
  const sliceWith = async (extra) => {
    const result = await client.callTool({ name: "slice_stl", arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, ...extra } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    const processPath = slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";").at(-1);
    const { layer_height, wall_loops, sparse_infill_density } = JSON.parse(fs.readFileSync(processPath, "utf8"));
    return { layer_height, wall_loops, sparse_infill_density };
  };
  assert.deepEqual(await sliceWith({ quality: "fine", strength: "max" }), { layer_height: "0.12", wall_loops: "6", sparse_infill_density: "40%" });
  assert.deepEqual(await sliceWith({ quality: "draft", strength: "strong" }), { layer_height: "0.28", wall_loops: "4", sparse_infill_density: "25%" });
  assert.equal((await sliceWith({ quality: "standard", strength: "standard" })).layer_height, "0.2", "standard keeps the preset's own value");
  assert.equal((await sliceWith({ quality: "fine", layer_height: 0.16 })).layer_height, "0.16", "an explicit layer_height wins");
  const refused = await client.callTool({ name: "slice_stl", arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s",
    slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, quality: "ultra" } });
  assert.equal(refused.isError, true);  // Copies on a backend that can't make them say so instead of slicing one (capabilities.slicing.copies is false there).
  const noCopies = await client.callTool({ name: "slice_stl", arguments: { stl_path: SAMPLE_STL, bambu_model: "p1s",
    slicer_type: "prusaslicer", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, repetitions: 3 } });
  assert.equal(noCopies.isError, true);
  assert.match(noCopies.content[0].text, /Copies \(repetitions\) need the Bambu Studio or OrcaSlicer CLI, not prusaslicer/);
});

test("a designer's 3MF slices with its own process; strength never weakens it; a bare 3MF keeps the preset", async (t) => {
  // 2026-11-04: a designer's caliper card (0.16 mm, 100% infill, 2 walls) was sliced at the preset's
  // values, and Strong lowered its infill to 25%: its fold hinges and snaps no longer worked.
  const fakeSlicer = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], cwd: fakeSlicer.tempDir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_SLICER_PROFILE: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot, TEMP_DIR: path.join(fakeSlicer.tempDir, "out"), SLICER_TYPE: "bambustudio", MCP_ALLOW_EXECUTABLE_ARG: "1" },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const model = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const write3mf = async (name, settings) => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    zip.file("3D/3dmodel.model", model);
    if (settings) zip.file("Metadata/project_settings.config", JSON.stringify(settings));
    const file = path.join(fakeSlicer.tempDir, name);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    return file;
  };
  const designer = await write3mf("designer.3mf", { layer_height: "0.16", sparse_infill_density: "100%", wall_loops: "2", top_shell_layers: "6", print_settings_id: "Designer",
    filament_settings_id: ["Bambu PLA Basic @BBL X1C"], filament_type: ["PLA"], filament_colour: ["#000000"] });
  const bare = await write3mf("bare.3mf");
  const sliceWith = async (file, extra = {}) => {
    const result = await client.callTool({ name: "slice_stl", arguments: { stl_path: file, bambu_model: "p1s", slice_plate: 1, arrange: false, orient: false,
      slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, ...extra } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    const processPath = slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";").at(-1);
    const { layer_height, wall_loops, sparse_infill_density } = JSON.parse(fs.readFileSync(processPath, "utf8"));
    return { layer_height, wall_loops, sparse_infill_density };
  };
  assert.deepEqual(await sliceWith(designer), { layer_height: "0.16", wall_loops: "2", sparse_infill_density: "100%" }, "the designer's own process");
  assert.deepEqual(await sliceWith(designer, { strength: "strong" }), { layer_height: "0.16", wall_loops: "4", sparse_infill_density: "100%" },
    "strong adds walls but keeps the designer's denser infill");
  assert.equal((await sliceWith(designer, { quality: "fine" })).layer_height, "0.12", "a chosen quality still applies");
  assert.equal((await sliceWith(designer, { sparse_infill_density: "20%" })).sparse_infill_density, "20%", "an explicit value is written as given");
  assert.equal((await sliceWith(bare)).layer_height, "0.2", "a 3MF without its own process keeps the preset");
  // get_slice_settings says which of the two slice_stl just did, so a client never reads the 3MF itself.
  const settingsOf = file => client.callTool({ name: "get_slice_settings", arguments: { source_path: file } });
  assert.equal(parseJsonResult(await settingsOf(designer)).own_process, true, "the designer's 3MF slices with its own process");
  const machineOnly = await write3mf("machine-only.3mf", { printer_model: "Bambu Lab P1S" });
  assert.equal(parseJsonResult(await settingsOf(machineOnly)).own_process, false, "settings without a process slice with the preset");
  // The slice's own arguments, as slice_stl takes them: own_process is what that slice does, decided here.
  const forSlice = async extra => parseJsonResult(await client.callTool({ name: "get_slice_settings", arguments: { source_path: designer, ...extra } })).own_process;
  assert.equal(await forSlice({ quality: "standard", strength: "standard" }), true, "standard changes nothing");
  assert.equal(await forSlice({ layer_height: 0.42, nozzle_diameter: "0.6" }), false, "a layer height valid for the slice's own nozzle is checked against it");
  for (const extra of [{ slicer_profile: path.join(fakeSlicer.tempDir, "mine.json") }, { template_3mf_path: bare }, { layer_height: 0.2 }, { wall_loops: 3 },
    { sparse_infill_density: "20%" }, { quality: "fine" }, { strength: "strong" }, { enable_support: false }])
    assert.equal(await forSlice(extra), false, `${Object.keys(extra)[0]} replaces or changes the designer's process`);
  // With source_path, template_name is the slice's template, as slice_stl takes it, never the file read.
  const templates = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(templates, "house.json"), JSON.stringify({ layer_height: "0.2" }));
  assert.equal(await forSlice({ template_name: "house", template_dir: templates }), false, "a named template replaces the designer's process");
  for (const invalid of [{ quality: "bogus" }, { layer_height: -1 }, { sparse_infill_density: "200%" }, { support_type: "organic" },
    { slicer_profile: path.join(fakeSlicer.tempDir, "mine.json"), layer_height: -1 }])
    assert.equal((await client.callTool({ name: "get_slice_settings", arguments: { source_path: designer, ...invalid } })).isError, true,
      `${JSON.stringify(invalid)} is refused, as slice_stl refuses it`);
  // A 3MF with no settings says so, so a client can tell "none to keep" from a file it couldn't read.
  const noneReply = await settingsOf(bare);
  assert.equal(noneReply.isError, undefined, noneReply.content?.[0]?.text);
  const none = parseJsonResult(noneReply);
  assert.equal(none.raw_key_count, 0);
  assert.equal(none.own_process, false);
  assert.equal(none.extracted_settings_path, undefined);
  const unreadable = path.join(fakeSlicer.tempDir, "unreadable.3mf");
  fs.writeFileSync(unreadable, "not a zip");
  assert.equal((await settingsOf(unreadable)).isError, true, "a file that can't be read is an error, not a file without settings");
  const corrupt = path.join(fakeSlicer.tempDir, "corrupt.3mf");
  const corruptZip = new JSZip();
  corruptZip.file("3D/3dmodel.model", model);
  corruptZip.file("Metadata/project_settings.config", '{"layer_height": "0.16", "sparse_infill_dens');
  fs.writeFileSync(corrupt, await corruptZip.generateAsync({ type: "nodebuffer" }));
  assert.equal((await settingsOf(corrupt)).isError, true, "settings that can't be read are an error, not a file without settings");
  // A PrusaSlicer project's settings are read too, not refused as unreadable.
  const prusa = path.join(fakeSlicer.tempDir, "prusa.3mf");
  const prusaZip = new JSZip();
  prusaZip.file("3D/3dmodel.model", model);
  prusaZip.file("Metadata/Slic3r_PE.config", "; generated by PrusaSlicer\nlayer_height = 0.15\nfill_density = 20%\n");
  fs.writeFileSync(prusa, await prusaZip.generateAsync({ type: "nodebuffer" }));
  const prusaSettings = parseJsonResult(await settingsOf(prusa));
  assert.equal(prusaSettings.raw_key_count, 2);
  assert.ok(fs.existsSync(prusaSettings.extracted_settings_path));
  // Each slice extracted the designer's settings to its own directory and removed it when the call ended;
  // get_slice_settings hands its path back, so that one stays.
  const extracted = parseJsonResult(await settingsOf(designer)).extracted_settings_path;
  assert.ok(fs.existsSync(extracted));
  assert.deepEqual(fs.readdirSync(path.join(fakeSlicer.tempDir, "out")).filter(entry => /^(slicer-settings-|[0-9a-f]{16}_Metadata_)/.test(entry)), [],
    "no slice leaves its extraction behind");
});

test("quality scales with the nozzle: draft on a 0.6 mm nozzle is 0.42 mm", async () => {
  const { withPrintQuality } = await import("../dist/slicer/print-quality.js");
  assert.equal(withPrintQuality({ quality: "draft" }, 0.6).layer_height, 0.42);
  assert.equal(withPrintQuality({ quality: "fine" }, 0.2).layer_height, 0.06);
  assert.deepEqual(withPrintQuality({ stl_path: "x" }, 0.4), { stl_path: "x" }, "nothing asked, nothing written");
  assert.throws(() => withPrintQuality({ strength: "huge" }, 0.4), /strength must be one of/);
  assert.throws(() => withPrintQuality({ strength: null }, 0.4), /strength must be one of/, "null is not Standard");
});

test("the installed Bambu Studio generates supports only when slice_stl's enable_support asks for them", {
  skip: !fs.existsSync(installedStudio) && "Bambu Studio is not installed",
  timeout: 600_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-supports-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // A T: a narrow stem under a wide, unsupported cap.
  const tee = boxesStl([[[-2, 0, 0], [2, 40, 26]], [[-30, 0, 26], [30, 40, 30]]]);
  const manipulator = new STLManipulator(directory);
  // Studio's own record of the slice: the project settings it used and whether the plate used supports.
  const slice = async (overrides, name) => {
    const stl = path.join(directory, `${name}.stl`);
    fs.writeFileSync(stl, tee);
    const sliced = await manipulator.sliceSTLWithResult(stl, "bambustudio", installedStudio, undefined, undefined,
      "Bambu Lab P1S 0.4 nozzle", { bedType: "textured_plate", processOverrides: overrides });
    const zip = await JSZip.loadAsync(fs.readFileSync(sliced.path));
    const settings = JSON.parse(await zip.file("Metadata/project_settings.config").async("string"));
    const info = await zip.file("Metadata/slice_info.config").async("string");
    return { settings, supportUsed: /key="support_used" value="true"/.test(info) };
  };
  const on = await slice({ enable_support: "1", support_type: "tree(auto)", support_threshold_angle: "35" }, "on");
  assert.deepEqual([on.settings.enable_support, on.settings.support_type, on.settings.support_threshold_angle], ["1", "tree(auto)", "35"]);
  assert.equal(on.supportUsed, true);
  const off = await slice({ enable_support: "0" }, "off");
  assert.equal(off.settings.enable_support, "0");
  assert.equal(off.supportUsed, false);
});

test("relative TEMP_DIR and profile, filament and model paths reach the slicer as absolute paths", async (t) => {
  // BambuStudio 2.8.2.61 fails every export ("return_code=-13") when
  // --outputdir is relative, so a TEMP_DIR=./temp .env broke all slicing.
  const fakeSlicer = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true }));
  // The child's cwd is the real path (/private/var on macOS, not /var).
  const cwd = fs.realpathSync(fakeSlicer.tempDir);
  fs.copyFileSync(SAMPLE_STL, path.join(cwd, "box.stl"));
  fs.writeFileSync(path.join(cwd, "process.json"), JSON.stringify({ name: "Relative process", inherits: "Behavior process", layer_height: "0.16" }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      TEMP_DIR: "./temp",
      BAMBU_PROFILES_ROOT: "profiles",
      BAMBU_SLICER_PROFILE_DIRS: "",
      BAMBU_SLICER_PROFILE: "",
      SLICER_PROFILE: "",
      BAMBU_TEMPLATE_3MF_PATH: "",
      SLICER_TYPE: "bambustudio",
      SLICER_PATH: "",
      BAMBU_MODEL: "p1s",
      BAMBU_PRINTER_MODEL: "",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_stl",
    arguments: {
      stl_path: "box.stl",
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
      slicer_profile: "process.json",
      load_filaments: path.join("profiles", "BBL", "filament", "Behavior filament.json"),
      use_printer_filaments: false,
    },
  });

  assert.notEqual(result.isError, true, JSON.stringify(result));
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const valueOf = (flag) => {
    assert.ok(slicerArgs.includes(flag), `${flag} missing from ${JSON.stringify(slicerArgs)}`);
    return slicerArgs[slicerArgs.indexOf(flag) + 1];
  };
  const tempRoot = path.join(cwd, "temp");
  // Each slice writes into a folder of its own under TEMP_DIR (TEMP_DIR/slices/<operation>).
  const sliceDir = valueOf("--outputdir");
  assert.equal(path.dirname(sliceDir), path.join(tempRoot, "slices"));
  assert.equal(slicerArgs.at(-1), path.join(cwd, "box.stl"));
  const settings = valueOf("--load-settings").split(";");
  const filaments = valueOf("--load-filaments").split(";");
  assert.equal(settings.length, 2);
  for (const entry of [...settings, ...filaments]) {
    assert.ok(path.isAbsolute(entry), `${entry} must be absolute`);
    assert.ok(fs.existsSync(entry), `${entry} must exist`);
  }
  assert.equal(JSON.parse(fs.readFileSync(settings[1], "utf8")).layer_height, "0.16");
  const outputPath = path.join(sliceDir, "box_sliced.3mf");
  assert.ok(fs.existsSync(outputPath), "the sliced 3MF must be written under the resolved TEMP_DIR");
  assert.ok(result.content[0].text.includes(outputPath), result.content[0].text);
});

test("template machine settings never replace the selected machine preset", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", printer_model: "Bambu Lab P1S", nozzle_diameter: ["0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  // A project sliced for another printer stores that printer's machine settings in project_settings.
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({
    printer_model: "Bambu Lab X1 Carbon", printer_settings_id: "Bambu Lab X1 Carbon 0.4 nozzle",
    machine_start_gcode: "; TEMPLATE_MACHINE_MARKER", nozzle_diameter: ["0.6"], layer_height: "0.16",
  }));
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  const templatePath = path.join(templateDir, "x1c-project.3mf");
  fs.writeFileSync(templatePath, await zip.generateAsync({ type: "nodebuffer" }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      BAMBU_SLICER_PROFILE: "",
      BAMBU_TEMPLATE_3MF_PATH: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      BAMBU_SLICER_PROFILE_DIRS: "",
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  for (const [name, template] of [
    ["slice_stl", { template_3mf_path: templatePath }],
    ["slice_with_template", { template_name: "x1c-project", template_dir: templateDir }],
  ]) {
    const result = await client.callTool({
      name,
      arguments: {
        stl_path: SAMPLE_STL,
        ...template,
        bambu_model: "p1s",
        slicer_path: fakeSlicer.fakeSlicerPath,
        use_printer_filaments: false,
      },
    });

    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    const [machinePath, processPath] = slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";");
    const machine = JSON.parse(fs.readFileSync(machinePath, "utf8"));
    assert.equal(machine.machine_start_gcode, "fixture start");
    assert.equal(machine.printer_model, "Bambu Lab P1S");
    const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
    assert.equal(processSettings.layer_height, "0.16", `${name} keeps template process settings`);
    for (const key of ["machine_start_gcode", "printer_model", "nozzle_diameter"]) {
      assert.equal(key in processSettings, false, `${name}: template ${key} must not reach the CLI`);
    }
  }
});

test("slice_stl writes the installed nozzle type into the machine preset so printing can match the printer", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], nozzle_type: ["stainless_steel"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  const connect = async (extraEnv = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "",
        BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
        BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1", ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = createClient();
    t.after(async () => { await closeTransport(transport); });
    await client.connect(transport);
    return (extra) => client.callTool({ name: "slice_stl", arguments: {
      stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, ...extra,
    } });
  };
  const machine = () => {
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    return JSON.parse(fs.readFileSync(slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  };
  const slice = await connect();
  let result = await slice({ nozzle_type: "hardened_steel" });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["hardened_steel"]);
  // Without a choice the preset's stock nozzle is kept.
  result = await slice({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["stainless_steel"]);
  // Invalid values stop before the slicer runs.
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_type: "diamond" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid nozzle type/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
  // BAMBU_NOZZLE_TYPE supplies the default.
  result = await (await connect({ BAMBU_NOZZLE_TYPE: "hardened-steel" }))({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["hardened_steel"]);
});

test("slice_stl slices for the installed nozzle flow type and refuses one the preset lacks", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const writeMachine = (variants) => fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], extruder_type: ["Direct Drive"], extruder_variant_list: [variants],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  writeMachine("Direct Drive Standard,Direct Drive High Flow");
  const connect = async (extraEnv = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_SERIAL: "", BAMBU_TOKEN: "",
        BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
        BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1", ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = createClient();
    t.after(async () => { await closeTransport(transport); });
    await client.connect(transport);
    return (extra) => client.callTool({ name: "slice_stl", arguments: {
      stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, use_printer_filaments: false, ...extra,
    } });
  };
  const machine = () => {
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    return JSON.parse(fs.readFileSync(slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  };
  const slice = await connect();
  let result = await slice({ nozzle_volume_type: "high_flow" });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["High Flow"]);
  // Without a choice the preset's Standard default is kept.
  result = await slice({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["Standard"]);
  // Invalid values stop before the slicer runs.
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_volume_type: "turbo" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid nozzle volume type/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
  // BAMBU_NOZZLE_VOLUME_TYPE supplies the default.
  result = await (await connect({ BAMBU_NOZZLE_VOLUME_TYPE: "High Flow" }))({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["High Flow"]);
  // A preset without High Flow values is refused rather than mislabelled.
  writeMachine("Direct Drive Standard");
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_volume_type: "high_flow" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /declares no High Flow variant/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
});

test("template_name resolves by source type for slicer profiles versus 3MF sources", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  await writeTemplate3mfFixture(templateDir, "shared-template", "3MF Template", "0.20");
  await writeTemplateJsonFixture(templateDir, "shared-template", "JSON Template", "0.12");
  await writeTemplateJsonFixture(templateDir, "My Template", "Space Template", "0.18");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const inspected = await client.callTool({
    name: "get_slice_settings",
    arguments: {
      template_name: "shared-template",
      template_dir: templateDir,
    },
  });
  assert.equal(inspected.isError, undefined);
  assert.equal(parseJsonResult(inspected).source_type, "3mf");

  const sliced = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "shared-template",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
      use_printer_filaments: false,
    },
  });

  assert.equal(sliced.isError, undefined);
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const settingsValue = slicerArgs[slicerArgs.indexOf("--load-settings") + 1];
  const processPath = settingsValue.split(";").at(-1);
  const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
  assert.equal(processSettings.name, "JSON Template");
  assert.equal(processSettings.layer_height, "0.12");

  const spaced = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "My Template",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
      use_printer_filaments: false,
    },
  });

  assert.equal(spaced.isError, undefined);
  const spacedSlicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const spacedSettingsValue = spacedSlicerArgs[spacedSlicerArgs.indexOf("--load-settings") + 1];
  const spacedProcessPath = spacedSettingsValue.split(";").at(-1);
  const spacedProcessSettings = JSON.parse(fs.readFileSync(spacedProcessPath, "utf8"));
  assert.equal(spacedProcessSettings.name, "Space Template");
  assert.equal(spacedProcessSettings.layer_height, "0.18");
});

test("non-slicer tools ignore invalid slicer configuration", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      SLICER_TYPE: "definitely-not-a-real-slicer",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  const result = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  assert.equal(result.isError, undefined);
  const payload = parseJsonResult(result);
  assert.equal(payload.fileName, "sample_cube.stl");
});

test("per-call executable selectors are rejected before any process can start", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-executable-selector-gate-"));
  const executable = path.join(tempDir, "unexpected-executable");
  const markerPath = path.join(tempDir, "executed");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf executed > '${markerPath}'\nexit 17\n`,
    { mode: 0o755 }
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_NETWORK_BRIDGE_COMMAND: "",
      BLENDER_MCP_BRIDGE_COMMAND: "",
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
    },
    stderr: "pipe",
  });
  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);

  for (const call of [
    {
      name: "slice_stl",
      argumentName: "slicer_path",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: "orcaslicer",
        slicer_path: executable,
        bambu_model: "p1s",
      },
    },
    {
      name: "bambu_network_bridge_status",
      argumentName: "bridge_command",
      arguments: { connect: true, bridge_command: executable },
    },
    {
      name: "blender_mcp_edit_model",
      argumentName: "bridge_command",
      arguments: {
        stl_path: SAMPLE_STL,
        operations: ["remesh"],
        execute: true,
        bridge_command: executable,
      },
    },
    {
      name: "camera_snapshot",
      argumentName: "ffmpeg_path",
      arguments: {
        bambu_model: "h2s",
        ffmpeg_path: executable,
        timeout_ms: 100,
      },
    },
  ]) {
    fs.rmSync(markerPath, { force: true });
    const rejected = await client.callTool({
      name: call.name,
      arguments: call.arguments,
    });
    assert.equal(rejected.isError, true, `${call.name} must reject ${call.argumentName}`);
    assert.match(rejected.content?.[0]?.text || "", new RegExp(call.argumentName));
    assert.match(rejected.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
    assert.equal(
      fs.existsSync(markerPath),
      false,
      `${call.name} must reject ${call.argumentName} before executing it`
    );
  }
});

test("legacy bridge opt-in does not authorize slicer or ffmpeg executables", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-legacy-bridge-gate-"));
  const executable = path.join(tempDir, "unexpected-executable");
  const markerPath = path.join(tempDir, "executed");
  const bridgeExecutable = path.join(tempDir, "trusted-legacy-bridge");
  const bridgeMarkerPath = path.join(tempDir, "bridge-executed");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf executed > '${markerPath}'\nexit 17\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    bridgeExecutable,
    `#!/bin/sh\nprintf executed > '${bridgeMarkerPath}'\nexit 0\n`,
    { mode: 0o755 }
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "1",
    },
    stderr: "pipe",
  });
  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  for (const call of [
    {
      name: "slice_stl",
      argumentName: "slicer_path",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: "orcaslicer",
        slicer_path: executable,
        bambu_model: "p1s",
      },
    },
    {
      name: "camera_snapshot",
      argumentName: "ffmpeg_path",
      arguments: {
        bambu_model: "h2s",
        ffmpeg_path: executable,
        timeout_ms: 100,
      },
    },
  ]) {
    fs.rmSync(markerPath, { force: true });
    const rejected = await client.callTool({
      name: call.name,
      arguments: call.arguments,
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content?.[0]?.text || "", new RegExp(call.argumentName));
    assert.match(rejected.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
    assert.equal(
      fs.existsSync(markerPath),
      false,
      `${call.argumentName} must remain blocked by the legacy bridge-only flag`
    );
  }

  const bridgeResult = await client.callTool({
    name: "blender_mcp_edit_model",
    arguments: {
      stl_path: SAMPLE_STL,
      operations: ["remesh"],
      execute: true,
      bridge_command: bridgeExecutable,
    },
  });
  assert.equal(bridgeResult.isError, undefined, "the legacy flag must still authorize bridge_command");
  assert.equal(
    fs.existsSync(bridgeMarkerPath),
    true,
    "the legacy bridge-only compatibility path must remain functional"
  );
});

test("empty slicer_path preserves env fallback without executable opt-in", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SERIAL: "",
      BAMBU_TOKEN: "",
      SLICER_PATH: fakeSlicer.fakeSlicerPath,
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_stl",
    arguments: {
      stl_path: SAMPLE_STL,
      slicer_path: "",
      bambu_model: "p1s",
    },
  });
  assert.doesNotMatch(result.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
});

test("camera_snapshot uses trusted FFMPEG_PATH without opening per-call selectors", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-ffmpeg-path-"));
  const fakeFfmpeg = path.join(tempDir, "fake-ffmpeg.mjs");
  const argsPath = path.join(tempDir, "ffmpeg-args.json");
  fs.writeFileSync(
    fakeFfmpeg,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.argv.at(-1), Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]));
`,
    { mode: 0o755 }
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      FFMPEG_PATH: fakeFfmpeg,
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "camera_snapshot",
    arguments: { bambu_model: "h2s", timeout_ms: 500 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(parseJsonResult(result).transport, "rtsps-322");
  const ffmpegArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  const tlsVerifyIndex = ffmpegArgs.indexOf("-tls_verify");
  assert.notEqual(tlsVerifyIndex, -1, "RTSP should explicitly handle the printer's self-signed TLS certificate");
  assert.equal(ffmpegArgs[tlsVerifyIndex + 1], "0");
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

test("streamable-http transport: rejects DNS-rebinding hosts and foreign origins by default, and survives a malformed Host", async (t) => {
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
      MCP_HTTP_ALLOWED_ORIGINS: "",
      MCP_HTTP_ALLOWED_HOSTS: "Printer-MCP.lan:3000, fe80::1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrOutput = "";
  childProcess.stderr?.on("data", (chunk) => { stderrOutput += chunk.toString(); });
  t.after(async () => { await terminateChildProcess(childProcess); });
  await waitForHttpServerReady(endpoint);

  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-05", capabilities: {}, clientInfo: { name: "host-test", version: "1.0.0" } },
  });
  // fetch() cannot set Host, so write the request on a raw socket.
  const rawResponse = async (headers) => {
    const socket = net.connect(port, "127.0.0.1");
    const lines = [
      "POST /mcp HTTP/1.1", ...headers,
      "Content-Type: application/json", "Accept: application/json, text/event-stream",
      `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body,
    ];
    socket.end(lines.join("\r\n"));
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString(); });
    await once(socket, "close");
    return response;
  };
  const rawStatus = async (headers) => Number(/^HTTP\/1\.1 (\d{3})/.exec(await rawResponse(headers))?.[1]);

  assert.equal(await rawStatus([`Host: evil.example:${port}`]), 403, `rebinding Host must be refused. stderr: ${stderrOutput}`);
  assert.equal(await rawStatus([`Host: 127.0.0.1:${port}`, `Origin: http://evil.example:${port}`]), 403, "foreign Origin must be refused by default");
  assert.equal(await rawStatus(["Host: a b"]), 400, "malformed Host must get 400");
  assert.equal(await rawStatus([`Host: ::1`]), 400, "an unbracketed IPv6 Host header is malformed");
  assert.equal(await rawStatus([`Host: [fe80::1]:${port}`, "Origin: null"]), 403, "an opaque null origin is refused by default");
  assert.equal(childProcess.exitCode, null, `server must survive a malformed Host. stderr: ${stderrOutput}`);
  assert.equal(await rawStatus([`Host: localhost.:${port}`, `Origin: http://localhost:${port}`]), 200, "a local browser origin stays allowed, with or without a trailing dot");
  // The session is already initialized, so the MCP transport itself answers with a JSON-RPC error: the host was let through.
  assert.match(await rawResponse([`Host: printer-mcp.lan:${port}`]), /"jsonrpc":"2\.0"/, "MCP_HTTP_ALLOWED_HOSTS extends the allowed hosts");
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

test("tool schema invariant: input schemas use Codex-compatible root objects", async (t) => {
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

  for (const tool of listToolsResult.tools) {
    assert.equal(
      tool.inputSchema?.type,
      "object",
      `${tool.name} input schema root must be an object`
    );
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(tool.inputSchema || {}, keyword),
        false,
        `${tool.name} input schema root must not use ${keyword}`
      );
    }
  }
});

test("H2D Pro slicing selects its exact installed preset and refuses an H2D substitute", async (t) => {
  const fixture = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fixture.tempDir, { recursive: true, force: true }));
  const preset = "Bambu Lab H2D Pro 0.4 nozzle";
  const machinePath = path.join(fixture.profilesRoot, "BBL", "machine", `${preset}.json`);
  fs.writeFileSync(machinePath, JSON.stringify({
    name: preset, printer_model: "Bambu Lab H2D Pro", nozzle_diameter: ["0.4", "0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"],
    machine_start_gcode: "H2D Pro fixture start",
  }));
  fs.writeFileSync(path.join(fixture.profilesRoot, "BBL", "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab H2D Pro": { downward_check: { [preset]: [] } },
  } }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], stderr: "pipe",
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "h2dpro", BAMBU_SERIAL: "", BAMBU_TOKEN: "",
      BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fixture.profilesRoot,
      BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1" },
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const slice = () => client.callTool({ name: "slice_stl", arguments: {
    stl_path: SAMPLE_STL, bambu_model: "h2dpro", slicer_path: fixture.fakeSlicerPath, use_printer_filaments: false,
  } });
  const result = await slice();
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const args = JSON.parse(fs.readFileSync(fixture.argsOutPath, "utf8"));
  const machine = JSON.parse(fs.readFileSync(args[args.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  assert.equal(machine.machine_start_gcode, "H2D Pro fixture start");
  assert.deepEqual(machine.nozzle_diameter, ["0.4", "0.4"]);
  fs.rmSync(machinePath);
  fs.writeFileSync(path.join(fixture.profilesRoot, "BBL", "machine", "Bambu Lab H2D 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab H2D 0.4 nozzle", printer_model: "Bambu Lab H2D", nozzle_diameter: ["0.4", "0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"],
  }));
  fs.rmSync(fixture.argsOutPath);
  const missing = await slice();
  assert.equal(missing.isError, true, JSON.stringify(missing.content));
  assert.equal(fs.existsSync(fixture.argsOutPath), false, "missing exact preset must stop before CLI execution");
});

test("two projects' settings extract to distinct files, so concurrent slices can't swap processes", async (t) => {
  const { extractBambuTemplateSettings } = await import("../dist/3mf_parser.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = async (name, layer) => {
    const zip = new JSZip();
    zip.file("Metadata/project_settings.config", JSON.stringify({ layer_height: layer }));
    const file = path.join(dir, name);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    return file;
  };
  const [a, b] = await Promise.all([write("a.3mf", "0.16"), write("b.3mf", "0.28")].map(async p => extractBambuTemplateSettings(await p, dir)));
  assert.notEqual(a, b);
  assert.equal(JSON.parse(fs.readFileSync(a, "utf8")).layer_height, "0.16");
  assert.equal(JSON.parse(fs.readFileSync(b, "utf8")).layer_height, "0.28");
});

test("every extraction has its own path, even of the same project, and an operation removes what it extracted", async (t) => {
  const { extractBambuTemplateSettings, withExtractedSettingsCleanup } = await import("../dist/3mf_parser.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({ layer_height: "0.16" }));
  const project = path.join(dir, "model.3mf");
  fs.writeFileSync(project, await zip.generateAsync({ type: "nodebuffer" }));
  // The same project sliced twice at once: one call's write can't truncate the file the other is reading.
  const same = await Promise.all([1, 2, 3].map(() => extractBambuTemplateSettings(project, dir)));
  assert.equal(new Set(same).size, 3);
  let during, kept;
  await withExtractedSettingsCleanup(async () => {
    during = await Promise.all([1, 2].map(() => extractBambuTemplateSettings(project, dir)));
    kept = await Promise.all([1, 2].map(() => extractBambuTemplateSettings(project, dir, { keep: true })));
    assert.ok(during.every(file => fs.existsSync(file)), "present while the operation runs");
  });
  assert.ok(during.every(file => !fs.existsSync(path.dirname(file))), "removed when it settles");
  assert.equal(kept[0], kept[1], "a path handed back to the caller is named by content, so repeat calls reuse one file");
  assert.equal(JSON.parse(fs.readFileSync(kept[0], "utf8")).layer_height, "0.16", "and it stays");
  assert.deepEqual(fs.readdirSync(dir).filter(entry => entry.endsWith(".partial")), []);
  await assert.rejects(withExtractedSettingsCleanup(async () => {
    during = [await extractBambuTemplateSettings(project, dir)];
    throw new Error("slice failed");
  }), /slice failed/);
  assert.equal(fs.existsSync(during[0]), false, "removed when the operation fails too");
});
