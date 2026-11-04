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
import { withPrintSnapshot } from "../dist/safety/artifact.js";
import { studioAmsMappingInfo, trayColour } from "../dist/ams-mapping.js";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = "127.0.0.1";
const serial = "01PTESTSAFETY";
const token = "TEST_TOKEN";

function safetyStatus({ model = "p1s", nozzle = "0.4", state = "IDLE", ...raw } = {}) {
  return {
    connected: true, model, status: state, serial,
    raw: { model, ...(["h2d","h2dpro","h2c","x2d"].includes(model) ? {vir_slot:[{id:254,tray_type:"PLA"},{id:255,tray_type:"PLA"}]} : {}), gcode_state: state, nozzle_diameter: nozzle, print_error: 0, hms: [], ...raw },
    observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report" },
  };
}

async function fixture(t, { model = "p1s", nozzle = "0.4", nozzleDiameters, material = "PLA", gcode = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", raw = false, project = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-safety-dispatch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, raw ? "job.gcode" : "job.gcode.3mf");
  const nozzles = (nozzleDiameters ?? [nozzle]).map(String);
  const content = `; printer_model = Bambu Lab ${model === "a1mini" ? "A1 mini" : model.toUpperCase()}\n; nozzle_diameter = ${nozzles.join(";")}\n; filament_type = ${material}\n${nozzles.length === 2 ? `; filament_map = ${material.split(";").map(() => 1).join(",")}\n; physical_extruder_map = 1,0\n` : ""}; filament_colour = #FFFFFF\n; curr_bed_type = Textured PEI Plate\n${gcode}`;
  if (raw) await fs.writeFile(file, content);
  else {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="cube.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
    zip.file("Metadata/plate_1.gcode", content);
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
    zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: model, nozzle_diameter: nozzles, filament_type: [material], curr_bed_type: "Textured PEI Plate", ...project }));
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return file;
}

