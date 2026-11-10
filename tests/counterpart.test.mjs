import {trackedMkdtempSync} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { bambuProgress, bambuState, formatHmsCode, hmsUrl, offlineProgress, stageWords, TASK_CANCELLED } from "../dist/counterpart/progress.js";
import { bambuPrinterInfo } from "../dist/counterpart/info.js";
import { makeCounterpart3mf } from "../dist/counterpart/make-3mf.js";
import { MAKE_3MF_OUTPUT_SCHEMA, PRINT_PROGRESS_OUTPUT_SCHEMA, PRINTER_INFO_OUTPUT_SCHEMA } from "../dist/counterpart/schemas.js";
import { BAMBU_STAGES, BAMBU_STAGES_SOURCE } from "../dist/printers/bambu-stages.js";
import { HMS_MESSAGES, HMS_MESSAGES_SOURCE, PRINT_ERROR_MESSAGES } from "../dist/safety/hms-messages.js";
import { HIDDEN_HMS_SOURCE } from "../dist/safety/hidden-hms.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = new AjvJsonSchemaValidator();
const validate = (schema, value) => {
  const result = validator.getValidator(schema)(value);
  assert.ok(result.valid, result.errorMessage);
};
const progress = (raw, options = {}) => {
  const result = bambuProgress(raw, { receivedAt: Date.UTC(2026, 10, 1, 12, 0, 0), serial: "01PTEST", model: "p1s", ...options });
  validate(PRINT_PROGRESS_OUTPUT_SCHEMA, result);
  return result;
};

test("gcode_state maps to the counterpart/1 state table", () => {
  for (const [gcodeState, state] of [
    ["IDLE", "idle"], ["PREPARE", "preparing"], ["SLICING", "preparing"], ["RUNNING", "printing"],
    ["PAUSE", "paused"], ["FINISH", "finished"], ["FAILED", "failed"], ["running", "printing"],
    ["INIT", "busy"], ["UNKNOWN", "busy"], [undefined, "busy"], [42, "busy"],
  ]) {
    assert.equal(bambuState({ gcode_state: gcodeState, print_error: 0 }), state, String(gcodeState));
    assert.equal(progress({ gcode_state: gcodeState }).state, state, String(gcodeState));
  }
});

test("a cancelled job is cancelled, from print_error or the X2D fail_reason, and is not a problem", () => {
  for (const raw of [
    { gcode_state: "FAILED", print_error: TASK_CANCELLED, subtask_name: "part" },
    { gcode_state: "FAILED", print_error: 0, fail_reason: TASK_CANCELLED, subtask_name: "part" },
    { gcode_state: "FAILED", print_error: 0, fail_reason: String(TASK_CANCELLED), subtask_name: "part" },
  ]) {
    const result = progress(raw);
    assert.equal(result.state, "cancelled");
    assert.deepEqual(result.problems, []);
    assert.equal(result.job.name, "part");
  }
  // Any other failure stays a failure and keeps its code.
  const failed = progress({ gcode_state: "FAILED", print_error: 0x07008011, subtask_name: "part" });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.problems.map(problem => problem.code), ["07008011"]);
  // 0300400C alone, outside FAILED, records a cancel and is never a problem either.
  assert.deepEqual(progress({ gcode_state: "IDLE", print_error: TASK_CANCELLED }).problems, []);
});

test("time left is minutes in the report and seconds in the result; percent and layers pass through", () => {
  const result = progress({ gcode_state: "RUNNING", subtask_name: "bracket", task_id: "0", mc_percent: 37, mc_remaining_time: 42, layer_num: 12, total_layer_num: 140 });
  assert.deepEqual(result.job, { name: "bracket", progress: 37, remainingSec: 2520, totalLayers: 140, layer: 12 });
  assert.equal(result.observedAt, "2026-11-01T12:00:00.000Z");
  // Layers are omitted until the printer knows the total; out-of-range values are dropped.
  assert.deepEqual(progress({ gcode_state: "PREPARE", subtask_name: "bracket", mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0 }).job,
    { name: "bracket", progress: 0, remainingSec: 0 });
  assert.deepEqual(progress({ gcode_state: "RUNNING", subtask_name: "bracket", mc_percent: 140, mc_remaining_time: -1 }).job, { name: "bracket" });
});

