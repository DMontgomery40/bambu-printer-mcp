import {createHash} from "node:crypto";
import {trackedMkdtemp} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { UNPINNED_PLUGIN_ENV, createFakeNativeHome } from "./fixtures/native-home.mjs";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;

// Exercise platform dispatch on every CI OS. Only the OS selector and transport
// boundaries are mocked; file inspection, AMS validation and preflight are real.
async function server(t, { platform = "darwin", model = "x2d", state = "IDLE", gcode = "G1 X0 Y0\n", decline = false, helperDelay = 0, ignoreTerm = false, dispatchState, dispatchError, installedHelper = true, installedPlugin = true, tunnelLibrary = true, arch = "x64", unpinnedOptIn = true, helperFails = false, crashAfterDispatch = false, mqttFails = false, mqttHangs = false, mqttDelay = 0, mqttFirstConnectionOffline = false, hms = [], storage = {}, dispatchStorage, env = {}, printer = "x2d", resumeAfterPrint = false } = {}) {
  // The printer the plate is sliced for and the fresh report describes; model only sets BAMBU_MODEL.
  const x1c = printer === "x1c";
  const dir = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-native-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventsFile = path.join(dir, "events.jsonl");
  const helper = path.join(dir, "helper.mjs");
  const file = path.join(dir, "cube.3mf");
  await fs.writeFile(eventsFile, "");
  await fs.writeFile(helper, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const e = process.env;
if (${ignoreTerm}) process.on('SIGTERM', () => {});
const event = { kind: 'helper', pid: process.pid, mode: process.argv[2], file: e.BAMBU_NATIVE_FILE,
  exists: existsSync(e.BAMBU_NATIVE_FILE || ''), config: e.BAMBU_NATIVE_CONFIG_FILE,
  destination: e.BAMBU_NATIVE_DST_FILE, useAMS: e.BAMBU_NATIVE_USE_AMS,
  projectName: e.BAMBU_NATIVE_PROJECT_NAME, presetName: e.BAMBU_NATIVE_PRESET_NAME,
  plateIndex: e.BAMBU_NATIVE_PLATE_INDEX, bedType: e.BAMBU_NATIVE_BED_TYPE,
  mapping: e.BAMBU_NATIVE_AMS_MAPPING, mapping2: e.BAMBU_NATIVE_AMS_MAPPING2,
  printOptions: Object.fromEntries(["BED_LEVELING", "FLOW_CALIBRATION", "VIBRATION_CALIBRATION", "LAYER_INSPECT", "TIMELAPSE", "AUTO_BED_LEVELING", "AUTO_FLOW_CALI", "AUTO_OFFSET_CALI", "EXTRUDER_CALI_MANUAL_MODE"].map(key => [key, e["BAMBU_NATIVE_" + key]])),
  tryEmmc: e.BAMBU_NATIVE_TRY_EMMC_PRINT, plugin: e.BAMBU_NATIVE_PLUGIN, certDir: e.BAMBU_NATIVE_CERT_DIR, configDir: e.BAMBU_NATIVE_CONFIG_DIR,
  command: JSON.parse(e.BAMBU_NATIVE_COMMAND_JSON || '{}') };
event.olderAlive = readFileSync(${JSON.stringify(eventsFile)}, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)
  .filter(old => old.mode === '--print-authorized' || old.command?.print?.temp > 0)
  .filter(old => { try { process.kill(old.pid, 0); return true; } catch { return false; } }).map(old => old.pid);
appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');
if (${helperFails} && process.argv[2].startsWith('--command')) {
  console.error('native_error=simulated plug-in failure');
  process.exit(1);
}
if (${helperDelay} && (['--print-authorized', '--upload'].includes(process.argv[2]) || event.command.print?.temp > 0)) {
  await new Promise(resolve => setTimeout(resolve, ${helperDelay}));
  appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({kind:'sent'}) + '\\n');
}
if (['--print-authorized', '--command-authorized'].includes(process.argv[2])) {
  const input = createInterface({input:process.stdin});
  const authorization = new Promise(resolve => input.once('line', resolve));
  console.log('native_dispatch_request=1');
  if (await authorization !== 'native_dispatch_authorized=1') process.exit(21);
  input.close();
  appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({kind:'dispatched'}) + '\\n');
  if (${crashAfterDispatch} && process.argv[2] === '--print-authorized') process.exit(1);
}
console.log('native_print result=0');
`, { mode: 0o755 });
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  zip.file("Metadata/plate_1.gcode", x1c
    ? `; printer_model = Bambu Lab X1 Carbon\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\n${gcode}`
    : `; printer_model = Bambu Lab X2D\n; nozzle_diameter = 0.4;0.4\n; filament_type = PLA\n; filament_map = 1\n; physical_extruder_map = 1,0\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\n${gcode}`);
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  const preload = `
    import { appendFileSync, readFileSync, copyFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(printerModule)};
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
    const record = kind => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({kind})+'\\n');
    let offlineClient;
    BambuImplementation.prototype.getPrinter = async () => {
      if (${mqttFirstConnectionOffline}) {
        if (!offlineClient || offlineClient.closed) {
          // First connection stays offline until expiry closes it. A replacement
          // is ready immediately: test connection ordering, not reconnect timing.
          const offline = !offlineClient;
          const pending = new Set();
          offlineClient = {
            closed: false,
            publish: () => {
              if (!offline) { record('mqtt'); return Promise.resolve(); }
              record('mqtt-queued');
              return new Promise((_resolve, reject) => pending.add(reject));
            },
            disconnect: async () => {
              offlineClient.closed = true;
              for (const reject of pending) reject(new Error('transport closed'));
              pending.clear();
            },
          };
        }
        return offlineClient;
      }
      if (${mqttFails}) { record('mqtt-failed'); throw new Error('simulated MQTT failure'); }
      if (${mqttHangs}) { record('mqtt-hung'); return new Promise(() => {}); }
      if (${mqttDelay}) { record('mqtt-wait'); await new Promise(resolve => setTimeout(resolve, ${mqttDelay})); record('mqtt-connected'); }
      // Note which older print/heating helpers were still alive at each MQTT send.
      return { publish: async () => {
        const alive = readFileSync(${JSON.stringify(eventsFile)}, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)
          .filter(old => old.mode === '--print-authorized' || old.command?.print?.temp > 0)
          .filter(old => { try { process.kill(old.pid, 0); return true; } catch { return false; } }).map(old => old.pid);
        appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ kind: 'mqtt', olderAlive: alive }) + '\\n');
      } };
    };
    if (${resumeAfterPrint}) BambuImplementation.prototype.ftpDownload = async (_host, _token, _remote, destination) => {
      record('reread'); copyFileSync(${JSON.stringify(file)}, destination);
    };
    BambuImplementation.prototype.ftpUpload = async () => { record('ftp'); throw new Error('unexpected FTPS'); };
    BambuImplementation.prototype.disconnectAll = async () => { record('disconnect'); };
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => {
      record('status');
      const helperStarted = readFileSync(${JSON.stringify(eventsFile)}, 'utf8').includes('helper');
      const completed = readFileSync(${JSON.stringify(eventsFile)}, 'utf8').includes('dispatched');
      const job = completed && ${resumeAfterPrint} ? JSON.parse(readFileSync(${JSON.stringify(eventsFile)}, 'utf8').trim().split('\\n').find(line => JSON.parse(line).kind === 'helper')) : undefined;
      const observedState = job ? 'PAUSE' : ${JSON.stringify(dispatchState)} && helperStarted ? ${JSON.stringify(dispatchState)} : ${JSON.stringify(state)};
      const storage = ${JSON.stringify(dispatchStorage)} && helperStarted ? ${JSON.stringify(dispatchStorage)} : ${JSON.stringify(storage)};
      return { connected:true, serial, model:${JSON.stringify(printer)}, status:observedState,
        raw: {serial,model:${JSON.stringify(printer)},vir_slot:${x1c ? "[{id:255,tray_type:'PLA'}]" : "[{id:254,tray_type:'PLA'},{id:255,tray_type:'PLA'}]"},gcode_state:observedState,print_error:${JSON.stringify(dispatchError)} && readFileSync(${JSON.stringify(eventsFile)}, 'utf8').includes('helper') ? ${JSON.stringify(dispatchError)} : 0,hms:${JSON.stringify(hms)},nozzle_diameter:${x1c ? "'0.4'" : "['0.4','0.4']"},
          ams: { ams:[{id:'0',tray:[{id:'0',tray_type:'PLA'}]}, {id:'128',tray:[{id:'0',tray_type:'PLA'}]}] }, ...storage, ...(job ? {subtask_name:job.destination,gcode_file:job.destination} : {}) },
        observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'} };
    };
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry], cwd: dir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: model, BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: x1c ? "00MTEST" : "20PTEST", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
      // An empty private home keeps a developer's real Linux setup out of the test.
      BAMBU_NATIVE_HELPER: installedHelper ? helper : "",
      BAMBU_NATIVE_HOME: installedPlugin ? createFakeNativeHome(dir, { tunnelLibrary }) : path.join(dir, "empty-native-home"),
      ...(unpinnedOptIn ? UNPINNED_PLUGIN_ENV : { BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN: "" }),
      BAMBU_DEFAULT_CONNECTION_MODE: "", BAMBU_EMERGENCY_MQTT_TIMEOUT_MS: "500", BAMBU_NATIVE_TRY_EMMC_PRINT: undefined,
      // Each server keeps its own resume records: a job another test started must never be resumable here.
      BAMBU_RESUME_STATE_DIR: await trackedMkdtemp(path.join(os.tmpdir(), "bambu-resume-server-")), ...env }, stderr: "pipe",
  });
  const client = new Client({ name: "native-regression", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  const prompts = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.requestedSchema.properties.confirmed) {
      prompts.push("confirm");
      return decline ? { action: "decline" } : { action: "accept", content: { confirmed: true } };
    }
    prompts.push("model");
    return { action: "accept", content: { bambu_model: "x2d" } };
  });
  t.after(() => client.close());
  await client.connect(transport);
  return {
    client, file, dir, prompts,
    events: async () => (await fs.readFile(eventsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    print: (args, options) => client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, ...args } }, undefined, options),
  };
}