function isolatedPrinter(status = safetyStatus(), { confirm = async () => true, resumeStateDir, files = new Map() } = {}) {
  const prompts = [];
  const printer = new BambuImplementation(async (message) => { prompts.push(message); return confirm(message); }, { resumeStateDir });
  const events = [];
  // The printer's storage: uploads land here and FTPS downloads read them back.
  const stored = (remote) => remote.replace(/^\/+/, "");
  printer.ftpUpload = async (_host, _token, file, remote) => {
    const bytes = await fs.readFile(file);
    files.set(stored(remote), bytes);
    events.push({ action: "upload", file, remote, bytes });
  };
  printer.ftpDownload = async (_host, _token, remote, destination) => {
    events.push({ action: "download", remote });
    const bytes = files.get(stored(remote));
    if (!bytes) throw new Error(`550 ${remote}: no such file`);
    await fs.writeFile(destination, bytes);
  };
  printer.getSafetyStatus = async () => { events.push({ action: "status" }); return status; };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return { publish: async (payload) => events.push({ action: "publish", payload }) };
  };
  return { printer, events, files, prompts };
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
  test(`${route} rejects an explicitly unloaded nozzle before upload or dispatch`, async (t) => {
    const file = await fixture(t, { raw: route !== "legacy 3MF" });
    const { printer, events } = isolatedPrinter(safetyStatus({ ams: { tray_now: "255", ams: [] } }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "legacy 3MF"
      ? printer.print3mf(host, serial, token, { projectName: "unloaded", filePath: file, bambuModel: "p1s", useAMS: false })
      : route === "raw upload-and-print"
        ? printer.uploadFile(host, serial, token, file, "unloaded.gcode", true, "p1s")
        : printer.startJob(host, serial, token, "unloaded.gcode", "p1s");
    await assert.rejects(print, /no filament|unloaded|load.*filament/i);
    assertNoDispatch(events);
  });

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

/** A checked P1S job started by this server, then reported paused; confirm answers the prompts after the start. */
async function pausedJob(t, { confirm = async () => true, resumeStateDir } = {}) {
  const file = await fixture(t);
  let answer = async () => true;
  const isolated = isolatedPrinter(undefined, { confirm: (message) => answer(message), resumeStateDir });
  const started = await isolated.printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
  answer = confirm;
  isolated.events.length = 0;
  isolated.prompts.length = 0;
  // A legacy .gcode.3mf start reports no subtask_name, so the job is named after its file.
  const jobName = started.subtaskName ?? path.posix.basename(started.remoteProjectPath);
  const job = { ...isolated, file, started, jobName, published: () => isolated.events.filter(({ action }) => action === "publish") };
  job.report = { state: "PAUSE", gcode_file: started.remoteProjectPath, subtask_name: started.subtaskName };
  isolated.printer.getSafetyStatus = async () => {
    isolated.events.push({ action: "status" });
    return safetyStatus(job.report);
  };
  return job;
}

/** Record the job as a plug-in route placed it, with a file the printer cannot give back: that resume still asks a person. */
function unverified(job) {
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  job.printer.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  job.files.clear();
}

test("a matching inspected paused job resumes after its bytes are re-read and a fresh check, without a prompt", async (t) => {
  const job = await pausedJob(t, { confirm: async () => false });
  const result = await job.printer.resumeJob(host, serial, token);
  assert.equal(result.status, "success");
  assert.equal(result.bytesVerified, true);
  assert.equal(result.jobName, job.jobName);
  assert.deepEqual(job.events.map(({ action }) => action), ["status", "download", "status", "connect", "publish"]);
  assert.equal(job.events[1].remote, job.started.remoteProjectPath);
  assert.equal(job.events[4].payload.print.command, "resume");
  assert.deepEqual(job.prompts, [], "a resume whose bytes were re-read does not ask");
});

/** The same printer, as a new server process sees it after a restart: same storage, same paused report, same record folder. */
function restarted(job, resumeStateDir) {
  const next = isolatedPrinter(undefined, { resumeStateDir, files: job.files });
  next.printer.getSafetyStatus = async () => { next.events.push({ action: "status" }); return safetyStatus(job.report); };
  return next;
}

async function recordFolder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-resume-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Nov 3: the MCP restarted (companion restarts) while a P1S pick paused before layer 2; Resume from Counterpart was
// refused for the rest of the print because the record of the job lived only in the old process.
test("a server restarted during a pause still resumes the job it started, with every check", async (t) => {
  const dir = await recordFolder(t);
  const job = await pausedJob(t, { resumeStateDir: dir });
  job.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", gcode_file: job.started.remoteProjectPath, subtask_name: job.started.subtaskName });
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  assert.equal((await fs.stat(path.join(dir, files[0]))).mode & 0o777, 0o600, "the record is private");
  const next = restarted(job, dir);
  const result = await next.printer.resumeJob(host, serial, token);
  assert.equal(result.status, "success");
  assert.equal(result.bytesVerified, true);
  assert.deepEqual(next.events.map(({ action }) => action), ["status", "download", "status", "connect", "publish"]);
  assert.equal(next.events.at(-1).payload.print.command, "resume");
});

test("after a restart, a job stopped before it or ended while the server was down is not resumed", async (t) => {
  const dir = await recordFolder(t);
  const stopped = await pausedJob(t, { resumeStateDir: dir });
  await stopped.printer.cancelJob(host, serial, token, async () => ({ status: "success" }));
  assert.deepEqual(await fs.readdir(dir), [], "Stop removes the record");
  const afterStop = restarted(stopped, dir);
  await assert.rejects(afterStop.printer.resumeJob(host, serial, token), /inspected and started/);
  assert.deepEqual(afterStop.events, []);

  const ended = await pausedJob(t, { resumeStateDir: dir });
  ended.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", gcode_file: ended.started.remoteProjectPath, subtask_name: ended.started.subtaskName });
  const afterEnd = restarted(ended, dir);
  // The first report the new server sees says the job finished; the same file then pauses again (a touchscreen reprint).
  afterEnd.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", gcode_file: ended.started.remoteProjectPath, subtask_name: ended.started.subtaskName });
  await assert.rejects(afterEnd.printer.resumeJob(host, serial, token), /inspected and started/);
  assert.equal(afterEnd.events.filter(({ action }) => action === "publish").length, 0);
});

test("a damaged or foreign resume record is ignored", async (t) => {
  const dir = await recordFolder(t);
  const job = await pausedJob(t, { resumeStateDir: dir });
  const [name] = await fs.readdir(dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  for (const damaged of ["{not json", JSON.stringify({ ...saved, key: "other-host\nother-serial" }), JSON.stringify({ ...saved, job: { ...saved.job, sha256: "nope" } })]) {
    await fs.writeFile(path.join(dir, name), damaged);
    await assert.rejects(restarted(job, dir).printer.resumeJob(host, serial, token), /inspected and started/);
  }
});

/**
 * A printer client that answers each control on its report topic, as the real MQTT client re-emits it
 * (rawMessage). answer(print) returns the fields of the printer's reply, or undefined for no reply.
 */
function answeringClient(events, answer) {
  const listeners = new Set();
  return {
    on: (name, listener) => { if (name === "rawMessage") listeners.add(listener); },
    off: (name, listener) => { if (name === "rawMessage") listeners.delete(listener); },
    publish: async (payload) => {
      events.push({ action: "publish", payload });
      const reply = answer(payload.print);
      if (reply) setTimeout(() => {
        const text = JSON.stringify({ print: { command: payload.print.command, param: "", sequence_id: payload.print.sequence_id, ...reply } });
        for (const listener of [...listeners]) listener(`device/${serial}/report`, Buffer.from(text));
      }, 10);
    },
  };
}

// Developer Mode connection: a printer that is not really in LAN Only + Developer Mode refuses unsigned controls
// (84033543, 0x05024007). Counterpart must say so instead of "sent".
for (const command of ["stop", "pause", "resume"]) {
  test(`a direct ${command} the printer refuses as unsigned says it isn't in Developer Mode; an answered one is confirmed`, async (t) => {
    for (const [answer, expected] of [[{ err_code: 84033543 }, "refused"], [{ result: "success" }, "accepted"]]) {
      const job = await pausedJob(t);
      job.printer.getPrinter = async () => { job.events.push({ action: "connect" }); return answeringClient(job.events, () => answer); };
      const send = command === "stop" ? job.printer.cancelJob(host, serial, token)
        : command === "pause" ? job.printer.pauseJob(host, serial, token) : job.printer.resumeJob(host, serial, token);
      if (expected === "refused") {
        await assert.rejects(send, /refused \w+ \(error 05024007\): it isn't in LAN Only and Developer Mode.*Bambu Studio or Bambu Handy/);
      } else {
        const result = await send;
        assert.equal(result.confirmed, true);
        assert.match(result.message, /accepted/);
      }
      const sent = job.published().at(-1).payload.print;
      assert.deepEqual([sent.command, sent.param], [command, ""], "Bambu Studio's own control JSON");
      assert.match(sent.sequence_id, /^\d+$/);
    }
  });
}

test("a direct control with no answer still reports it was sent, unconfirmed", async (t) => {
  const job = await pausedJob(t);
  process.env.BAMBU_CONTROL_REPLY_MS = "50";
  t.after(() => { delete process.env.BAMBU_CONTROL_REPLY_MS; });
  job.printer.getPrinter = async () => answeringClient(job.events, () => undefined);
  const result = await job.printer.pauseJob(host, serial, token);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /Pause command sent/);
});

test("an unverified resume asks a person first: a declined prompt sends nothing", async (t) => {
  const job = await pausedJob(t, { confirm: async () => false });
  unverified(job);
  await assert.rejects(job.printer.resumeJob(host, serial, token), /declined|cancelled/i);
  assert.equal(job.prompts.length, 1);
  assert.match(job.prompts[0], /^Resume checked-[a-f0-9-]+-job\.gcode\.3mf on P1S \(01PTESTSAFETY\)\?.*reheats.*nozzle 220°C, bed 60°C.*Materials: PLA\..*SHA-256: [a-f0-9]{64} \(Bambu's plug-in placed the file/s);
  assert.deepEqual(job.published(), []);
});

test("an unverified resume reads the printer again after the prompt", async (t) => {
  let job;
  job = await pausedJob(t, { confirm: async () => { job.report = { ...job.report, state: "RUNNING" }; return true; } });
  unverified(job);
  await assert.rejects(job.printer.resumeJob(host, serial, token), /paused/i);
  assert.equal(job.prompts.length, 1);
  assert.deepEqual(job.published(), []);
});

test("a changed printer file refuses the resume and retires the record", async (t) => {
  const job = await pausedJob(t);
  const remote = job.started.remoteProjectPath.replace(/^\/+/, "");
  const original = job.files.get(remote);
  job.files.set(remote, Buffer.concat([original, Buffer.from("\n; changed")]));
  await assert.rejects(job.printer.resumeJob(host, serial, token), /SHA-256 of .* changed/);
  assert.deepEqual(job.prompts, [], "nobody is asked about a file that is not the inspected one");
  job.files.set(remote, original);
  await assert.rejects(job.printer.resumeJob(host, serial, token), /inspected and started/);
  assert.deepEqual(job.published(), []);
});

test("a printer file that cannot be re-read refuses the resume but keeps the record", async (t) => {
  const job = await pausedJob(t);
  const remote = job.started.remoteProjectPath.replace(/^\/+/, "");
  const original = job.files.get(remote);
  job.files.delete(remote);
  await assert.rejects(job.printer.resumeJob(host, serial, token), /re-read .* over FTPS/);
  assert.deepEqual(job.published(), []);
  job.files.set(remote, original);
  assert.equal((await job.printer.resumeJob(host, serial, token)).status, "success");
});

/** What a P1S does once it starts a project: it removes the 3MF and keeps the extracted plate G-code. */
async function extractPlate(job, plateBytes) {
  const remote = job.started.remoteProjectPath.replace(/^\/+/, "");
  const zip = await JSZip.loadAsync(job.files.get(remote));
  job.files.delete(remote);
  const plate = remote.replace(/(?:\.gcode)?\.3mf$/i, "_plate_1.gcode");
  job.files.set(plate, plateBytes ?? await zip.file("Metadata/plate_1.gcode").async("nodebuffer"));
  return plate;
}

test("a project the printer replaced with its extracted plate is verified against the inspected plate", async (t) => {
  const job = await pausedJob(t);
  const plate = await extractPlate(job);
  const result = await job.printer.resumeJob(host, serial, token);
  assert.equal(result.bytesVerified, true);
  assert.deepEqual(job.events.filter(({ action }) => action === "download").map(({ remote }) => remote), [job.started.remoteProjectPath, plate]);
  assert.deepEqual(job.prompts, []);
  assert.equal(job.published().length, 1);
});

test("an extracted plate that differs from the inspected plate refuses the resume and retires the record", async (t) => {
  const job = await pausedJob(t);
  const plate = await extractPlate(job, Buffer.from("G28\nM104 S300\n"));
  await assert.rejects(job.printer.resumeJob(host, serial, token), new RegExp(`SHA-256 of ${plate.replaceAll(".", "\\.")} changed`));
  await assert.rejects(job.printer.resumeJob(host, serial, token), /inspected and started/);
  assert.deepEqual(job.published(), []);
});

for (const [name, after] of [
  ["it was cancelled", async (job) => { await job.printer.cancelJob(host, serial, token, async () => ({ status: "success" })); }],
  ["it finished after it was seen running", async (job) => {
    job.report = { ...job.report, state: "RUNNING" };
    await assert.rejects(job.printer.resumeJob(host, serial, token), /paused/i);
    job.report = { ...job.report, state: "FINISH" };
    await assert.rejects(job.printer.resumeJob(host, serial, token), /no longer the job|paused/i);
  }],
  ["another job ran in its place", async (job) => {
    job.report = { ...job.report, state: "RUNNING" };
    await assert.rejects(job.printer.resumeJob(host, serial, token), /paused/i);
    job.report = { state: "RUNNING", gcode_file: "cache/someone-else.3mf", subtask_name: "someone-else" };
    await assert.rejects(job.printer.resumeJob(host, serial, token), /no longer the job|paused/i);
  }],
  ["MQTT reported it ended, with nobody polling", async (job) => {
    // The client store hands every merged report to the record.
    job.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", gcode_file: job.started.remoteProjectPath, subtask_name: job.started.subtaskName });
    job.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", gcode_file: job.started.remoteProjectPath, subtask_name: job.started.subtaskName });
  }],
]) {
  test(`a paused job with the same name is not resumed once ${name}`, async (t) => {
    const job = await pausedJob(t);
    await after(job);
    // The same file paused again, for example reprinted from the touchscreen.
    job.report = { state: "PAUSE", gcode_file: job.started.remoteProjectPath, subtask_name: job.started.subtaskName };
    await assert.rejects(job.printer.resumeJob(host, serial, token), /no longer the job|inspected and started/);
    assert.deepEqual(job.published(), []);
  });
}

test("a job that ends and pauses again while the prompt is open is not resumed", async (t) => {
  let job;
  job = await pausedJob(t, { confirm: async () => {
    job.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", gcode_file: job.started.remoteProjectPath, subtask_name: job.started.subtaskName });
    return true;
  } });
  unverified(job);
  await assert.rejects(job.printer.resumeJob(host, serial, token), /no longer the job/);
  assert.equal(job.prompts.length, 1);
  assert.deepEqual(job.published(), []);
});

test("a plug-in route job the printer cannot re-read is matched by its unique name, and the prompt says so", async (t) => {
  const job = await pausedJob(t);
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  // As index.ts records the BambuNetwork and X2D native routes, whose file Bambu's plug-in placed.
  job.printer.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  job.files.clear();
  const result = await job.printer.resumeJob(host, serial, token);
  assert.equal(result.bytesVerified, false);
  assert.match(job.prompts[0], /could not be re-read over FTPS: .*550 .*no such file; matched by its unique name/);
  assert.equal(job.published().length, 1);
});

test("an unverified plug-in route resume always asks a person", async (t) => {
  let answer = true;
  const job = await pausedJob(t, { confirm: async () => answer });
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  job.printer.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  const saved = new Map(job.files);
  job.files.clear();
  answer = false;
  await assert.rejects(job.printer.resumeJob(host, serial, token), /could not be re-read, so this resume always needs a person/);
  assert.equal(job.prompts.length, 1);
  assert.deepEqual(job.published(), []);
  answer = true;
  const result = await job.printer.resumeJob(host, serial, token);
  assert.equal(result.bytesVerified, false);
  assert.equal(job.prompts.length, 2);
  assert.equal(job.published().length, 1);
  // The same route with readable, matching bytes does not ask.
  for (const [remote, bytes] of saved) job.files.set(remote, bytes);
  job.report = { ...job.report, state: "PAUSE" };
  assert.equal((await job.printer.resumeJob(host, serial, token)).bytesVerified, true);
  assert.equal(job.prompts.length, 2, "no prompt when the bytes were verified");
});

test("an unverified plug-in route resume without an elicitation client is refused", async (t) => {
  const job = await pausedJob(t);
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  const headless = new BambuImplementation();
  headless.getSafetyStatus = job.printer.getSafetyStatus;
  headless.ftpDownload = async () => { throw new Error("550 no such file"); };
  headless.getPrinter = job.printer.getPrinter;
  headless.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  await assert.rejects(headless.resumeJob(host, serial, token), /confirmation is unavailable.*always needs a person/);
  assert.deepEqual(job.published(), []);
});

test("a plug-in route job whose re-read file differs is still refused", async (t) => {
  const job = await pausedJob(t);
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  job.printer.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  const remote = record.remotePath.replace(/^\/+/, "");
  job.files.set(remote, Buffer.from("not the inspected bytes"));
  await assert.rejects(job.printer.resumeJob(host, serial, token), /SHA-256 of .* changed/);
  assert.deepEqual(job.published(), []);
});

test("the previous job's ended report does not retire a job not yet seen running", async (t) => {
  const job = await pausedJob(t);
  // Right after dispatch the printer may still report the job before it.
  job.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", gcode_file: "cache/previous.3mf", subtask_name: "previous" });
  assert.equal((await job.printer.resumeJob(host, serial, token)).status, "success");
});

test("a raw G-code print returns the jobName counterpart_print_progress reports", async (t) => {
  const file = await fixture(t, { raw: true });
  const { printer } = isolatedPrinter();
  printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
  const result = await printer.startJob(host, serial, token, "old-job.gcode", "p1s");
  assert.equal(result.jobName, path.posix.basename(result.remotePath));
  const { bambuProgress } = await import("../dist/counterpart/progress.js");
  for (const gcode_file of [result.remotePath, `/sdcard/${result.remotePath}`, `0:/${result.remotePath}`]) {
    assert.equal(bambuProgress({ gcode_state: "RUNNING", gcode_file }, { receivedAt: Date.now(), serial, model: "p1s" }).job.name, result.jobName, gcode_file);
  }
});

for (const [name, changes, error] of [
  ["a different paused job", { gcode_file: "cache/unverified.gcode", subtask_name: "another job" }, /identity|artifact|match/i],
  ["a changed nozzle", { nozzle: "0.6" }, /nozzle|diameter/i],
  ["a changed spool material", { vt_tray: { tray_type: "ABS" } }, /material|contradict/i],
  ["a job that is no longer paused", { state: "RUNNING" }, /paused|PAUSE|state/i],
  ["an explicitly unloaded nozzle", { ams: { tray_now: 255, ams: [] } }, /no filament|unloaded|load.*filament/i],
  ["a different loaded spool", { ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "ABS" }] }] } }, /loaded.*tray|loaded.*spool/i],
  ["an unknown current AMS tray", { ams: { ams: [] } }, /loaded.*tray|loaded.*spool/i],
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

async function interceptedMcp(t, { blockBridgeInitialization = false, realBridgeRequest = false, model = "p1s", nozzleDiameters = [0.4], ams, bridgeResponse = { ok: true, value: 0 }, localPrint } = {}) {
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
        raw:{model:${JSON.stringify(model)},...${JSON.stringify(['h2d','h2dpro','h2c','x2d'].includes(model) ? {vir_slot:[{id:254,tray_type:'PLA'},{id:255,tray_type:'PLA'}]} : {})},gcode_state:'IDLE',nozzle_diameter:${JSON.stringify(String(nozzleDiameters[0]))},device:{nozzle:{info:${JSON.stringify(nozzleDiameters.map((diameter, id) => ({ id, diameter, type: "HH01", stat: 0 })))}}},print_error:0,hms:[],...${JSON.stringify(ams ? { ams } : {})},...reported},
        observation:{source:'mqtt',requestedAt:now,receivedAt:now,identitySource:'report'}};
    };
    ${localPrint ? `BambuNetworkBridge.prototype.startLocalPrint = async (printer, method, payload) => {
      log({ action:'local-print', printer: { ...printer, password: '[set]' }, method, payload });
      return ${JSON.stringify(localPrint)};
    };` : ""}
    BambuNetworkBridge.prototype.ensureAgent = async () => {
      ${blockBridgeInitialization ? `log({action:'agent-wait'}); while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(resolve => setTimeout(resolve,10));` : ""}
      return { agent: 0, handshake: { ok: true } };
    };
    // The Bambu Cloud session (login, subscribe, certificate) has its own fake-host tests;
    // here a cloud job runs straight through it to the print request.
    BambuNetworkBridge.prototype.withCloudSession = async function (devId, _options, assertActive, _timing, run) {
      log({ action:"cloud-session", devId }); assertActive();
      return run({ settle: async () => {}, messages: [], jobUpdates: [] });
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
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, path.join(root, "dist/index.js")], cwd: dir, stderr: "pipe", env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_PRINTER_HOST: host, BAMBU_PRINTER_SERIAL: serial, BAMBU_SERIAL: serial, BAMBU_PRINTER_ACCESS_TOKEN: token, BAMBU_TOKEN: token, BAMBU_DEV_ID: serial, BAMBU_NETWORK_BRIDGE_COMMAND: "",
    // Each server keeps its own resume records: a job another test started must never be resumable here.
    BAMBU_RESUME_STATE_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "bambu-resume-server-")) } });
  const client = new Client({ name: "safety-dispatch-tests", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  t.after(() => client.close());
  await client.connect(transport);
  return { client, eventsPath, releaseAgent: () => fs.writeFile(releasePath, "release"), setReportedStatus: reported => fs.writeFile(statusPath, JSON.stringify(reported)) };
}

test("a LAN bridge print that the plug-in cannot publish reports the cause and the plug-in's own job reports", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t, { localPrint: { result: { ok: true, value: -4030, job_id: 1 }, jobUpdates: [
    { status: 1, code: 100, msg: "0.0M/0.0M" }, { status: 3, code: -4030, msg: "send msg failed" },
  ] } });
  const file = await fixture(t);
  const result = await client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "lan" } });
  assert.equal(result.isError, true);
  assert.match(result.content.map(item => item.text ?? "").join(" "),
    /start_local_print returned non-zero result -4030 \(the networking plug-in could not send the print command to the printer over MQTT\)\. Plug-in reported: status 1, code 100: 0\.0M\/0\.0M; status 3, code -4030: send msg failed\./);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const local = events.filter(event => event.action === "local-print");
  assert.equal(local.length, 1);
  assert.equal(local[0].method, "net.start_local_print");
  assert.deepEqual(local[0].printer, { devId: serial, devIp: host, username: "bblp", password: "[set]", useSsl: true });
});

