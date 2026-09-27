import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { BambuImplementation } from "../dist/printers/bambu.js";

async function capture(t, model, serial, { sparse = false, useAMS = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cube.gcode.3mf");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.gcode", `; filament_colour = ${sparse ? "#FFFFFF;#FFFFFF;#FFFFFF;#FFFFFF;#FFFFFF;#FFFFFF" : "#FFFFFF"}\nG1 X0 Y0\n`);
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [sparse ? 5 : 0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  const printer = new BambuImplementation();
  let uploadedPath;
  const published = [];
  printer.ftpUpload = async (_host, _token, _file, remote) => { uploadedPath = remote; };
  printer.getPrinter = async () => ({ publish: async (message) => { published.push(typeof message === "string" ? JSON.parse(message) : message); } });
  await printer.print3mf("127.0.0.1", serial, "test", {
    projectName: "cube", filePath: file, bambuModel: model,
    useAMS, ...(useAMS ? { amsSlots: [1] } : {}),
  });
  assert.equal(published.length, 1);
  return { uploadedPath, cmd: published[0].print };
}

test("full-size A1 uploads to SD root and uses project_file", async (t) => {
  const { uploadedPath, cmd } = await capture(t, "a1", "030TEST");
  assert.equal(uploadedPath, "/cube.gcode.3mf");
  assert.equal(cmd.command, "project_file");
  assert.equal(cmd.url, "file:///sdcard/cube.gcode.3mf");
  assert.equal(cmd.ams_mapping[0], 1);
});

test("A1 keeps an AMS selection beyond the fifth project filament", async (t) => {
  const { cmd } = await capture(t, "a1", "030TEST", { sparse: true });
  assert.deepEqual(cmd.ams_mapping, [-1, -1, -1, -1, -1, 1]);
});

for (const [model, serial] of [["p1s", "01PTEST"], ["p1p", "01STEST"], ["x1c", "00MTEST"], ["x1e", "03WTEST"], ["a1mini", "039TEST"]]) {
  test(`${model} retains the legacy cache/gcode_file route`, async (t) => {
    const { uploadedPath, cmd } = await capture(t, model, serial);
    assert.equal(uploadedPath, "/cache/cube.gcode.3mf");
    assert.equal(cmd.command, "gcode_file");
    assert.equal(cmd.param, "cache/cube.gcode.3mf");
  });
}

test("P2S external spool uses the new payload without requiring AMS mapping", async (t) => {
  const { uploadedPath, cmd } = await capture(t, "p2s", "22ETEST", { useAMS: false });
  assert.equal(uploadedPath, "/cache/cube.gcode.3mf");
  assert.equal(cmd.command, "project_file");
  assert.equal(cmd.url, "ftp:///cache/cube.gcode.3mf");
  assert.equal(cmd.use_ams, false);
});
