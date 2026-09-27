import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client as FTPClient } from "basic-ftp";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import JSZip from "jszip";
import { BambuImplementation } from "../dist/printers/bambu.js";

const credentials = ["127.0.0.1", "01PTESTUPLOAD", "DUMMY"];
const code = (commands = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", model = "p1s") =>
  `; printer_model = ${model}\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament_colour = #FFFFFF\n${commands}`;

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-upload-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function artifact(t, contents = code(), name = "job.gcode") {
  const file = path.join(await directory(t), name);
  await fs.writeFile(file, contents);
  return file;
}

async function project(t, plates) {
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: "p1s", nozzle_diameter: ["0.4"], filament_type: ["PLA"] }));
  for (const [number, gcode] of plates) {
    zip.file(`Metadata/plate_${number}.gcode`, gcode);
    zip.file(`Metadata/plate_${number}.json`, JSON.stringify({ filament_ids: [0] }));
  }
  return artifact(t, await zip.generateAsync({ type: "nodebuffer" }), "job.3mf");
}

function capturedUpload(raw = {}) {
  const printer = new BambuImplementation(async () => true);
  const uploads = [];
  printer.ftpUpload = async (_host, _token, file, remote) => uploads.push({ file, remote, bytes: await fs.readFile(file) });
  printer.getPrinter = async () => { throw new Error("Upload-only must not issue MQTT mutations"); };
  printer.getSafetyStatus = async () => {
    const now = Date.now();
    return { connected: true, model: "p1s", serial: credentials[1], status: "RUNNING",
      raw: { model: "p1s", gcode_state: "RUNNING", nozzle_diameter: "0.4", print_error: 0, hms: [], ...raw },
      observation: { source: "mqtt", requestedAt: now, receivedAt: now, identitySource: "report" } };
  };
  return { printer, uploads };
}

for (const [description, report] of [
  ["a different live printer model", { model: "h2s" }],
  ["a different live nozzle", { nozzle_diameter: "0.6" }],
  ["an active printer error", { print_error: 1234 }],
]) {
  test(`upload-only refuses ${description} before FTP`, async t => {
    const file = await artifact(t);
    const { printer, uploads } = capturedUpload(report);
    await assert.rejects(printer.uploadFile(...credentials, file, "job.gcode", false, "p1s"), /model|nozzle|error/i);
    assert.deepEqual(uploads, []);
  });
}

test("upload-only checks identity without requiring future AMS slot selection", async t => {
  const file = await project(t, [[1, code()]]);
  const { printer, uploads } = capturedUpload({ ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "ABS" }] }] }, vt_tray: { tray_type: "ABS" } });
  const result = await printer.uploadFile(...credentials, file, "job.3mf", false, "p1s");
  assert.equal(result.inspected, true);
  assert.equal(result.printRequested, false);
  assert.equal(uploads.length, 1);
});

for (const [name, contents, model] of [
  ["PLA at 400 C", code("M104 S400\n"), "p1s"],
  ["bed at 300 C", code("M140 S300\n"), "p1s"],
  ["a nonfinite nozzle target", code("M104 SNaN\n"), "p1s"],
  ["a job for a different model", code("M104 S220\n", "h2s"), "p1s"],
  ["a missing declared printer model", code(), undefined],
]) {
  test(`upload without printing rejects ${name} before FTP`, async t => {
    const file = await artifact(t, contents);
    const { printer, uploads } = capturedUpload();
    await assert.rejects(printer.uploadFile(...credentials, file, "job.gcode", false, model), /temperature|finite|model|limit/i);
    assert.deepEqual(uploads, []);
  });
}

test("upload-only 3MF inspects every printable plate", async t => {
  const file = await project(t, [[1, code()], [2, code("M104 S400\n")]]);
  const { printer, uploads } = capturedUpload();
  await assert.rejects(printer.uploadFile(...credentials, file, "job.3mf", false, "p1s"), /temperature|limit/i);
  assert.deepEqual(uploads, [], "an unsafe non-default plate must stop the whole upload");
});

test("upload-only refuses an unsliced 3MF", async t => {
  const file = await project(t, []);
  const { printer, uploads } = capturedUpload();
  await assert.rejects(printer.uploadFile(...credentials, file, "job.3mf", false, "p1s"), /slice|plate|printable/i);
  assert.deepEqual(uploads, []);
});

test("upload-only cannot bypass inspection by mismatching printable extensions", async t => {
  const file = await artifact(t, code("M104 S400\n"), "opaque.bin");
  const { printer, uploads } = capturedUpload();
  await assert.rejects(printer.uploadFile(...credentials, file, "job.gcode", false, "p1s"), /extension|format|gcode|printable/i);
  assert.deepEqual(uploads, []);
});