test("a LAN bridge job runs under the checked name while the result keeps the caller's project name", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t, { localPrint: { result: { ok: true, value: 0, job_id: 1 }, jobUpdates: [] } });
  const file = await fixture(t);
  const result = await client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", bed_type: "textured_plate", use_ams: false, connection_type: "lan", project_name: "My cube" } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.projectName, "My cube");
  assert.match(body.printerJobName, /^checked-[0-9a-f-]{36}-/);
  const local = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse).find(event => event.action === "local-print");
  assert.equal(local.payload.params.project_name, body.printerJobName, "the plug-in names the stored file and printer job from project_name");
  assert.equal(local.payload.params.task_name, body.printerJobName);
});

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

test("a FULU cloud print sends Bambu Studio's ams_mapping_info for the tray it prints from", async (t) => {
  const { client, eventsPath } = await interceptedMcp(t, {
    ams: { tray_now: "255", ams: [{ id: "0", tray: [
      { id: "0", tray_type: "PLA", tray_info_idx: "GFA00", tray_color: "FFFFFFFF", nozzle_temp_min: "190", nozzle_temp_max: "230" },
      { id: "1", tray_type: "PLA", tray_info_idx: "GFA00", tray_color: "161616FF", nozzle_temp_min: "190", nozzle_temp_max: "230" },
    ] }] },
  });
  const file = await fixture(t, { project: { filament_ids: ["GFA00"], filament_colour: ["#000000"], filament_map: ["1"] } });
  const result = await client.callTool({ name: "print_3mf_bambu_network", arguments: { three_mf_path: file, bambu_model: "p1s", bed_type: "textured_plate", ams_slots: [1], connection_type: "cloud" } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const params = events.find(event => event.method === "net.start_print")?.payload.params;
  assert.equal(params.ams_mapping, "[1]");
  assert.deepEqual(JSON.parse(params.ams_mapping_info), [
    { ams: 1, targetColor: "161616FF", filamentId: "GFA00", filamentType: "PLA", nozzleId: 1, sourceColor: "#000000FF" },
  ]);
});

test("ams_mapping_info covers every project filament, external spools, AMS-HT and the right nozzle", () => {
  const raw = {
    ams: { ams: [{ id: "1", tray: [{ id: "0" }, { id: "1" }, { id: "2", tray_color: "00AE42FF" }] }, { id: "128", tray: [{ id: "0", tray_color: "F4EE2AFF" }] }] },
    vir_slot: [{ id: "254", tray_color: "FFFFFFFF" }, { id: "255", tray_color: "000000FF" }],
  };
  const filaments = [
    { type: "PLA", filamentId: "GFA00", colour: "#00AE42", nozzle: 2 },
    { type: "PETG", filamentId: "GFG00", colour: "#ffffff80" },
    { type: "PLA", filamentId: "GFA01", colour: "#F4EE2A", nozzle: 1 },
    { type: "PLA", filamentId: "GFA00", colour: "#000000", nozzle: 1 },
    { type: "PLA", filamentId: "GFA00", colour: "#000000" },
  ];
  assert.deepEqual(studioAmsMappingInfo(filaments, [6, 254, 128, 255, -1], tray => trayColour(raw, tray)), [
    { ams: 6, targetColor: "00AE42FF", filamentId: "GFA00", filamentType: "PLA", nozzleId: 0, sourceColor: "#00AE42FF" },
    { ams: 254, targetColor: "FFFFFFFF", filamentId: "GFG00", filamentType: "PETG", sourceColor: "#FFFFFF80" },
    { ams: 128, targetColor: "F4EE2AFF", filamentId: "GFA01", filamentType: "PLA", nozzleId: 1, sourceColor: "#F4EE2AFF" },
    { ams: 255, targetColor: "000000FF", filamentId: "GFA00", filamentType: "PLA", nozzleId: 1, sourceColor: "#000000FF" },
    { ams: -1, targetColor: "", filamentId: "", filamentType: "" },
  ]);
  assert.equal(trayColour({ vt_tray: { tray_color: "123456FF" } }, 254), "123456FF", "single-nozzle printers report the external spool as vt_tray");
  assert.equal(trayColour(raw, 3), undefined, "a tray the printer does not report has no colour");
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
    // This fixture's printer has no readable copy of the plug-in's file.
    assert.match(resumed.content?.[0]?.text ?? "", /"bytesVerified":\s*false/);
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
      const beforeWrongSpool = await fs.readFile(eventsPath, "utf8");
      for (const mapping of [{ams_mapping:[255]}, {ams_slots:[255]}]) {
        const wrong = await client.callTool({name:tool,arguments:{three_mf_path:file,bambu_model:"h2d",bed_type:"textured_plate",use_ams:false,...nozzleArgs,...mapping}});
        assert.equal(wrong.isError,true,'wrong-nozzle explicit spool must not be replaced');
        assert.match(wrong.content?.[0]?.text ?? '',/nozzle|binding|spool/i);
        assert.equal(await fs.readFile(eventsPath,"utf8"),beforeWrongSpool,'rejected mapping must not upload or dispatch');
      }
      const events = beforeWrongSpool.trim().split("\n").map(JSON.parse);
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
    onDispatched: method => { checks.push(["dispatched", method]); },
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { ok: true, value: 0 });
  assert.deepEqual(checks, [["fresh-state", "net.start_print"], ["cancellation", "net.start_print"], ["dispatched", "net.start_print"]]);
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

test("the print after a hardware clear declines before upload and shows inspected settings", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  await printer.clearHmsErrors(host, serial, token);
  events.length = 0;
  printer.getSafetyStatus = async () => safetyStatus();
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /confirmation.*declined/i);
  assertNoDispatch(events);
  assert.match(prompts[0], /P1S.*0\.4 mm.*PLA.*220°C.*60°C.*SHA-256/s);
});

test("print preflight rechecks printer state before upload", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => safetyStatus(++reads >= 2 ? { state: "RUNNING" } : {});
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /not safely idle/i);
  assertNoDispatch(events);
});