test("job id is the reported task id unless it is the LAN placeholder 0; idle and busy have no job", () => {
  assert.equal(progress({ gcode_state: "RUNNING", subtask_name: "a", task_id: "0" }).job.id, undefined);
  assert.equal(progress({ gcode_state: "RUNNING", subtask_name: "a", task_id: "1793576906" }).job.id, "1793576906");
  assert.equal(progress({ gcode_state: "RUNNING", subtask_name: "a", task_id: 987 }).job.id, "987");
  // A raw G-code print reports only its file path; job.name is its basename, the jobName the print returned.
  assert.equal(progress({ gcode_state: "RUNNING", subtask_name: "", gcode_file: "cache/a.3mf" }).job.name, "a.3mf");
  assert.equal(progress({ gcode_state: "RUNNING", gcode_file: "/sdcard/cache/checked-1-job.gcode" }).job.name, "checked-1-job.gcode");
  assert.equal(progress({ gcode_state: "RUNNING" }).job, undefined);
  assert.equal(progress({ gcode_state: "IDLE", subtask_name: "last job" }).job, undefined);
  assert.equal(progress({ gcode_state: "INIT", subtask_name: "last job" }).job, undefined);
});

test("stg_cur maps to Bambu Studio's stage words only while the printer reports a stage list", () => {
  assert.equal(BAMBU_STAGES[0], "Printing");
  assert.equal(BAMBU_STAGES[1], "Auto bed leveling");
  assert.equal(BAMBU_STAGES[2], "Heatbed preheating");
  assert.equal(BAMBU_STAGES[7], "Heating nozzle");
  assert.equal(BAMBU_STAGES_SOURCE.studioCommit, HIDDEN_HMS_SOURCE.studioCommit, "stages and HMS tables come from one pinned commit");
  assert.equal(stageWords({ stg_cur: 2, stg: [2, 14, 1] }), "Heatbed preheating");
  assert.equal(stageWords({ stg_cur: 255, stg: [] }), undefined, "idle");
  assert.equal(stageWords({ stg_cur: 2, stg: [] }), undefined, "no stage list, as Bambu Studio shows none");
  assert.equal(stageWords({ stg_cur: -1, stg: [1] }), undefined);
  assert.equal(stageWords({ stg_cur: 900, stg: [1] }), undefined, "unknown stage");
  assert.equal(progress({ gcode_state: "PREPARE", subtask_name: "a", stg_cur: 1, stg: [2, 1] }).job.stage, "Auto bed leveling");
});

test("HMS entries become AAAA_BBBB_CCCC_DDDD problems with severity, Bambu's text and page", () => {
  assert.equal(formatHmsCode("0300180000010003"), "0300_1800_0001_0003");
  assert.equal(hmsUrl("0300180000010003"), "https://e.bambulab.com/index.php?e=0300180000010003&s=device_hms&lang=en");
  const documented = Object.entries(HMS_MESSAGES).find(([, text]) => typeof text === "string");
  const [hex, text] = documented;
  const attr = parseInt(hex.slice(0, 8), 16);
  const problems = progress({ gcode_state: "RUNNING", subtask_name: "a", print_error: 0, hms: [
    { attr, code: parseInt(hex.slice(8), 16) },
    { attr: 0x03001800, code: 0x00010003 },
    { attr: 0x03001800, code: 0x00020003 },
    { attr: 0x03001800, code: 0x00030003 },
    { attr: 0x03001800, code: 0x00040003 },
    { attr: 0x03001800, code: 0x00090003 },
    { attr: 0x03001800, code: 0x00010003 },
  ] }).problems;
  assert.deepEqual(problems[0], { code: formatHmsCode(hex), severity: ["fatal", "error", "warning", "info"][parseInt(hex.slice(8, 12), 16) - 1] ?? "error", message: text, url: hmsUrl(hex) });
  assert.deepEqual(problems.slice(1).map(problem => [problem.code, problem.severity]), [
    ["0300_1800_0001_0003", "fatal"], ["0300_1800_0002_0003", "error"], ["0300_1800_0003_0003", "warning"],
    ["0300_1800_0004_0003", "info"], ["0300_1800_0009_0003", "error"],
  ], "unknown levels fail toward error; repeats are listed once");
  for (const problem of problems) assert.match(problem.message, /\S/);
});

