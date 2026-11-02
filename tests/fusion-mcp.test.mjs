import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FUSION_MCP_DEFAULT_ARGS, FUSION_MCP_PIN, FusionMcpBridge } from "../dist/fusion-mcp-bridge.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests/fixtures/fusion-mcp-server.mjs");
const text = (result) => result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
const events = (logPath) => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** A TCP listener standing in for the Fusion360MCP add-in's port. */
async function addin(t) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(t, mode = "normal", overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-fusion-test-"));
  const logPath = path.join(directory, "peer.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_TOKEN: "printer-secret-do-not-forward",
      FUSION_MCP_COMMAND: process.execPath, FUSION_MCP_ARGS: JSON.stringify([fixture, mode, logPath]),
      FUSION_MCP_HOST: "127.0.0.1", FUSION_MCP_PORT: String(await closedPort()), FUSION_MCP_TIMEOUT_MS: "5000",
      ...overrides,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "fusion-bridge-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  // Listing caches each outputSchema, so callTool validates structuredContent like the companion does.
  const { tools } = await client.listTools();
  return { client, tools, directory, logPath };
}

test("Fusion tools are listed with output schemas and the pinned faust command", async (t) => {
  const { tools } = await start(t);
  for (const name of ["fusion_mcp_status", "fusion_mcp_call", "fusion_mcp_new_design", "fusion_mcp_export"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.outputSchema?.type, "object", name);
  }
  assert.equal(FUSION_MCP_PIN, "19b9f1e95192");
  assert.deepEqual(FUSION_MCP_DEFAULT_ARGS, ["--from", "git+https://github.com/faust-machines/fusion360-mcp-server@19b9f1e95192", "fusion360-mcp-server", "--mode", "socket"]);
  assert.match(tools.find((tool) => tool.name === "fusion_mcp_status").description, /19b9f1e95192/);
});

test("status without configuration reports it and starts nothing", async (t) => {
  const { client, logPath } = await start(t, "normal", { FUSION_MCP_COMMAND: "" });
  const result = await client.callTool({ name: "fusion_mcp_status", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.configured, false);
  assert.equal(result.structuredContent.connected, false);
  assert.deepEqual(result.structuredContent.tools, []);
  assert.deepEqual(events(logPath), []);
});

test("status is connected only when the add-in answers, and the child gets Fusion settings but no printer secrets", async (t) => {
  const port = await addin(t);
  const { client, logPath } = await start(t, "normal", { FUSION_MCP_PORT: String(port) });
  const result = await client.callTool({ name: "fusion_mcp_status", arguments: {} });
  assert.deepEqual(JSON.parse(text(result)), result.structuredContent);
  assert.equal(result.structuredContent.configured, true);
  assert.equal(result.structuredContent.addinReachable, true);
  assert.equal(result.structuredContent.fusionRunning, true);
  assert.equal(result.structuredContent.connected, true);
  assert.equal(result.structuredContent.launched, false);
  assert.ok(result.structuredContent.tools.some((tool) => tool.name === "execute_code"));
  const [spawn] = events(logPath);
  assert.equal(spawn.printerTokenPresent, false);
  assert.equal(spawn.fusionHost, "127.0.0.1");
  assert.equal(spawn.commandPresent, false, "the bridge's own command settings stay with the bridge");
});

test("status with the add-in down lists tools but is not connected and sends no ping", async (t) => {
  const { client, logPath } = await start(t);
  const result = await client.callTool({ name: "fusion_mcp_status", arguments: {} });
  assert.equal(result.structuredContent.addinReachable, false);
  assert.equal(result.structuredContent.connected, false);
  assert.ok(result.structuredContent.tools.length > 0);
  assert.deepEqual(events(logPath).filter((event) => event.event === "call"), []);
  const port = await addin(t);
  const down = await start(t, "addin-down", { FUSION_MCP_PORT: String(port) });
  assert.equal((await down.client.callTool({ name: "fusion_mcp_status", arguments: {} })).structuredContent.connected, false, "a refused ping is not connected");
});

test("calls pass Fusion's content and errors through and share one long-lived session", async (t) => {
  const { client, logPath } = await start(t);
  const first = await client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "create_sketch", arguments: { plane: "xy" } } });
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.structuredContent, {});
  assert.match(text(first), /^\*\*create_sketch\*\* OK/);
  const second = await client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "set_parameter", arguments: { name: "width", value: 41 } } });
  assert.match(text(second), /set_parameter/);
  assert.equal(events(logPath).filter((event) => event.event === "spawn").length, 1, "one process for both calls");
  // Arguments are checked against the discovered schema before anything is sent.
  const invalid = await client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "set_parameter", arguments: { name: "width" } } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.match(text(invalid), /advertised input schema/);
  const unknown = await client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "measure_everything" } });
  assert.match(text(unknown), /does not advertise measure_everything/);
  assert.equal(events(logPath).filter((event) => event.event === "call").length, 2);
  const failed = await start(t, "no-design");
  const remoteError = await failed.client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "create_sketch" } });
  assert.equal(remoteError.isError, true, "Fusion's own error is preserved");
  assert.match(text(remoteError), /NO_ACTIVE_DESIGN/);
});

test("new design opens a parametric document through execute_code", async (t) => {
  const { client, logPath } = await start(t);
  const result = await client.callTool({ name: "fusion_mcp_new_design", arguments: {} });
  assert.deepEqual(result.structuredContent, { status: "created", document: "Untitled", parametric: true });
  const [call] = events(logPath).filter((event) => event.event === "call");
  assert.equal(call.name, "execute_code");
  assert.match(call.args.code, /app\.documents\.add\(adsk\.core\.DocumentTypes\.FusionDesignDocumentType\)/);
  assert.match(call.args.code, /ParametricDesignType/);
});

