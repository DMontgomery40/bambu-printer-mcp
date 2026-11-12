import assert from "node:assert/strict";
import { test } from "node:test";
import { BambuClient } from "bambu-node";
import { BambuImplementation } from "../dist/printers/bambu.js";

function client(serial = "239TEST") {
  return new BambuClient({ host: "127.0.0.1", serialNumber: serial, accessToken: "test" });
}

async function report(printer, payload) {
  // Exercise the actual patched MQTT parser without connecting to hardware.
  await printer.onMessage(JSON.stringify(payload), `device/${printer.config.serialNumber}/report`);
}

for (const [prefix, model] of [["093", "H2S"], ["094", "H2D"], ["31B", "H2C"], ["239", "H2DPRO"], ["22E", "P2S"], ["01P", "P1S"], ["039", "A1"], ["030", "A1M"]]) {
  test(`OTA model detection accepts ${model} (${prefix})`, async () => {
    const printer = client(`${prefix}TEST`);
    await report(printer, { info: { command: "get_version", module: [{ name: "ota", sn: `${prefix}TEST` }] } });
    assert.equal(printer.data.model, model);
    await report(printer, { print: { command: "push_status", gcode_state: "IDLE", nozzle_temper: 27 } });
    assert.equal(printer.status, "IDLE");
    assert.equal(printer.data.nozzle_temper, 27);
  });
}

test("unknown OTA serial preserves the detected identity and continues status updates", async () => {
  for (const knownModel of [undefined, "H2C"]) {
    const printer = client("NEWTEST");
    printer.data.model = knownModel;
    await report(printer, { info: { command: "get_version", module: [{ name: "ota", sn: "NEWTEST" }] } });
    assert.equal(printer.data.model, knownModel);
    await report(printer, { print: { command: "push_status", gcode_state: "IDLE", bed_temper: 25 } });
    assert.equal(printer.data.bed_temper, 25);
  }
});

test("version messages without OTA data preserve identity and do not terminate the listener", async () => {
  const printer = client();
  printer.data.model = "H2C";
  await report(printer, { info: { command: "get_version", module: [{ name: "ams", sn: "AMSTEST" }] } });
  assert.equal(printer.data.model, "H2C");
  assert.equal(printer.data.modules[0].name, "ams");
});

test("unexpected status transitions update status and accept the next report", async () => {
  const printer = client();
  for (const state of ["PAUSE", "FINISH", "IDLE", "FAILED", "PAUSE"]) {
    await report(printer, { print: { command: "push_status", gcode_state: state, nozzle_temper: 30 } });
    assert.equal(printer.status, state);
    assert.equal(printer.data.gcode_state, state);
  }
});

for (const [name, data, expected] of [
  ["P2S CTC temperature", { device: { ctc: { info: { temp: 26 } } } }, 26],
  ["packed CTC current and target temperatures", { device: { ctc: { info: { temp: 3932186 } } } }, 26],
  ["zero CTC temperature before legacy fields", { device: { ctc: { info: { temp: 0 } } }, chamber_temper: 30 }, 0],
  ["legacy chamber temperature", { chamber_temper: 32 }, 32],
  ["legacy frame temperature", { frame_temper: 29 }, 29],
  ["missing temperature", { device: { ctc: null } }, 0],
  ["invalid CTC temperature falls back", { device: { ctc: { info: { temp: -1 } } }, chamber_temper: 31 }, 31],
]) {
  test(`printer status reads ${name}`, async () => {
    const reportData = { gcode_state: "IDLE", model: "P2S", ...data };
    const bambu = new BambuImplementation();
    bambu.printerStore = { waitForInitialReport: async () => reportData };
    bambu.getPrinter = async () => ({ data: reportData, publish: async () => {} });

    const status = await bambu.getStatus("127.0.0.1", "TEST_SERIAL", "TEST_TOKEN");
    assert.equal(status.connected, true);
    assert.equal(status.temperatures.chamber, expected);
  });
}

// A sparse "hello" push (model/modules) precedes the full status. On a busy host the
// full push arrived after the fixed 500 ms settle and get_printer_status reported UNKNOWN.
test("printer status waits for the full report that follows a sparse first push", async () => {
  const bambu = new BambuImplementation();
  const store = bambu.printerStore;
  const key = "127.0.0.1-01PTEST-test";
  setTimeout(() => store.updateReportSnapshot(key, { model: "P1S", modules: [] }), 10);
  setTimeout(() => store.updateReportSnapshot(key, { gcode_state: "IDLE", nozzle_temper: 27 }), 800);
  const started = Date.now();
  const report = await store.waitForInitialReport("127.0.0.1", "01PTEST", "test", 3000);
  assert.equal(report.gcode_state, "IDLE");
  assert.equal(report.model, "P1S");
  assert.ok(Date.now() - started < 2000, "returns once the full status has merged");

  const silent = new BambuImplementation().printerStore;
  setTimeout(() => silent.updateReportSnapshot(key, { model: "P1S" }), 10);
  const sparse = await silent.waitForInitialReport("127.0.0.1", "01PTEST", "test", 300);
  assert.deepEqual(sparse, { model: "P1S" }, "a printer that never sends the full status still returns within the bound");
});