test("HMS text follows the printer's own table, falls back to the shared text, and hides what Bambu hides", () => {
  const [hex, texts] = Object.entries(HMS_MESSAGES).find(([, value]) => typeof value === "object" && Object.keys(value).some(key => key !== "*"));
  const prefix = Object.keys(texts).find(key => key !== "*");
  const entry = { attr: parseInt(hex.slice(0, 8), 16), code: parseInt(hex.slice(8), 16) };
  assert.equal(progress({ gcode_state: "IDLE", hms: [entry] }, { serial: `${prefix}TEST` }).problems[0].message, texts[prefix]);
  assert.equal(progress({ gcode_state: "IDLE", hms: [entry] }, { serial: "01PTEST" }).problems[0].message, texts["*"], "a P1S has no bundled table");
  // X2D lists 0500-0600-0002-0070 without text; Bambu never shows it as a fault.
  const hidden = progress({ gcode_state: "IDLE", hms: [{ attr: 0x05000600, code: 0x00020070 }] }, { serial: "20PTEST", model: "x2d" }).problems[0];
  assert.equal(hidden.code, "0500_0600_0002_0070");
  assert.equal(hidden.severity, "info");
  // Unknown codes and malformed entries are still reported.
  const unknown = progress({ gcode_state: "IDLE", hms: [{ attr: 0x7f7f7f7f, code: 0x00027f7f }, { attr: "x" }] }).problems;
  assert.equal(unknown[0].code, "7F7F_7F7F_0002_7F7F");
  assert.match(unknown[0].message, new RegExp(`no description.*|${HMS_MESSAGES_SOURCE.studioTag}`));
  assert.equal(unknown[1].code, "HMS_MALFORMED");
});

test("print_error becomes 8-digit hex with Bambu's device_error text", () => {
  const [code, text] = Object.entries(PRINT_ERROR_MESSAGES).find(([key, value]) => typeof value === "string" && key !== "0300400C");
  const problem = progress({ gcode_state: "PAUSE", subtask_name: "a", print_error: parseInt(code, 16) }).problems[0];
  assert.deepEqual(problem, { code, severity: "error", message: text });
  assert.equal(progress({ gcode_state: "PAUSE", subtask_name: "a", print_error: 0x500 }).problems[0].code, "00000500");
  assert.deepEqual(progress({ gcode_state: "PAUSE", print_error: 0 }).problems, []);
  assert.equal(PRINT_ERROR_MESSAGES["0300400C"], "The task was canceled.");
});

test("temperatures, chamber sensor and active filament", () => {
  const ams = { tray_now: "1", ams: [
    { id: "0", tray: [{ id: "0", tray_type: "PLA", tray_color: "000000FF" }, { id: "1", tray_type: "PLA", tray_color: "fec600ff" }] },
    { id: "1", tray: [{ id: "0" }, { id: "1" }, { id: "2", tray_type: "PETG", tray_color: "77EDD780" }] },
  ] };
  const p1s = progress({ gcode_state: "IDLE", nozzle_temper: 25.40625, nozzle_target_temper: 0, bed_temper: 21.9, bed_target_temper: 0, chamber_temper: 5, ams });
  assert.deepEqual(p1s.temps, { nozzle: { actual: 25.4, target: 0 }, bed: { actual: 21.9, target: 0 } }, "P1S reports a constant chamber value, so it is omitted");
  assert.deepEqual(p1s.activeFilament, { slot: "1", material: "PLA", color: "#FEC600" });
  assert.deepEqual(progress({ gcode_state: "IDLE", ams: { ...ams, tray_now: "6" } }).activeFilament, { slot: "6", material: "PETG", color: "#77EDD7" });
  assert.deepEqual(progress({ gcode_state: "IDLE", ams: { tray_now: "254" }, vt_tray: { id: "254", tray_type: "PETG", tray_color: "FFFFFFFF" } }).activeFilament,
    { slot: "ext", material: "PETG", color: "#FFFFFF" });
  assert.deepEqual(progress({ gcode_state: "IDLE", ams: { tray_now: "254" }, vt_tray: { tray_type: "", tray_color: "FFFFFF00" } }).activeFilament, { slot: "ext" });
  assert.equal(progress({ gcode_state: "IDLE", ams: { tray_now: "255" } }).activeFilament, undefined);
  assert.equal(progress({ gcode_state: "IDLE", chamber_temper: 31.25 }, { model: "x1c" }).temps.chamber, 31.3);
  assert.equal(progress({ gcode_state: "IDLE", device: { ctc: { info: { temp: 3932186 } } } }, { model: "h2d" }).temps.chamber, 26);
  assert.equal(progress({ gcode_state: "IDLE" }).temps, undefined);
});

test("an unreachable printer is offline with no job and no problems", () => {
  const result = offlineProgress(Date.UTC(2026, 10, 1));
  validate(PRINT_PROGRESS_OUTPUT_SCHEMA, result);
  assert.deepEqual(result, { contract: "counterpart/1", observedAt: "2026-11-01T00:00:00.000Z", state: "offline", problems: [] });
});

