// A stdio MCP peer shaped like faust-machines/fusion360-mcp-server at 19b9f1e95192 (the fork the bridge pins adds document binding): the same
// tool schemas and its "**tool** OK / key: value" text results. Never imports Fusion or runs code.
import fs from "node:fs";
import readline from "node:readline";

const [mode = "normal", logPath] = process.argv.slice(2);
const log = (value) => logPath && fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const ok = (id, name, fields) => send(id, { content: [{ type: "text", text: [`**${name}** OK`, ...Object.entries(fields).map(([key, value]) => `  ${key}: ${value}`)].join("\n") }] });
const error = (id, name, kind, message) => send(id, { content: [{ type: "text", text: `**${name}** ERROR (${kind})\n  ${message}` }], isError: true });
const object = (properties = {}, required) => ({ type: "object", properties, ...(required ? { required } : {}) });
const tools = [
  { name: "ping", inputSchema: object() },
  { name: "get_scene_info", inputSchema: object() },
  { name: "create_sketch", inputSchema: object({ plane: { type: "string", enum: ["xy", "yz", "xz"] } }) },
  { name: "execute_code", inputSchema: object({ code: { type: "string" } }, ["code"]) },
  { name: "export_stl", inputSchema: object({ body_name: { type: "string" }, file_path: { type: "string" } }, ["body_name"]) },
  { name: "export_f3d", inputSchema: object({ file_path: { type: "string" } }) },
  { name: "get_parameters", inputSchema: object() },
  { name: "set_parameter", inputSchema: object({ name: { type: "string" }, value: { type: "number" } }, ["name", "value"]) },
];
if (mode === "binding") {
  for (const tool of tools) tool.inputSchema.properties.document_id = {type: "string", minLength: 1};
  tools.push({name: "new_document", inputSchema: object({source_f3d: {type: "string"}})});
}
function triangleStl() {
  const stl = Buffer.alloc(134);
  stl.writeUInt32LE(1, 80);
  stl.writeFloatLE(10, 96);
  stl.writeFloatLE(10, 112);
  stl.writeFloatLE(5, 124);
  return stl;
}
log({ event: "spawn", pid: process.pid, printerTokenPresent: Boolean(process.env.BAMBU_TOKEN), fusionHost: process.env.FUSION_MCP_HOST ?? null, fusionPort: process.env.FUSION_MCP_PORT ?? null, commandPresent: Boolean(process.env.FUSION_MCP_COMMAND) });
const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (mode === "slow-start") return setTimeout(() => send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fusion360-mcp-server", version: "0.1.0" } }), 3000);
    return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fusion360-mcp-server", version: "0.1.0" } });
  }
  if (request.method === "tools/list") return send(request.id, { tools });
  if (request.method !== "tools/call") return;
  const { name, arguments: args = {} } = request.params;
  log({ event: "call", name, args });
  if (mode === "call-timeout") return;
  if (mode === "mixed-content") return send(request.id, {content: [{type: "text", text: "Visible sketch result"}, {type: "image", mimeType: "image/png", data: "aW1hZ2U="}], structuredContent: {sketch: "Sketch1"}});
  if (name === "ping") return mode === "addin-down" ? error(request.id, name, "CONNECTION", "Fusion 360 not reachable") : ok(request.id, name, { pong: "True" });
  if (mode === "no-design") return error(request.id, name, "NO_ACTIVE_DESIGN", "No active design");
  if (name === "new_document") return ok(request.id, name, {document: "Untitled", document_id: "owned-document-token", document_binding: 1, parametric: "True"});
  if (name === "execute_code") {
    const marker = /^# BAMBU_FUSION (\w+)/.exec(args.code)?.[1];
    const result = marker === "new_design" ? { document: "Untitled", parametric: true }
      // The fixture STL is a flat 10 x 10 x 0 triangle; Fusion reports centimetres. Hidden and surface bodies are never exported.
      : marker === "bodies" ? [
        { name: "Bracket", solid: true, visible: true, size_cm: mode === "cm-stl" ? [10, 10, 0] : [1, 1, 0] },
        { name: "Hidden", solid: true, visible: false, size_cm: [2, 2, 2] },
        { name: "Skin", solid: false, visible: true, size_cm: [3, 3, 0] },
        ...(mode === "multi-body" ? [{ name: "Insert", solid: true, visible: true, size_cm: [1, 1, 0.5] }] : []),
        ...(mode === "duplicate-body" ? [{ name: "Bracket", solid: true, visible: true, size_cm: [1, 1, 0] }] : []),
        ...(mode === "hidden-namesake" ? [{ name: "Bracket", solid: true, visible: false, size_cm: [4, 4, 4] }] : []),
      ]
      : marker === "parameters" ? { parameters: [{ name: "width", value: 4, expression: "40 mm", unit: "mm", comment: "it's \"wide\"\nreally" }], count: 1 }
      : "done";
    return ok(request.id, name, { executed: "True", result: typeof result === "string" ? result : JSON.stringify(result), output: "" });
  }
  if (name === "export_stl") {
    if (mode !== "export-elsewhere") fs.writeFileSync(args.file_path, triangleStl());
    return ok(request.id, name, { exported: "True", body: args.body_name, file_path: args.file_path });
  }
  if (name === "export_f3d") {
    if (mode !== "export-elsewhere") fs.writeFileSync(args.file_path, "PK\u0003\u0004 fusion archive");
    return ok(request.id, name, { exported: "True", file_path: args.file_path });
  }
  return ok(request.id, name, { done: "True" });
});
reader.on("close", () => log({ event: "closed", pid: process.pid }));
