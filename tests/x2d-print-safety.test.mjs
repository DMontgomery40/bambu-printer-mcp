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

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const unsupportedX2D = /X2D direct printing is not supported.*native eMMC/i;

async function fixture(t, sliced = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-x2d-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, sliced ? "cube.gcode.3mf" : "cube.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  if (sliced) {
    zip.file("Metadata/plate_1.gcode", "; filament_colour = #FFFFFF\nG1 X0 Y0\n");
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
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitations += 1;
    return { action: "accept", content: { bambu_model: "x2d" } };
  });
  t.after(() => transport.close());
  await client.connect(transport);

  const requests = [
    ["print_3mf", { three_mf_path: file, auto_match_ams: true }],
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
    assert.equal(call.payload.params.filename, slicedFile);
  }
  assert.equal(await fs.readFile(effectsFile, "utf8"), "", "bridge routing must not use the direct printer transport");
});