for (const type of ["gcode", "3mf", "txt"]) {
  test(`safe ${type} upload uses a unique remote name and private copy`, async t => {
    const file = type === "3mf" ? await project(t, [[1, code()], [3, code()]]) : await artifact(t, type === "gcode" ? code() : "non-printing text", `job.${type}`);
    const expected = await fs.readFile(file);
    const { printer, uploads } = capturedUpload();
    const first = await printer.uploadFile(...credentials, file, `job.${type}`, false, type === "txt" ? undefined : "p1s");
    const second = await printer.uploadFile(...credentials, file, first.remotePath, false, type === "txt" ? undefined : "p1s");
    assert.equal(first.status, "success");
    assert.equal(first.printRequested, false);
    assert.match(first.remotePath, new RegExp(`^cache/checked-[a-f0-9-]+-job\\.${type}$`));
    assert.notEqual(second.remotePath, first.remotePath, "even a caller-supplied checked filename must not overwrite an earlier job");
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].remote, `/${first.remotePath}`);
    assert.notEqual(uploads[0].file, file);
    assert.deepEqual(uploads[0].bytes, expected);
  });
}

function fakeFtp(t, entries, listError) {
  const events = [];
  t.mock.method(FTPClient.prototype, "access", async () => { events.push({ action: "access" }); });
  t.mock.method(FTPClient.prototype, "list", async remote => {
    events.push({ action: "list", remote });
    if (listError) throw listError;
    return entries;
  });
  t.mock.method(FTPClient.prototype, "uploadFrom", async (stream, remote) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    events.push({ action: "upload", remote, bytes: Buffer.concat(chunks) });
  });
  const printer = new BambuImplementation();
  printer.waitForTlsSession = async () => {};
  return { printer, events };
}

test("FTP refuses an existing destination without issuing STOR", async t => {
  const file = await artifact(t);
  const { printer, events } = fakeFtp(t, [{ name: "CURRENT.GCODE" }]);
  await assert.rejects(printer.ftpUpload(credentials[0], credentials[2], file, "/cache/current.gcode"), /exist|overwrite/i);
  assert.equal(events.some(event => event.action === "upload"), false);
});

test("FTP fails closed when destination listing cannot establish absence", async t => {
  const file = await artifact(t);
  const { printer, events } = fakeFtp(t, [], new Error("directory unavailable"));
  await assert.rejects(printer.ftpUpload(credentials[0], credentials[2], file, "/cache/checked-new.gcode"), /directory unavailable/);
  assert.equal(events.some(event => event.action === "upload"), false);
});

test("FTP retains the exact checked path after confirming it is unused", async t => {
  const file = await artifact(t);
  const { printer, events } = fakeFtp(t, [{ name: "other.gcode" }]);
  await printer.ftpUpload(credentials[0], credentials[2], file, "/cache/checked-new.gcode");
  assert.deepEqual(events.map(event => event.action), ["access", "list", "upload"]);
  assert.equal(events[1].remote, "/cache");
  assert.equal(events[2].remote, "/cache/checked-new.gcode");
  assert.deepEqual(events[2].bytes, await fs.readFile(file));
});

for (const tool of ["upload_file", "upload_gcode"]) {
  test(`${tool} inspects uploads without printing through the public handler`, async t => {
    const dir = await directory(t);
    const log = path.join(dir, "uploads.jsonl");
    const preload = path.join(dir, "boundaries.mjs");
    await fs.writeFile(preload, `
      import fs from 'node:fs';
      import {BambuImplementation} from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
      BambuImplementation.prototype.ftpUpload=async (_host,_token,file,remote)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({remote,bytes:fs.readFileSync(file,'utf8')})+'\\n');
      BambuImplementation.prototype.getPrinter=async()=>{throw new Error('Upload-only must not dispatch MQTT mutations');};
      BambuImplementation.prototype.getSafetyStatus=async()=>{
        const now=Date.now();return {connected:true,model:'p1s',serial:'01PTESTUPLOAD',status:'RUNNING',
          raw:{model:'p1s',gcode_state:'RUNNING',nozzle_diameter:'0.4',print_error:0,hms:[]},
          observation:{source:'mqtt',requestedAt:now,receivedAt:now,identitySource:'report'}};
      };
    `);
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: dir, stderr: "pipe", env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_PRINTER_HOST: credentials[0], BAMBU_PRINTER_SERIAL: credentials[1], BAMBU_PRINTER_ACCESS_TOKEN: credentials[2],
    } });
    const client = new MCPClient({ name: "upload-safety", version: "1" });
    t.after(() => client.close());
    await client.connect(transport);
    for (const unsafe of [true, false]) {
      const contents = code(unsafe ? "M104 S400\n" : undefined);
      const file = await artifact(t, contents);
      const result = await client.callTool({ name: tool, arguments: {
        filename: "existing.gcode", bambu_model: "p1s",
        ...(tool === "upload_file" ? { file_path: file, print: false } : { gcode: contents }),
      } });
      if (unsafe) {
        assert.equal(result.isError, true);
        assert.match(result.content?.[0]?.text ?? "", /temperature|limit/i);
        await assert.rejects(fs.access(log), { code: "ENOENT" });
      } else {
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        const response = result.structuredContent ?? JSON.parse(result.content[0].text);
        assert.equal(response.inspected, true);
        assert.equal(response.printRequested, false);
        assert.match(response.remotePath, /^cache\/checked-[a-f0-9-]+-existing\.gcode$/);
        const upload = JSON.parse((await fs.readFile(log, "utf8")).trim());
        assert.equal(upload.remote, `/${response.remotePath}`);
        assert.equal(upload.bytes, contents);
      }
    }
  });
}
