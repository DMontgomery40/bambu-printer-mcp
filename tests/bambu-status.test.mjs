import assert from "node:assert/strict";
import { test } from "node:test";
import { BambuClient } from "bambu-node";

function client(serial = "239TEST") {
  return new BambuClient({ host: "127.0.0.1", serialNumber: serial, accessToken: "test" });
}

async function report(printer, payload) {
  // Exercise the actual patched MQTT parser without connecting to hardware.
  await printer.onMessage(JSON.stringify(payload), `device/${printer.config.serialNumber}/report`);
}

for (const [prefix, model] of [["093", "H2S"], ["094", "H2D"], ["239", "H2C"], ["31B", "H2DPRO"], ["22E", "P2S"], ["01P", "P1S"], ["039", "A1"], ["030", "A1M"]]) {
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
