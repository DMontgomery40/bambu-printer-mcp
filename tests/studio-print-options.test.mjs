import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readStudioSavedOptions, resolveStudioPrintOptions, studioConfigPath } from "../dist/studio-print-options.js";

// David's BambuStudio.conf section for the P1S (printer type C12), as Bambu Studio 02.08.02.61 saved it.
const DAVID_C12 = { bed_leveling: "on", flow_cali: "auto", nozzle_offset_cali: "auto", timelapse: "off" };
const SECRET = "12345678";

/** A BambuStudio.conf as Studio writes it: JSON, then an MD5 checksum line. It also holds access codes. */
function studioConf(t, sections) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-conf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "BambuStudio.conf");
  fs.writeFileSync(file, `${JSON.stringify({ ...sections, access_code: { "01P00TEST": SECRET } }, null, 4)}\n# MD5 checksum 0123456789ABCDEF0123456789ABCDEF\n`);
  return file;
}

const fields = (options) => ({
  task_bed_leveling: options.task_bed_leveling, task_flow_cali: options.task_flow_cali,
  task_vibration_cali: options.task_vibration_cali, task_layer_inspect: options.task_layer_inspect,
  auto_bed_leveling: options.auto_bed_leveling, auto_flow_cali: options.auto_flow_cali, auto_offset_cali: options.auto_offset_cali,
  extruder_cali_manual_mode: options.extruder_cali_manual_mode,
});

// What SelectMachine.cpp:3344-3356 sends for a P1S, with David's saved options and with none.
const P1S_STUDIO = {
  task_bed_leveling: true, task_flow_cali: false, task_vibration_cali: false, task_layer_inspect: true,
  auto_bed_leveling: 1, auto_flow_cali: 2, auto_offset_cali: 2, extruder_cali_manual_mode: 0,
};

test("a P1S with David's saved Studio options sends what Studio's Send dialog sends", (t) => {
  const result = resolveStudioPrintOptions("p1s", {}, { configPath: studioConf(t, { C12: DAVID_C12 }) });
  assert.deepEqual(fields(result), P1S_STUDIO);
  assert.equal(result.printerType, "C12");
  assert.deepEqual(result.values, { bed_leveling: "on", flow_cali: "auto", nozzle_offset_cali: "auto" });
  assert.deepEqual(result.sources, { bed_leveling: "studio-config", flow_cali: "studio-config", nozzle_offset_cali: "studio-config" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET), "nothing but the printer type's options is read");
});

test("a P1S with no saved Studio options uses Studio's defaults, which send the same", (t) => {
  for (const configPath of [undefined, path.join(os.tmpdir(), "no-such-studio.conf"), studioConf(t, { C11: { bed_leveling: "off" } })]) {
    const result = resolveStudioPrintOptions("p1s", {}, { configPath });
    assert.deepEqual(fields(result), P1S_STUDIO, String(configPath));
    assert.deepEqual(result.sources, { bed_leveling: "studio-default", flow_cali: "studio-default", nozzle_offset_cali: "studio-default" });
  }
});

test("a saved value the printer does not offer falls back as Studio's load_option_vals does", (t) => {
  // P1S bed leveling offers only on/off (support_bed_leveling 1), so a saved "auto" becomes "on".
  const result = resolveStudioPrintOptions("p1s", {}, { configPath: studioConf(t, { C12: { ...DAVID_C12, bed_leveling: "auto", flow_cali: "sometimes" } }) });
  assert.equal(result.values.bed_leveling, "on");
  assert.equal(result.sources.bed_leveling, "studio-default");
  assert.equal(result.values.flow_cali, "auto");
  assert.deepEqual(fields(result), P1S_STUDIO);
});

test("saved off/on values are sent as Studio maps them", (t) => {
  const result = resolveStudioPrintOptions("p1s", {}, { configPath: studioConf(t, { C12: { bed_leveling: "off", flow_cali: "on", nozzle_offset_cali: "off" } }) });
  assert.deepEqual(fields(result), { ...P1S_STUDIO, task_bed_leveling: false, auto_bed_leveling: 0, task_flow_cali: true, auto_flow_cali: 1, auto_offset_cali: 0 });
});