test("printer info reports the camera transport and controls for each model without printer traffic", () => {
  const server = { name: "bambu-printer-mcp", version: "9.9.9" };
  const cases = [["p1s", "P1S", "bambu-tcp", true], ["a1mini", "A1 Mini", "bambu-tcp", true], ["x1c", "X1C", "rtsp", true],
    ["h2dpro", "H2D Pro", "rtsp", true], ["x2d", "X2D", "rtsp", false], [undefined, undefined, "none", true]];
  for (const [model, display, camera, gcode] of cases) {
    const info = bambuPrinterInfo({ server, host: "192.0.2.10", serial: "01PTEST", model });
    validate(PRINTER_INFO_OUTPUT_SCHEMA, info);
    assert.equal(info.contract, "counterpart/1");
    assert.deepEqual(info.server, server);
    assert.equal(info.printer.kind, "bambu");
    assert.equal(info.printer.model, display);
    assert.equal(info.printer.host, "192.0.2.10");
    assert.equal(info.capabilities.camera, camera);
    assert.equal(info.capabilities.gcode, gcode);
    assert.deepEqual([info.capabilities.progress, info.capabilities.layers, info.capabilities.pause, info.capabilities.resume, info.capabilities.cancel, info.capabilities.print3mf, info.capabilities.filaments],
      [true, true, true, true, true, true, "ams"]);
    assert.deepEqual(info.capabilities.slicing, { supports: true, copies: true, orient: true }, "Bambu Studio's CLI takes all three");
  }
  // The capability follows the backend: remote orca-slicer-api makes no copies; PrusaSlicer, Slic3r and Cura take none.
  assert.deepEqual(bambuPrinterInfo({ server, host: "h", slicerType: "orca-slicer-api" }).capabilities.slicing, { supports: true, copies: false, orient: true });
  for (const slicerType of ["prusaslicer", "slic3r", "cura"]) {
    assert.deepEqual(bambuPrinterInfo({ server, host: "h", slicerType }).capabilities.slicing, { supports: false, copies: false, orient: false }, slicerType);
  }
  assert.deepEqual(bambuPrinterInfo({ server, host: "h", slicerType: "orcaslicer" }).capabilities.slicing, { supports: true, copies: true, orient: true });
  assert.equal(bambuPrinterInfo({ server, host: "h", serial: "" }).printer.serial, undefined);
});

function boxStl(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + t.length * 50);
  buffer.writeUInt32LE(t.length, 80);
  t.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const vertex of triangle) for (const value of v[vertex]) { buffer.writeFloatLE(value, offset); offset += 4; }
  });
  return buffer;
}

function parts(t) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "counterpart-3mf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = path.join(directory, "base.stl"), top = path.join(directory, "top.stl"), side = path.join(directory, "side.stl");
  fs.writeFileSync(base, boxStl([-10, -10, 5], [10, 10, 15]));
  fs.writeFileSync(top, boxStl([-5, -5, 15], [5, 5, 20]));
  fs.writeFileSync(side, boxStl([10, -2.5, 5], [12.25, 2.5, 7.5]));
  return { directory, base, top, side };
}

async function readModel(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return { model: await zip.file("3D/3dmodel.model").async("string"), settings: await zip.file("Metadata/model_settings.config").async("string"), names: Object.keys(zip.files) };
}

test("counterpart_make_3mf writes one assembly with one part per STL and each part's filament", async t => {
  const f = parts(t);
  const out = path.join(f.directory, "assembly.3mf");
  const result = await makeCounterpart3mf({ out_path: out, parts: [{ stl_path: f.base, name: "Body" }, { stl_path: f.top, name: "Lid & <cap>" }, { stl_path: f.side, name: "Tab", filament: 2 }] });
  validate(MAKE_3MF_OUTPUT_SCHEMA, result);
  assert.deepEqual(result, { contract: "counterpart/1", path: fs.realpathSync(out), objects: 1, filaments: 2, parts: [
    { name: "Body", stl_path: f.base, filament: 1, triangles: 12 }, { name: "Lid & <cap>", stl_path: f.top, filament: 2, triangles: 12 }, { name: "Tab", stl_path: f.side, filament: 2, triangles: 12 }] });
  const { model, settings, names } = await readModel(out);
  assert.deepEqual(names.filter(name => !name.endsWith("/")).sort(), ["3D/3dmodel.model", "Metadata/model_settings.config", "[Content_Types].xml", "_rels/.rels"]);
  // Object count: three mesh parts, one assembly referencing them, one build item.
  assert.equal((model.match(/<mesh>/g) ?? []).length, 3);
  assert.equal((model.match(/<component objectid="\d+"\/>/g) ?? []).length, 3);
  assert.equal((model.match(/<item /g) ?? []).length, 1);
  assert.match(model, /<object id="4" type="model">\s*<components>/);
  assert.match(model, /<item objectid="4" /);
  // Meshes are indexed: eight shared vertices per box, never a triangle soup.
  assert.equal((model.match(/<vertex /g) ?? []).length, 24);
  assert.equal((settings.match(/<part id="\d" subtype="normal_part">/g) ?? []).length, 3);
  assert.deepEqual([...settings.matchAll(/<part id="(\d)"[\s\S]*?key="name" value="([^"]*)"[\s\S]*?key="extruder" value="(\d+)"/g)].map(match => match.slice(1)),
    [["1", "Body", "1"], ["2", "Lid &amp; &lt;cap&gt;", "2"], ["3", "Tab", "2"]]);
});