test("FINISH adds no plate confirmation, and an ordinary print does not ask", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false });
  assert.equal(prompts.length, 0);
});

test("bed clearance cannot authorize a different finished job", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FINISH", subtask_name: "previous-part" }));
  let reads = 0;
  printer.getSafetyStatus = async () => safetyStatus({ state: "FINISH", subtask_name: ++reads >= 2 ? "another-part" : "previous-part" });
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "confirm", filePath: file, bambuModel: "p1s", useAMS: false }), /job changed during preflight/i);
  assertNoDispatch(events);
});

test("manual positive heating and heater-off send without a prompt", async () => {
  const { printer, events, prompts } = isolatedPrinter(undefined, { confirm: async () => false });
  await printer.setTemperature(host, serial, token, "nozzle", 220, "p1s", "PLA");
  assert.match(events.filter(event => event.action === "publish")[0].payload.print.param, /M104 (?:T0 )?S220/);
  await printer.setTemperature(host, serial, token, "nozzle", 0);
  assert.match(events.filter(event => event.action === "publish")[1].payload.print.param, /M104 S0/);
  assert.deepEqual(prompts, []);
});

test("hardware errors cannot be cleared without human confirmation", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [{ attr: 1, code: 0x20001 }] }));
  const prompts = [];
  printer.confirm = async message => { prompts.push(message); return false; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), error => {
    assert.match(error.message, /confirmation was declined or cancelled/i);
    assert.match(error.message, /always needs a person/);
    return true;
  });
  assert.match(prompts[0], /print_error:123.*HMS 0000-0001-0002-0001|HMS 0000-0001-0002-0001.*print_error:123/);
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