test("an explicit caller value wins, through the same off/on/auto value", (t) => {
  const configPath = studioConf(t, { C12: DAVID_C12 });
  assert.deepEqual(fields(resolveStudioPrintOptions("p1s", { bedLeveling: false }, { configPath })), { ...P1S_STUDIO, task_bed_leveling: false, auto_bed_leveling: 0 });
  assert.deepEqual(fields(resolveStudioPrintOptions("p1s", { flowCalibration: true }, { configPath })), { ...P1S_STUDIO, task_flow_cali: true, auto_flow_cali: 1 });
  assert.deepEqual(fields(resolveStudioPrintOptions("p1s", { autoBedLeveling: 2, autoOffsetCali: 0 }, { configPath })), { ...P1S_STUDIO, task_bed_leveling: false, auto_bed_leveling: 2, auto_offset_cali: 0 });
  assert.deepEqual(fields(resolveStudioPrintOptions("p1s", { vibrationCalibration: true, layerInspect: false, extruderCaliManualMode: 1 }, { configPath })),
    { ...P1S_STUDIO, task_vibration_cali: true, task_layer_inspect: false, extruder_cali_manual_mode: 1 });
  assert.equal(resolveStudioPrintOptions("p1s", { bedLeveling: false }, { configPath }).sources.bed_leveling, "caller");
  assert.throws(() => resolveStudioPrintOptions("p1s", { autoFlowCali: 3 }, { configPath }), /auto_flow_cali must be 0 \(off\), 1 \(on\) or 2 \(auto\)/);
});

test("other printers resolve from Studio's printer definitions", () => {
  // X1C: bed leveling on/off, flow calibration on/off (no auto flow), so the defaults are "on".
  assert.deepEqual(fields(resolveStudioPrintOptions("x1c", {}, { configPath: undefined })),
    { ...P1S_STUDIO, task_flow_cali: true, auto_flow_cali: 1 });
  // H2D: bed leveling and flow calibration offer auto; one nozzle without a filament switcher turns nozzle offset off.
  const h2d = { ...P1S_STUDIO, task_bed_leveling: false, auto_bed_leveling: 2 };
  assert.deepEqual(fields(resolveStudioPrintOptions("h2d", {}, { configPath: undefined, usedNozzles: 2 })), h2d);
  assert.deepEqual(fields(resolveStudioPrintOptions("h2d", {}, { configPath: undefined, usedNozzles: 1 })), { ...h2d, auto_offset_cali: 0 });
  assert.equal(resolveStudioPrintOptions("x1c", {}, { configPath: undefined }).printerType, "3DPrinter-X1-Carbon");
});

test("an unreadable BambuStudio.conf is ignored without echoing any of its text", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-conf-bad-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "BambuStudio.conf");
  fs.writeFileSync(file, `{"C12": {"bed_leveling": "off"}, "access_code": {"01P00TEST": "${SECRET}"`);
  assert.equal(readStudioSavedOptions(["C12"], file), undefined);
  const result = resolveStudioPrintOptions("p1s", {}, { configPath: file });
  assert.deepEqual(fields(result), P1S_STUDIO);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("BAMBU_STUDIO_CONFIG overrides the path, and empty means no config", () => {
  const previous = process.env.BAMBU_STUDIO_CONFIG;
  try {
    process.env.BAMBU_STUDIO_CONFIG = "/tmp/elsewhere/BambuStudio.conf";
    assert.equal(studioConfigPath(), "/tmp/elsewhere/BambuStudio.conf");
    process.env.BAMBU_STUDIO_CONFIG = "";
    assert.equal(studioConfigPath(), undefined);
    delete process.env.BAMBU_STUDIO_CONFIG;
    if (process.platform === "darwin") assert.equal(studioConfigPath(), path.join(os.homedir(), "Library", "Application Support", "BambuStudio", "BambuStudio.conf"));
  } finally {
    if (previous === undefined) delete process.env.BAMBU_STUDIO_CONFIG; else process.env.BAMBU_STUDIO_CONFIG = previous;
  }
});