test("counterpart_make_3mf keeps parts' relative positions with one shared plate transform", async t => {
  const f = parts(t);
  const out = path.join(f.directory, "assembly.3mf");
  await makeCounterpart3mf({ out_path: out, parts: [{ stl_path: f.base, name: "Body" }, { stl_path: f.side, name: "Tab" }] });
  const { model } = await readModel(out);
  // Exact source coordinates, including a non-integer one.
  assert.match(model, /<vertex x="12\.25" y="-2\.5" z="7\.5"\/>/);
  assert.match(model, /<vertex x="-10" y="-10" z="5"\/>/);
  // Footprint x -10..12.25 and y -10..10 centred on the default 256 mm plate; the lowest point (z 5) on the bed.
  const transform = /<item objectid="3" transform="([^"]+)"/.exec(model)[1].split(" ").map(Number);
  assert.deepEqual(transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, 128 - 1.125, 128, -5]);
});

test("counterpart_make_3mf refuses overwrites, missing directories, bad parts and unknown arguments", async t => {
  const f = parts(t);
  const existing = path.join(f.directory, "existing.3mf");
  fs.writeFileSync(existing, "keep");
  const part = { stl_path: f.base, name: "Body" };
  await assert.rejects(makeCounterpart3mf({ out_path: existing, parts: [part] }), /already exists/);
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "missing", "a.3mf"), parts: [part] }), /parent directory/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.stl"), parts: [part] }), /\.3mf/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [] }), /1 to 64/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ ...part, filament: 0 }] }), /filament/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ ...part, colour: "red" }] }), /accepts only/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: f.base }] }), /name/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [part], arrange: true }), /accepts only/);
  const broken = path.join(f.directory, "broken.stl");
  fs.writeFileSync(broken, Buffer.alloc(84));
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: broken, name: "Broken" }] }), /no valid finite triangle mesh/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: path.join(f.directory, "none.stl"), name: "None" }] }), /does not exist/);
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith(".3mf")).sort(), ["existing.3mf"], "nothing is left behind");
});

async function server(t, env = {}, files = {}) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "counterpart-mcp-"));
  for (const [name, { text, mode }] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text, { mode });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_PRINTER_MODEL: "", PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_HOST: "",
      BAMBU_SERIAL: "01PTESTSERIAL", BAMBU_PRINTER_SERIAL: "", BAMBU_TOKEN: "printer-secret-never-returned", ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "counterpart-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  // Listing caches each outputSchema, so callTool below validates structuredContent like the companion does.
  const { tools } = await client.listTools();
  return { client, tools, directory };
}