test("the print preflight names hidden HMS notices that do not block printing", async () => {
  const prompts = [];
  const printer = new BambuImplementation(async message => { prompts.push(message); return true; });
  // Only the print after a hardware clear asks; its prompt carries the notices.
  printer.clearedErrors.set("20PTEST", ["print_error:123"]);
  printer.clearedErrors.set("094TEST", ["print_error:123"]);
  const inspection = { model: "x2d", nozzleDiameters: [0.4, 0.4], materials: ["PETG"], maxNozzleTemperature: 270, maxBedTemperature: 70, maxChamberTemperature: 0, sha256: "a".repeat(64) };
  await printer.confirmPrintPreflight("20PTEST", { raw: { serial: "20PTEST", gcode_state: "IDLE", hms: [{ attr: 83887616, code: 131184 }] } }, inspection);
  assert.match(prompts[0], /The printer also reports HMS 0500-0600-0002-0070, which Bambu lists for this model without text and never shows as a fault; it does not block printing/);
  await printer.confirmPrintPreflight("20PTEST", { raw: { gcode_state: "IDLE", hms: [] } }, inspection);
  assert.doesNotMatch(prompts[1], /also reports/);
  assert.doesNotMatch(prompts[1], /identity chip/);
  const unchipped = { device: { nozzle: { info: [{ id: 0, diameter: 0.4, type: "HS01", stat: 1, sn: "N/A" }, { id: 1, diameter: 0.4, type: "HS01", stat: 1, sn: "N/A" }] } } };
  await printer.confirmPrintPreflight("094TEST", { raw: { gcode_state: "IDLE", hms: [], ...unchipped } }, { ...inspection, model: "h2d" });
  assert.match(prompts[2], /Printer nozzles 0 and 1 report no identity chip, so their diameter and type are the printer's configured settings; confirm they match the installed hotends\./);
  unchipped.device.nozzle.info[1].sn = "B01";
  await printer.confirmPrintPreflight("094TEST", { raw: { gcode_state: "IDLE", hms: [], ...unchipped } }, { ...inspection, model: "h2d" });
  assert.match(prompts[3], /Printer nozzle 0 reports no identity chip, so its diameter and type are the printer's configured settings; confirm they match the installed hotend\./);
});

for (const [stage, appearsOnRead] of [["confirmation recheck", 2], ["dispatch recheck", 3]]) {
  test(`a hidden notice that first appears at the ${stage} stops the print until it is named`, async (t) => {
    // H2D (serial prefix 094) lists 0500-0100-0002-0003 without text.
    const notice = { attr: 0x05000100, code: 0x00020003 };
    const h2d = hms => ({ ...safetyStatus({ model: "h2d", nozzle: ["0.4", "0.4"], hms, sn: "094TESTSAFETY" }), serial: "094TESTSAFETY" });
    const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.4] });
    const { printer, events } = isolatedPrinter();
    let reads = 0;
    printer.getSafetyStatus = async () => h2d(++reads >= appearsOnRead ? [notice] : []);
    const prompts = [];
    printer.confirm = async message => { prompts.push(message); return true; };
    const options = { projectName: "late-notice", filePath: file, bambuModel: "h2d", useAMS: false };
    await assert.rejects(printer.print3mf(host, "094TESTSAFETY", token, options),
      /reported HMS 0500-0100-0002-0003 after the print confirmation.*start the print again/);
    assert.equal(events.some(({ action }) => action === "publish"), false, "an unnamed notice must stop the print before it is sent");

    // The retry sees the notice from the start, and the print goes out without a prompt.
    printer.getSafetyStatus = async () => h2d([notice]);
    await printer.print3mf(host, "094TESTSAFETY", token, options);
    assert.deepEqual(prompts, []);
    assert.equal(events.filter(({ action }) => action === "publish").length, 1);
  });
}

