/**
 * Autodesk Fusion through faust-machines/fusion360-mcp-server (PRD §8.9).
 *
 * MCP client (this) ─stdio─▶ fusion360-mcp-server ─TCP localhost:9877─▶ the
 * Fusion360MCP add-in ─▶ Fusion's main thread. Configured like Blender, with
 * trusted FUSION_MCP_COMMAND / FUSION_MCP_ARGS, but the stdio session is kept
 * for the life of this server, because a design pass makes many calls and each
 * new uvx process would reconnect to the add-in. A timeout, cancellation or
 * transport failure closes the session; the next call starts a new one.
 * Requests are never replayed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { stlMetadata } from "./blender-mcp-bridge.js";
import { FUSION_ADDIN_COMMIT, FUSION_ADDIN_REPOSITORY } from "./design-app-setup.js";
const execFileAsync = promisify(execFile);
/**
 * The server and add-in commit fusion_mcp_setup installs (FUSION_ADDIN_COMMIT): David Montgomery's fork of
 * faust-machines/fusion360-mcp-server with document binding, which fusion_mcp_new_design's bind_document needs, while
 * that change is reviewed upstream. Move it only after the Counterpart PRD §8.9 acceptance check passes.
 */
export const FUSION_MCP_PIN = FUSION_ADDIN_COMMIT.slice(0, 12);
/** PRD §8.9: Blender's MCP add-on holds the add-in's own default, 9876, so Counterpart's Fusion uses 9877. */
export const FUSION_ADDIN_DEFAULT_PORT = 9877;
export const FUSION_MCP_DEFAULT_ARGS = Object.freeze([
    "--from", `git+https://github.com/${FUSION_ADDIN_REPOSITORY}@${FUSION_MCP_PIN}`,
    "fusion360-mcp-server", "--mode", "socket",
]);
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 600000;
const LAUNCH_WAIT_MS = 90000;
const ADDIN_PING_MS = 2000;
const EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
/** Faust's add-in refuses every command, execute_code included, until a design is open (faust issue #12). */
const NO_DESIGN = /NO_ACTIVE_DESIGN|No active design/;
class FusionError extends Error {
}
/**
 * The add-in reads FUSION_MCP_PORT from Fusion's environment at the pin
 * (addon/Fusion360MCP.py), and an app started from the Dock gets no shell
 * environment, so the launch passes the port the bridge probes. `open --env`
 * applies only when it starts the app, which is the only time this runs.
 */