const canceledTask = { fail_reason: '50348044', subtask_name: 'previous-canceled-part', task_id: '1', subtask_id: '0', job_id: '0' };

test('native printing from a canceled X2D task adds no prompt, even for a client that would decline', async t => {
  const s = await server(t, { state: 'FAILED', storage: canceledTask, decline: true });
  const result = await s.print({ connection_mode: 'bambu_native', ams_slots: [0] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(s.prompts, []);
  assert.equal((await s.events()).some(e => e.kind === 'helper'), true);
});

test('a canceled X2D task reaches checked native dispatch without error-reset commands', async t => {
  const s = await server(t, { state: 'FAILED', storage: canceledTask });
  const result = await s.print({ connection_mode: 'bambu_native', ams_slots: [0] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const events = await s.events();
  const helpers = events.filter(e => e.kind === 'helper');
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0].mode, '--print-authorized');
  assert.equal(events.filter(e => e.kind === 'dispatched').length, 1);
  assert.equal(events.some(e => e.command?.system?.command === 'uiop' || e.command?.print?.command === 'clean_print_error'), false);
});

test('a different canceled task appearing during native setup cannot reuse bed clearance', async t => {
  const s = await server(t, { state: 'FAILED', storage: canceledTask, dispatchStorage: { ...canceledTask, task_id: '2' } });
  const result = await s.print({ connection_mode: 'bambu_native', ams_slots: [0] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /job changed during preflight/i);
  assert.equal((await s.events()).some(e => e.kind === 'dispatched'), false);
});

for (const overrides of [{ fail_reason: 0x0300400d }, { print_error: 123 }, { hms: [{ attr: 1, code: 0x20001 }] }]) {
  test(`native canceled-task recovery rejects a real fault ${JSON.stringify(overrides)}`, async t => {
    const s = await server(t, { state: 'FAILED', storage: { ...canceledTask, ...overrides } });
    const result = await s.print({ connection_mode: 'bambu_native', ams_slots: [0] });
    assert.equal(result.isError, true);
    assert.equal((await s.events()).some(e => e.kind === 'helper'), false);
  });
}

test("native X2D printing sends Bambu Studio's Send dialog options, and an explicit one wins", async t => {
  const s = await server(t);
  assert.notEqual((await s.print({ ams_slots: [128] })).isError, true);
  // X2D bed leveling and flow calibration default to auto; a one-nozzle job turns nozzle offset calibration off.
  const studio = {
    BED_LEVELING: "false", FLOW_CALIBRATION: "false", VIBRATION_CALIBRATION: "false", LAYER_INSPECT: "true", TIMELAPSE: "false",
    AUTO_BED_LEVELING: "2", AUTO_FLOW_CALI: "2", AUTO_OFFSET_CALI: "0", EXTRUDER_CALI_MANUAL_MODE: "0",
  };
  assert.deepEqual((await s.events()).find(e => e.kind === "helper").printOptions, studio);
  const explicit = await server(t);
  assert.notEqual((await explicit.print({ ams_slots: [128], bed_leveling: true, vibration_calibration: true })).isError, true);
  assert.deepEqual((await explicit.events()).find(e => e.kind === "helper").printOptions,
    { ...studio, BED_LEVELING: "true", AUTO_BED_LEVELING: "1", VIBRATION_CALIBRATION: "true" });
});

for (const connection_mode of [undefined, "lan_mqtt_ftps", "bambu_native"]) {
  test(`elicited X2D uses native print with ${connection_mode || "default"} routing`, async t => {
    const s = await server(t, { model: "" });
    const result = await s.print({ connection_mode, ams_slots: [128] });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(s.prompts, ["model"], "model should be resolved exactly once, and the print itself does not ask");
    const events = await s.events();
    assert.equal(events.filter(e => e.kind === "helper").length, 1);
    assert.equal(events.some(e => ["ftp", "mqtt"].includes(e.kind)), false);
    const call = events.find(e => e.kind === "helper");
    assert.equal(call.mode, "--print-authorized");
    assert.notEqual(call.file, s.file);
    assert.equal(call.config, call.file);
    assert.equal(call.exists, true);
    assert.equal(call.useAMS, "true");
    assert.deepEqual(JSON.parse(call.mapping), [128]);
    assert.deepEqual(JSON.parse(call.mapping2), [{ ams_id: 128, slot_id: 0 }]);
    assert.match(call.destination, /^checked-/);
  });
}

for (const mapping of ['[{"ams_id":0,"slot_id":0}]', 'not-json', '[]']) {
  test(`raw ams_mapping2 is rejected before dispatch: ${mapping}`, async t => {
    const s = await server(t);
    for (const extra of [{}, { use_ams: true }, { ams_slots: [0] }]) {
      const result = await s.print({ ams_mapping2: mapping, ...extra });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /ams_mapping2 cannot override/);
    }
    assert.deepEqual(await s.events(), []);
  });
}

test("native AMS cannot silently fall back; explicit external-spool printing is preserved", async t => {
  const s = await server(t);
  for (const args of [{}, { use_ams: true }, { ams_slots: [] }, { ams_slots: [0, 1] }]) {
    assert.equal((await s.print(args)).isError, true, JSON.stringify(args));
  }
  assert.equal((await s.events()).some(e => e.kind === "helper"), false);
  const result = await s.print({ use_ams: false });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const call = (await s.events()).find(e => e.kind === "helper");
  assert.equal(call.useAMS, "false");
  assert.deepEqual(JSON.parse(call.mapping), [-1]);
});

for (const [label, options, transport] of [
  ["darwin", { platform: "darwin" }, "helper"],
  ["linux with a complete install", { platform: "linux" }, "helper"],
  // Incomplete Linux installs keep the previous MQTT route for stop/pause/heater-off.
  ["linux without a native helper", { platform: "linux", installedHelper: false }, "mqtt"],
  ["linux with a helper but no plug-in", { platform: "linux", installedPlugin: false }, "mqtt"],
  ["linux without the tunnel library", { platform: "linux", tunnelLibrary: false }, "mqtt"],
  ["linux with an unpinned plug-in", { platform: "linux", unpinnedOptIn: false }, "mqtt"],
  ["linux arm64", { platform: "linux", arch: "arm64" }, "mqtt"],
  ["win32", { platform: "win32" }, "mqtt"],
]) {
  test(`pause selects ${transport} on ${label}`, async t => {
    const s = await server(t, options);
    const result = await s.client.callTool({ name: "pause_print", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const events = await s.events();
    assert.deepEqual(events.map(e => e.kind), [transport]);
    if (transport === "helper") assert.equal(events[0].command.print.command, "pause");
  });
}

// Status reported by the physical X2D with a ready 30 GB card: sdcard, home_flag
// bits 8-9 and aux bits 12-13 all say "normal".
const cardReady = { sdcard: true, home_flag: -1066969665, cfg: "4D10457D299", fun: "40029FD1930F9CB7", aux: "2801004", stat: "10010402180F0" };
for (const [label, storage, tryEmmc, reported] of [
  ["a ready card", cardReady, "false", "external"],
  ["no card", { sdcard: false, home_flag: 0 }, "true", "internal"],
  ["a read-only card", { ...cardReady, aux: "2803004" }, "true", "internal"],
  ["an abnormal card", { sdcard: true, home_flag: 0x200 }, "true", "internal"],
]) test(`native print with ${label} stores the job on ${reported} storage`, async t => {
  const s = await server(t, { storage });
  const result = await s.print({ ams_slots: [128] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).storage, reported);
  assert.equal((await s.events()).find(e => e.kind === "helper").tryEmmc, tryEmmc);
});

for (const [label, env, args] of [
  ["BAMBU_NATIVE_TRY_EMMC_PRINT=1", { BAMBU_NATIVE_TRY_EMMC_PRINT: "1" }, {}],
  ["try_emmc_print: true", {}, { try_emmc_print: true }],
  ["try_emmc_print: true over BAMBU_NATIVE_TRY_EMMC_PRINT=0", { BAMBU_NATIVE_TRY_EMMC_PRINT: "0" }, { try_emmc_print: true }],
]) test(`${label} keeps the job on internal storage despite a ready card`, async t => {
  const s = await server(t, { storage: cardReady, env });
  const result = await s.print({ ams_slots: [128], ...args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).storage, "internal");
  assert.equal((await s.events()).find(e => e.kind === "helper").tryEmmc, "true");
});

test("an empty BAMBU_NATIVE_TRY_EMMC_PRINT still detects the card", async t => {
  const s = await server(t, { storage: cardReady, env: { BAMBU_NATIVE_TRY_EMMC_PRINT: " " } });
  const result = await s.print({ ams_slots: [128] });
  assert.equal(JSON.parse(result.content[0].text).storage, "external");
});

for (const [label, env, args] of [
  ["try_emmc_print: false", {}, { try_emmc_print: false }],
  ["BAMBU_NATIVE_TRY_EMMC_PRINT=0", { BAMBU_NATIVE_TRY_EMMC_PRINT: "0" }, {}],
]) test(`${label} without a ready card is refused before the helper starts`, async t => {
  const s = await server(t, { storage: { sdcard: false, home_flag: 0 }, env });
  const result = await s.print({ ams_slots: [128], ...args });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no ready SD card or USB stick/);
  assert.equal((await s.events()).some(e => e.kind === "helper"), false);
});

test("a non-boolean try_emmc_print is refused before contacting the printer", async t => {
  const s = await server(t, { storage: cardReady });
  const result = await s.print({ ams_slots: [128], try_emmc_print: "false" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /try_emmc_print must be true or false/);
  assert.deepEqual(await s.events(), []);
});

test("a card that is removed before dispatch stops the print", async t => {
  const s = await server(t, { storage: cardReady, dispatchStorage: { ...cardReady, aux: "2800004" } });
  const result = await s.print({ ams_slots: [128] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SD card or USB stick is no longer ready/);
  assert.equal((await s.events()).some(e => e.kind === "dispatched"), false);
});

test("Linux X2D print uses the installed native helper with the shared checks", async t => {
  const s = await server(t, { platform: "linux", model: "" });
  const result = await s.print({ ams_slots: [0] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(s.prompts, ["model"]);
  const events = await s.events();
  assert.equal(events.some(e => ["ftp", "mqtt"].includes(e.kind)), false);
  const call = events.find(e => e.kind === "helper");
  assert.equal(call.mode, "--print-authorized");
  assert.notEqual(call.file, s.file);
  assert.deepEqual(JSON.parse(call.mapping), [0]);
  assert.ok(events.some(e => e.kind === "dispatched"));
  // The server hands the helper the exact pinned install it validated.
  const home = path.join(s.dir, "native-home");
  assert.equal(call.plugin, path.join(home, "plugins/libbambu_networking.so"));
  assert.equal(call.certDir, path.join(home, "cert"));
  assert.equal(call.configDir, path.join(home, "config"));
});

test("Linux X2D print without the helper names the setup command before touching the printer", async t => {
  const s = await server(t, { platform: "linux", model: "", installedHelper: false });
  const result = await s.print({ use_ams: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /bambu-printer-mcp-native-setup/);
  assert.deepEqual(await s.events(), []);
  assert.deepEqual(s.prompts, ["model"]);
});

for (const [label, options, message] of [
  ["a missing plug-in", { installedPlugin: false }, /networking plug-in is not installed.*bambu-printer-mcp-native-setup/],
  ["an arm64 host", { arch: "arm64" }, /requires macOS or x86-64 Linux/],
  ["a missing tunnel library", { tunnelLibrary: false }, /libBambuSource\.so is missing beside/],
  ["an unpinned plug-in", { unpinnedOptIn: false }, /is not the pinned Bambu plug-in 02\.09\.01\.54/],
]) {
  test(`Linux X2D print with ${label} fails before touching the printer`, async t => {
    const s = await server(t, { platform: "linux", model: "", ...options });
    const result = await s.print({ use_ams: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
    assert.deepEqual(await s.events(), []);
    assert.deepEqual(s.prompts, ["model"]);
  });
}

test("Windows X2D print fails with a platform error before touching the printer", async t => {
  const s = await server(t, { platform: "win32", model: "" });
  const result = await s.print({ use_ams: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires macOS or x86-64 Linux/);
  assert.deepEqual(await s.events(), []);
  assert.deepEqual(s.prompts, ["model"]);
});

for (const options of [{ state: "RUNNING" }, { gcode: "M104 S400\n" }]) {
  test(`native print honors shared preflight: ${JSON.stringify(options)}`, async t => {
    const s = await server(t, options);
    assert.equal((await s.print({ use_ams: false })).isError, true);
    assert.equal((await s.events()).some(e => ["helper", "ftp", "mqtt"].includes(e.kind)), false);
  });
}

test("native upload inspects every plate and cannot upload an unsafe archive", async t => {
  const s = await server(t, { gcode: "M104 S400\n" });
  const result = await s.client.callTool({ name: "upload_file", arguments: {
    file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native",
  } });
  assert.equal(result.isError, true);
  assert.equal((await s.events()).some(e => e.kind === "helper"), false);
});

test("native upload honors validated plate and display metadata", async t => {
  const s = await server(t);
  const zip = await JSZip.loadAsync(await fs.readFile(s.file));
  zip.file("Metadata/plate_2.gcode", (await zip.file("Metadata/plate_1.gcode").async("string")).replace("Textured PEI Plate", "Cool Plate"));
  zip.file("Metadata/plate_2.json", JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(s.file, await zip.generateAsync({ type: "nodebuffer" }));
  const result = await s.client.callTool({ name: "upload_file", arguments: {
    file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native",
    project_name: "My project", preset_name: "My preset", plate_index: 1, bed_type: "cool_plate",
  } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const call = (await s.events()).find(e => e.kind === "helper");
  assert.equal(call.mode, "--upload");
  assert.equal(call.projectName, "My project");
  assert.equal(call.presetName, "My preset");
  assert.equal(call.plateIndex, "2");
  assert.equal(call.bedType, "cool_plate");
});

test("native upload rejects unsupported print options and invalid metadata before helper dispatch", async t => {
  const s = await server(t);
  const rejected = [
    { plate_index: -1 }, { plate_index: 0.5 }, { plate_index: 1 },
    { bed_type: "invalid" }, { bed_type: "cool_plate" }, { project_name: 42 }, { preset_name: "" },
    ...["use_ams", "ams_mapping", "ams_mapping2", "ams_mapping_info", "nozzle_mapping", "nozzles_info",
      "bed_leveling", "flow_calibration", "vibration_calibration", "layer_inspect", "timelapse"]
      .map(key => ({ [key]: key === "ams_mapping" ? [0] : key === "use_ams" ? true : "unsupported" })),
  ];
  for (const args of rejected) {
    const result = await s.client.callTool({ name: "upload_file", arguments: {
      file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native", ...args,
    } });
    assert.equal(result.isError, true, JSON.stringify({ args, result }));
  }
  assert.equal((await s.events()).some(e => e.kind === "helper"), false);
  const schema = (await s.client.listTools()).tools.find(tool => tool.name === "upload_file").inputSchema.properties;
  assert.equal(schema.use_ams, undefined);
  assert.equal(schema.ams_mapping2, undefined);
});

test("native print rechecks live readiness after helper connection before dispatch", async t => {
  const s = await server(t, { dispatchState: "RUNNING" });
  const result = await s.print({ use_ams: false });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /ready|running|idle/i);
  const events = await s.events();
  assert.equal(events.some(e => e.kind === "helper"), true);
  assert.equal(events.some(e => e.kind === "dispatched"), false);
});

test("raw native metadata uses the requested serial rather than the configured model", async t => {
  const message_json = JSON.stringify({ print: { command: "extrusion_cali_get", sequence_id: "1" } });
  const configured = await server(t);
  const other = await configured.client.callTool({ name: "x2d_native_control", arguments: {
    message_json, bambu_serial: "01POTHER", host: "127.0.0.2",
  } });
  assert.equal(other.isError, true);
  assert.deepEqual(await configured.events(), []);
  const unconfigured = await server(t, { model: "" });
  const x2d = await unconfigured.client.callTool({ name: "x2d_native_control", arguments: { message_json } });
  assert.notEqual(x2d.isError, true, JSON.stringify(x2d));
  assert.equal((await unconfigured.events()).filter(e => e.kind === "helper").length, 1);
});

test("native AMS tools reject fractional addresses before dispatch", async t => {
  const s = await server(t);
  for (const [name, args] of [
    ["reread_ams_rfid", { ams_id: 1.9, slot_id: 0 }],
    ["reread_ams_rfid", { ams_id: 0, slot_id: 2.8 }],
    ["reread_ams_rfid", { ams_id: 128, slot_id: 1 }],
    ["set_ams_drying", { ams_id: 1.9, action: "start" }],
  ]) {
    assert.equal((await s.client.callTool({ name, arguments: args })).isError, true, JSON.stringify(args));
  }
  assert.deepEqual(await s.events(), []);
});

test("native heating rechecks readiness after helper connection", async t => {
  const s = await server(t, { dispatchState: "RUNNING" });
  const result = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 50 } });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /ready|running|idle/i);
  assert.equal((await s.events()).some(e => e.kind === "dispatched"), false);
});

test("native error clearing cannot clear newly appeared unconfirmed errors", async t => {
  const s = await server(t, { dispatchError: 1234 });
  const result = await s.client.callTool({ name: "clear_hms_errors", arguments: {} });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /errors changed/i);
  assert.equal((await s.events()).some(e => e.kind === "dispatched"), false);
});

test('native error clearing cannot reuse confirmation for a different job during helper setup', async t => {
  const s = await server(t, { state: 'FAILED', storage: canceledTask, dispatchStorage: { ...canceledTask, task_id: '2' } });
  const result = await s.client.callTool({ name: 'clear_hms_errors', arguments: {} });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /job changed/);
  assert.equal((await s.events()).some(e => e.kind === 'dispatched'), false);
});

test("raw native controls cannot bypass checked heating, resume or error clearing", async t => {
  const s = await server(t);
  for (const command of ["set_nozzle_temp", "set_bed_temp", "resume", "clean_print_error", "gcode_file", "xyz_ctrl", "ams_change_filament", "select_extruder", "set_ctt", "idle_ignore", "ignore"]) {
    const result = await s.client.callTool({ name: "x2d_native_control", arguments: {
      message_json: JSON.stringify({ print: { command, sequence_id: "test", temp: 220, target_temp: 220 } }),
    } });
    assert.equal(result.isError, true);
    // The low-level command validator may reject the shape first; either way
    // none of these raw requests may reach a helper or printer.
  }
  assert.equal((await s.client.callTool({ name: "resume_print", arguments: {} })).isError, true);
  assert.deepEqual(await s.events(), []);
});

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for native helper state");
}

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

for (const name of ["cancel_print", "set_temperature"]) {
  test(`${name} terminates a pending native print before its snapshot is released`, async t => {
    const s = await server(t, { model: "", helperDelay: 3000, ignoreTerm: true });
    const pending = s.print({ use_ams: false });
    const call = await until(async () => (await s.events()).find(e => e.mode === "--print-authorized"));
    await fs.access(call.file);
    const result = await s.client.callTool({ name, arguments: name === "set_temperature"
      ? { component: "bed", temperature: 0, bambu_model: "x2d" } : {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const interrupted = await pending;
    assert.equal(interrupted.isError, true);
    assert.match(interrupted.content[0].text, /cancelled.*verify its state/i);
    const emergency = (await s.events()).find(e => e.command?.print?.command === "stop" || e.command?.print?.temp === 0);
    assert.deepEqual(emergency.olderAlive, [], "terminate pending helpers before sending stop/heater-off");
    assert.equal(exited(call.pid), true, "do not return while a SIGTERM-resistant helper can still send a print");
    await assert.rejects(fs.access(call.file), { code: "ENOENT" });
    assert.equal((await s.events()).some(e => e.kind === "sent"), false);
    assert.equal((await s.events()).some(e => e.kind === "mqtt"), false, "elicited X2D control must retain native routing");
  });
}

for (const name of ["print_3mf", "upload_file"]) test(`MCP cancellation terminates a pending ${name} helper`, async t => {
  const s = await server(t, { helperDelay: 3000, ignoreTerm: true });
  const controller = new AbortController();
  const pending = (name === "print_3mf" ? s.print({ use_ams: false }, { signal: controller.signal }) :
    s.client.callTool({ name, arguments: { file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native" } }, undefined, { signal: controller.signal }))
    .catch(error => error);
  const call = await until(async () => (await s.events()).find(e => ["--print-authorized", "--upload"].includes(e.mode)));
  controller.abort();
  assert.ok(await pending instanceof Error);
  await until(() => exited(call.pid));
  await until(async () => { try { await fs.access(call.file); return false; } catch { return true; } });
  assert.equal((await s.events()).some(e => e.kind === "sent"), false);
});

for (const model of ["x2d", ""]) test(`heater-off terminates pending native heating with ${model || "elicited model"}`, async t => {
  const s = await server(t, { model, helperDelay: 3000, ignoreTerm: true });
  const pending = s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 50 } });
  const call = await until(async () => (await s.events()).find(e => e.command?.print?.temp === 50));
  const off = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 0 } });
  assert.notEqual(off.isError, true, JSON.stringify(off));
  assert.equal((await pending).isError, true);
  assert.deepEqual((await s.events()).find(e => e.command?.print?.temp === 0).olderAlive, []);
  assert.equal(exited(call.pid), true);
  assert.equal((await s.events()).some(e => e.kind === "sent"), false);
});

for (const name of ["pause_print", "set_temperature"]) test(`${name} with an overridden serial does not inherit the default X2D transport`, async t => {
  const s = await server(t);
  const result = await s.client.callTool({ name, arguments: { bambu_serial: "01POTHER",
    ...(name === "set_temperature" ? { component: "bed", temperature: 0 } : {}) } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual((await s.events()).map(e => e.kind), ["mqtt"]);
});

test("server shutdown cannot leave a SIGTERM-resistant native print helper running", async t => {
  const s = await server(t, { helperDelay: 3000, ignoreTerm: true });
  const pending = s.print({ use_ams: false }).catch(error => error);
  const call = await until(async () => (await s.events()).find(e => e.mode === "--print-authorized"));
  await s.client.close();
  await pending;
  await until(() => exited(call.pid));
  assert.equal((await s.events()).some(e => e.kind === "sent"), false);
});

test("public raw control rejects safety settings, extra fields and malformed metadata", async t => {
  const s = await server(t);
  for (const message of [
    { system: { command: "set_door_stat", door_stat: 0 } },
    { xcam: { command: "xcam_control_set", control: false } },
    { print: { command: "print_option", nozzle_blob_detect: false } },
    { print: { command: "ams_filament_setting", sequence_id: "1", ams_id: 0, slot_id: 0, gcode: "M104 S300" } },
    { print: { command: "ams_filament_setting", sequence_id: "1", ams_id: 0, slot_id: 0, nozzle_temp_min: 400 } },
    { print: { command: "extrusion_cali_sel", sequence_id: "1", ams_id: 128, slot_id: 3 } },
    { print: { command: "extrusion_cali_sel", sequence_id: "1", ams_id: 1, slot_id: 2, tray_id: 2, cali_idx: -1 } },
  ]) {
    const result = await s.client.callTool({ name: "x2d_native_control", arguments: { message_json: JSON.stringify(message) } });
    assert.equal(result.isError, true, JSON.stringify(message));
  }
  assert.deepEqual(await s.events(), []);
});

test("metadata preserves unit-local filament IDs and absolute calibration IDs across AMS units", async t => {
  const s = await server(t);
  for (const [ams_id, slot_id, absolute] of [[0, 1, 1], [1, 2, 6], [3, 3, 15], [128, 0, 128]]) {
    for (const command of ["ams_filament_setting", "extrusion_cali_sel"]) {
      const expected = command === "ams_filament_setting" ? slot_id : absolute;
      for (const explicit of [false, true]) {
        const result = await s.client.callTool({ name: "x2d_native_control", arguments: {
          message_json: JSON.stringify({ print: { command, sequence_id: "metadata", ams_id, slot_id,
            ...(explicit ? { tray_id: expected } : {}),
            ...(command === "extrusion_cali_sel" ? { cali_idx: -1 } : {}),
          } }),
        } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const call = (await s.events()).at(-1);
        assert.equal(call.command.print.tray_id, expected);
        assert.equal(call.command.print.ams_id, ams_id);
        assert.equal(call.command.print.slot_id, slot_id);
      }
    }
  }
});

test("elicited X2D heating uses native dispatch without a heating prompt", async t => {
  const s = await server(t, { model: "" });
  const result = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 50 } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(s.prompts, ["model"]);
  const events = await s.events();
  assert.equal(events.some(e => e.kind === "mqtt"), false);
  assert.equal(events.find(e => e.kind === "helper").command.print.command, "set_bed_temp");
});

test("native heater-off stays available but rejected heating cannot reach the helper", async t => {
  const s = await server(t, { state: "RUNNING" });
  const rejected = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 50 } });
  assert.equal(rejected.isError, true);
  assert.equal((await s.events()).some(e => e.kind === "helper"), false);
  const off = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 0 } });
  assert.notEqual(off.isError, true, JSON.stringify(off));
  assert.equal((await s.events()).find(e => e.kind === "helper").command.print.temp, 0);
  assert.deepEqual(s.prompts, []);
});

for (const [name, args] of [["cancel_print", {}], ["set_temperature", { component: "bed", temperature: 0 }]]) {
  test(`Linux ${name} goes out over native and MQTT at once`, async t => {
    const s = await server(t, { platform: "linux" });
    const result = await s.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual((await s.events()).map(e => e.kind).sort(), ["helper", "mqtt", "mqtt"], "immediate MQTT plus the send after older helpers exit");
    assert.match(result.content[0].text, /"native":\s*"sent"[\s\S]*"mqtt":\s*"sent"[\s\S]*"mqtt_immediate":\s*"sent"/);
  });

  test(`Linux ${name} still succeeds over MQTT when the native helper fails`, async t => {
    const s = await server(t, { platform: "linux", helperFails: true });
    const result = await s.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual((await s.events()).map(e => e.kind).sort(), ["helper", "mqtt", "mqtt"], "immediate MQTT plus the send after older helpers exit");
    assert.match(result.content[0].text, /"native":\s*"failed"[\s\S]*"mqtt":\s*"sent"[\s\S]*native_error/);
  });

  test(`Linux ${name} returns the native result when MQTT never connects`, async t => {
    const s = await server(t, { platform: "linux", mqttHangs: true });
    const started = Date.now();
    const result = await s.client.callTool({ name, arguments: args });
    assert.ok(Date.now() - started < 5_000, "a hanging MQTT connect must not hold back the stop");
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /"native":\s*"sent"[\s\S]*"mqtt":\s*"failed"[\s\S]*no MQTT confirmation within 0.5 s/);
  });

  test(`Linux ${name} never dispatches a timed-out MQTT command after reconnection`, async t => {
    const s = await server(t, { platform: "linux", mqttDelay: 1000 });
    const result = await s.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /"mqtt":\s*"failed"/);
    await until(async () => (await s.events()).filter(e => e.kind === 'mqtt-connected').length === 2);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await s.events()).filter(e => e.kind === 'mqtt').length, 0, 'expired stop/heater-off must never publish after MQTT reconnects');
  });

  test(`Linux ${name} gives the counted send its own window after the immediate queue expires`, async t => {
    const s = await server(t, { platform: "linux", helperFails: true, mqttFirstConnectionOffline: true,
      env: { BAMBU_EMERGENCY_MQTT_TIMEOUT_MS: "1500" } });
    const result = await s.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /"native":\s*"failed"[\s\S]*"mqtt":\s*"sent"[\s\S]*"mqtt_immediate":\s*"failed"/);
    assert.equal((await s.events()).filter(e => e.kind === 'mqtt').length, 1);
  });

  test(`Linux ${name} fails, naming both routes, when the helper fails and MQTT never connects`, async t => {
    const s = await server(t, { platform: "linux", helperFails: true, mqttHangs: true });
    const result = await s.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /native route: .*MQTT route: no MQTT confirmation within 0.5 s/);
  });

  test(`Linux ${name} reports both reasons when both routes fail`, async t => {
    const s = await server(t, { platform: "linux", helperFails: true, mqttFails: true });
    const result = await s.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /native route: .*MQTT route: /);
  });

  test(`macOS ${name} keeps its native-only route`, async t => {
    const s = await server(t, { platform: "darwin", helperFails: true });
    const result = await s.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.deepEqual((await s.events()).map(e => e.kind), ["helper"]);
  });
}