// counterpart_print_progress reads the cached MQTT report (PRD §8.3): no printer traffic on a held session.
function heldSession(bambu, key, report, ageMs = 0) {
  const store = bambu.printerStore;
  const published = [];
  const printer = { publish: async (message) => { published.push(message); } };
  store.printers.set(key, printer);
  store.updateReportSnapshot(key, report);
  store.reportTimes.set(key, Date.now() - ageMs);
  return { store, printer, published };
}

test("progress reads a held session's cached report without connecting or sending a command", async () => {
  const bambu = new BambuImplementation();
  const { published } = heldSession(bambu, "127.0.0.1-01PTEST-test", { gcode_state: "RUNNING", mc_percent: 12 });
  bambu.getPrinter = async () => { throw new Error("must not connect"); };
  const before = Date.now();
  const report = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test");
  assert.equal(report.raw.mc_percent, 12);
  assert.ok(report.receivedAt <= before && before - report.receivedAt < 1000, "observedAt is when the report arrived");
  assert.deepEqual(published, []);
});

test("a quiet printer's stale report is refreshed with PushAll at most once per interval", async () => {
  const bambu = new BambuImplementation();
  const key = "127.0.0.1-01PTEST-test";
  const { store, printer, published } = heldSession(bambu, key, { gcode_state: "IDLE" }, 600_000);
  bambu.getPrinter = async () => printer;
  setTimeout(() => store.updateReportSnapshot(key, { gcode_state: "IDLE", nozzle_temper: 26 }), 350);
  const refreshed = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test");
  assert.equal(refreshed.raw.nozzle_temper, 26);
  assert.equal(published.length, 1, "one pushall");
  store.reportTimes.set(key, Date.now() - 600_000);
  const again = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test");
  assert.equal(published.length, 1, "no second pushall within the interval");
  assert.equal(again.raw.nozzle_temper, 26, "the cached report is still served, with its own time");
});

test("progress returns no report within its bound when the printer never answers", async () => {
  const bambu = new BambuImplementation();
  // An unreachable printer's MQTT connect retries forever.
  bambu.getPrinter = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await bambu.readProgressReport("127.0.0.1", "01PTEST", "test", 200), null);
  assert.ok(Date.now() - started < 1000);
});

test("a cold progress read connects, asks once, and returns the first full report", async () => {
  const bambu = new BambuImplementation();
  const key = "127.0.0.1-01PTEST-test";
  const store = bambu.printerStore;
  const published = [];
  const printer = { publish: async (message) => { published.push(message); } };
  bambu.getPrinter = async () => {
    store.printers.set(key, printer);
    setTimeout(() => store.updateReportSnapshot(key, { gcode_state: "FINISH", subtask_name: "part" }), 50);
    return printer;
  };
  const report = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test", 5000);
  assert.equal(report.raw.gcode_state, "FINISH");
  assert.equal(published.length, 1);
});

test("a stale refresh whose publish never completes still returns the cached report within the bound", async () => {
  const bambu = new BambuImplementation();
  const key = "127.0.0.1-01PTEST-test";
  const { printer } = heldSession(bambu, key, { gcode_state: "RUNNING", mc_percent: 40 }, 600_000);
  // MQTT disconnected after connecting: the queued publish never settles.
  printer.publish = () => new Promise(() => {});
  bambu.getPrinter = async () => printer;
  const started = Date.now();
  const report = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test", 200);
  assert.equal(report.raw.mc_percent, 40, "the stale report keeps its own observedAt");
  assert.ok(Date.now() - started < 1000);
});

test("progress polls of an unreachable printer share one read and send one PushAll when it returns", async () => {
  const bambu = new BambuImplementation();
  const key = "127.0.0.1-01PTEST-test";
  const store = bambu.printerStore;
  const published = [];
  const printer = { publish: async (message) => { published.push(message); } };
  let connect;
  let connects = 0;
  const connected = new Promise((resolve) => { connect = resolve; });
  bambu.getPrinter = () => { connects++; return connected; };
  for (let poll = 0; poll < 4; poll++) assert.equal(await bambu.readProgressReport("127.0.0.1", "01PTEST", "test", 30), null);
  assert.equal(connects, 1, "expired polls do not start more reads");
  store.printers.set(key, printer);
  connect(printer);
  setTimeout(() => store.updateReportSnapshot(key, { gcode_state: "IDLE" }), 50);
  const report = await bambu.readProgressReport("127.0.0.1", "01PTEST", "test", 5000);
  assert.equal(report.raw.gcode_state, "IDLE");
  assert.equal(published.length, 1, "one PushAll for all the expired polls");

  // A printer that already pushed its full status while connecting is not asked again.
  const quiet = new BambuImplementation();
  const quietPublished = [];
  const quietPrinter = { publish: async (message) => { quietPublished.push(message); } };
  quiet.getPrinter = async () => {
    quiet.printerStore.printers.set(key, quietPrinter);
    quiet.printerStore.updateReportSnapshot(key, { gcode_state: "RUNNING" });
    return quietPrinter;
  };
  assert.equal((await quiet.readProgressReport("127.0.0.1", "01PTEST", "test", 5000)).raw.gcode_state, "RUNNING");
  assert.deepEqual(quietPublished, []);
});

