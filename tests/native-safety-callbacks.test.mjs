import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { test } from "node:test";
import { BambuImplementation } from "../dist/printers/bambu.js";

const host = "127.0.0.1", serial = "20PCALLBACK", token = "DUMMY";

function setup(t, raw = {}) {
  let confirmations = 0, reads = 0;
  const printer = new BambuImplementation(async () => { confirmations++; return true; });
  const report = { vir_slot: [{id:255,tray_type:"PLA"},{id:254,tray_type:"PLA"}], model: "x2d", gcode_state: "IDLE", nozzle_diameter: ["0.4", "0.4"], print_error: 0, hms: [], ...raw };
  printer.getSafetyStatus = async () => {
    reads++;
    return { connected: true, serial, model: report.model, status: report.gcode_state, raw: structuredClone(report),
      observation: { source: "mqtt", requestedAt: Date.now() - 1, receivedAt: Date.now(), identitySource: "report" } };
  };
  printer.getPrinter = async () => { throw new Error("Unexpected printer connection"); };
  return { printer, report, confirmations: () => confirmations, reads: () => reads };
}

test("native heating rejects newly busy state at helper dispatch without a prompt", async t => {
  const s = setup(t);
  let sent = false;
  await assert.rejects(s.printer.setTemperature(host, serial, token, "bed", 50, "x2d", undefined, 0.4,
    async (_heater, _target, _active, beforeDispatch) => {
      s.report.gcode_state = "RUNNING";
      await beforeDispatch?.();
      sent = true;
    }), /RUNNING|idle/i);
  assert.equal(sent, false);
  assert.equal(s.confirmations(), 0);
});

test("native heating repeats live checks for retries without a prompt", async t => {
  const s = setup(t);
  await s.printer.setTemperature(host, serial, token, "bed", 50, "x2d", undefined, 0.4,
    async (_heater, _target, _active, beforeDispatch) => {
      await beforeDispatch?.();
      s.report.model = "p1s";
      await assert.rejects(async () => beforeDispatch?.(), /identity|model/i);
    });
  assert.equal(s.reads(), 4);
  assert.equal(s.confirmations(), 0);
});

test("heating rechecks the currently loaded spool material at helper dispatch", async t => {
  const s = setup(t, { model: "p1s", nozzle_diameter: "0.4", ams: {
    tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }, { id: "1", tray_type: "ABS" }] }],
  } });
  let sent = false;
  await assert.rejects(s.printer.setTemperature(host, serial, token, "nozzle", 220, "p1s", "PLA", 0.4,
    async (_heater, _target, _active, beforeDispatch) => {
      s.report.ams.tray_now = "1";
      await beforeDispatch?.();
      sent = true;
    }), /material|contradict/i);
  assert.equal(sent, false);
});

/** A checked X2D job on the printer at cache/checked.3mf, whose bytes FTPS re-reads. */
function checkedNativeJob(s) {
  const bytes = Buffer.from("inspected 3mf bytes");
  s.printer.ftpDownload = async (_host, _token, remote, destination) => {
    assert.equal(remote, "cache/checked.3mf");
    await fs.writeFile(destination, bytes);
  };
  s.printer.recordCheckedJob(host, serial, "cache/checked.3mf", {
    model: "x2d", nozzleDiameters: [0.4, 0.4], materials: ["PLA"], usedFilamentPositions: [0], filamentNozzleIndices: [0], amsMapping: [255], useAMS: false,
  }, { sha256: createHash("sha256").update(bytes).digest("hex"), model: "x2d", maxNozzleTemperature: 220, maxBedTemperature: 60, maxChamberTemperature: 0, materials: ["PLA"] });
}

for (const [label, change, error] of [
  // Seen paused before, so another paused job also retires the record.
  ["job identity", s => Object.assign(s.report, { gcode_file: "cache/other.3mf" }), /no longer the job/],
  ["nozzle", s => Object.assign(s.report, { nozzle_diameter: ["0.6", "0.4"] }), /nozzle|diameter/i],
  ["paused state", s => Object.assign(s.report, { gcode_state: "RUNNING" }), /paused|PAUSE/i],
  // The job ended and the same file paused again between the server's last check and the helper's.
  ["that the confirmed record is still current", s => s.printer.observeReport(host, serial, { gcode_state: "FINISH", gcode_file: "cache/checked.3mf" }), /no longer the job/],
]) test(`native resume rechecks ${label} at helper dispatch`, async t => {
  const s = setup(t, { gcode_state: "PAUSE", gcode_file: "cache/checked.3mf" });
  checkedNativeJob(s);
  let sent = false;
  await assert.rejects(s.printer.resumeJob(host, serial, token, async (_active, beforeDispatch) => {
    change(s);
    await beforeDispatch?.();
    sent = true;
  }), error);
  assert.equal(sent, false);
  assert.equal(s.confirmations(), 0, "a resume whose bytes were re-read does not ask");
});

test("native error clearing rejects codes that changed after confirmation at helper dispatch", async t => {
  const s = setup(t, { print_error: 123 });
  let sent = false;
  await assert.rejects(s.printer.clearHmsErrors(host, serial, token, async (_active, beforeDispatch) => {
    s.report.print_error = 456;
    await beforeDispatch?.();
    sent = true;
  }), /errors changed/i);
  assert.equal(sent, false);
  assert.equal(s.confirmations(), 1);
});

test("native error clearing rechecks identical confirmed codes for every attempt", async t => {
  const s = setup(t, { print_error: 123, hms: [{ attr: 1, code: 131073 }] });
  const result = await s.printer.clearHmsErrors(host, serial, token, async (_active, beforeDispatch) => {
    await beforeDispatch?.();
    await beforeDispatch?.();
  });
  assert.equal(s.reads(), 4);
  assert.equal(s.confirmations(), 1);
  assert.deepEqual(result.cleared_codes, ["hms:1:131073", "print_error:123"]);
});

test("native heater-off needs neither fresh state nor confirmation", async t => {
  const s = setup(t);
  let sent = false;
  await s.printer.setTemperature(host, serial, token, "bed", 0, undefined, undefined, 0.4,
    async (_heater, target, _active, beforeDispatch) => {
      assert.equal(target, 0);
      assert.equal(beforeDispatch, undefined);
      sent = true;
    });
  assert.equal(sent, true);
  assert.equal(s.reads(), 0);
  assert.equal(s.confirmations(), 0);
});

for (const [method, args] of [
  ["rereadAmsRfid", [0.5, 0]], ["rereadAmsRfid", [0, 0.5]],
  ["setAmsDrying", ["start", 0.5]], ["setAmsDrying", ["stop", -0.5]],
]) test(`${method} rejects fractional addresses ${JSON.stringify(args)} before connecting`, async t => {
  const s = setup(t);
  await assert.rejects(s.printer[method](host, serial, token, ...args), /integer/i);
});