test("Linux pause stays native-only: only stop and heater-off use both routes", async t => {
  const s = await server(t, { platform: "linux", helperFails: true });
  const result = await s.client.callTool({ name: "pause_print", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual((await s.events()).map(e => e.kind), ["helper"]);
});

test("x2d_native_control names why Linux native controls are unavailable", async t => {
  const s = await server(t, { platform: "linux", unpinnedOptIn: false });
  const result = await s.client.callTool({ name: "x2d_native_control", arguments: {
    message_json: JSON.stringify({ print: { command: "extrusion_cali_get", sequence_id: "1" } }) } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not the pinned Bambu plug-in.*bambu-printer-mcp@\d+\.\d+\.\d+ bambu-printer-mcp-native-setup/);
  assert.deepEqual(await s.events(), []);
});

for (const name of ["cancel_print", "set_temperature"]) {
  test(`Linux ${name} sends MQTT again after a SIGTERM-resistant print helper has exited`, async t => {
    const s = await server(t, { platform: "linux", model: "", helperDelay: 3000, ignoreTerm: true });
    const pending = s.print({ use_ams: false });
    const call = await until(async () => (await s.events()).find(e => e.mode === "--print-authorized"));
    const result = await s.client.callTool({ name, arguments: name === "set_temperature"
      ? { component: "bed", temperature: 0, bambu_model: "x2d" } : {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal((await pending).isError, true);
    const sends = (await s.events()).filter(e => e.kind === "mqtt");
    assert.equal(sends.length, 2);
    assert.deepEqual(sends.at(-1).olderAlive, [], "the counted MQTT send follows the old helper's exit");
    assert.match(result.content[0].text, /"mqtt":\s*"sent"/, "the wait for the old helper does not count against the MQTT bound");
    assert.equal(exited(call.pid), true);
    assert.equal((await s.events()).some(e => e.kind === "sent"), false, "the old helper never dispatched");
  });
}

test("Linux native upload rejects a model without the native route before asking for the native setup", async t => {
  const s = await server(t, { platform: "linux", installedHelper: false });
  const result = await s.client.callTool({ name: "upload_file", arguments: {
    file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native", bambu_model: "p1s" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /restricted to X2D and X1C/);
  assert.doesNotMatch(result.content[0].text, /native-setup/);
  assert.deepEqual(await s.events(), []);
});

// X1C firmware 01.12.00.00 refused every FTPS STOR with 553 while Bambu Studio's plug-in printed.
test("X1C prints over the opt-in native route with the shared checks", async t => {
  const s = await server(t, { model: "x1c", printer: "x1c", storage: { sdcard: true } });
  const result = await s.print({ connection_mode: "bambu_native", ams_slots: [0] });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const events = await s.events();
  assert.equal(events.some(e => ["ftp", "mqtt"].includes(e.kind)), false);
  assert.ok(events.some(e => e.kind === "status"), "fresh printer state is checked");
  const calls = events.filter(e => e.kind === "helper");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "--print-authorized");
  assert.equal(calls[0].useAMS, "true");
  assert.deepEqual(JSON.parse(calls[0].mapping), [0]);
  assert.ok(events.some(e => e.kind === "dispatched"));
});

test("X1C keeps direct MQTT/FTPS as its default print route", async t => {
  const s = await server(t, { model: "x1c", printer: "x1c", storage: { sdcard: true } });
  const result = await s.print({ ams_slots: [0] });
  assert.equal(result.isError, true, "the mocked FTPS upload fails");
  const events = await s.events();
  assert.ok(events.some(e => e.kind === "ftp"));
  assert.equal(events.some(e => e.kind === "helper"), false, "X1C is not redirected to the native route");
});

test("X1C native upload-only uses the helper and never starts printing", async t => {
  const s = await server(t, { model: "x1c", printer: "x1c", storage: { sdcard: true } });
  const result = await s.client.callTool({ name: "upload_file", arguments: {
    file_path: s.file, filename: "cube.3mf", connection_mode: "bambu_native", bambu_model: "x1c" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const calls = (await s.events()).filter(e => e.kind === "helper");
  assert.deepEqual(calls.map(e => e.mode), ["--upload"]);
  assert.equal((await s.events()).some(e => ["ftp", "dispatched"].includes(e.kind)), false);
});

test("native printing stays refused for a model without the native route", async t => {
  const s = await server(t, { model: "p1s" });
  const result = await s.print({ connection_mode: "bambu_native", ams_slots: [0] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /restricted to X2D and X1C/);
  assert.deepEqual(await s.events(), []);
});

for (const name of ["cancel_print", "pause_print"]) {
  test(`${name} for an X1C native job goes over direct MQTT, not the X2D-only native controls`, async t => {
    const s = await server(t, { model: "x1c", printer: "x1c", storage: { sdcard: true } });
    const result = await s.client.callTool({ name, arguments: { connection_mode: "bambu_native" } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual((await s.events()).map(e => e.kind), ["mqtt"]);
  });
}

test("X2D prints past the hidden boot camera notice without clearing, other codes still block", async t => {
  const s = await server(t, { hms: [{ attr: 83887616, code: 131184 }] });
  const printed = await s.print({ ams_slots: [0] });
  assert.notEqual(printed.isError, true, JSON.stringify(printed));
  assert.ok((await s.events()).some(e => e.kind === "dispatched"));
  const blocked = await server(t, { hms: [{ attr: 83887616, code: 131184 }, { attr: 83887616, code: 0x20002 }] });
  const result = await blocked.print({ ams_slots: [0] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HMS 0500-0600-0002-0002/);
  assert.equal((await blocked.events()).some(e => e.kind === "helper"), false);
});

test("an X2D job on FULU's cloud route is paused through that route, not the native helper", async t => {
  // Codex review on #99: native controls used to win before the selected route was read.
  const s = await server(t, { env: { BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network", BAMBU_DEFAULT_CONNECTION_TYPE: "cloud",
    BAMBU_NETWORK_BRIDGE_COMMAND: "", FULU_BAMBU_NETWORK_BRIDGE_COMMAND: "", PJARCZAK_BAMBU_BRIDGE_COMMAND: "" } });
  const result = await s.client.callTool({ name: "pause_print", arguments: {} });
  assert.equal(result.isError, true, "no bridge is configured here, so the cloud route itself reports why");
  assert.equal((await s.events()).some(e => e.kind === "helper"), false, "the native helper sent nothing");
});

// X1C storage requires fresh printer evidence, independently of X2D's fallback.
for (const [label, storage, env, args] of [
  ['no card or capability', {}, {}, {}],
  ['explicit internal with ready card', {sdcard:true}, {}, {try_emmc_print:true}],
  ['environment internal with ready card', {sdcard:true}, {BAMBU_NATIVE_TRY_EMMC_PRINT:'1'}, {}],
  ...[undefined, '', '0', '2', 'invalid', 1, true].map(fun2 => [`invalid/absent capability ${String(fun2)}`, {fun2}, {}, {}]),
]) test(`X1C rejects ${label} before native upload or dispatch`, async t => {
  const s = await server(t, {model:'x1c',printer:'x1c',storage,env});
  const result = await s.print({connection_mode:'bambu_native',ams_slots:[0],...args});
  assert.equal(result.isError,true,JSON.stringify(result));
  assert.match(result.content[0].text,/X1C.*(storage|internal|SD card)/i);
  assert.equal((await s.events()).some(e=>['helper','dispatched','ftp','mqtt'].includes(e.kind)),false);
});

for (const fun2 of ['1','0000000000000000000000000000000000000000000000000000000000000001',' 0X11 ']) {
  test(`X1C permits internal storage advertised by fresh fun2 ${fun2}`, async t => {
    const s = await server(t,{model:'x1c',printer:'x1c',storage:{fun2}});
    const result = await s.print({connection_mode:'bambu_native',ams_slots:[0]});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.equal((await s.events()).find(e=>e.kind==='helper').tryEmmc,'true');
    assert.equal((await s.events()).filter(e=>e.kind==='dispatched').length,1);
  });
}

for (const [label, storage, dispatchStorage] of [
  ['card removed',{sdcard:true},{sdcard:false}],
  ['internal capability withdrawn',{fun2:'1'},{fun2:'0'}],
]) test(`X1C refuses final dispatch when ${label}`, async t => {
  const s=await server(t,{model:'x1c',printer:'x1c',storage,dispatchStorage});
  const result=await s.print({connection_mode:'bambu_native',ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.equal((await s.events()).filter(e=>e.kind==='helper').length,1);
  assert.equal((await s.events()).some(e=>e.kind==='dispatched'),false);
});

test('X1C native print rejects fresh AMS material mismatch before the helper',async t=>{
  const s=await server(t,{model:'x1c',printer:'x1c',storage:{sdcard:true,ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'PETG'}]}]}}});
  const result=await s.print({connection_mode:'bambu_native',ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/material|contradict/i);
  assert.equal((await s.events()).some(e=>e.kind==='helper'),false);
});

test('X1C native job resumes verified bytes over direct MQTT without prompting',async t=>{
  const s=await server(t,{model:'x1c',printer:'x1c',storage:{sdcard:true},resumeAfterPrint:true});
  const printed=await s.print({connection_mode:'bambu_native',ams_slots:[0]});
  assert.notEqual(printed.isError,true,JSON.stringify(printed));
  const resumed=await s.client.callTool({name:'resume_print',arguments:{connection_mode:'bambu_native'}});
  assert.notEqual(resumed.isError,true,JSON.stringify(resumed));
  const events=await s.events();
  assert.ok(events.some(e=>e.kind==='reread'));
  assert.equal(events.filter(e=>e.kind==='mqtt').length,1);
  assert.equal(events.filter(e=>e.kind==='helper').length,1,'resume does not start another native helper');
  assert.deepEqual(s.prompts,[]);
});

test('native helper failure after authorized print retains the exact unconfirmed flight record through the public tool',async t=>{
  const peer=await server(t,{crashAfterDispatch:true});
  const sent=await peer.print({connection_mode:'bambu_native',ams_slots:[0]});
  assert.equal(sent.isError,true);assert.equal(sent.structuredContent.printOutcome,'unknown');
  assert.equal((await peer.events()).filter(e=>e.kind==='dispatched').length,1);
  const saved=await peer.client.callTool({name:'counterpart_print_record',arguments:{host:'127.0.0.1',bambu_serial:'20PTEST'}});
  assert.equal(saved.structuredContent.status,'recorded');
  assert.equal(saved.structuredContent.record.dispatch.sha256,createHash('sha256').update(await fs.readFile(peer.file)).digest('hex'));
  assert.deepEqual(saved.structuredContent.record.dispatch.mapping,[0]);
  assert.equal(saved.structuredContent.record.dispatch.outcome,'unconfirmed');
  assert.equal(saved.structuredContent.physical.status,'unknown');
});
