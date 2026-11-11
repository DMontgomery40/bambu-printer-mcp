import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BambuImplementation, checkedFile } from "../dist/printers/bambu.js";
import { FlightRecords, flightKey } from "../dist/counterpart/flight-record.js";
const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const hash = "b".repeat(64);
const file = {
  sha256: hash,
  model: "p1s",
  materials: ["PLA"],
  maxNozzleTemperature: 220,
  maxBedTemperature: 55,
  maxChamberTemperature: 0,
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("checked-dispatch hook captures existing report callbacks independently of the resume lifecycle", (t) => {
  const dir = fixture(t);
  const bambu = new BambuImplementation();
  Object.defineProperty(bambu, "flightRecords", {
    value: new FlightRecords({ dir }),
  });
  bambu.getPrinter = () => {
    throw Error("no network allowed");
  };
  bambu.recordCheckedJob(
    "fixture",
    "01PFIXTURE",
    "cache/checked-shaft.3mf",
    {
      model: "p1s",
      nozzleDiameters: [0.4],
      materials: ["PLA"],
      useAMS: true,
      amsMapping: [0],
    },
    file,
  );
  for (const [state, layer] of [
    ["RUNNING", 2],
    ["RUNNING", 40],
    ["FINISH", 100],
  ])
    bambu.observeReport("fixture", "01PFIXTURE", {
      subtask_name: "checked-shaft",
      gcode_state: state,
      layer_num: layer,
      total_layer_num: 100,
      print_error: 0,
      hms: [],
    });
  const view = new FlightRecords({ dir }).read(
    flightKey("fixture", "01PFIXTURE"),
  );
  assert.equal(view.record.latest.gcode_state, "FINISH");
  assert.equal(view.record.reports.length, 3);
  assert.equal(view.physical.status, "unknown");
});
test("checked-file expected geometry uses only the selected plate", async (t) => {
  const dir = fixture(t),
    source = path.join(dir, "fixture.3mf"),
    zip = new JSZip();
  zip.file(
    "Metadata/plate_1.gcode",
    "M83\n; Z_HEIGHT: 10\nG1 X1 Y1\nG1 X2 Y2 E1",
  );
  zip.file(
    "Metadata/plate_2.gcode",
    "M83\n; Z_HEIGHT: 50\nG1 X1 Y1\nG1 X2 Y2 E1",
  );
  fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));
  const inspected = {
    ...file,
    nozzleDiameters: [0.4],
    usedFilamentPositions: [0],
    selectsAms: true,
    plateInternalPath: "Metadata/plate_2.gcode",
  };
  const checked = await checkedFile(inspected, source);
  assert.equal(checked.expected.heightMm, 50);
  assert.equal(checked.plate.index, 2);
});
test("public counterpart_print_record retrieves a persisted record without any network capability", async (t) => {
  const dir = fixture(t),
    log = path.join(dir, "network.log");
  const store = new FlightRecords({ dir: path.join(dir, "records") });
  store.begin(flightKey("127.0.0.1", "01PFIXTURE"), {
    sha256: hash,
    jobName: "checked-fixture.3mf",
    mapping: [0],
  });
  store.observe(flightKey("127.0.0.1", "01PFIXTURE"), {
    subtask_name: "checked-fixture",
    gcode_state: "FINISH",
    layer_num: 400,
  });
  const preload = path.join(root, "tests/fixtures/inspection-no-network.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist/index.js")],
    cwd: dir,
    stderr: "pipe",
    env: {
      HOME: dir,
      COUNTERPART_RECORD_DIR: path.join(dir, "records"),
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "01PFIXTURE",
      BAMBU_TOKEN: "fixture-token",
      BAMBU_MODEL: "p1s",
      INSPECTION_NETWORK_LOG: log,
    },
  });
  transport.stderr.on("data", () => {});
  const client = new Client(
    { name: "flight-read-test", version: "1" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "counterpart_print_record",
  );
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  const response = await client.callTool({
    name: "counterpart_print_record",
    arguments: {},
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(response.structuredContent.record.dispatch.sha256, hash);
  assert.equal(response.structuredContent.physical.status, "unknown");
  assert.equal(
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "",
    "",
  );
});
