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

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;

// Exercise platform dispatch on every CI OS. Only the OS selector and transport
// boundaries are mocked; file inspection, AMS validation and preflight are real.
async function server(t, { platform = "darwin", model = "x2d", state = "IDLE", gcode = "G1 X0 Y0\n", decline = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-native-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventsFile = path.join(dir, "events.jsonl");
  const helper = path.join(dir, "helper.mjs");
  const file = path.join(dir, "cube.3mf");
  await fs.writeFile(eventsFile, "");
  await fs.writeFile(helper, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
const e = process.env;
const event = { kind: 'helper', mode: process.argv[2], file: e.BAMBU_NATIVE_FILE,
  exists: existsSync(e.BAMBU_NATIVE_FILE || ''), config: e.BAMBU_NATIVE_CONFIG_FILE,
  destination: e.BAMBU_NATIVE_DST_FILE, useAMS: e.BAMBU_NATIVE_USE_AMS,
  mapping: e.BAMBU_NATIVE_AMS_MAPPING, mapping2: e.BAMBU_NATIVE_AMS_MAPPING2,
  command: JSON.parse(e.BAMBU_NATIVE_COMMAND_JSON || '{}') };
appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');
console.log('native_print result=0');
`, { mode: 0o755 });
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  zip.file("Metadata/plate_1.gcode", `; printer_model = Bambu Lab X2D\n; nozzle_diameter = 0.4;0.4\n; filament_type = PLA\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\n${gcode}`);
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  const preload = `
    import { appendFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(printerModule)};
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const record = kind => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({kind})+'\\n');
    BambuImplementation.prototype.getPrinter = async () => ({ publish: async () => record('mqtt') });
    BambuImplementation.prototype.ftpUpload = async () => { record('ftp'); throw new Error('unexpected FTPS'); };
    BambuImplementation.prototype.disconnectAll = async () => { record('disconnect'); };
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => {
      record('status');
      return { connected:true, serial, model:'x2d', status:${JSON.stringify(state)},
        raw: {model:'x2d',gcode_state:${JSON.stringify(state)},print_error:0,hms:[],nozzle_diameter:['0.4','0.4'],
          ams: { ams:[{id:'0',tray:[{id:'0',tray_type:'PLA'}]}, {id:'128',tray:[{id:'0',tray_type:'PLA'}]}] } },
        observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'} };
    };
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry], cwd: dir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: model, BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "20PTEST", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
      BAMBU_NATIVE_HELPER: helper, BAMBU_DEFAULT_CONNECTION_MODE: "", BAMBU_REQUIRE_CONFIRMATION: "1" }, stderr: "pipe",
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
    print: args => client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, ...args } }),
  };
}

for (const connection_mode of [undefined, "lan_mqtt_ftps", "bambu_native"]) {
  test(`elicited X2D uses native print with ${connection_mode || "default"} routing`, async t => {
    const s = await server(t, { model: "" });
    const result = await s.print({ connection_mode, ams_slots: [128] });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(s.prompts, ["model", "confirm"], "model should be resolved exactly once");
    const events = await s.events();
    assert.equal(events.filter(e => e.kind === "helper").length, 1);
    assert.equal(events.some(e => ["ftp", "mqtt"].includes(e.kind)), false);
    const call = events.find(e => e.kind === "helper");
    assert.equal(call.mode, "--print");
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
  assert.deepEqual(JSON.parse(call.mapping), [254]);
});

for (const platform of ["darwin", "linux"]) {
  test(`pause selects the correct transport on ${platform}`, async t => {
    const s = await server(t, { platform });
    const result = await s.client.callTool({ name: "pause_print", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const events = await s.events();
    assert.deepEqual(events.map(e => e.kind), [platform === "darwin" ? "helper" : "mqtt"]);
    if (platform === "darwin") assert.equal(events[0].command.print.command, "pause");
  });
}

test("Linux X2D print fails with a platform error before touching the printer", async t => {
  const s = await server(t, { platform: "linux", model: "" });
  const result = await s.print({ use_ams: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires macOS/);
  assert.deepEqual(await s.events(), []);
  assert.deepEqual(s.prompts, ["model"]);
});

for (const options of [{ state: "RUNNING" }, { gcode: "M104 S400\n" }, { decline: true }]) {
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

test("raw native controls cannot bypass checked heating, resume or error clearing", async t => {
  const s = await server(t);
  for (const command of ["set_nozzle_temp", "set_bed_temp", "resume", "clean_print_error", "gcode_file"]) {
    const result = await s.client.callTool({ name: "x2d_native_control", arguments: {
      message_json: JSON.stringify({ print: { command, temp: 220, target_temp: 220 } }),
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /dedicated checked/);
  }
  assert.equal((await s.client.callTool({ name: "resume_print", arguments: {} })).isError, true);
  assert.deepEqual(await s.events(), []);
});

test("elicited X2D heating uses native dispatch only after human preflight", async t => {
  const s = await server(t, { model: "" });
  const result = await s.client.callTool({ name: "set_temperature", arguments: { component: "bed", temperature: 50 } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(s.prompts, ["model", "confirm"]);
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