test("without an open design the bridge names the add-in's bootstrap limit", async (t) => {
  const { client } = await start(t, "no-design");
  const result = await client.callTool({ name: "fusion_mcp_new_design", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(text(result), /no open design.*issue #12/s);
});

test("export writes STL, F3D and parameters into the directory and returns absolute paths", async (t) => {
  const { client, directory, logPath } = await start(t);
  const output = path.join(directory, "out");
  fs.mkdirSync(output);
  const result = await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: output, name: "bracket" } });
  assert.equal(result.isError, undefined, text(result));
  const real = fs.realpathSync(output);
  assert.deepEqual(result.structuredContent, {
    status: "exported", stl: path.join(real, "bracket.stl"), f3d: path.join(real, "bracket.f3d"), parameters: path.join(real, "bracket.parameters.json"),
    body: "Bracket", triangles: 1, bytes: 134, parameterCount: 1,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.structuredContent.parameters, "utf8")).parameters[0], { name: "width", value: 4, expression: "40 mm", unit: "mm", comment: "it's \"wide\"\nreally" });
  assert.deepEqual(fs.readdirSync(output).sort(), ["bracket.f3d", "bracket.parameters.json", "bracket.stl"], "no staged files are left");
  assert.deepEqual(events(logPath).filter((event) => event.event === "call").map((event) => event.name), ["execute_code", "export_stl", "export_f3d", "execute_code"]);
  const again = await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: output, name: "bracket" } });
  assert.match(text(again), /already exists/);
  for (const name of ["../escape", ".hidden", "a/b"]) {
    assert.match(text(await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: output, name } })), /plain file name/, name);
  }
  assert.match(text(await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: path.join(directory, "missing"), name: "x" } })), /existing directory/);
});

test("export needs body_name when the design has several bodies", async (t) => {
  const { client, directory } = await start(t, "multi-body");
  const result = await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: directory, name: "assembly" } });
  assert.match(text(result), /2 bodies \(Bracket, Insert\); pass body_name/);
  const chosen = await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: directory, name: "insert", body_name: "Insert" } });
  assert.equal(chosen.structuredContent.body, "Insert");
});

test("an export Fusion wrote somewhere else publishes nothing", async (t) => {
  const { client, directory } = await start(t, "export-elsewhere");
  const result = await client.callTool({ name: "fusion_mcp_export", arguments: { output_dir: directory, name: "bracket" } });
  assert.match(text(result), /share the filesystem/);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => !name.endsWith(".jsonl")), []);
});

test("a timed-out call is reported as possibly running, never replayed, and the next call reconnects", async (t) => {
  const { client, logPath } = await start(t, "call-timeout");
  // Connect first, so the short deadline below can only expire on the tool request, however slow spawning is.
  assert.equal((await client.callTool({ name: "fusion_mcp_status", arguments: {} })).structuredContent.tools.length > 0, true);
  const result = await client.callTool({ name: "fusion_mcp_call", arguments: { tool_name: "create_sketch", timeout_ms: 1000 } });
  assert.equal(result.isError, true);
  assert.match(text(result), /may still be running.*not replayed/s);
  assert.equal((await client.callTool({ name: "fusion_mcp_status", arguments: {} })).structuredContent.tools.length > 0, true);
  const log = events(logPath);
  assert.equal(log.filter((event) => event.event === "call").length, 1, "the cut-off request was not replayed");
  assert.equal(log.filter((event) => event.event === "spawn").length, 2, "the cut-off session was closed and a new one started");
});

function fakeSystem(overrides = {}) {
  const calls = { launch: 0, probes: 0 };
  let open = false;
  const system = {
    platform: "darwin", launchWaitMs: 5_000,
    portOpen: async () => { calls.probes++; return open; },
    fusionRunning: async () => false,
    launch: async () => { calls.launch++; setTimeout(() => { open = true; }, 30); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
    ...overrides,
  };
  return { system, calls, setOpen: (value) => { open = value; } };
}

test("launch starts Fusion when it is not running and waits for the add-in", async (t) => {
  const saved = process.env.FUSION_MCP_COMMAND;
  delete process.env.FUSION_MCP_COMMAND;
  t.after(() => { if (saved === undefined) delete process.env.FUSION_MCP_COMMAND; else process.env.FUSION_MCP_COMMAND = saved; });
  const fake = fakeSystem();
  const status = await new FusionMcpBridge(fake.system).status({ launch: true });
  assert.equal(fake.calls.launch, 1);
  assert.deepEqual([status.launched, status.fusionRunning, status.addinReachable, status.configured], [true, true, true, false]);
  // Already running: no second launch.
  const running = fakeSystem({ fusionRunning: async () => true });
  assert.equal((await new FusionMcpBridge(running.system).status({ launch: true })).launched, false);
  assert.equal(running.calls.launch, 0);
  // Without launch, nothing starts.
  const idle = fakeSystem();
  assert.equal((await new FusionMcpBridge(idle.system).status({})).launched, false);
  assert.equal(idle.calls.launch, 0);
  // A Fusion that never opens the port is reported, not waited on forever.
  const slow = fakeSystem({ launch: async () => {}, launchWaitMs: 50 });
  const late = await new FusionMcpBridge(slow.system).status({ launch: true });
  assert.deepEqual([late.launched, late.addinReachable], [true, false]);
  await assert.rejects(new FusionMcpBridge(fakeSystem({ platform: "linux" }).system).status({ launch: true }), /macOS only/);
  await assert.rejects(new FusionMcpBridge(fake.system).status({ launch: "yes" }), /boolean/);
});
