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
import { BambuImplementation } from "../dist/printers/bambu.js";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const unsupportedX2D = /X2D direct printing is not supported.*native eMMC/i;

async function fixture(t, sliced = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-x2d-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, sliced ? "cube.gcode.3mf" : "cube.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  if (sliced) {
    zip.file("Metadata/plate_1.gcode", "; printer_model = Bambu Lab X2D\n; nozzle_diameter = 0.4;0.4\n; filament_type = PLA\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\nG1 X0 Y0\n");
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  }
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return { dir, file };
}

test("X2D direct print methods reject model and serial identities before upload or connection", async (t) => {
  const { file } = await fixture(t);
  const printer = new BambuImplementation();
  const effects = [];
  printer.ftpUpload = async () => { effects.push("upload"); };
  printer.getPrinter = async () => {
    effects.push("connect");
    return { publish: async () => { effects.push("publish"); } };
  };
  for (const [model, serial] of [["x2d", "UNKNOWN"], [undefined, "20PTEST"], ["h2d", "20PTEST"]]) {
    await assert.rejects(() => printer.print3mf("127.0.0.1", serial, "DUMMY", {
      projectName: "cube", filePath: file, bambuModel: model, useAMS: true, amsSlots: [0],
    }), unsupportedX2D);
    await assert.rejects(() => printer.startJob("127.0.0.1", serial, "DUMMY", "cube.gcode", model), unsupportedX2D);
    await assert.rejects(() => printer.uploadFile("127.0.0.1", serial, "DUMMY", file, "cube.gcode", true, model), unsupportedX2D);
  }
  assert.deepEqual(effects, [], "unsupported requests must never contact the printer");
});