// A P1S's first pushes of a new job carried its name and layer count before its layer number, so the merged report
// read the previous job's last layer against the new total ("315/150") for one poll (Counterpart #702).
test("a new job's first reports start at layer 0, not the previous job's last layer", async () => {
  const { bambuProgress } = await import("../dist/counterpart/progress.js");
  const bambu = new BambuImplementation();
  const store = bambu.printerStore;
  const printer = client("01PTEST");
  const key = "127.0.0.1-01PTEST-test";
  store.watchReports(printer, "127.0.0.1", "01PTEST", key);
  // As over MQTT: the raw message first, then bambu-node's own merge and its dataUpdate.
  const push = async (print) => {
    const payload = { print: { command: "push_status", ...print } };
    printer.emit("rawMessage", "device/01PTEST/report", Buffer.from(JSON.stringify(payload)));
    await report(printer, payload);
  };
  const job = () => bambuProgress(store.getCachedReport("127.0.0.1", "01PTEST", "test"), { receivedAt: Date.now(), serial: "01PTEST", model: "p1s" }).job;
  await push({ gcode_state: "RUNNING", subtask_name: "bracket", total_layer_num: 315, layer_num: 314, mc_percent: 99 });
  await push({ layer_num: 315 });
  assert.equal(job().layer, 315, "a delta of the same job keeps its layer");
  await push({ gcode_state: "FINISH", mc_percent: 100 });
  assert.equal(job().layer, 315, "the finished job keeps its last layer");
  await push({ gcode_state: "PREPARE", subtask_name: "hook", total_layer_num: 150 });
  assert.equal(printer.data.layer_num, 315, "bambu-node's own merge still holds the old layer");
  assert.deepEqual([job().name, job().layer, job().totalLayers], ["hook", 0, 150]);
  await push({ gcode_state: "RUNNING", layer_num: 1 });
  assert.deepEqual([job().layer, job().totalLayers], [1, 150]);
});

test("a report merge restarts the progress only when a different job starts without its own", async () => {
  const { mergeBambuReport } = await import("../dist/printers/report-merge.js");
  const finished = { gcode_state: "FINISH", subtask_name: "a", gcode_file: "/sdcard/a.gcode", total_layer_num: 40, layer_num: 40, mc_percent: 100, mc_remaining_time: 0 };
  const progress = (report) => [report.layer_num, report.mc_percent, report.mc_remaining_time];
  assert.equal(mergeBambuReport(undefined, { layer_num: 12 }).layer_num, 12, "the first report is taken as it is");
  assert.deepEqual(progress(mergeBambuReport(finished, { nozzle_temper: 30 })), [40, 100, 0], "an idle delta keeps the last job's progress");
  assert.deepEqual(progress(mergeBambuReport(finished, { gcode_state: "PREPARE" })), [0, 0, undefined], "a start after a finished job restarts it");
  assert.equal(Object.hasOwn(mergeBambuReport(finished, { gcode_state: "PREPARE" }), "mc_remaining_time"), false, "an unknown remaining time is left out");
  assert.deepEqual(progress(mergeBambuReport(finished, { gcode_state: "PREPARE", mc_remaining_time: 95 })), [0, 0, 95], "what the new job sent is kept");
  assert.equal(mergeBambuReport(finished, { gcode_file: "/sdcard/b.gcode" }).layer_num, 0, "another file is another job");
  assert.equal(mergeBambuReport(finished, { task_id: "77" }).layer_num, 40, "a job id the report never had names no other job");
  assert.equal(mergeBambuReport({ ...finished, task_id: "76" }, { task_id: "77" }).layer_num, 0);
  assert.equal(mergeBambuReport(finished, { subtask_name: "b", total_layer_num: 10, layer_num: 3 }).layer_num, 3, "a full report's own layer wins");
  assert.equal(mergeBambuReport({ ...finished, gcode_state: "PAUSE" }, { gcode_state: "RUNNING" }).layer_num, 40, "a resume is the same job");
  // Placeholders name no job: a total of 0 before slicing, an empty file, LAN's task_id "0".
  const running = { gcode_state: "RUNNING", subtask_name: "a", gcode_file: "/sdcard/a.gcode", task_id: "0", total_layer_num: 0, layer_num: 7 };
  for (const update of [{ total_layer_num: 150 }, { gcode_file: "" }, { task_id: "123" }, { subtask_name: " " }]) {
    assert.equal(mergeBambuReport(running, update).layer_num, 7, JSON.stringify(update));
  }
});