test("counterpart tools declare outputSchemas and return structuredContent with the same JSON as text", async t => {
  const { client, tools } = await server(t, { MCP_HTTP_JSON_RESPONSE: "0" });
  for (const [name, schema] of [["counterpart_printer_info", PRINTER_INFO_OUTPUT_SCHEMA], ["counterpart_print_progress", PRINT_PROGRESS_OUTPUT_SCHEMA], ["counterpart_make_3mf", MAKE_3MF_OUTPUT_SCHEMA]]) {
    assert.deepEqual(tools.find(tool => tool.name === name)?.outputSchema, JSON.parse(JSON.stringify(schema)), name);
  }
  const slice = tools.find(tool => tool.name === "slice_stl").inputSchema.properties;
  assert.deepEqual([slice.layer_height.type, slice.wall_loops.type, slice.sparse_infill_density.type], ["number", "integer", "string"]);
  // structuredContent is required even with JSON responses turned off.
  const info = await client.callTool({ name: "counterpart_printer_info", arguments: {} });
  assert.equal(info.isError, undefined);
  assert.deepEqual(JSON.parse(info.content[0].text), info.structuredContent);
  assert.equal(info.structuredContent.printer.model, "P1S");
  assert.equal(info.structuredContent.printer.serial, "01PTESTSERIAL");
  assert.equal(info.structuredContent.server.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.doesNotMatch(info.content[0].text, /printer-secret/);
});

const NO_BRIDGE = { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, FULU_BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_BRIDGE_COMMAND: undefined };
const ROUTE_ENV = { ...NO_BRIDGE, BAMBU_DEFAULT_CONNECTION_MODE: undefined, BAMBU_DEFAULT_CONNECTION_TYPE: undefined };
const WITH_BRIDGE = { ...ROUTE_ENV, BAMBU_NETWORK_BRIDGE_COMMAND: "/usr/bin/true" };
const route = async (client, args = {}) => JSON.parse((await client.callTool({ name: "counterpart_print_route", arguments: args })).content[0].text);

test("counterpart_print_route reads the route and changes it in the running server and its .env", async t => {
  const dotenv = "# printer\nBAMBU_SERIAL=01PTESTSERIAL\nBAMBU_DEFAULT_CONNECTION_MODE=bambu_network\nBAMBU_DEFAULT_CONNECTION_TYPE=lan\nBAMBU_REQUIRE_X=1\n";
  const { client, directory } = await server(t, WITH_BRIDGE, { ".env": { text: dotenv, mode: 0o600 } });
  const read = await route(client);
  assert.deepEqual([read.route, read.mode, read.type, read.savedTo], ["lan", "bambu_network", "lan", null]);
  assert.deepEqual(read.choices, ["lan", "cloud", "developer"]);
  assert.deepEqual(read.options.map(option => [option.id, option.label, option.available]),
    [["lan", "Local network", true], ["cloud", "Bambu Cloud", true], ["developer", "Local network, Developer Mode", true]]);
  assert.match(read.options[0].controls, /authenticated connection.*Pause, Resume and Stop/);
  assert.match(read.options[2].controls, /Developer Mode/);

  const cloud = await route(client, { route: "cloud" });
  assert.deepEqual([cloud.route, cloud.mode, cloud.type], ["cloud", "bambu_network", "cloud"]);
  const file = path.join(fs.realpathSync(directory), ".env");
  assert.equal(fs.realpathSync(cloud.savedTo), file);
  assert.equal(fs.readFileSync(file, "utf8"), dotenv.replace("CONNECTION_TYPE=lan", "CONNECTION_TYPE=cloud"), "only the route line changes");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file keeps its permissions");
  assert.equal((await route(client)).route, "cloud", "the running server uses the new route");

  // Developer Mode is the direct LAN route; choosing the local network again goes back through FULU.
  const developer = await route(client, { route: "developer" });
  assert.deepEqual([developer.route, developer.mode, developer.type], ["developer", "lan_mqtt_ftps", "lan"]);
  assert.match(fs.readFileSync(file, "utf8"), /BAMBU_DEFAULT_CONNECTION_MODE=lan_mqtt_ftps\nBAMBU_DEFAULT_CONNECTION_TYPE=lan/);
  assert.deepEqual([(await route(client, { route: "lan" })).mode, (await route(client)).type], ["bambu_network", "lan"]);
  assert.equal(fs.readFileSync(file, "utf8"), dotenv);
});

test("counterpart_print_route without FULU's bridge: only Developer Mode can be chosen, and no .env is created", async t => {
  const { client, directory } = await server(t, { ...ROUTE_ENV, BAMBU_DEFAULT_CONNECTION_MODE: "lan_mqtt_ftps" });
  const read = await route(client);
  assert.deepEqual([read.route, read.mode], ["developer", "lan_mqtt_ftps"]);
  assert.deepEqual(read.choices, ["developer"]);
  assert.match(read.options.find(option => option.id === "cloud").reason, /BAMBU_NETWORK_BRIDGE_COMMAND/);
  for (const unavailable of ["cloud", "lan"]) {
    const refused = await client.callTool({ name: "counterpart_print_route", arguments: { route: unavailable } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /isn't available here.*BAMBU_NETWORK_BRIDGE_COMMAND/);
  }
  assert.equal((await route(client)).mode, "lan_mqtt_ftps", "a refused change keeps the route");
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  const refused = await client.callTool({ name: "counterpart_print_route", arguments: { route: "wifi" } });
  assert.equal(refused.isError, true);
});

test("counterpart_print_route keeps an X2D native setup as its local network", async t => {
  const { client } = await server(t, { ...ROUTE_ENV, BAMBU_MODEL: "x2d", BAMBU_DEFAULT_CONNECTION_MODE: "bambu_native" });
  const read = await route(client);
  assert.deepEqual([read.route, read.mode], ["lan", "bambu_native"]);
  assert.deepEqual(read.choices, ["lan", "developer"]);
  assert.equal((await route(client, { route: "lan" })).mode, "bambu_native");
});

test("an X2D on its implicit native route can choose the local network, and comes back to native after Developer Mode", async t => {
  // Codex review on #99: the route tool used to pass the unresolved defaults, and Developer Mode overwrote native.
  for (const env of [{ ...ROUTE_ENV, BAMBU_MODEL: "x2d" }, { ...WITH_BRIDGE, BAMBU_MODEL: "x2d", BAMBU_DEFAULT_CONNECTION_MODE: "bambu_native" }]) {
    const { client } = await server(t, env);
    const read = await route(client);
    assert.deepEqual([read.route, read.mode], ["lan", "bambu_native"]);
    assert.equal((await route(client, { route: "lan" })).mode, "bambu_native");
    assert.equal((await route(client, { route: "developer" })).mode, "lan_mqtt_ftps");
    assert.ok((await route(client)).choices.includes("lan"), "the native local route is still offered");
    assert.equal((await route(client, { route: "lan" })).mode, "bambu_native", "and choosing it returns to native");
  }
});

test("counterpart errors are text only, so an MCP client's outputSchema check cannot hide them", async t => {
  const { client, directory } = await server(t);
  const result = await client.callTool({ name: "counterpart_make_3mf", arguments: { out_path: path.join(directory, "missing", "a.3mf"), parts: [{ stl_path: "x.stl", name: "x" }] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /parent directory/);
  // Other tools keep their structured error for existing clients.
  const other = await client.callTool({ name: "lay_flat", arguments: {} });
  assert.equal(other.isError, true);
  assert.equal(other.structuredContent.status, "error");
});

test("lay_flat returns the STL path as its only text and says in structuredContent that it laid the model flat", async t => {
  const { client, directory } = await server(t);
  const input = path.join(directory, "standing.stl");
  fs.writeFileSync(input, boxStl([0, 0, 0], [2, 20, 30]));
  const result = await client.callTool({ name: "lay_flat", arguments: { stl_path: input } });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, result.structuredContent.path);
  assert.equal(result.structuredContent.laid_flat, true);
  assert.notEqual(result.structuredContent.path, input);
  assert.match(result.structuredContent.message, /600\.0 mm² of bed contact/);
});

test("counterpart_print_progress reports an unreachable printer as offline within its bound", { timeout: 30_000 }, async t => {
  // Nothing listens on port 8883 here; the MQTT client keeps retrying, which must not hold the call.
  const { client } = await server(t);
  const started = Date.now();
  const result = await client.callTool({ name: "counterpart_print_progress", arguments: {} }, undefined, { timeout: 20_000 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, "offline");
  assert.deepEqual(result.structuredContent.problems, []);
  assert.ok(Date.now() - started < 15_000, "bounded");
});

test("an AMS-HT tray is addressed by its unit id, as Bambu Studio's V1 parser does", () => {
  const ams = { tray_now: "128", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }, { id: "128", tray: [{ id: "0", tray_type: "PETG-HF", tray_color: "112233FF" }] }] };
  assert.deepEqual(progress({ gcode_state: "RUNNING", ams }).activeFilament, { slot: "128", material: "PETG-HF", color: "#112233" });
});

test("V2 reports take the active extruder's packed temperature and loaded filament, with the legacy fallback", () => {
  const pack = (low, high) => (high * 65536) + low;
  const ams = { tray_now: "255", ams: [{ id: "0", tray: [{ id: "0" }, { id: "1", tray_type: "PLA", tray_color: "FF0000FF" }] }, { id: "1", tray: [{ id: "0" }, { id: "1" }, { id: "2", tray_type: "ABS", tray_color: "0000FFFF" }] }] };
  const vir_slot = [{ id: "255", tray_type: "PLA", tray_color: "FFFFFFFF" }, { id: "254", tray_type: "PETG", tray_color: "00FF00FF" }];
  const report = (current, snows) => ({
    gcode_state: "RUNNING", nozzle_temper: 99, nozzle_target_temper: 99, ams, vir_slot,
    device: { extruder: { state: 2 | (current << 4), info: [{ id: 0, temp: pack(212, 220), snow: snows[0] }, { id: 1, temp: pack(25, 0), snow: snows[1] }] } },
  });
  // Right (main) nozzle 0 printing from AMS 1 slot 2.
  const right = progress(report(0, [(1 << 8) | 2, 0xffff]), { serial: "094TEST", model: "h2d" });
  assert.deepEqual(right.temps.nozzle, { actual: 212, target: 220 });
  assert.deepEqual(right.activeFilament, { slot: "6", material: "ABS", color: "#0000FF" });
  // Left (deputy) nozzle 1 on its external spool.
  const left = progress(report(1, [(0 << 8) | 1, (254 << 8) | 0]), { serial: "094TEST", model: "h2d" });
  assert.deepEqual(left.temps.nozzle, { actual: 25, target: 0 });
  assert.deepEqual(left.activeFilament, { slot: "254", material: "PETG", color: "#00FF00" });
  // Nothing loaded on the active nozzle.
  assert.equal(progress(report(1, [(0 << 8) | 1, 0xffff]), { serial: "094TEST", model: "h2d" }).activeFilament, undefined);
  // A single-nozzle V2 printer's external spool is "ext"; dual-nozzle X2D names the nozzle's slot.
  assert.deepEqual(progress({ ...report(0, [(255 << 8) | 0]), vir_slot: [{ id: "254", tray_type: "TPU" }] }, { serial: "093TEST", model: "h2s" }).activeFilament, { slot: "ext", material: "TPU" });
  assert.deepEqual(progress(report(0, [(255 << 8) | 0]), { serial: "20PTEST", model: "x2d" }).activeFilament, { slot: "255", material: "PLA", color: "#FFFFFF" });
  // Without device.extruder, the legacy fields are used.
  assert.deepEqual(progress({ gcode_state: "RUNNING", nozzle_temper: 205, nozzle_target_temper: 210, ams: { ...ams, tray_now: "1" } }).temps.nozzle, { actual: 205, target: 210 });
});

test("an HMS or print_error code missing from the bundled tables uses the user's own Bambu Studio download, by serial prefix", (t) => {
  // Bambu Studio keeps its downloaded tables in an hms folder next to BambuStudio.conf. Fixture text, not Bambu's.
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "studio-hms-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "hms"));
  const table = (hms, errors) => JSON.stringify({ data: { device_hms: { en: hms, ver: 1 }, device_error: { en: errors, ver: 1 } }, result: 0, ver: 1 });
  fs.writeFileSync(path.join(directory, "hms", "hms_en_01P.json"), table([{ ecode: "03000D0000020001", intro: "Fixture P1S heatbed text" }], [{ ecode: "0E010001", intro: "Fixture P1S error text" }]));
  fs.writeFileSync(path.join(directory, "hms", "hms_en.json"), table([{ ecode: "0C00FFFF0001FFFE", intro: "Fixture generic text" }, { ecode: "03000D0000020001", intro: "Generic text that the prefix table overrides" }], []));
  const raw = { gcode_state: "FAILED", print_error: 0x0e010001, hms: [{ attr: 0x03000d00, code: 0x00020001 }, { attr: 0x0c00ffff, code: 0x0001fffe }] };
  const previous = process.env.BAMBU_STUDIO_CONFIG;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_STUDIO_CONFIG; else process.env.BAMBU_STUDIO_CONFIG = previous; });

  process.env.BAMBU_STUDIO_CONFIG = path.join(directory, "BambuStudio.conf");
  const messages = Object.fromEntries(progress(raw).problems.map((problem) => [problem.code, problem.message]));
  assert.deepEqual(messages, {
    "0E010001": "Fixture P1S error text",
    "0300_0D00_0002_0001": "Fixture P1S heatbed text",
    "0C00_FFFF_0001_FFFE": "Fixture generic text",
  });
  // Another printer's serial skips the P1S table and uses only hms_en.json.
  const x1 = Object.fromEntries(progress(raw, { serial: "00MTEST", model: "x1c" }).problems.map((problem) => [problem.code, problem.message]));
  assert.equal(x1["0300_0D00_0002_0001"], "Generic text that the prefix table overrides");
  assert.match(x1["0E010001"], /has no description/);

  process.env.BAMBU_STUDIO_CONFIG = "";
  assert.match(progress(raw).problems.find((problem) => problem.code === "0300_0D00_0002_0001").message, /has no description/);
});