test("X2D MCP print requests stop before slicing, status, uploads, and connections", async (t) => {
  const { dir, file } = await fixture(t, false);
  const { file: slicedFile } = await fixture(t);
  const effectsFile = path.join(dir, "effects.jsonl");
  const bridgeFile = path.join(dir, "bridge.jsonl");
  await fs.writeFile(effectsFile, "");
  await fs.writeFile(bridgeFile, "");
  const preload = `
    import { appendFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    import { STLManipulator } from ${JSON.stringify(new URL("../dist/stl/stl-manipulator.js", import.meta.url).href)};
    import { BambuNetworkBridge } from ${JSON.stringify(new URL("../dist/bambu-network-bridge.js", import.meta.url).href)};
    for (const method of ['getPrinter', 'getStatus', 'ftpUpload']) {
      BambuImplementation.prototype[method] = async () => {
        appendFileSync(${JSON.stringify(effectsFile)}, method + '\\n');
        throw new Error('Unexpected printer side effect: ' + method);
      };
    }
    STLManipulator.prototype.sliceSTL = async () => {
      appendFileSync(${JSON.stringify(effectsFile)}, 'slice\\n');
      throw new Error('Unexpected slicing');
    };
    BambuNetworkBridge.prototype.callWithAgent = async (method, payload) => {
      appendFileSync(${JSON.stringify(bridgeFile)}, JSON.stringify({ method, payload }) + '\\n');
      return { ok: true, value: 0 };
    };
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => ({
      connected:true, serial, model:'x2d', status:'IDLE',
      raw:{model:'x2d',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:['0.4','0.4']},
      observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'}
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(ROOT, "dist/index.js")],
    cwd: dir,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "UNKNOWN", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
      BAMBU_NETWORK_BRIDGE_COMMAND: "/configured/test-only/bridge",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "x2d-print-safety", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  let elicitations = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.requestedSchema.properties.confirmed) return { action: "accept", content: { confirmed: true } };
    elicitations += 1;
    return { action: "accept", content: { bambu_model: "x2d" } };
  });
  t.after(() => transport.close());
  await client.connect(transport);

  const requests = [
    ["print_collar_charm", { source_path: file }],
    ["start_print", { filename: "cube.gcode" }],
    ["start_print_job", { filename: "cube.gcode" }],
    ["upload_file", { file_path: file, filename: "cube.gcode", print: true }],
  ];
  for (const [name, args] of requests) {
    for (const identity of [{ bambu_model: "x2d" }, { bambu_model: "h2d", bambu_serial: "20PTEST" }, {}]) {
      const result = await client.callTool({ name, arguments: { ...args, ...identity } });
      assert.equal(result.isError, true, `${name} must reject direct X2D printing`);
      assert.match(result.content?.[0]?.text || "", unsupportedX2D, `${name}: ${JSON.stringify(identity)}`);
    }
  }
  assert.equal(elicitations, requests.length, "an elicited X2D model must receive the same guard");
  assert.equal(await fs.readFile(effectsFile, "utf8"), "", "preflight must not contact printers or invoke slicing");

  for (const name of ["print_3mf", "print_3mf_bambu_network"]) {
    const result = await client.callTool({ name, arguments: {
      three_mf_path: slicedFile, bambu_model: "x2d", bambu_serial: "20PTEST", use_ams: false,
      connection_mode: "bambu_network", connection_type: "lan",
    } });
    assert.notEqual(result.isError, true, "the explicitly configured bridge retains its separate print path");
  }
  const bridgeCalls = (await fs.readFile(bridgeFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(bridgeCalls.length, 2);
  for (const call of bridgeCalls) {
    assert.equal(call.method, "net.start_local_print");
    assert.equal(call.payload.params.dev_id, "20PTEST");
    assert.notEqual(call.payload.params.filename, slicedFile, "bridge must receive a checked private snapshot");
    assert.equal(path.basename(call.payload.params.filename), path.basename(slicedFile));
  }
  assert.equal(await fs.readFile(effectsFile, "utf8"), "", "bridge routing must not use the direct printer transport");
});

// Dual external spools: 255 (right/main nozzle) and 254 (left/deputy nozzle) must reach the
// configured bridge unchanged and still pass through the fresh per-nozzle material check.
test("X2D bridge prints send tray 255 unchanged after the per-nozzle external spool check", async (t) => {
  const { dir, file: slicedFile } = await fixture(t);
  const bridgeFile = path.join(dir, "bridge.jsonl");
  const virSlotFile = path.join(dir, "vir_slot.json");
  await fs.writeFile(bridgeFile, "");
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PLA" }]));
  const preload = `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    import { BambuNetworkBridge } from ${JSON.stringify(new URL("../dist/bambu-network-bridge.js", import.meta.url).href)};
    for (const method of ['getPrinter', 'getStatus', 'ftpUpload']) {
      BambuImplementation.prototype[method] = async () => { throw new Error('Unexpected printer side effect: ' + method); };
    }
    BambuNetworkBridge.prototype.callWithAgent = async (method, payload) => {
      appendFileSync(${JSON.stringify(bridgeFile)}, JSON.stringify({ method, payload }) + '\\n');
      return { ok: true, value: 0 };
    };
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => ({
      connected:true, serial, model:'x2d', status:'IDLE',
      raw:{model:'x2d',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:['0.4','0.4'],
        device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}},
        vir_slot: JSON.parse(readFileSync(${JSON.stringify(virSlotFile)}, 'utf8'))},
      observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'}
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(ROOT, "dist/index.js")],
    cwd: dir,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "UNKNOWN", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
      BAMBU_NETWORK_BRIDGE_COMMAND: "/configured/test-only/bridge",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "x2d-dual-external", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  t.after(() => transport.close());
  await client.connect(transport);
  const print = (extra) => client.callTool({ name: "print_3mf_bambu_network", arguments: {
    three_mf_path: slicedFile, bambu_model: "x2d", bambu_serial: "20PTEST", connection_mode: "bambu_network", connection_type: "lan", ...extra,
  } });
  const bridgeCalls = async () => (await fs.readFile(bridgeFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

  for (const [index, args] of [{ ams_mapping: [255] }, { ams_slots: [255] }, { ams_mapping: [254] }].entries()) {
    const result = await print(args);
    assert.notEqual(result.isError, true, `${JSON.stringify(args)}: ${result.content?.[0]?.text}`);
    const calls = await bridgeCalls();
    assert.equal(calls.length, index + 1);
    assert.equal(calls[index].method, "net.start_local_print");
    assert.equal(calls[index].payload.params.ams_mapping, JSON.stringify(Object.values(args)[0]), "external tray ids reach the bridge unchanged");
    assert.equal(calls[index].payload.params.task_use_ams, true);
  }
  const before = (await bridgeCalls()).length;
  for (const args of [{ ams_mapping: [256] }, { ams_slots: [256] }]) {
    const result = await print(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content?.[0]?.text || "", /255/);
  }
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PETG" }]));
  const contradicted = await print({ ams_mapping: [255] });
  assert.equal(contradicted.isError, true);
  assert.match(contradicted.content?.[0]?.text || "", /PETG|material/i);
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }]));
  const missing = await print({ ams_mapping: [255] });
  assert.equal(missing.isError, true);
  assert.match(missing.content?.[0]?.text || "", /255/);
  assert.equal((await bridgeCalls()).length, before, "rejected mappings must never reach the bridge");
});