test("clearing never records a hidden notice, and clear prompts show Bambu's HMS form", async () => {
  const x2d = raw => ({ ...safetyStatus({ model: "x2d", nozzle: ["0.4", "0.4"], ...raw, sn: "20PTEST" }), serial: "20PTEST" });
  const prompts = [];
  const printer = new BambuImplementation(async message => { prompts.push(message); return true; });
  printer.getSafetyStatus = async () => x2d({ hms: [{ attr: 83887616, code: 131184 }, { attr: 1, code: 0x20001 }] });
  printer.getPrinter = async () => ({ publish: async () => {} });
  const cleared = await printer.clearHmsErrors(host, "20PTEST", token);
  assert.deepEqual(cleared.cleared_codes, ["hms:1:131073", "print_error:0"], "the hidden camera entry is not an error to clear");
  assert.match(prompts[0], /HMS 0000-0001-0002-0001, print_error:0\?/);
  assert.doesNotMatch(prompts[0], /0500-0600-0002-0070|83887616/);
});

test("changed hardware codes during confirmation are not cleared", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ print_error: 123, hms: [] }));
  printer.confirm = async () => { printer.getSafetyStatus = async () => safetyStatus({ print_error: 456, hms: [] }); return true; };
  await assert.rejects(printer.clearHmsErrors(host, serial, token), /errors changed/i);
  assertNoDispatch(events);
});

