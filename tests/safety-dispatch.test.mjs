import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import JSZip from "jszip";
import { BambuImplementation } from "../dist/printers/bambu.js";
import { BambuNetworkBridge } from "../dist/bambu-network-bridge.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = "127.0.0.1";
const serial = "01PTESTSAFETY";
const token = "TEST_TOKEN";

function safetyStatus({ model = "p1s", nozzle = "0.4", state = "IDLE", ...raw } = {}) {
  return {
    connected: true, model, status: state, serial,
    raw: { model, gcode_state: state, nozzle_diameter: nozzle, print_error: 0, hms: [], ...raw },
    observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report" },
  };
}

async function fixture(t, { model = "p1s", nozzle = "0.4", nozzleDiameters, material = "PLA", gcode = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", raw = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-safety-dispatch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, raw ? "job.gcode" : "job.gcode.3mf");
  const nozzles = (nozzleDiameters ?? [nozzle]).map(String);
  const content = `; printer_model = Bambu Lab ${model === "a1mini" ? "A1 mini" : model.toUpperCase()}\n; nozzle_diameter = ${nozzles.join(";")}\n; filament_type = ${material}\n; filament_colour = #FFFFFF\n; curr_bed_type = Textured PEI Plate\n${gcode}`;
  if (raw) await fs.writeFile(file, content);
  else {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="cube.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
    zip.file("Metadata/plate_1.gcode", content);
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
    zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: model, nozzle_diameter: nozzles, filament_type: [material], curr_bed_type: "Textured PEI Plate" }));
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return file;
}

function isolatedPrinter(status = safetyStatus()) {
  const printer = new BambuImplementation(async () => true);
  const events = [];
  printer.ftpUpload = async (_host, _token, file, remote) => events.push({ action: "upload", file, remote, bytes: await fs.readFile(file) });
  printer.getSafetyStatus = async () => { events.push({ action: "status" }); return status; };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return { publish: async (payload) => events.push({ action: "publish", payload }) };
  };
  return { printer, events };
}

function assertNoDispatch(events) {
  assert.deepEqual(events.filter(({ action }) => action === "upload" || action === "publish"), [], "rejected print must not upload bytes or publish a print command");
}

for (const [name, gcode] of [
  ["declared PLA at 400 C", "M104 S400\n"],
  ["bed at 300 C", "M140 S300\n"],
  ["nonfinite nozzle target", "M104 SNaN\n"],
  ["R-form waiting nozzle target", "M109 R400\n"],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, { gcode });
    const { printer, events } = isolatedPrinter();
    await assert.rejects(printer.print3mf(host, serial, token, { projectName: "unsafe", filePath: file, bambuModel: "p1s", nozzleDiameters: [0.4], useAMS: false }), /temperature|thermal|finite|target|limit/i);
    assertNoDispatch(events);
  });
}

for (const [name, fileOptions, status, options, error] of [
  ["file model mismatch", { model: "h2d" }, safetyStatus(), {}, /model|P1S|H2D/i],
  ["requested nozzle mismatch", { nozzle: "0.8" }, safetyStatus(), {}, /nozzle|diameter/i],
  ["live model mismatch", {}, safetyStatus({ model: "a1mini" }), {}, /model|identity/i],
  ["live nozzle mismatch", {}, safetyStatus({ nozzle: "0.6" }), {}, /nozzle|diameter/i],
  ["busy printer", {}, safetyStatus({ state: "RUNNING" }), {}, /state|busy|RUNNING/i],
  ["active printer error", {}, safetyStatus({ print_error: 1234 }), {}, /error|fault/i],
  ["reported external-spool material contradicting PLA", {}, safetyStatus({ vt_tray: { tray_type: "ABS", nozzle_temp_min: "240", nozzle_temp_max: "270" } }), {}, /material|contradict/i],
  ["missing selected plate on the legacy route", {}, safetyStatus(), { plateIndex: 98 }, /plate|present|missing/i],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, fileOptions);
    const { printer, events } = isolatedPrinter(status);
    await assert.rejects(printer.print3mf(host, serial, token, { projectName: "unsafe", filePath: file, bambuModel: "p1s", nozzleDiameters: [0.4], useAMS: false, ...options }), error);
    assertNoDispatch(events);
  });
}

test("low-level print3mf requires a model even when the serial has a known prefix", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "missing-model", filePath: file, useAMS: false }), /model.*required|provide.*model|explicit.*model/i);
  assert.deepEqual(events, [], "model validation must happen before connecting");
});

