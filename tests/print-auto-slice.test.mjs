import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failure = "Required Bambu machine profile is missing nozzle_volume_type; select a matching machine and filament profile.";

async function start(t, { sliceSucceeds = false, realSlice = false, slicerType = 'bambustudio' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-auto-slice-"));
  const log = path.join(directory, "calls.jsonl");
  const profile = path.join(directory, "process.json");
  fs.writeFileSync(profile, "{}");
  const profilesRoot = path.join(directory, 'profiles');
  fs.mkdirSync(path.join(profilesRoot, 'BBL', 'machine'), { recursive: true });
  const executable = path.join(directory, 'slicer');
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({action: 'cli'}) + '\\n');\n`, { mode: 0o755 });
  const makeProject = async (name, { sliced = false, checksumOnly = false } = {}) => {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
    if (sliced) {
      zip.file("Metadata/plate_1.gcode", "; printer_model = p1s\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament_colour = #FFFFFF\n; curr_bed_type = Textured PEI Plate\nM104 S220\nM140 S60\nG1 X0 Y0\n");
      zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: "p1s", nozzle_diameter: ["0.4"], filament_type: ["PLA"], curr_bed_type: "Textured PEI Plate" }));
      zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
    }
    if (checksumOnly) zip.file("Metadata/plate_1.gcode.md5", "12345678901234567890123456789012");
    const file = path.join(directory, name);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    return file;
  };
  const slicedOutput = await makeProject("auto-sliced.gcode.3mf", { sliced: true });
  const preload = path.join(directory, "boundaries.mjs");
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { STLManipulator } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stl/stl-manipulator.js")).href)};
import { BambuImplementation } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/printers/bambu.js")).href)};
const log = (event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
${realSlice ? '' : `STLManipulator.prototype.sliceSTL = async function (file) {
  log({ action: 'slice', file });
  ${sliceSucceeds ? `return ${JSON.stringify(slicedOutput)};` : `throw new Error(${JSON.stringify(failure)});`}
};`}
BambuImplementation.prototype.ftpUpload = async function (_host, _token, file, remote) { log({ action: 'upload', file, remote, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }); };
BambuImplementation.prototype.getPrinter = async function () {
  log({ action: 'connection' });
  return { publish: async (payload) => log({ action: 'publish', payload }) };
};
BambuImplementation.prototype.getStatus = async function () { log({ action: 'status' }); throw new Error('Unexpected printer status read'); };
BambuImplementation.prototype.getSafetyStatus = async function () {
  log({action:'safety-status'});
  const now=Date.now();
  return {connected:true,model:'p1s',status:'IDLE',serial:'TEST_SERIAL',
    raw:{model:'p1s',gcode_state:'IDLE',nozzle_diameter:'0.4',print_error:0,hms:[]},
    observation:{source:'mqtt',requestedAt:now,receivedAt:now,identitySource:'report'}};
};
`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist/index.js")],
    cwd: directory,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "TEST_SERIAL", BAMBU_SERIAL: "TEST_SERIAL", BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN", BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_CLIENT_CERT: "/nonexistent", BAMBU_CLIENT_KEY: "/nonexistent",
      BAMBU_TEMPLATE_3MF: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_SLICER_PROFILE: "", BAMBU_SLICER_TYPE: "bambustudio",
      SLICER_TYPE: slicerType, SLICER_PATH: executable, BAMBU_PROFILES_ROOT: profilesRoot, BAMBU_SLICER_PROFILE_DIRS: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "auto-slice-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  return {
    makeProject,
    slicedOutput,
    events: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    print: (file) => client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, bambu_model: "p1s", slicer_type: slicerType, slicer_profile: profile, bed_type: "textured_plate", use_ams: false } }),
    slice: (file) => client.callTool({ name: "slice_stl", arguments: { stl_path: file, bambu_model: "p1s", slicer_profile: profile, use_printer_filaments: false, bed_type: "textured_plate" } }),
  };
}

for (const slicerType of ['bambustudio', 'orcaslicer', 'orcaslicer-bambulab', 'fulu-orca', 'orca-studio']) {
  test(`${slicerType} real profile gate stops MCP slicing and auto-print before external side effects`, async t => {
    const server = await start(t, { realSlice: true, slicerType });
    const project = await server.makeProject('missing-machine.3mf');
    for (const call of [server.slice, server.print]) {
      const result = await call(project);
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text || '', /Printer profile.*Bambu Lab P1S 0\.4 nozzle.*not found/);
      assert.deepEqual(server.events(), [], 'missing machine must stop CLI launch, connection, upload, and print dispatch');
    }
  });
}

for (const checksumOnly of [false, true]) {
  test(`print_3mf preserves auto-slice errors before upload${checksumOnly ? " when only a gcode checksum is present" : ""}`, async (t) => {
    const server = await start(t);
    const project = await server.makeProject("unsliced.3mf", { checksumOnly });
    const result = await server.print(project);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.message, failure);
    assert.deepEqual(server.events(), [{ action: "slice", file: project }], "a failed slice must never upload or contact the printer");
  });
}

test("print_3mf uploads only the generated file after successful auto-slicing", async (t) => {
  const server = await start(t, { sliceSucceeds: true });
  const project = await server.makeProject("unsliced.3mf");
  const result = await server.print(project);
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const events = server.events();
  assert.deepEqual(events[0], { action: "slice", file: project });
  assert.equal(events.filter((event) => event.action === "upload").length, 1);
  const upload = events.find((event) => event.action === "upload");
  assert.notEqual(upload.file, project);
  assert.notEqual(upload.file, server.slicedOutput, "dispatch must upload a private checked copy");
  assert.equal(upload.sha256, createHash("sha256").update(fs.readFileSync(server.slicedOutput)).digest("hex"), "only generated, inspected bytes may be uploaded");
  assert.equal(events.filter((event) => event.action === "publish").length, 1);
});

for (const extension of ["3mf", "gcode.3mf"]) {
  test(`print_3mf keeps the direct already-sliced .${extension} path`, async (t) => {
    const server = await start(t);
    const project = await server.makeProject(`prepared.${extension}`, { sliced: true });
    const result = await server.print(project);
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const events = server.events();
    assert.equal(events.some((event) => event.action === "slice"), false);
    const upload = events.find((event) => event.action === "upload");
    assert.notEqual(upload.file, project, "already-sliced projects still require a private checked copy");
    assert.equal(upload.sha256, createHash("sha256").update(fs.readFileSync(project)).digest("hex"));
    assert.equal(events.filter((event) => event.action === "publish").length, 1);
  });
}