for (const failure of ["confirmation recheck", "upload", "dispatch recheck", "publish"]) {
  test(`cleared-error acknowledgment survives failed ${failure} until successful dispatch`, async (t) => {
    const legacyFile = await fixture(t);
    const file = legacyFile.replace(".gcode.3mf", ".3mf");
    await fs.rename(legacyFile, file);
    const { printer } = isolatedPrinter(safetyStatus({ print_error: 123 }));
    await printer.clearHmsErrors(host, serial, token);
    let reads = 0;
    printer.getSafetyStatus = async () => safetyStatus({ state: ++reads === (failure === "confirmation recheck" ? 2 : failure === "dispatch recheck" ? 3 : -1) ? "RUNNING" : "IDLE" });
    const upload = printer.ftpUpload, getPrinter = printer.getPrinter;
    if (failure === "upload") printer.ftpUpload = async () => { throw Error("upload failed"); };
    if (failure === "publish") printer.getPrinter = async () => ({ publish: async () => { throw Error("publish failed"); } });
    const prompts = [];
    printer.confirm = async message => { prompts.push(message); return true; };
    const options = { projectName: "retry", filePath: file, bambuModel: "p1s", useAMS: false };
    await assert.rejects(printer.print3mf(host, serial, token, options));
    assert.equal(prompts.length, 1);
    printer.getSafetyStatus = async () => safetyStatus();
    printer.ftpUpload = upload; printer.getPrinter = getPrinter;
    await printer.print3mf(host, serial, token, options);
    assert.equal(prompts.length, 2, "retry must require a new physical acknowledgment even in headless mode");
    assert.ok(prompts.every(message => message.includes("Previously cleared hardware codes: print_error:123")));
    await printer.print3mf(host, serial, token, options);
    assert.equal(prompts.length, 2, "a successful checked dispatch consumes the acknowledged codes");
  });
}

test("bridge snapshots are retained only after handoff, including an uncertain result", async (t) => {
  const file = await fixture(t);
  let rejectedSnapshot;
  await assert.rejects(withPrintSnapshot(file, async snapshot => { rejectedSnapshot = snapshot; throw Error("preflight rejected"); }), /preflight rejected/);
  await assert.rejects(fs.access(path.dirname(rejectedSnapshot)), { code: "ENOENT" });
  let dispatchedSnapshot;
  await assert.rejects(withPrintSnapshot(file, async (snapshot, retain) => { dispatchedSnapshot = snapshot; retain(); throw Error("response timed out"); }), /response timed out/);
  assert.deepEqual(await fs.readFile(dispatchedSnapshot), await fs.readFile(file));
  await fs.rm(path.dirname(dispatchedSnapshot), { recursive: true, force: true });
});