export function fusionLaunchArguments(port) {
    return ["-a", "Autodesk Fusion", "--env", `FUSION_MCP_PORT=${port}`];
}
export const defaultFusionSystem = {
    platform: process.platform,
    /**
     * An open port is not enough: Blender's MCP add-on defaults to
     * localhost:9876, the add-in's own default. The add-in speaks newline-delimited JSON
     * (addon/server/socket_server.py) and answers {"type":"ping"} without touching
     * Fusion's API: on its fast path (event_bridge.py) with
     * {"status":"success","result":{"ok":true,"status":"pong"}}, and through its
     * command handler with {"pong":true}. Blender's add-on answers an unknown command
     * with an error.
     */
    addinAnswers: (host, port, timeoutMs) => new Promise(resolve => {
        const socket = net.connect({ host, port });
        let buffer = "";
        let settled = false;
        const done = (answers) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(answers);
        };
        const deadline = setTimeout(() => done(false), timeoutMs);
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(`${JSON.stringify({ type: "ping", params: {} })}\n`));
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.length > 65536)
                return done(false);
            const newline = buffer.indexOf("\n");
            try {
                const reply = JSON.parse(newline >= 0 ? buffer.slice(0, newline) : buffer);
                done(reply?.status === "success" && (reply?.result?.status === "pong" || reply?.result?.pong === true));
            }
            catch {
                if (newline >= 0)
                    done(false);
            }
        });
        socket.once("error", () => done(false));
        socket.once("close", () => done(false));
    }),
    fusionRunning: async () => {
        if (process.platform !== "darwin")
            return false;
        try {
            await execFileAsync("pgrep", ["-f", "Autodesk Fusion[^/]*\\.app/Contents/MacOS/"], { timeout: 5000 });
            return true;
        }
        catch {
            return false;
        }
    },
    launch: async (port) => { await execFileAsync("open", fusionLaunchArguments(port), { timeout: 30000 }); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    launchWaitMs: LAUNCH_WAIT_MS,
};
function argumentObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new FusionError(`${label} must be an object.`);
    return value;
}
function allowedArguments(args, names) {
    if (Object.keys(args).some(name => !names.includes(name))) {
        throw new FusionError("Unknown Fusion argument. Executables and their arguments must be configured on the server with FUSION_MCP_COMMAND and FUSION_MCP_ARGS.");
    }
}
function textArgument(value, label) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0"))
        throw new FusionError(`${label} must be a non-empty string without NUL characters.`);
    return value;
}
function timeoutMilliseconds(value) {
    const timeout = value ?? (process.env.FUSION_MCP_TIMEOUT_MS ? Number(process.env.FUSION_MCP_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS);
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) {
        throw new FusionError(`timeout_ms / FUSION_MCP_TIMEOUT_MS must be an integer from 100 to ${MAX_TIMEOUT_MS}.`);
    }
    return timeout;
}
function configuration() {
    const command = process.env.FUSION_MCP_COMMAND?.trim();
    if (!command)
        throw new FusionError(`No Fusion MCP server configured. Set FUSION_MCP_COMMAND to uvx and FUSION_MCP_ARGS to ${JSON.stringify(FUSION_MCP_DEFAULT_ARGS)}, and run the Fusion360MCP add-in in Fusion.`);
    if (command.includes("\0"))
        throw new FusionError("FUSION_MCP_COMMAND must be an executable without NUL characters.");
    const raw = process.env.FUSION_MCP_ARGS?.trim();
    if (!raw)
        return { command, args: [...FUSION_MCP_DEFAULT_ARGS] };
    let args;
    try {
        args = JSON.parse(raw);
    }
    catch {
        throw new FusionError("FUSION_MCP_ARGS must be a JSON array of strings, not a shell command.");
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
        throw new FusionError("FUSION_MCP_ARGS must be a JSON array of strings without NUL characters.");
    }
    return { command, args };
}
/** Where the add-in listens: faust reads FUSION_MCP_HOST and FUSION_MCP_PORT too. */
export function addinAddress() {
    const host = process.env.FUSION_MCP_HOST?.trim() || "localhost";
    const port = Number(process.env.FUSION_MCP_PORT?.trim() || FUSION_ADDIN_DEFAULT_PORT);
    return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : FUSION_ADDIN_DEFAULT_PORT };
}
function fusionEnvironment() {
    // Fusion needs its own settings, never printer access codes or other server secrets.
    const env = getDefaultEnvironment();
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith("FUSION_") && value !== undefined && key !== "FUSION_MCP_COMMAND" && key !== "FUSION_MCP_ARGS")
            env[key] = value;
    }
    // faust defaults to 9876 (src/fusion360_mcp/connection.py), so it is told the port this bridge probes and launches with.
    env.FUSION_MCP_PORT = String(addinAddress().port);
    return env;
}
function resultText(result) {
    return result.content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n");
}
/** Faust reports failures with isError and a "**tool** ERROR (KIND)" heading. */
function failed(result, name) {
    return result.isError === true || resultText(result).trimStart().startsWith(`**${name}** ERROR`);
}
/** The add-in's error kind from faust's "**tool** ERROR (KIND)" heading (fusion360_mcp/server.py), when it failed with one. */
function errorKind(result, name) {
    return new RegExp(`^\\*\\*${name}\\*\\* ERROR \\(([A-Z_]+)\\)`).exec(resultText(result).trimStart())?.[1];
}
/** The value of one "  key: value" line in faust's text result. */
function resultField(result, key) {
    for (const line of resultText(result).split("\n")) {
        if (line.startsWith(`  ${key}: `))
            return line.slice(key.length + 4);
    }
    return undefined;
}
/** execute_code's value when the code's last expression is json.dumps(...). */
function codeJson(result) {
    const value = resultField(result, "result");
    try {
        return JSON.parse(value ?? "");
    }
    catch {
        throw new FusionError("Fusion returned an unreadable execute_code result.");
    }
}
const NEW_DESIGN_CODE = `# BAMBU_FUSION new_design
import json
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
new_design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
new_design.designType = adsk.fusion.DesignTypes.ParametricDesignType
json.dumps({"document": doc.name, "parametric": new_design.designType == adsk.fusion.DesignTypes.ParametricDesignType})`;
// The bodies export_stl looks a name up in, in its order (faust _body_by_name: root
// bodies, then every occurrence's proxies), with bounding boxes in Fusion's centimetres.
const BODIES_CODE = `# BAMBU_FUSION bodies
import json
json.dumps([{"name": b.name, "solid": b.isSolid, "visible": b.isVisible, "size_cm": [bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y, bb.maxPoint.z - bb.minPoint.z]} for b in list(component.bRepBodies) + [p for o in component.allOccurrences for p in o.bRepBodies] for bb in [b.boundingBox]])`;
function fusionBodies(value) {
    if (!Array.isArray(value))
        throw new FusionError("Fusion returned an unreadable body list.");
    return value.map((entry) => {
        const size = entry?.size_cm;
        if (typeof entry?.name !== "string" || !Array.isArray(size) || size.length !== 3 || size.some((part) => typeof part !== "number" || !Number.isFinite(part) || part < 0)) {
            throw new FusionError("Fusion returned an unreadable body list.");
        }
        return { name: entry.name, solid: entry.solid === true, visible: entry.visible === true, size_cm: size };
    });
}
// The fields faust's get_parameters reports, as JSON instead of its Python-repr text.
const PARAMETERS_CODE = `# BAMBU_FUSION parameters
import json
json.dumps({"parameters": [{"name": p.name, "value": p.value, "expression": p.expression, "unit": p.unit, "comment": p.comment} for p in design.userParameters], "count": design.userParameters.count})`;
export const FUSION_STATUS_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        configured: { type: "boolean", description: "FUSION_MCP_COMMAND is set." },
        connected: { type: "boolean", description: "The Fusion MCP server started and the add-in answered its ping." },
        addinReachable: { type: "boolean", description: "The Fusion360MCP add-in answered a ping on FUSION_MCP_HOST:FUSION_MCP_PORT (default localhost:9877) within 2 s. Another program on that port, such as Blender's MCP add-on, does not count." },
        fusionRunning: { type: "boolean" },
        activeDesign: { type: "boolean", description: "When connected: whether Fusion has a design open, from the add-in's read-only get_design_type (false is its NO_ACTIVE_DESIGN). The pinned add-in refuses every design command, fusion_mcp_new_design included, without one (faust issue #12). Absent when unknown." },
        tools: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        launched: { type: "boolean", description: "This call started Fusion." },
        transport: { type: "string" },
        pin: { type: "string", description: "The faust-machines/fusion360-mcp-server commit this bridge is set up for." },
        server: { type: "object" },
        error: { type: "string" },
    },
    required: ["configured", "connected", "addinReachable", "fusionRunning", "tools"],
};
export const FUSION_NEW_DESIGN_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        status: { type: "string", const: "created" },
        document: { type: "string" },
        parametric: { type: "boolean" },
        document_id: { type: "string" },
        document_binding: { type: "integer", const: 1 },
    },
    required: ["status", "document", "parametric"],
};
export const FUSION_EXPORT_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        status: { type: "string", const: "exported" },
        stl: { type: "string", description: "Absolute path of <name>.stl." },
        f3d: { type: "string", description: "Absolute path of <name>.f3d." },
        parameters: { type: "string", description: "Absolute path of <name>.parameters.json." },
        body: { type: "string" },
        triangles: { type: "integer", minimum: 1 },
        bytes: { type: "integer", minimum: 1 },
        parameterCount: { type: "integer", minimum: 0 },
        boundingBox: { type: "object", description: "Measured from the written STL, in its own units: min, max and dimensions." },
        stlUnits: { type: "string", enum: ["mm", "cm", "unknown"], description: "The STL's units, from its size against the Fusion body's." },
        fusionSizeMm: { type: "array", items: { type: "number" }, description: "The Fusion body's bounding-box size in mm." },
        warnings: { type: "array", items: { type: "string" } },
    },
    required: ["status", "stl", "f3d", "parameters", "body", "triangles", "parameterCount"],
};
export class FusionMcpBridge {
    constructor(system = defaultFusionSystem) {
        this.system = system;
    }
    /** Close the stdio session, if any; the next call reconnects. */
    async close() {
        const live = this.live;
        this.live = undefined;
        if (!live)
            return;
        live.closed = true;
        await live.client.close().catch(() => { });
        await live.transport.close().catch(() => { });
    }
    async open(timeout) {
        const config = configuration();
        const client = new Client({ name: "bambu-printer-mcp-fusion", version: "1.0.0" });
        const transport = new StdioClientTransport({ ...config, env: fusionEnvironment(), stderr: "pipe" });
        // Drain stderr without relaying arbitrary logs or credentials into the outer MCP stream.
        transport.stderr?.on("data", () => { });
        const live = { client, transport, tools: [], closed: false };
        transport.onclose = () => {
            live.closed = true;
            if (this.live === live)
                this.live = undefined;
        };
        const options = { timeout };
        try {
            await client.connect(transport, options);
            const cursors = new Set();
            let cursor;
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, options);
                live.tools.push(...page.tools);
                cursor = page.nextCursor;
                if (cursor && (cursors.has(cursor) || cursors.size >= 99))
                    throw new FusionError("Fusion MCP returned an invalid or excessive tools/list pagination sequence.");
                if (cursor)
                    cursors.add(cursor);
            } while (cursor);
            return live;
        }
        catch (error) {
            live.closed = true;
            await client.close().catch(() => { });
            await transport.close().catch(() => { });
            throw error;
        }
    }
    /**
     * The live session, starting one if needed. A start is shared by every caller
     * that arrives while it runs, so it has its own deadline (the longer of the
     * caller's and FUSION_MCP_TIMEOUT_MS) and no caller's signal; each caller
     * waits on it with its own deadline and cancellation.
     */
    async session(timeout, signal) {
        if (this.live && !this.live.closed)
            return this.live;
        if (!this.connecting) {
            const connecting = this.open(Math.max(timeout, timeoutMilliseconds(undefined)))
                .then(live => { this.live = live; return live; })
                .finally(() => { if (this.connecting === connecting)
                this.connecting = undefined; });
            connecting.catch(() => { });
            this.connecting = connecting;
        }
        const shared = this.connecting;
        if (signal.aborted)
            throw new DOMException("The operation was aborted.", "AbortError");
        return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            signal.addEventListener("abort", abort, { once: true });
            shared.then(live => { signal.removeEventListener("abort", abort); resolve(live); }, error => { signal.removeEventListener("abort", abort); reject(error); });
        });
    }
    /** One request with a deadline. An interrupted request is never retried; the session is closed instead. */
    async request(args, work) {
        const controller = new AbortController();
        let timedOut = false;
        let phase = "connection";
        let sent = false;
        const deadline = Date.now() + args.timeout;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, args.timeout);
        const abort = () => controller.abort();
        args.signal?.addEventListener("abort", abort, { once: true });
        if (args.signal?.aborted)
            controller.abort();
        const options = () => ({ signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) });
        try {
            const live = await this.session(options().timeout, controller.signal);
            phase = "tool request";
            return await work(live, options(), () => { sent = true; });
        }
        catch (error) {
            if (error instanceof FusionError)
                throw error;
            const code = error?.code;
            // The child may still be executing; never reuse a session whose request was cut off.
            if (sent || timedOut || controller.signal.aborted)
                await this.close();
            if (timedOut || code === ErrorCode.RequestTimeout) {
                throw new FusionError(`Fusion MCP timed out during ${phase}.${sent ? " Fusion may still be running the request; inspect the design before retrying. It was not replayed." : " Check FUSION_MCP_COMMAND, FUSION_MCP_ARGS and the Fusion360MCP add-in."}`);
            }
            if (controller.signal.aborted)
                throw new FusionError(`Fusion MCP request cancelled.${sent ? " Fusion may still be running it; inspect the design before retrying." : ""}`);
            // Error messages from processes/RPC peers may contain arguments, code, or credentials.
            const safeCode = typeof code === "number" ? ` (RPC ${code})` : ["ENOENT", "EACCES"].includes(String(code)) ? ` (${code})` : "";
            await this.close();
            throw new FusionError(`Fusion MCP failed during ${phase}${safeCode}. Check FUSION_MCP_COMMAND, FUSION_MCP_ARGS and the Fusion360MCP add-in.`);
        }
        finally {
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abort);
        }
    }
    async invoke(live, options, dispatched, name, args) {
        const tool = live.tools.find(candidate => candidate.name === name);
        if (!tool)
            throw new FusionError(`Fusion MCP does not advertise ${name}. Call fusion_mcp_status to inspect the available tools.`);
        let valid;
        try {
            valid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid;
        }
        catch {
            throw new FusionError("Fusion MCP advertised an unsupported input schema for this tool.");
        }
        if (!valid)
            throw new FusionError(`${name} arguments do not match its advertised input schema. Inspect fusion_mcp_status before calling the tool.`);
        dispatched();
        return await live.client.callTool({ name, arguments: args }, undefined, options);
    }
    /** A faust tool that must succeed; its failure text is Fusion's own and contains no secrets of ours. */
    async must(live, options, dispatched, name, args) {
        const result = await this.invoke(live, options, dispatched, name, args);
        if (!failed(result, name))
            return result;
        const text = resultText(result);
        if (NO_DESIGN.test(text)) {
            throw new FusionError(`Fusion has no open design, so ${name} cannot run. Call fusion_mcp_new_design first; if that fails too, open any design in Fusion once (the Fusion360MCP add-in at ${FUSION_MCP_PIN} cannot create the first one, faust-machines issue #12).`);
        }
        throw new FusionError(`Fusion ${name} failed: ${text.slice(0, 2000)}`);
    }
    async status(args, signal) {
        allowedArguments(args, ["launch", "timeout_ms"]);
        if (args.launch !== undefined && typeof args.launch !== "boolean")
            throw new FusionError("launch must be a boolean.");
        const timeout = timeoutMilliseconds(args.timeout_ms);
        const { host, port } = addinAddress();
        const configured = Boolean(process.env.FUSION_MCP_COMMAND?.trim());
        let addinReachable = await this.system.addinAnswers(host, port, ADDIN_PING_MS);
        let fusionRunning = addinReachable || await this.system.fusionRunning();
        let launched = false;
        if (args.launch === true && !fusionRunning) {
            if (this.system.platform !== "darwin")
                throw new FusionError("launch is supported on macOS only; start Fusion yourself.");
            try {
                await this.system.launch(port);
            }
            catch {
                throw new FusionError(`Could not start Autodesk Fusion with open -a "Autodesk Fusion" --env FUSION_MCP_PORT=${port}. Is it installed?`);
            }
            launched = true;
            fusionRunning = true;
            const until = Date.now() + this.system.launchWaitMs;
            while (!addinReachable && Date.now() < until) {
                if (signal?.aborted)
                    throw new FusionError("Fusion MCP request cancelled while waiting for Fusion to start.");
                await this.system.sleep(1000);
                addinReachable = await this.system.addinAnswers(host, port, ADDIN_PING_MS);
            }
        }
        const result = { configured, connected: false, addinReachable, fusionRunning, tools: [], launched, transport: "stdio", pin: FUSION_MCP_PIN };
        if (!configured)
            return result;
        try {
            await this.request({ timeout, signal }, async (live, options, dispatched) => {
                result.tools = live.tools;
                result.server = live.client.getServerVersion();
                // faust's ping answers through the add-in without touching Fusion's API.
                if (addinReachable && live.tools.some(tool => tool.name === "ping")) {
                    const ping = await this.invoke(live, options, dispatched, "ping", {});
                    result.connected = !failed(ping, "ping");
                }
                // Whether a design is open, from the add-in itself. get_design_type reads the active document's Design product
                // (the add-in's _design(), as every design command does) and changes nothing; with no design it fails with the
                // add-in's own error kind NO_ACTIVE_DESIGN (its hints.py). Any other answer leaves activeDesign out: unknown.
                if (result.connected === true && live.tools.some(tool => tool.name === "get_design_type")) {
                    let read;
                    // A read that didn't finish (timeout, cancel, lost connection): Fusion isn't usable now. request() closes the
                    // cut-off session and names what happened, which status reports as its error.
                    try {
                        read = await this.invoke(live, options, dispatched, "get_design_type", {});
                    }
                    catch (error) {
                        result.connected = false;
                        throw error;
                    }
                    if (!failed(read, "get_design_type"))
                        result.activeDesign = true;
                    else if (errorKind(read, "get_design_type") === "NO_ACTIVE_DESIGN")
                        result.activeDesign = false;
                }
            });
        }
        catch (error) {
            result.error = error instanceof Error ? error.message : String(error);
        }
        return result;
    }
    boundArguments(live, name, args, documentId) {
        if (documentId === undefined)
            return args;
        const id = textArgument(documentId, "document_id");
        const schema = live.tools.find(tool => tool.name === name)?.inputSchema;
        if (!schema?.properties?.document_id)
            throw new FusionError("This Fusion MCP does not support document binding for this tool; update the configured bridge and add-in first.");
        if (Object.prototype.hasOwnProperty.call(args, "document_id"))
            throw new FusionError("Pass document_id once, outside arguments.");
        return { ...args, document_id: id };
    }
    async call(args, signal) {
        allowedArguments(args, ["tool_name", "arguments", "timeout_ms", "document_id"]);
        const name = textArgument(args.tool_name, "tool_name");
        const toolArgs = argumentObject(args.arguments ?? {}, "arguments");
        return this.request({ timeout: timeoutMilliseconds(args.timeout_ms), signal }, (live, options, dispatched) => this.invoke(live, options, dispatched, name, this.boundArguments(live, name, toolArgs, args.document_id)));
    }
    async newDesign(args, signal) {
        allowedArguments(args, ["timeout_ms", "bind_document", "source_f3d"]);
        if (args.bind_document !== undefined && typeof args.bind_document !== "boolean")
            throw new FusionError("bind_document must be a boolean.");
        if (args.source_f3d !== undefined && args.bind_document !== true)
            throw new FusionError("Importing a revision requires document binding.");
        return this.request({ timeout: timeoutMilliseconds(args.timeout_ms), signal }, async (live, options, dispatched) => {
            if (args.bind_document === true) {
                if (!live.tools.some(tool => tool.name === "new_document"))
                    throw new FusionError("This Fusion MCP does not support document binding; update the configured bridge and add-in first.");
                const imported = args.source_f3d === undefined ? {} : { source_f3d: textArgument(args.source_f3d, "source_f3d") };
                const result = await this.must(live, options, dispatched, "new_document", imported);
                const id = resultField(result, "document_id"), document = resultField(result, "document");
                if (!id || !document || resultField(result, "document_binding") !== "1")
                    throw new FusionError("Fusion did not confirm document binding for the new design.");
                return { status: "created", document, document_id: id, document_binding: 1, parametric: resultField(result, "parametric") === "True" };
            }
            const created = codeJson(await this.must(live, options, dispatched, "execute_code", { code: NEW_DESIGN_CODE }));
            if (!created || typeof created.document !== "string")
                throw new FusionError("Fusion did not report the new design document.");
            return { status: "created", document: created.document, parametric: created.parametric === true };
        });
    }
    async export(args, signal) {
        allowedArguments(args, ["output_dir", "name", "body_name", "timeout_ms", "document_id"]);
        const name = textArgument(args.name, "name").trim();
        if (!EXPORT_NAME.test(name) || name.includes(".."))
            throw new FusionError("name must be a plain file name (letters, digits, spaces, dot, dash, underscore), without a path.");
        const bodyName = args.body_name === undefined ? undefined : textArgument(args.body_name, "body_name");
        const timeout = timeoutMilliseconds(args.timeout_ms);
        const directory = await fs.realpath(path.resolve(textArgument(args.output_dir, "output_dir"))).catch(() => { throw new FusionError("output_dir must be an existing directory."); });
        if (!(await fs.stat(directory)).isDirectory())
            throw new FusionError("output_dir must be an existing directory.");
        const outputs = { stl: path.join(directory, `${name}.stl`), f3d: path.join(directory, `${name}.f3d`), parameters: path.join(directory, `${name}.parameters.json`) };
        for (const output of Object.values(outputs)) {
            const exists = await fs.lstat(output).then(() => true, (error) => {
                if (error.code !== "ENOENT")
                    throw new FusionError(`${output} cannot be accessed.`);
                return false;
            });
            if (exists)
                throw new FusionError(`${output} already exists; choose a new name. Existing files are never overwritten.`);
        }
        const id = randomUUID();
        const staged = { stl: path.join(directory, `.fusion-${id}.stl`), f3d: path.join(directory, `.fusion-${id}.f3d`), parameters: path.join(directory, `.fusion-${id}.parameters.json`) };
        try {
            const exported = await this.request({ timeout, signal }, async (live, options, dispatched) => {
                const bound = (name, fields) => this.boundArguments(live, name, fields, args.document_id);
                // Hidden and surface bodies are never chosen: only what would print.
                const everyBody = fusionBodies(codeJson(await this.must(live, options, dispatched, "execute_code", bound("execute_code", { code: BODIES_CODE }))));
                const bodies = everyBody.filter(entry => entry.solid && entry.visible);
                const names = bodies.map(entry => entry.name);
                const body = bodyName ? bodies.find(entry => entry.name === bodyName) : bodies.length === 1 ? bodies[0] : undefined;
                if (!body) {
                    if (bodyName)
                        throw new FusionError(`No visible solid body named "${bodyName}". Visible solid bodies: ${names.slice(0, 20).join(", ") || "none"}.`);
                    throw new FusionError(bodies.length
                        ? `The design has ${bodies.length} visible solid bodies (${names.slice(0, 20).join(", ")}); pass body_name to choose the one to export.`
                        : "The design has no visible solid body to export.");
                }
                // export_stl takes the first body with the name, hidden or not, so the name must be unique among all of them.
                if (everyBody.filter(entry => entry.name === body.name).length > 1) {
                    throw new FusionError(`Several bodies are named "${body.name}", counting hidden and surface bodies and copies of a component; Fusion's export_stl takes the first. Rename them in Fusion so the export is unambiguous.`);
                }
                await this.must(live, options, dispatched, "export_stl", bound("export_stl", { body_name: body.name, file_path: staged.stl }));
                await this.must(live, options, dispatched, "export_f3d", bound("export_f3d", { file_path: staged.f3d }));
                const parameters = codeJson(await this.must(live, options, dispatched, "execute_code", bound("execute_code", { code: PARAMETERS_CODE })));
                if (!parameters || !Array.isArray(parameters.parameters))
                    throw new FusionError("Fusion returned unreadable parameters.");
                return { body, parameters };
            });
            // Fusion writes the files itself, so it must share this filesystem (FUSION_MCP_HOST on another machine cannot export here).
            const mesh = await stlMetadata(staged.stl).catch(() => { throw new FusionError("Fusion did not write a valid STL here. Fusion and this server must share the filesystem."); });
            // Fusion measures in centimetres; the STL's own numbers show which unit it was written in.
            const largestCm = Math.max(...exported.body.size_cm);
            const ratio = largestCm > 0 ? Math.max(...mesh.bounding_box.dimensions) / largestCm : NaN;
            const stlUnits = Math.abs(ratio - 10) < 0.5 ? "mm" : Math.abs(ratio - 1) < 0.05 ? "cm" : "unknown";
            const warnings = [];
            if (stlUnits === "cm")
                warnings.push("The STL is in centimetres; slicers read STL numbers as millimetres. Scale it by 10 before slicing.");
            if (stlUnits === "unknown")
                warnings.push("The STL's size does not match the Fusion body's size in mm or cm; check it before slicing.");
            const archive = await fs.lstat(staged.f3d).catch(() => undefined);
            if (!archive?.isFile() || archive.size === 0)
                throw new FusionError("Fusion did not write the F3D archive here. Fusion and this server must share the filesystem.");
            await fs.writeFile(staged.parameters, `${JSON.stringify(exported.parameters, null, 2)}\n`, { flag: "wx" });
            // link() publishes without replacing a file created since the check above.
            // All three or none: a failure removes the outputs this call already published.
            const published = [];
            try {
                for (const key of ["stl", "f3d", "parameters"]) {
                    await fs.link(staged[key], outputs[key]).catch(() => { throw new FusionError(`Cannot write ${outputs[key]}; it may already exist or be unwritable.`); });
                    published.push(outputs[key]);
                }
            }
            catch (error) {
                for (const file of published)
                    await fs.rm(file, { force: true }).catch(() => { });
                throw error;
            }
            return {
                status: "exported", ...outputs, body: exported.body.name,
                triangles: mesh.triangles, bytes: mesh.bytes,
                parameterCount: exported.parameters.parameters.length,
                boundingBox: mesh.bounding_box, stlUnits,
                fusionSizeMm: exported.body.size_cm.map(value => Math.round(value * 10 * 1e4) / 1e4),
                ...(warnings.length ? { warnings } : {}),
            };
        }
        finally {
            for (const file of Object.values(staged))
                await fs.rm(file, { force: true }).catch(() => { });
        }
    }
}
