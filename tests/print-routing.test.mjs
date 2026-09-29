import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { BambuImplementation } from "../dist/printers/bambu.js";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";

async function capture(t, model, serial, { sparse = false, useAMS = true, suffix = ".gcode.3mf" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `cube${suffix}`);
  const zip = new JSZip();
  const filamentCount = sparse ? 6 : 1;
  const nozzleDiameters = ["h2d", "h2c"].includes(model) ? [0.4, 0.4] : [0.4];
  zip.file("Metadata/plate_1.gcode", `; printer_model = ${model}\n; nozzle_diameter = ${nozzleDiameters.join(";")}\n; filament_type = ${Array(filamentCount).fill("PLA").join(";")}\n; filament_colour = ${Array(filamentCount).fill("#FFFFFF").join(";")}\nM104 S220\nM140 S60\nG1 X0 Y0\n`);
  zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: model, nozzle_diameter: nozzleDiameters.map(String), filament_type: Array(filamentCount).fill("PLA") }));
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [sparse ? 5 : 0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  const printer = new BambuImplementation(async () => true);
  let uploadedPath;
  const published = [];
  printer.ftpUpload = async (_host, _token, _file, remote) => { uploadedPath = remote; };
  printer.getSafetyStatus = async () => {
    const now = Date.now();
    return { connected: true, model, status: "IDLE", serial,
      raw: { model, gcode_state: "IDLE", nozzle_diameter: "0.4", nozzle_type: "hardened_steel", device: { nozzle: { info: nozzleDiameters.map((diameter, id) => ({ id, diameter, type: "HH01", stat: 0 })) } }, print_error: 0, hms: [], ams: { tray_now: "254", ams: [{ id: "0", tray: [{ id: "1", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] } },
      observation: { source: "mqtt", requestedAt: now, receivedAt: now, identitySource: "report" } };
  };
  printer.getPrinter = async () => ({ publish: async (message) => { published.push(typeof message === "string" ? JSON.parse(message) : message); } });
  const result = await printer.print3mf("127.0.0.1", serial, "test", {
    projectName: "cube", filePath: file, bambuModel: model,
    nozzleDiameters,
    useAMS, ...(useAMS ? { amsSlots: [1] } : {}),
  });
  assert.equal(published.length, 1);
  assert.match(path.posix.basename(uploadedPath), /^checked-[a-f0-9-]+-cube(?:\.gcode)?\.3mf$/);
  assert.equal(uploadedPath, `/${result.remoteProjectPath}`);
  return { uploadedPath, remote: result.remoteProjectPath, cmd: published[0].print };
}

test("full-size A1 uploads to SD root and uses project_file", async (t) => {
  const { uploadedPath, remote, cmd } = await capture(t, "a1", "030TEST");
  assert.equal(path.posix.dirname(uploadedPath), "/");
  assert.equal(cmd.command, "project_file");
  assert.equal(cmd.url, `file:///sdcard/${remote}`);
  assert.equal(cmd.ams_mapping[0], 1);
});

test("A1 keeps an AMS selection beyond the fifth project filament", async (t) => {
  const { cmd } = await capture(t, "a1", "030TEST", { sparse: true });
  assert.deepEqual(cmd.ams_mapping, [-1, -1, -1, -1, -1, 1]);
});

for (const [model, serial] of [["p1s", "01PTEST"], ["p1p", "01STEST"], ["x1c", "00MTEST"], ["x1e", "03WTEST"], ["a1mini", "039TEST"]]) {
  test(`${model} retains the legacy cache/gcode_file route`, async (t) => {
    const { uploadedPath, remote, cmd } = await capture(t, model, serial, { useAMS: false });
    assert.equal(path.posix.dirname(uploadedPath), "/cache");
    assert.equal(cmd.command, "gcode_file");
    assert.equal(cmd.param, remote);
  });
}

for (const [model, serial] of [["p1s", "01PTEST"], ["a1mini", "039TEST"]]) {
  test(`${model} normal 3MF retains project_file AMS mapping`, async (t) => {
    const { uploadedPath, remote, cmd } = await capture(t, model, serial, { suffix: ".3mf" });
    assert.equal(path.posix.dirname(uploadedPath), "/cache");
    assert.equal(cmd.command, "project_file");
    assert.equal(cmd.url, `file:///sdcard/${remote}`);
    assert.equal(cmd.ams_mapping[0], 1);
    assert.equal(cmd.use_ams, true);
  });
}

test("P2S external spool uses the new payload without requiring AMS mapping", async (t) => {
  const { uploadedPath, remote, cmd } = await capture(t, "p2s", "22ETEST", { useAMS: false });
  assert.equal(path.posix.dirname(uploadedPath), "/cache");
  assert.equal(cmd.command, "project_file");
  assert.equal(cmd.url, `ftp:///${remote}`);
  assert.equal(cmd.use_ams, false);
});

for (const [model, serial] of [["h2s", "093TEST"], ["h2d", "094TEST"], ["h2c", "TESTH2C"]]) {
  test(`${model} retains the root project_file route and positional AMS payload`, async (t) => {
    const { uploadedPath, remote, cmd } = await capture(t, model, serial);
    assert.equal(path.posix.dirname(uploadedPath), "/");
    assert.equal(cmd.command, "project_file");
    assert.equal(cmd.url, `ftp:///${remote}`);
    assert.deepEqual(cmd.ams_mapping, [1]);
    assert.deepEqual(cmd.ams_mapping2, [{ ams_id: 0, slot_id: 1 }]);
  });
}

for (const [model, serial] of [["p1s", "01PTEST"], ["a1", "030TEST"], ["a1mini", "039TEST"], ["h2s", "093TEST"], ["h2d", "094TEST"], ["h2c", "TESTH2C"]]) {
  test(`${model} preserves external-spool dispatch with a declared material`, async (t) => {
    const { cmd } = await capture(t, model, serial, { useAMS: false });
    assert.ok(["project_file", "gcode_file"].includes(cmd.command));
    if (cmd.command === "project_file") assert.equal(cmd.use_ams, false);
  });
}