/** A BambuStudio.conf with David's saved P1S (C12) Send dialog options. */
async function davidStudioConf(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-conf-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "BambuStudio.conf");
  await fs.writeFile(file, `${JSON.stringify({ C12: { bed_leveling: "on", flow_cali: "auto", nozzle_offset_cali: "auto", timelapse: "off" } }, null, 4)}\n# MD5 checksum 00\n`);
  return file;
}

function withStudioConf(t, file) {
  const previous = process.env.BAMBU_STUDIO_CONFIG;
  process.env.BAMBU_STUDIO_CONFIG = file;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_STUDIO_CONFIG; else process.env.BAMBU_STUDIO_CONFIG = previous; });
}

const optionFields = (print, keys) => Object.fromEntries(keys.map((key) => [key, print[key]]));

for (const [label, useConf] of [["David's saved Studio options", true], ["no Studio config", false]]) {
  test(`P1S project_file over MQTT sends Bambu Studio's options with ${label}`, async (t) => {
    if (useConf) withStudioConf(t, await davidStudioConf(t));
    const legacy = await fixture(t);
    const file = legacy.replace(/\.gcode\.3mf$/, ".3mf");
    await fs.copyFile(legacy, file);
    const { printer, events } = isolatedPrinter();
    await printer.print3mf(host, serial, token, { projectName: "studio", filePath: file, bambuModel: "p1s", useAMS: false });
    const print = events.find(({ action }) => action === "publish").payload.print;
    assert.equal(print.command, "project_file");
    assert.deepEqual(optionFields(print, ["bed_leveling", "flow_cali", "vibration_cali", "layer_inspect", "timelapse"]),
      { bed_leveling: true, flow_cali: false, vibration_cali: false, layer_inspect: true, timelapse: false });
  });
}

test("an explicit print_3mf option still wins on the MQTT route", async (t) => {
  withStudioConf(t, await davidStudioConf(t));
  const legacy = await fixture(t);
  const file = legacy.replace(/\.gcode\.3mf$/, ".3mf");
  await fs.copyFile(legacy, file);
  const { printer, events } = isolatedPrinter();
  await printer.print3mf(host, serial, token, { projectName: "studio", filePath: file, bambuModel: "p1s", useAMS: false, bedLeveling: false, vibrationCalibration: true });
  const print = events.find(({ action }) => action === "publish").payload.print;
  assert.deepEqual(optionFields(print, ["bed_leveling", "flow_cali", "vibration_cali", "layer_inspect"]),
    { bed_leveling: false, flow_cali: false, vibration_cali: true, layer_inspect: true });
});

test("H2D project_file over MQTT sends Bambu Studio's resolved options in its existing fields", async (t) => {
  const h2d = { ...safetyStatus({ model: "h2d", nozzle: ["0.4", "0.4"], sn: "094TESTSAFETY" }), serial: "094TESTSAFETY" };
  const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.4] });
  const { printer, events } = isolatedPrinter(h2d);
  await printer.print3mf(host, "094TESTSAFETY", token, { projectName: "studio", filePath: file, bambuModel: "h2d", useAMS: false });
  const print = events.find(({ action }) => action === "publish").payload.print;
  // H2D bed leveling and flow calibration default to auto; a one-nozzle job turns nozzle offset calibration off.
  assert.deepEqual(optionFields(print, ["bed_leveling", "auto_bed_leveling", "flow_cali", "vibration_cali", "layer_inspect", "nozzle_offset_cali", "extrude_cali_manual_mode"]),
    { bed_leveling: 0, auto_bed_leveling: 2, flow_cali: 0, vibration_cali: 0, layer_inspect: 1, nozzle_offset_cali: 0, extrude_cali_manual_mode: 0 });
});

test("the BambuNetwork bridge sends exactly the PrintParams Bambu Studio's Send dialog sends for a P1S", async (t) => {
  withStudioConf(t, await davidStudioConf(t));
  const server = await startBridgeJob(t);
  assert.notEqual(server.result.isError, true, server.result.content?.[0]?.text);
  assert.deepEqual(optionFields(server.params, ["task_bed_leveling", "task_flow_cali", "task_vibration_cali", "task_layer_inspect", "auto_bed_leveling", "auto_flow_cali", "auto_offset_cali", "extruder_cali_manual_mode", "task_record_timelapse"]), {
    task_bed_leveling: true, task_flow_cali: false, task_vibration_cali: false, task_layer_inspect: true,
    auto_bed_leveling: 1, auto_flow_cali: 2, auto_offset_cali: 2, extruder_cali_manual_mode: 0, task_record_timelapse: false,
  });
});

test("H2D project_file encodes flow calibration on and off; auto has no verified field and sends what off sends", async (t) => {
  const h2d = { ...safetyStatus({ model: "h2d", nozzle: ["0.4", "0.4"], sn: "094TESTSAFETY" }), serial: "094TESTSAFETY" };
  const file = await fixture(t, { model: "h2d", nozzleDiameters: [0.4, 0.4] });
  const sent = {};
  for (const [label, autoFlowCali] of [["off", 0], ["on", 1], ["auto", 2]]) {
    const { printer, events } = isolatedPrinter(h2d);
    await printer.print3mf(host, "094TESTSAFETY", token, { projectName: `flow-${label}`, filePath: file, bambuModel: "h2d", useAMS: false, autoFlowCali });
    const print = events.find(({ action }) => action === "publish").payload.print;
    sent[label] = { flow_cali: print.flow_cali, extrude_cali_flag: print.extrude_cali_flag };
  }
  assert.deepEqual(sent, { off: { flow_cali: 0, extrude_cali_flag: 0 }, on: { flow_cali: 1, extrude_cali_flag: 0 }, auto: { flow_cali: 0, extrude_cali_flag: 0 } });
});