test("legacy gcode_file refuses an AMS mapping it cannot carry", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "mapped", filePath: file, bambuModel: "p1s", useAMS: true, amsSlots: [1] }), /AMS|mapping|gcode_file|legacy/i);
  assertNoDispatch(events);
});

test("a project AMS mapping cannot bypass a reported material mismatch", async (t) => {
  const legacyFile = await fixture(t);
  const file = legacyFile.replace(".gcode.3mf", ".3mf");
  await fs.rename(legacyFile, file);
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { ams: [{ id: "0", tray: [{ id: "1", tray_type: "ABS", nozzle_temp_min: "240", nozzle_temp_max: "270" }] }] } }));
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "conflicting-material", filePath: file, bambuModel: "p1s", useAMS: true, amsSlots: [1] }), /material|contradict/i);
  assertNoDispatch(events);
});

test("printer becoming busy during upload stops the final print command", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => safetyStatus({ state: ++reads <= 2 ? "IDLE" : "RUNNING" });
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "state-changed", filePath: file, bambuModel: "p1s", useAMS: false }), /state|busy|RUNNING/i);
  assert.equal(events.filter(({ action }) => action === "upload").length, 1);
  assert.equal(events.filter(({ action }) => action === "publish").length, 0);
});

for (const action of ["stop", "heater-off"]) {
  test(`${action} during upload is immediate and prevents pending print dispatch`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter();
    let releaseUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    let markUploadStarted;
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    printer.ftpUpload = async () => { events.push({ action: "upload" }); markUploadStarted(); await uploadGate; };
    const pendingPrint = printer.print3mf(host, serial, token, { projectName: "cancelled", filePath: file, bambuModel: "p1s", useAMS: false });
    // Attach the rejection observer before cancellation to avoid an unhandled rejection.
    const outcome = pendingPrint.then(value => ({ value }), error => ({ error }));
    await uploadStarted;
    const safetyAction = action === "stop" ? printer.cancelJob(host, serial, token) : printer.setTemperature(host, serial, token, "nozzle", 0);
    let timeout;
    try {
      await Promise.race([safetyAction, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${action} waited behind a pending upload`)), 1500); })]);
      const publishes = events.filter((event) => event.action === "publish");
      assert.equal(publishes.length, 1, "stop/off must publish while the upload is blocked");
      if (action === "stop") assert.equal(publishes[0].payload.print.command, "stop");
      else assert.match(JSON.stringify(publishes[0].payload), /M104 S0/);
    } finally {
      clearTimeout(timeout);
      releaseUpload();
      await safetyAction;
    }
    const completed = await outcome;
    assert.match(completed.error?.message ?? "", /cancelled|canceled|stop|heater-off/i, "the pending print must be cancelled");
    assert.equal(events.filter((event) => event.action === "publish").length, 1, "no print command may follow stop/off");
  });
}

test("upload-and-print rejects dangerous raw G-code before uploading", async (t) => {
  const file = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.uploadFile(host, serial, token, file, "unsafe.gcode", true, "p1s"), /temperature|thermal|limit/i);
  assertNoDispatch(events);
});

test("an inspected print uploads its private copy when the caller's file changes", async (t) => {
  const file = await fixture(t);
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => {
    if (++reads === 1) await fs.writeFile(file, "M104 S400\n");
    return safetyStatus();
  };
  const result = await printer.print3mf(host, serial, token, { projectName: "snapshot", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(result.status, "success");
  const upload = events.find(({ action }) => action === "upload");
  assert.notEqual(upload.file, file);
  assert.deepEqual(upload.bytes, expected, "uploaded bytes must be the file that passed inspection");
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-job\.gcode\.3mf$/);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), new RegExp(path.posix.basename(upload.remote).replaceAll(".", "\\.")));
});

for (const [component, target, material] of [["nozzle", NaN, "PLA"], ["bed", Infinity, undefined], ["bed", 300, undefined], ["nozzle", 300, "PLA"], ["nozzle", 220, undefined]]) {
  test(`manual ${component} target ${String(target)} ${material ?? "without material"} rejects before connection`, async () => {
    const { printer, events } = isolatedPrinter();
    await assert.rejects(printer.setTemperature(host, serial, token, component, target, "p1s", material, 0.4), /temperature|finite|material|limit/i);
    assert.deepEqual(events, [], "invalid heater requests must not connect or publish");
  });
}

test("heater-off remains available without material or reported nozzle metadata", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ nozzle: undefined }));
  const result = await printer.setTemperature(host, serial, token, "nozzle", 0);
  assert.equal(result.status, "success");
  assert.equal(events.filter(({ action }) => action === "publish").length, 1);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), /M104 S0/);
});

test("manual nozzle heating cannot relabel a loaded AMS PLA spool as PA", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({
    ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
  }));
  await assert.rejects(printer.setTemperature(host, serial, token, "nozzle", 300, "p1s", "PA", 0.4), /material|contradict|PLA/i);
  assertNoDispatch(events);
});

test("manual nozzle heating accepts a declared external PA spool with matching telemetry", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { tray_now: "254", ams: [] }, vt_tray: { tray_type: "PA", nozzle_temp_min: "250", nozzle_temp_max: "300" } }));
  const result = await printer.setTemperature(host, serial, token, "nozzle", 280, "p1s", "PA", 0.4);
  assert.equal(result.status, "success");
  const publishes = events.filter((event) => event.action === "publish");
  assert.equal(publishes.length, 1);
  assert.match(JSON.stringify(publishes[0].payload), /M104(?: T0)? S280/);
});

for (const route of ["legacy 3MF", "raw upload-and-print", "remote start"]) {
  test(`${route} checks the loaded AMS material instead of an unused external-spool declaration`, async (t) => {
    const file = await fixture(t, { raw: route !== "legacy 3MF", material: "PA", gcode: "M104 S300\nM140 S60\nG1 X10 Y10 Z1\n" });
    const { printer, events } = isolatedPrinter(safetyStatus({
      ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
      vt_tray: { tray_type: "PA", nozzle_temp_min: "250", nozzle_temp_max: "300" },
    }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "legacy 3MF"
      ? printer.print3mf(host, serial, token, { projectName: "wrong-loaded-material", filePath: file, bambuModel: "p1s", useAMS: false })
      : route === "raw upload-and-print"
        ? printer.uploadFile(host, serial, token, file, "wrong-material.gcode", true, "p1s")
        : printer.startJob(host, serial, token, "wrong-material.gcode", "p1s");
    await assert.rejects(print, /material|contradict|PLA|loaded/i);
    assertNoDispatch(events);
  });
}

test("remote start refuses an artifact that cannot be downloaded for inspection", async () => {
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async () => { throw new Error("remote artifact unavailable for inspection"); };
  await assert.rejects(printer.startJob(host, serial, token, "uninspected.gcode", "p1s"), /inspect|download|unavailable/i);
  assertNoDispatch(events);
});

test("remote start rejects downloaded PLA at 400 C before reupload or print", async (t) => {
  const file = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
  await assert.rejects(printer.startJob(host, serial, token, "unsafe.gcode", "p1s"), /temperature|thermal|limit/i);
  assertNoDispatch(events);
});

test("remote start uploads and starts a uniquely named copy of the inspected download", async (t) => {
  const file = await fixture(t, { raw: true });
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  const downloads = [];
  printer.ftpDownload = async (targetHost, targetToken, remote, destination) => {
    downloads.push({ targetHost, targetToken, remote });
    await fs.copyFile(file, destination);
  };
  const result = await printer.startJob(host, serial, token, "old-job.gcode", "p1s");
  assert.equal(result.status, "success");
  assert.deepEqual(downloads, [{ targetHost: host, targetToken: token, remote: "cache/old-job.gcode" }]);
  const upload = events.find(({ action }) => action === "upload");
  assert.deepEqual(upload.bytes, expected);
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-old-job\.gcode$/);
  assert.match(JSON.stringify(events.find(({ action }) => action === "publish").payload), new RegExp(path.posix.basename(upload.remote).replaceAll(".", "\\.")));
});

test("resume refuses a job this server has not inspected before connecting", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "PAUSE" }));
  await assert.rejects(printer.resumeJob(host, serial, token), /inspect|server instance|verified/i);
  assert.deepEqual(events, []);
});

test("a matching inspected paused job can resume after a fresh safety check", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  const started = await printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
  events.length = 0;
  printer.getSafetyStatus = async () => {
    events.push({ action: "status" });
    return safetyStatus({ state: "PAUSE", gcode_file: started.remoteProjectPath });
  };
  const result = await printer.resumeJob(host, serial, token);
  assert.equal(result.status, "success");
  assert.deepEqual(events.map(({ action }) => action), ["status", "connect", "publish"]);
  assert.equal(events[2].payload.print.command, "resume");
});

for (const [name, changes, error] of [
  ["a different paused job", { gcode_file: "cache/unverified.gcode", subtask_name: "another job" }, /identity|artifact|match/i],
  ["a changed nozzle", { nozzle: "0.6" }, /nozzle|diameter/i],
  ["a changed spool material", { vt_tray: { tray_type: "ABS" } }, /material|contradict/i],
  ["a job that is no longer paused", { state: "RUNNING" }, /paused|PAUSE|state/i],
]) {
  test(`resume refuses ${name} without publishing`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter();
    const started = await printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
    events.length = 0;
    printer.getSafetyStatus = async () => safetyStatus({ state: "PAUSE", gcode_file: started.remoteProjectPath, ...changes });
    await assert.rejects(printer.resumeJob(host, serial, token), error);
    assert.deepEqual(events, [], "rejected resume must not connect to publish a mutation");
  });
}

async function interceptedMcp(t, { blockBridgeInitialization = false, realBridgeRequest = false, model = "p1s", nozzleDiameters = [0.4], ams, bridgeResponse = { ok: true, value: 0 } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-bridge-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "events.jsonl");
  const releasePath = path.join(dir, "release-agent");
  const statusPath = path.join(dir, "reported-status.json");
  const preload = path.join(dir, "boundaries.mjs");
  await fs.writeFile(preload, `
    import fs from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/printers/bambu.js")).href)};
    import { BambuNetworkBridge } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/bambu-network-bridge.js")).href)};
    import { STLManipulator } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stl/stl-manipulator.js")).href)};
    const log = event => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
    BambuImplementation.prototype.ftpUpload = async (_host, _token, file, remote) => log({action:'upload', file, remote});
    BambuImplementation.prototype.ftpDownload = async () => { throw new Error('Remote artifact unavailable for inspection'); };
    BambuImplementation.prototype.getPrinter = async () => ({publish: async payload => log({action:'publish', payload})});
    STLManipulator.prototype.sliceSTL = async () => { log({action:'slice'}); throw new Error('Test slicer must not be invoked'); };
    BambuImplementation.prototype.getSafetyStatus = async () => {
      const now = Date.now();
      const reported=fs.existsSync(${JSON.stringify(statusPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(statusPath)},'utf8')) : {};
      return {connected:true, model:${JSON.stringify(model)}, status:reported.gcode_state??'IDLE', serial:${JSON.stringify(serial)},
        raw:{model:${JSON.stringify(model)},gcode_state:'IDLE',nozzle_diameter:${JSON.stringify(String(nozzleDiameters[0]))},device:{nozzle:{info:${JSON.stringify(nozzleDiameters.map((diameter, id) => ({ id, diameter, type: "HH01", stat: 0 })))}}},print_error:0,hms:[],...${JSON.stringify(ams ? { ams } : {})},...reported},
        observation:{source:'mqtt',requestedAt:now,receivedAt:now,identitySource:'report'}};
    };
    BambuNetworkBridge.prototype.ensureAgent = async () => {
      ${blockBridgeInitialization ? `log({action:'agent-wait'}); while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(resolve => setTimeout(resolve,10));` : ""}
      return { agent: 0, handshake: { ok: true } };
    };
    ${realBridgeRequest ? `BambuNetworkBridge.prototype.ensureStarted = async function () {
      this.child = {exitCode:0, stdin:{write:(frame, callback) => {
        const message=JSON.parse(frame.subarray(16).toString('utf8'));
        log({action:'bridge-frame',...message});
        const payload=Buffer.from(JSON.stringify(${JSON.stringify(bridgeResponse)}));
        const response=Buffer.alloc(16+payload.length);
        response.writeUInt32LE(0x52424a50,0); response.writeUInt32LE(2,4);
        response.writeUInt32LE(frame.readUInt32LE(8),8); response.writeUInt32LE(payload.length,12); payload.copy(response,16);
        queueMicrotask(()=>this.handleStdout(response)); callback?.(); return true;
      }}};
    };` : `BambuNetworkBridge.prototype.request = async (method, payload) => {
      log({ action:'bridge', method, payload });
      return ${JSON.stringify(bridgeResponse)};
    };`}
  `);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, path.join(root, "dist/index.js")], cwd: dir, stderr: "pipe", env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_PRINTER_HOST: host, BAMBU_PRINTER_SERIAL: serial, BAMBU_SERIAL: serial, BAMBU_PRINTER_ACCESS_TOKEN: token, BAMBU_TOKEN: token, BAMBU_DEV_ID: serial, BAMBU_NETWORK_BRIDGE_COMMAND: "" } });
  const client = new Client({ name: "safety-dispatch-tests", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  t.after(() => client.close());
  await client.connect(transport);
  return { client, eventsPath, releaseAgent: () => fs.writeFile(releasePath, "release"), setReportedStatus: reported => fs.writeFile(statusPath, JSON.stringify(reported)) };
}

test("raw BambuNetwork start_print cannot bypass the inspected print handler", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const result = await client.callTool({ name: "bambu_network_call", arguments: { method: "net.start_print", with_agent: false, payload: { client_job_id: 0, params: { filename: "uninspected.gcode" } } } });
  assert.equal(result.isError, true);
  assert.match(result.content.map((item) => item.text ?? "").join(" "), /safety|print_3mf_bambu_network|inspect|not allowed|disabled/i);
  await assert.rejects(fs.access(eventsPath), { code: "ENOENT" }, "raw mutation must be rejected before invoking the bridge");
});

test("public print and heating tools enforce safety before their transport boundaries", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const unsafe3mf = await fixture(t, { gcode: "M104 S400\n" });
  const unsafeGcode = await fixture(t, { raw: true, gcode: "M140 S300\n" });
  const safe3mf = await fixture(t);
  for (const [name, args, expected] of [
    ["print_3mf", { three_mf_path: unsafe3mf, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false }, /temperature|thermal|limit/i],
    ["upload_file", { file_path: unsafeGcode, filename: "unsafe.gcode", print: true, bambu_model: "p1s" }, /temperature|thermal|limit/i],
    ["start_print", { filename: "uninspected.gcode", bambu_model: "p1s" }, /inspect|download|unavailable/i],
    ["start_print_job", { filename: "uninspected.gcode", bambu_model: "p1s" }, /inspect|download|unavailable/i],
    ["print_3mf_bambu_network", { three_mf_path: unsafe3mf, bambu_model: "p1s", bed_type: "textured_plate", ams_slots: [0], connection_type: "cloud" }, /temperature|thermal|limit/i],
    ["print_3mf_bambu_network", { three_mf_path: safe3mf, bambu_model: "p1s", bed_type: "textured_plate", plate_index: 98, ams_slots: [0], connection_type: "cloud" }, /plate/i],
    ["set_temperature", { component: "nozzle", temperature: "not-a-number", bambu_model: "p1s", material: "PLA" }, /number|finite|temperature/i],
    ["set_temperature", { component: "bed", temperature: 300, bambu_model: "p1s" }, /temperature|limit/i],
  ]) {
    await t.test(`${name} rejects ${JSON.stringify(args)}`, async () => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(result.content.map((item) => item.text ?? "").join(" "), expected);
      await assert.rejects(fs.access(eventsPath), { code: "ENOENT" }, "rejected public request must not upload, publish, or invoke bridge");
    });
  }
});

test("verified public direct and bridge prints reach their intended transport", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t);
  const file = await fixture(t);
  const direct = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false } });
  assert.notEqual(direct.isError, true, direct.content?.[0]?.text);
  const directEvents = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(directEvents.map(({ action }) => action), ["upload", "publish"]);
  assert.equal(directEvents[1].payload.print.command, "gcode_file");
  assert.equal(directEvents[1].payload.print.param, directEvents[0].remote.slice(1));

  await fs.writeFile(eventsPath, "");
  const bridge = await client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  assert.notEqual(bridge.isError, true, bridge.content?.[0]?.text);
  const bridgeEvents = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const print = bridgeEvents.find((event) => event.method === "net.start_print");
  assert.ok(print, "verified bridge handler must issue net.start_print");
  assert.equal(print.payload.params.plate_index, 1, "bridge uses one-based plate numbers");
  assert.notEqual(print.payload.params.filename, file, "bridge must consume the checked private copy");
  assert.match(print.payload.params.dst_file, /^checked-[a-f0-9-]+-job\.gcode\.3mf$/);
  assert.equal(print.payload.params.task_use_ams, false);
  assert.equal(print.payload.params.ams_mapping, "[254]");
});

async function startBridgeJob(t, options) {
  const server = await interceptedMcp(t, { realBridgeRequest: true, ...options });
  const file = await fixture(t);
  const result = await server.client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", bed_type: "textured_plate", use_ams: false, connection_type: "cloud" } });
  const events = (await fs.readFile(server.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const params = events.find(event => event.action === "bridge-frame" && event.method === "net.start_print")?.payload.params;
  assert.ok(params, "the bridge job must reach the native request boundary");
  return { ...server, result, params };
}

for (const identityField of ["gcode_file", "subtask_name"]) {
  test(`a verified bridge job resumes when fresh ${identityField} identifies its unique artifact`, async (t) => {
    const server = await startBridgeJob(t);
    assert.notEqual(server.result.isError, true, server.result.content?.[0]?.text);
    assert.match(server.params.task_name, /^checked-[a-f0-9-]+-job/);
    const reportedName = identityField === "gcode_file" ? server.params.dst_file : server.params.task_name;
    await server.setReportedStatus({ gcode_state: "PAUSE", [identityField]: reportedName });
    await fs.writeFile(server.eventsPath, "");
    const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
    assert.notEqual(resumed.isError, true, resumed.content?.[0]?.text);
    const events = (await fs.readFile(server.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(event => event.action), ["publish"]);
    assert.equal(events[0].payload.print.command, "resume");
  });
}

for (const [description, changedReport, expected] of [
  ["a different paused job", { gcode_file: "unverified.gcode", subtask_name: "other project" }, /identity|artifact|match/i],
  ["a changed physical nozzle", { nozzle_diameter: "0.6", device: { nozzle: { info: [{ id: 0, diameter: 0.6, type: "HH01", stat: 0 }] } } }, /nozzle|diameter/i],
]) {
  test(`bridge-job resume refuses ${description}`, async (t) => {
    const server = await startBridgeJob(t);
    assert.notEqual(server.result.isError, true, server.result.content?.[0]?.text);
    await server.setReportedStatus({ gcode_state: "PAUSE", gcode_file: server.params.dst_file, ...changedReport });
    await fs.writeFile(server.eventsPath, "");
    const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
    assert.equal(resumed.isError, true);
    assert.match(resumed.content?.[0]?.text ?? "", expected);
    assert.equal(await fs.readFile(server.eventsPath, "utf8"), "", "a failed resume must not publish or dispatch");
  });
}

test("a rejected bridge start cannot authorize a later resume", async (t) => {
  const server = await startBridgeJob(t, { bridgeResponse: { ok: true, value: -1 } });
  assert.equal(server.result.isError, true);
  await server.setReportedStatus({ gcode_state: "PAUSE", gcode_file: server.params.dst_file });
  await fs.writeFile(server.eventsPath, "");
  const resumed = await server.client.callTool({ name: "resume_print", arguments: {} });
  assert.equal(resumed.isError, true);
  assert.match(resumed.content?.[0]?.text ?? "", /inspected|server instance|verified/i);
  assert.equal(await fs.readFile(server.eventsPath, "utf8"), "", "failed submission cannot leave a resumable job receipt");
});

test("public print schemas expose ordered nozzle diameter arrays", async (t) => {
  const { client } = await interceptedMcp(t);
  const { tools } = await client.listTools();
  for (const name of ["print_3mf", "print_3mf_bambu_network"]) {
    const schema = tools.find(tool => tool.name === name)?.inputSchema;
    assert.equal(schema?.properties?.nozzle_diameters?.type, "array", `${name} must accept per-nozzle diameters`);
    assert.equal(schema.properties.nozzle_diameters.items.type, "number");
  }
});

for (const tool of ["print_3mf", "print_3mf_bambu_network"]) {
  for (const [description, nozzleArgs] of [
    ["explicit ordered nozzle diameters", { nozzle_diameters: [0.4, 0.6] }],
    ["job metadata when no nozzle argument is supplied", {}],
  ]) {
    test(`${tool} accepts mixed H2D nozzles using ${description}`, async (t) => {
      const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.4, 0.6], realBridgeRequest: true });
      const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
      const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", bed_type: "textured_plate", use_ams: false, ...nozzleArgs } });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
      if (tool === "print_3mf") {
        assert.deepEqual(events.map(event => event.action), ["upload", "publish"]);
        assert.equal(events[1].payload.print.command, "project_file");
        assert.equal(events[1].payload.print.param, "Metadata/plate_1.gcode");
      } else {
        assert.equal(events.filter(event => event.action === "bridge-frame" && event.method === "net.start_print").length, 1);
      }
    });
  }

  test(`${tool} accepts mixed H2D nozzles with a verified AMS mapping`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, {
      model: "h2d", nozzleDiameters: [0.4, 0.6], realBridgeRequest: true,
      ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
    });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", ams_slots: [0] } });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    if (tool === "print_3mf") {
      assert.deepEqual(events.find(event => event.action === "publish")?.payload.print.ams_mapping, [0]);
    } else {
      assert.equal(events.find(event => event.action === "bridge-frame" && event.method === "net.start_print")?.payload.params.ams_mapping, "[0]");
    }
  });

  for (const [description, nozzleArgs] of [
    ["an explicit scalar that does not match every nozzle", { nozzle_diameter: "0.4" }],
    ["an array with the nozzle positions reversed", { nozzle_diameters: [0.6, 0.4] }],
  ]) {
    test(`${tool} rejects ${description}`, async (t) => {
      const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
      const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
      const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", ...nozzleArgs, bed_type: "textured_plate", use_ams: false } });
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? "", /nozzle|diameter/i);
      await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
    });
  }

  test(`${tool} rejects a mixed H2D file when the live second nozzle differs`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.4, 0.8], realBridgeRequest: true });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /nozzle.*1.*diameter|nozzle.*match/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });

  test(`${tool} rejects conflicting scalar and array nozzle arguments`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameter: "0.4", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /both|conflict|one of|either/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });

  test(`${tool} rejects mixed-nozzle auto-slicing before the slicer or printer is invoked`, async (t) => {
    const { client, eventsPath } = await interceptedMcp(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.6] });
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.remove("Metadata/plate_1.gcode");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await client.callTool({ name: tool, arguments: { three_mf_path: file, bambu_model: "h2d", nozzle_diameters: [0.4, 0.6], bed_type: "textured_plate", use_ams: false } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /mixed|pre-sliced|already.sliced/i);
    await assert.rejects(fs.access(eventsPath), { code: "ENOENT" });
  });
}

function bridgeWithCapturedFrames(t, beforeStartup = async () => {}) {
  const bridge = new BambuNetworkBridge();
  const frames = [];
  bridge.ensureStarted = async () => {
    await beforeStartup();
    bridge.child = { exitCode: 0, stdin: { write(frame, callback) {
      frames.push(JSON.parse(frame.subarray(16).toString("utf8")));
      const payload = Buffer.from(JSON.stringify({ ok: true, value: 0 }));
      const response = Buffer.alloc(16 + payload.length);
      response.writeUInt32LE(0x52424a50, 0);
      response.writeUInt32LE(2, 4);
      response.writeUInt32LE(frame.readUInt32LE(8), 8);
      response.writeUInt32LE(payload.length, 12);
      payload.copy(response, 16);
      queueMicrotask(() => bridge.handleStdout(response));
      callback?.();
      return true;
    } } };
  };
  t.after(() => bridge.stop());
  return { bridge, frames };
}

test("bridge request checks fresh state after process startup and before writing a frame", async (t) => {
  let completeStartup;
  let startupEntered;
  const waiting = new Promise(resolve => { startupEntered = resolve; });
  const startupGate = new Promise(resolve => { completeStartup = resolve; });
  const { bridge, frames } = bridgeWithCapturedFrames(t, async () => { startupEntered(); await startupGate; });
  let state = "IDLE";
  const request = bridge.request("net.start_print", {}, {
    beforeDispatch: async () => { if (state !== "IDLE") throw new Error("Fresh printer state is RUNNING"); },
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(request, /RUNNING/);
  await waiting;
  state = "RUNNING";
  completeStartup();
  await rejected;
  assert.deepEqual(frames, [], "no print frame may be written after startup invalidates the observed state");
});

test("bridge request checks cancellation after awaited preflight immediately before frame write", async (t) => {
  const { bridge, frames } = bridgeWithCapturedFrames(t);
  let releasePreflight;
  let preflightEntered;
  const waiting = new Promise(resolve => { preflightEntered = resolve; });
  const preflightGate = new Promise(resolve => { releasePreflight = resolve; });
  let cancelled = false;
  const request = bridge.request("net.start_print", {}, {
    beforeDispatch: async () => { preflightEntered(); await preflightGate; },
    assertDispatchAllowed: () => { if (cancelled) throw new Error("Print cancelled"); },
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(request, /cancelled/);
  await waiting;
  cancelled = true;
  releasePreflight();
  await rejected;
  assert.deepEqual(frames, [], "cancellation during async preflight must stop the actual frame write");
});

test("bridge request writes a valid frame after both preflight hooks allow dispatch", async (t) => {
  const { bridge, frames } = bridgeWithCapturedFrames(t);
  const checks = [];
  const result = await bridge.request("net.start_print", { agent: 7, params: { plate_index: 1 } }, {
    beforeDispatch: async method => { checks.push(["fresh-state", method]); },
    assertDispatchAllowed: method => { checks.push(["cancellation", method]); },
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { ok: true, value: 0 });
  assert.deepEqual(checks, [["fresh-state", "net.start_print"], ["cancellation", "net.start_print"]]);
  assert.deepEqual(frames, [{ method: "net.start_print", payload: { agent: 7, params: { plate_index: 1 } } }]);
});

test("public stop during bridge agent initialization prevents the actual native print frame", async (t) => {
  const { client, eventsPath, releaseAgent } = await interceptedMcp(t, { blockBridgeInitialization: true, realBridgeRequest: true });
  const file = await fixture(t);
  const pending = client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "lan" } });
  try {
    const deadline = Date.now() + 5000;
    while (!(await fs.readFile(eventsPath, "utf8").catch(() => "")).includes('"agent-wait"')) {
      assert.ok(Date.now() < deadline, "bridge initialization gate must be reached");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const stopped = await client.callTool({ name: "cancel_print", arguments: {} });
    assert.notEqual(stopped.isError, true, stopped.content?.[0]?.text);
  } finally {
    await releaseAgent();
  }
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content.map(item => item.text ?? "").join(" "), /cancelled|canceled|stop/i);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(event => event.action === "publish" && event.payload?.print?.command === "stop").length, 1);
  assert.equal(events.filter(event => event.action === "bridge-frame").length, 0, "the real bridge request must stop before stdin.write");
});

test("human preflight declines before upload and shows inspected settings", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assertNoDispatch(events);
  assert.match(prompts[0], /P1S.*0\.4 mm.*PLA.*220°C.*60°C.*SHA-256/s);
});

test("human preflight rechecks printer state after confirmation", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ state: "RUNNING" }); return true; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /not safely idle/i);
  assertNoDispatch(events);
});

test("FINISH requires bed clearance even with ordinary headless prompts disabled", async (t) => {
  const previous = process.env.BAMBU_REQUIRE_CONFIRMATION;
  process.env.BAMBU_REQUIRE_CONFIRMATION = "0";
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_REQUIRE_CONFIRMATION; else process.env.BAMBU_REQUIRE_CONFIRMATION = previous; });
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assert.match(prompts[0], /FINISH.*remove the previous part/i);
  assertNoDispatch(events);
});

test("bed clearance cannot authorize a different finished job", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ state: "FINISH", subtask_name: "another-part" }); return true; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /newly finished job/i);
  assertNoDispatch(events);
});

test("manual positive heating requires confirmation but heater-off does not", async () => {
  const { printer, events } = isolatedPrinter();
  printer.confirm = async () => false;
  await assert.rejects(printer.setTemperature(host, serial, token, "nozzle", 220, "p1s", "PLA"), /confirmation.*declined/i);
  assertNoDispatch(events);
  await printer.setTemperature(host, serial, token, "nozzle", 0);
  assert.match(events.find(event => event.action === "publish").payload.print.param, /M104 S0/);
});

test("hardware errors cannot be cleared without human confirmation", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [{ attr: 1, code: 0x20001 }] }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), /confirmation.*declined/i);
  assert.match(prompts[0], /print_error:123.*hms:1:131073|hms:1:131073.*print_error:123/);
  assertNoDispatch(events);
});

test("cleared hardware codes are returned and acknowledged again before printing", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  const cleared = await printer.clearHmsErrors(host, serial, token);
  assert.deepEqual(cleared.cleared_codes, ["print_error:123"]);
  events.length = 0;
  printer.getSafetyStatus = async () => safetyStatus();
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assert.match(prompts[0], /Previously cleared hardware codes: print_error:123/);
  assertNoDispatch(events);
});

test("changed hardware codes during confirmation are not cleared", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ print_error: 456, hms: [] }); return true; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), /errors changed/i);
  assertNoDispatch(events);
});
