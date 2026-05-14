#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { STLManipulator, SLICER_TYPES, normalizeSlicerType, } from "./stl/stl-manipulator.js";
import { BambuNetworkBridge } from "./bambu-network-bridge.js";
import { parse3MF } from './3mf_parser.js';
import { BambuImplementation } from "./printers/bambu.js";
dotenv.config();
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_TOKEN || "";
const DEFAULT_BAMBU_DEV_ID = process.env.BAMBU_DEV_ID || DEFAULT_BAMBU_SERIAL;
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), "temp");
// Printer model and bed type
const DEFAULT_BAMBU_MODEL = process.env.BAMBU_MODEL?.trim().toLowerCase() || "";
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";
const VALID_BAMBU_MODELS = ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"];
const VALID_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"];
// Map model IDs to BambuStudio --load-machine preset names
const BAMBU_MODEL_PRESETS = {
    p1s: (n) => `Bambu Lab P1S ${n} nozzle`,
    p1p: (n) => `Bambu Lab P1P ${n} nozzle`,
    x1c: (n) => `Bambu Lab X1 Carbon ${n} nozzle`,
    x1e: (n) => `Bambu Lab X1E ${n} nozzle`,
    a1: (n) => `Bambu Lab A1 ${n} nozzle`,
    a1mini: (n) => `Bambu Lab A1 mini ${n} nozzle`,
    h2d: (n) => `Bambu Lab H2D ${n} nozzle`,
};
function validateBambuModel(model) {
    const normalized = model.trim().toLowerCase();
    if (!VALID_BAMBU_MODELS.includes(normalized)) {
        throw new Error(`Invalid bambu_model: "${model}". Valid models: ${VALID_BAMBU_MODELS.join(", ")}`);
    }
    return normalized;
}
function resolveBedType(argsBedType) {
    const bedType = (argsBedType || DEFAULT_BED_TYPE).trim().toLowerCase();
    if (!VALID_BED_TYPES.includes(bedType)) {
        throw new Error(`Invalid bed_type: "${bedType}". Valid types: ${VALID_BED_TYPES.join(", ")}`);
    }
    return bedType;
}
// Slicer configuration (defaults to bambustudio)
const DEFAULT_SLICER_TYPE = process.env.SLICER_TYPE || "bambustudio";
const DEFAULT_SLICER_PROFILE = process.env.SLICER_PROFILE || "";
const SLICER_SCHEMA_VALUES = [
    ...SLICER_TYPES,
    "fulu-orca",
    "fulu-orcaslicer",
    "orca-studio",
    "orca-bambulab",
];
function firstExistingPath(paths, fallback) {
    return paths.find((candidate) => fs.existsSync(candidate)) || fallback;
}
function defaultSlicerPathFor(slicerType) {
    if (slicerType === "orcaslicer" || slicerType === "orcaslicer-bambulab") {
        if (process.platform === "darwin") {
            return firstExistingPath([
                "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
                "/Applications/Orca Studio.app/Contents/MacOS/Orca Studio",
                "/Applications/OrcaSlicer-BMCU.app/Contents/MacOS/OrcaSlicer",
            ], "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer");
        }
        if (process.platform === "win32") {
            return "C:\\Program Files\\OrcaSlicer\\OrcaSlicer.exe";
        }
        return "OrcaSlicer";
    }
    if (slicerType === "bambustudio") {
        if (process.platform === "darwin") {
            return "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
        }
        if (process.platform === "win32") {
            return "C:\\Program Files\\Bambu Studio\\bambu-studio.exe";
        }
        return "BambuStudio";
    }
    return slicerType;
}
function resolveSlicerConfig(args) {
    const slicerType = normalizeSlicerType(String(args?.slicer_type || DEFAULT_SLICER_TYPE));
    const slicerPath = String(args?.slicer_path || process.env.SLICER_PATH || defaultSlicerPathFor(slicerType));
    const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
    return { slicerType, slicerPath, slicerProfile };
}
function parseBooleanEnv(rawValue, fallback) {
    if (rawValue === undefined)
        return fallback;
    const value = rawValue.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value))
        return true;
    if (["0", "false", "no", "off"].includes(value))
        return false;
    return fallback;
}
function parsePort(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid MCP_HTTP_PORT value: ${value}`);
    }
    return parsed;
}
function normalizePath(pathValue) {
    const value = (pathValue ?? "/mcp").trim();
    if (!value)
        return "/mcp";
    return value.startsWith("/") ? value : `/${value}`;
}
function parseCsvEnv(value) {
    if (!value)
        return new Set();
    return new Set(value.split(",").map((e) => e.trim()).filter((e) => e.length > 0));
}
function readRuntimeConfig() {
    const rawTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
    const transport = rawTransport === "streamable-http" || rawTransport === "http"
        ? "streamable-http"
        : "stdio";
    return {
        transport,
        httpHost: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
        httpPort: parsePort(process.env.MCP_HTTP_PORT, 3000),
        httpPath: normalizePath(process.env.MCP_HTTP_PATH),
        statefulSession: parseBooleanEnv(process.env.MCP_HTTP_STATEFUL, true),
        enableJsonResponse: parseBooleanEnv(process.env.MCP_HTTP_JSON_RESPONSE, true),
        allowedOrigins: parseCsvEnv(process.env.MCP_HTTP_ALLOWED_ORIGINS),
        blenderBridgeCommand: process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() || undefined,
    };
}
function expandUserPath(rawPath) {
    const trimmed = rawPath.trim();
    if (trimmed === "~") {
        return process.env.HOME || trimmed;
    }
    if (trimmed.startsWith("~/")) {
        return path.join(process.env.HOME || "", trimmed.slice(2));
    }
    return path.resolve(trimmed);
}
function readableFilePathFromString(value) {
    if (!value.trim() || value.includes("\n") || value.includes("\r")) {
        return undefined;
    }
    const candidate = expandUserPath(value);
    try {
        return fs.statSync(candidate).isFile() ? candidate : undefined;
    }
    catch {
        return undefined;
    }
}
function looksLikeGcodeFilePath(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
        return false;
    }
    return (trimmed.startsWith("/") ||
        trimmed.startsWith("./") ||
        trimmed.startsWith("../") ||
        trimmed.startsWith("~/") ||
        trimmed.includes("\\") ||
        /\.(gcode|gco|gc)$/i.test(trimmed));
}
function requireReadableFilePath(rawPath, label) {
    const candidate = expandUserPath(rawPath);
    try {
        if (!fs.statSync(candidate).isFile()) {
            throw new Error(`${label} is not a file: ${candidate}`);
        }
    }
    catch (error) {
        if (error.message.startsWith(`${label} is not a file:`)) {
            throw error;
        }
        throw new Error(`${label} does not exist or is not readable: ${candidate}`);
    }
    return candidate;
}
function writeGcodeContentToTempFile(filename, gcode) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const cleanupDir = fs.mkdtempSync(path.join(TEMP_DIR, "upload-gcode-"));
    const safeName = path.basename(filename.replace(/^\/+/, "")) || "upload.gcode";
    const filePath = path.join(cleanupDir, safeName);
    fs.writeFileSync(filePath, gcode);
    return { filePath, cleanupDir };
}
function resolveUploadGcodeSource(args) {
    const gcodePath = args.gcode_path !== undefined ? String(args.gcode_path) : "";
    const gcode = args.gcode !== undefined ? String(args.gcode) : "";
    if (gcodePath && gcode) {
        throw new Error("Provide either gcode_path or gcode, not both.");
    }
    if (gcodePath) {
        return { filePath: requireReadableFilePath(gcodePath, "gcode_path") };
    }
    if (!gcode) {
        throw new Error("Missing required parameter: gcode or gcode_path");
    }
    const detectedPath = readableFilePathFromString(gcode);
    if (detectedPath) {
        return { filePath: detectedPath };
    }
    if (looksLikeGcodeFilePath(gcode)) {
        throw new Error("gcode looks like a local G-code path, but the file is not readable. " +
            "Pass readable gcode_path or literal G-code content.");
    }
    return writeGcodeContentToTempFile(String(args.filename), gcode);
}
const BAMBU_NETWORK_PRINT_METHODS = [
    "start_print",
    "start_local_print",
    "start_local_print_with_record",
    "start_send_gcode_to_sdcard",
    "start_sdcard_print",
];
function resolveBambuNetworkPrintMethod(rawMethod, connectionType) {
    const defaultMethod = connectionType === "lan" ? "start_local_print" : "start_print";
    const method = (rawMethod || defaultMethod).trim();
    if (!BAMBU_NETWORK_PRINT_METHODS.includes(method)) {
        throw new Error(`Invalid bambu_network_method: "${method}". Valid methods: ${BAMBU_NETWORK_PRINT_METHODS.join(", ")}`);
    }
    return method;
}
function toBridgeMethod(method) {
    return `net.${method}`;
}
function stringifyBridgeJson(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
function redactPrintParams(params) {
    return {
        ...params,
        password: params.password ? "[redacted]" : "",
    };
}
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}
class BambuPrinterMCPServer {
    constructor() {
        this.runtimeConfig = readRuntimeConfig();
        this.server = new Server({
            name: "bambu-printer-mcp",
            version: "1.0.0"
        }, {
            capabilities: {
                resources: {},
                tools: {}
            }
        });
        this.bambu = new BambuImplementation();
        this.bambuNetwork = new BambuNetworkBridge();
        this.stlManipulator = new STLManipulator(TEMP_DIR);
        this.setupHandlers();
        this.setupErrorHandling();
    }
    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error("[MCP Error]", error);
        };
    }
    setupHandlers() {
        this.setupResourceHandlers();
        this.setupToolHandlers();
    }
    /**
     * Resolve the Bambu printer model from args, env, or by asking the user via elicitation.
     * This is critical for safety: the wrong model can cause physical damage to the printer.
     */
    async resolveBambuModel(argsModel) {
        const fromArgs = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
        if (fromArgs) {
            return validateBambuModel(fromArgs);
        }
        // No model from args or env - ask the user via elicitation
        try {
            const result = await this.server.elicitInput({
                mode: "form",
                message: "Your Bambu Lab printer model is required for safe operation. " +
                    "Using the wrong model can cause the bed to crash into the nozzle and damage the printer.",
                requestedSchema: {
                    type: "object",
                    properties: {
                        bambu_model: {
                            type: "string",
                            title: "Printer Model",
                            description: "Which Bambu Lab printer do you have?",
                            oneOf: [
                                { const: "p1s", title: "P1S" },
                                { const: "p1p", title: "P1P" },
                                { const: "x1c", title: "X1 Carbon" },
                                { const: "x1e", title: "X1E" },
                                { const: "a1", title: "A1" },
                                { const: "a1mini", title: "A1 Mini" },
                                { const: "h2d", title: "H2D" },
                            ],
                        },
                    },
                    required: ["bambu_model"],
                },
            });
            if (result.action === "accept" && result.content?.bambu_model) {
                return validateBambuModel(String(result.content.bambu_model));
            }
            throw new Error("Printer model selection was cancelled. Cannot proceed without knowing the printer model.");
        }
        catch (elicitError) {
            // Elicitation not supported by this client - fall back to a clear error
            const msg = elicitError?.message || String(elicitError);
            if (elicitError?.code === -32601 || elicitError?.code === -32600 ||
                msg.includes("does not support") || msg.includes("elicitation")) {
                throw new Error("bambu_model is required but your MCP client does not support elicitation. " +
                    `Set the BAMBU_MODEL environment variable or pass bambu_model in the tool call. ` +
                    `Valid models: ${VALID_BAMBU_MODELS.join(", ")}`);
            }
            throw elicitError;
        }
    }
    bridgeOptionsFromArgs(args) {
        return {
            bridgeCommand: args?.bridge_command !== undefined ? String(args.bridge_command) : undefined,
            configDir: args?.bambu_network_config_dir !== undefined ? String(args.bambu_network_config_dir) : undefined,
            countryCode: args?.country_code !== undefined ? String(args.country_code) : undefined,
            userInfo: args?.user_info !== undefined ? String(args.user_info) : undefined,
            timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
        };
    }
    async ensurePrintableThreeMFPath(args, printModel, printPreset) {
        const { slicerType, slicerPath, slicerProfile } = resolveSlicerConfig(args);
        let threeMFPath = String(args.three_mf_path);
        const JSZip = (await import('jszip')).default;
        const zipData = fs.readFileSync(threeMFPath);
        const zip = await JSZip.loadAsync(zipData);
        const hasGcode = Object.keys(zip.files).some(f => f.match(/Metadata\/plate_\d+\.gcode/i) || f.endsWith('.gcode'));
        if (hasGcode) {
            return { threeMFPath, autoSliced: false };
        }
        console.log(`3MF has no gcode - auto-slicing with ${slicerType} for ${printModel}`);
        const autoSliceOptions = {
            uptodate: true,
            ensureOnBed: true,
            minSave: true,
            skipModifiedGcodes: true,
        };
        threeMFPath = await this.stlManipulator.sliceSTL(threeMFPath, slicerType, slicerPath, slicerProfile || undefined, undefined, printPreset, autoSliceOptions);
        console.log("Auto-sliced to: " + threeMFPath);
        return { threeMFPath, autoSliced: true };
    }
    async resolveAmsPrintSettings(threeMFPath, args) {
        const parsed3MFData = await parse3MF(threeMFPath);
        let parsedAmsMapping;
        if (parsed3MFData.slicerConfig?.ams_mapping) {
            const slots = Object.values(parsed3MFData.slicerConfig.ams_mapping)
                .filter(v => typeof v === 'number');
            if (slots.length > 0) {
                parsedAmsMapping = slots.sort((a, b) => a - b);
            }
        }
        let finalAmsMapping = parsedAmsMapping;
        const explicitUseAMS = args?.use_ams !== undefined;
        let useAMS = explicitUseAMS ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
        if (args?.ams_mapping) {
            let userMappingOverride;
            if (Array.isArray(args.ams_mapping)) {
                userMappingOverride = args.ams_mapping.filter((v) => typeof v === 'number');
            }
            else if (typeof args.ams_mapping === 'object') {
                userMappingOverride = Object.values(args.ams_mapping)
                    .filter((v) => typeof v === 'number')
                    .sort((a, b) => a - b);
            }
            if (userMappingOverride && userMappingOverride.length > 0) {
                finalAmsMapping = userMappingOverride;
                useAMS = true;
            }
        }
        if (args?.use_ams === false) {
            finalAmsMapping = undefined;
            useAMS = false;
        }
        if ((!finalAmsMapping || finalAmsMapping.length === 0) && !explicitUseAMS) {
            useAMS = false;
        }
        return { useAMS, finalAmsMapping };
    }
    async print3mfViaBambuNetwork(args, host, bambuSerial, bambuToken) {
        if (!args?.three_mf_path) {
            throw new Error("Missing required parameter: three_mf_path");
        }
        const printModel = await this.resolveBambuModel(args?.bambu_model);
        const printBedType = resolveBedType(args?.bed_type);
        const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
        const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
        const plateIndex = args?.plate_index !== undefined ? Number(args.plate_index) : 0;
        if (!Number.isInteger(plateIndex) || plateIndex < 0) {
            throw new Error("plate_index must be a non-negative integer.");
        }
        const connectionType = String(args?.connection_type || "cloud").trim().toLowerCase();
        if (!["cloud", "lan"].includes(connectionType)) {
            throw new Error('connection_type must be "cloud" or "lan".');
        }
        const bridgePrintMethod = resolveBambuNetworkPrintMethod(args?.bambu_network_method !== undefined ? String(args.bambu_network_method) : undefined, connectionType);
        const bridgeMethod = toBridgeMethod(bridgePrintMethod);
        const isLocalBridgePrint = bridgePrintMethod !== "start_print";
        const devId = String(args?.dev_id || bambuSerial || DEFAULT_BAMBU_DEV_ID).trim();
        if (!devId) {
            throw new Error("dev_id is required for FULU BambuNetwork printing. Pass dev_id or set BAMBU_DEV_ID/BAMBU_SERIAL.");
        }
        const devIp = String(args?.dev_ip || args?.host || host || "").trim();
        const explicitPassword = String(args?.password || args?.bambu_token || "").trim();
        const password = isLocalBridgePrint ? (explicitPassword || String(bambuToken || "").trim()) : explicitPassword;
        if (isLocalBridgePrint && (!devIp || devIp === "localhost")) {
            throw new Error("dev_ip or host is required for FULU BambuNetwork LAN/local print methods.");
        }
        if (isLocalBridgePrint && !password) {
            throw new Error("bambu_token/access code is required for FULU BambuNetwork LAN/local print methods.");
        }
        const { threeMFPath, autoSliced } = await this.ensurePrintableThreeMFPath(args, printModel, printPreset);
        const { useAMS, finalAmsMapping } = await this.resolveAmsPrintSettings(threeMFPath, args);
        const threeMfFilename = path.basename(threeMFPath);
        const projectName = String(args?.project_name || threeMfFilename.replace(/\.3mf$/i, ''));
        const presetName = String(args?.preset_name || `${projectName}_plate_${plateIndex + 1}`);
        const clientJobId = args?.client_job_id !== undefined ? Number(args.client_job_id) : Date.now();
        const amsMapping = stringifyBridgeJson(args?.ams_mapping_bridge ?? finalAmsMapping);
        const params = {
            dev_id: devId,
            task_name: String(args?.task_name || projectName),
            project_name: projectName,
            preset_name: presetName,
            filename: threeMFPath,
            config_filename: String(args?.config_filename || threeMFPath),
            plate_index: plateIndex + 1,
            ftp_folder: String(args?.ftp_folder || ""),
            ftp_file: String(args?.ftp_file || ""),
            ftp_file_md5: String(args?.ftp_file_md5 || ""),
            nozzle_mapping: stringifyBridgeJson(args?.nozzle_mapping) || "",
            ams_mapping: amsMapping || "",
            ams_mapping2: stringifyBridgeJson(args?.ams_mapping2) || "",
            ams_mapping_info: stringifyBridgeJson(args?.ams_mapping_info) || "",
            nozzles_info: stringifyBridgeJson(args?.nozzles_info) || "",
            connection_type: connectionType,
            comments: String(args?.comments || ""),
            origin_profile_id: args?.origin_profile_id !== undefined ? Number(args.origin_profile_id) : 0,
            stl_design_id: args?.stl_design_id !== undefined ? Number(args.stl_design_id) : 0,
            origin_model_id: String(args?.origin_model_id || ""),
            print_type: String(args?.print_type || "from_normal"),
            dst_file: String(args?.dst_file || ""),
            dev_name: String(args?.dev_name || ""),
            dev_ip: devIp,
            use_ssl_for_ftp: args?.use_ssl_for_ftp !== undefined ? Boolean(args.use_ssl_for_ftp) : true,
            use_ssl_for_mqtt: args?.use_ssl_for_mqtt !== undefined ? Boolean(args.use_ssl_for_mqtt) : true,
            username: String(args?.username || "bblp"),
            password,
            task_bed_leveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : true,
            task_flow_cali: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : true,
            task_vibration_cali: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : true,
            task_layer_inspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : false,
            task_record_timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : false,
            task_use_ams: useAMS,
            task_bed_type: printBedType,
            extra_options: stringifyBridgeJson(args?.extra_options) || "",
            auto_bed_leveling: args?.auto_bed_leveling !== undefined ? Number(args.auto_bed_leveling) : 0,
            auto_flow_cali: args?.auto_flow_cali !== undefined ? Number(args.auto_flow_cali) : 0,
            auto_offset_cali: args?.auto_offset_cali !== undefined ? Number(args.auto_offset_cali) : 0,
            extruder_cali_manual_mode: args?.extruder_cali_manual_mode !== undefined ? Number(args.extruder_cali_manual_mode) : -1,
            task_ext_change_assist: args?.external_change_assist !== undefined ? Boolean(args.external_change_assist) : false,
            try_emmc_print: args?.try_emmc_print !== undefined ? Boolean(args.try_emmc_print) : false,
        };
        const bridgeResult = await this.bambuNetwork.callWithAgent(bridgeMethod, { client_job_id: clientJobId, params }, this.bridgeOptionsFromArgs(args));
        if (typeof bridgeResult === "object" && bridgeResult !== null && bridgeResult.ok === false) {
            throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} failed: ${String(bridgeResult.error || "unknown bridge error")}`);
        }
        if (typeof bridgeResult === "object" &&
            bridgeResult !== null &&
            typeof bridgeResult.value === "number" &&
            bridgeResult.value !== 0) {
            const value = bridgeResult.value;
            throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} returned non-zero result ${value}.`);
        }
        return {
            status: "success",
            message: `FULU BambuNetwork ${bridgePrintMethod} command for ${threeMfFilename} sent successfully.`,
            bridgeMethod,
            bridgeResult,
            clientJobId,
            autoSliced,
            projectName,
            plateIndex,
            bridgePlateIndex: plateIndex + 1,
            useAMS,
            amsMapping: finalAmsMapping,
            params: redactPrintParams(params),
        };
    }
    setupResourceHandlers() {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return {
                resources: [
                    {
                        uri: `printer://${DEFAULT_HOST}/status`,
                        name: "Bambu Printer Status",
                        mimeType: "application/json",
                        description: "Current status of the Bambu Lab printer"
                    },
                    {
                        uri: `printer://${DEFAULT_HOST}/files`,
                        name: "Bambu Printer Files",
                        mimeType: "application/json",
                        description: "List of files on the Bambu Lab printer"
                    }
                ],
                templates: [
                    {
                        uriTemplate: "printer://{host}/status",
                        name: "Bambu Printer Status",
                        mimeType: "application/json"
                    },
                    {
                        uriTemplate: "printer://{host}/files",
                        name: "Bambu Printer Files",
                        mimeType: "application/json"
                    }
                ]
            };
        });
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const match = uri.match(/^printer:\/\/([^\/]+)\/(.+)$/);
            if (!match) {
                throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
            }
            const [, host, resource] = match;
            const bambuSerial = DEFAULT_BAMBU_SERIAL;
            const bambuToken = DEFAULT_BAMBU_TOKEN;
            let content;
            if (resource === "status") {
                content = await this.bambu.getStatus(host || DEFAULT_HOST, bambuSerial, bambuToken);
            }
            else if (resource === "files") {
                content = await this.bambu.getFiles(host || DEFAULT_HOST, bambuSerial, bambuToken);
            }
            else {
                throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${resource}`);
            }
            return {
                contents: [
                    {
                        uri,
                        mimeType: "application/json",
                        text: JSON.stringify(content, null, 2)
                    }
                ]
            };
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "get_printer_status",
                        description: "Get the current status of the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for the Bambu Lab printer (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for the Bambu Lab printer (default: value from env)"
                                }
                            }
                        }
                    },
                    {
                        name: "extend_stl_base",
                        description: "Extend the base of an STL file by a specified amount",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to modify" },
                                extension_height: { type: "number", description: "Height in mm to extend the base by" }
                            },
                            required: ["stl_path", "extension_height"]
                        }
                    },
                    {
                        name: "scale_stl",
                        description: "Scale an STL file by specified factors",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to scale" },
                                scale_x: { type: "number", description: "Scale factor for X axis (default: 1.0)" },
                                scale_y: { type: "number", description: "Scale factor for Y axis (default: 1.0)" },
                                scale_z: { type: "number", description: "Scale factor for Z axis (default: 1.0)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "rotate_stl",
                        description: "Rotate an STL file by specified angles (degrees)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to rotate" },
                                angle_x: { type: "number", description: "Rotation angle for X axis in degrees (default: 0)" },
                                angle_y: { type: "number", description: "Rotation angle for Y axis in degrees (default: 0)" },
                                angle_z: { type: "number", description: "Rotation angle for Z axis in degrees (default: 0)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "get_stl_info",
                        description: "Get detailed information about an STL file (bounding box, face count, dimensions)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to analyze" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "slice_stl",
                        description: "Slice an STL or 3MF file using a slicer to generate printable G-code or sliced 3MF. IMPORTANT: bambu_model must be specified to ensure the slicer generates safe G-code for the correct printer.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL or 3MF file to slice" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                slicer_type: {
                                    type: "string",
                                    enum: SLICER_SCHEMA_VALUES,
                                    description: "Type of slicer to use. Bambu-compatible choices (bambustudio, orcaslicer, orcaslicer-bambulab) export sliced 3MF; aliases such as fulu-orca and orca-studio are accepted."
                                },
                                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env or a platform default)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file (optional, overrides bambu_model preset)" },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                                uptodate: { type: "boolean", description: "Refresh 3MF preset configs to match the latest Bambu-compatible slicer presets. Use when slicing downloaded or older 3MF files to prevent stale-config failures." },
                                repetitions: { type: "number", description: "Print N identical copies of the model. Each copy gets its own plate placement. Example: 3 prints three copies." },
                                orient: { type: "boolean", description: "Auto-orient the model for optimal printability (minimize supports, maximize bed adhesion). Recommended for raw STL imports that lack a pre-set orientation." },
                                arrange: { type: "boolean", description: "Auto-arrange all objects on the build plate with optimal spacing. Recommended when importing STLs or adding multiple objects. Set false to preserve existing plate layout." },
                                ensure_on_bed: { type: "boolean", description: "Detect models floating above the bed and lower them onto the build surface. Safety net for imported models with incorrect Z origins." },
                                clone_objects: { type: "string", description: "Duplicate specific objects on the plate. Comma-separated clone counts per object index, e.g. '1,3,1,10' clones object 0 once, object 1 three times, etc." },
                                skip_objects: { type: "string", description: "Skip specific objects during slicing by index. Comma-separated, e.g. '3,5,10'. Useful for multi-object 3MFs where you only want to print some parts." },
                                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs, e.g. 'pla_basic.json;petg_cf.json'." },
                                filament_profile: { type: "string", description: "Compatibility alias for load_filaments. Semicolon-separated Orca/Bambu filament profile JSON paths; flat self-contained profiles are safest because Orca does not resolve every inherited system filament setting from arbitrary file paths." },
                                load_filament_ids: { type: "string", description: "Map filaments to objects/parts. Comma-separated IDs matching load_filaments order, e.g. '1,2,3,1' assigns filament 1 to objects 0 and 3." },
                                enable_timelapse: { type: "boolean", description: "Insert timelapse parking moves into gcode. The toolhead parks at a fixed position each layer for camera capture. Adds ~10% print time." },
                                allow_mix_temp: { type: "boolean", description: "Allow filaments with different temperature requirements on the same plate. Required for multi-material prints mixing e.g. PLA and PETG." },
                                scale: { type: "number", description: "Uniform scale factor applied to all axes. 1.0 = original size, 2.0 = double, 0.5 = half. Applied before slicing." },
                                rotate: { type: "number", description: "Rotate the model around the Z-axis (vertical) by this many degrees before slicing. Positive = counterclockwise when viewed from above." },
                                rotate_x: { type: "number", description: "Rotate the model around the X-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                                rotate_y: { type: "number", description: "Rotate the model around the Y-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                                min_save: { type: "boolean", description: "Write a smaller output 3MF by omitting non-essential metadata. Reduces file size for faster FTP upload to the printer." },
                                skip_modified_gcodes: { type: "boolean", description: "Strip custom start/end gcodes embedded in the 3MF. Recommended for downloaded 3MFs since custom gcodes from other users' profiles may be unsafe for your printer." },
                                slice_plate: { type: "number", description: "Which plate index to slice. 0 = all plates (default). Use 1, 2, etc. to slice only a specific plate in multi-plate 3MF projects." }
                            },
                            required: ["stl_path", "bambu_model"]
                        }
                    },
                    {
                        name: "list_printer_files",
                        description: "List files stored on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            }
                        }
                    },
                    {
                        name: "bambu_network_bridge_status",
                        description: "Inspect or probe the FULU OrcaSlicer-bambulab BambuNetwork bridge runtime used for cloud and restored BambuNetwork printing.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                connect: { type: "boolean", description: "When true, start the bridge command and run a handshake plus agent initialization probe." },
                                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND." },
                                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the BambuNetwork agent; defaults to BAMBU_NETWORK_CONFIG_DIR or a user config directory." },
                                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the agent during startup." },
                                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string to pass to net.change_user after the agent starts." },
                                timeout_ms: { type: "number", description: "Bridge request timeout in milliseconds for the connect probe." }
                            }
                        }
                    },
                    {
                        name: "bambu_network_call",
                        description: "Call a raw FULU OrcaSlicer-bambulab BambuNetwork bridge method, optionally with an initialized network agent injected into the payload.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                method: { type: "string", description: "FULU bridge method name, for example bridge.handshake, net.is_user_login, or net.get_user_selected_machine." },
                                payload: { type: "object", description: "JSON payload passed to the bridge method." },
                                with_agent: { type: "boolean", description: "When true, initialize a BambuNetwork agent and add its agent id to the payload before calling the method." },
                                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND." },
                                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the BambuNetwork agent; defaults to BAMBU_NETWORK_CONFIG_DIR or a user config directory." },
                                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the agent during startup." },
                                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string to pass to net.change_user after the agent starts." },
                                timeout_ms: { type: "number", description: "Bridge request timeout in milliseconds." }
                            },
                            required: ["method"]
                        }
                    },
                    {
                        name: "print_3mf_bambu_network",
                        description: "Print a 3MF through FULU OrcaSlicer-bambulab's restored BambuNetwork path instead of the MCP LAN MQTT/FTPS path.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                three_mf_path: { type: "string", description: "Path to the 3MF file to print; unsliced 3MFs are auto-sliced before sending." },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                connection_type: { type: "string", enum: ["cloud", "lan"], description: "BambuNetwork connection type to put in FULU PrintParams; cloud uses restored internet printing, lan uses local bridge printing." },
                                bambu_network_method: { type: "string", enum: BAMBU_NETWORK_PRINT_METHODS, description: "FULU print method to invoke; defaults to start_print for cloud and start_local_print for lan." },
                                dev_id: { type: "string", description: "Bambu device id used by BambuNetwork; defaults to BAMBU_DEV_ID or BAMBU_SERIAL." },
                                dev_ip: { type: "string", description: "Printer IP address for LAN/local bridge methods; defaults to host when provided." },
                                host: { type: "string", description: "Printer host or IP address, used as dev_ip for LAN/local bridge methods." },
                                bambu_serial: { type: "string", description: "Fallback Bambu device id when dev_id is not supplied." },
                                bambu_token: { type: "string", description: "Printer access code/password for LAN/local bridge methods." },
                                username: { type: "string", description: "Printer username for LAN/local bridge methods; defaults to bblp." },
                                password: { type: "string", description: "Printer password/access code override for LAN/local bridge methods." },
                                bed_type: { type: "string", enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"], description: "Bed plate type currently installed (default: textured_plate)." },
                                plate_index: { type: "number", description: "Zero-based plate index to print from the sliced 3MF; converted to FULU's one-based PrintParams plate_index." },
                                project_name: { type: "string", description: "Optional project name sent in FULU PrintParams; defaults to the 3MF filename without extension." },
                                preset_name: { type: "string", description: "Optional preset name sent in FULU PrintParams; defaults to project plus one-based plate index." },
                                task_name: { type: "string", description: "Optional BambuNetwork task name; defaults to the project name." },
                                config_filename: { type: "string", description: "Optional config 3MF path for cloud print; defaults to the same 3MF path." },
                                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND." },
                                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the BambuNetwork agent; defaults to BAMBU_NETWORK_CONFIG_DIR or a user config directory." },
                                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the agent during startup." },
                                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string to pass to net.change_user after the agent starts." },
                                timeout_ms: { type: "number", description: "Bridge request timeout in milliseconds." },
                                slicer_type: { type: "string", enum: SLICER_SCHEMA_VALUES, description: "Slicer to use only if auto-slicing an unsliced 3MF; use orcaslicer-bambulab for FULU's fork." },
                                slicer_path: { type: "string", description: "Path to the slicer executable for auto-slicing; defaults to value from env or a platform default." },
                                slicer_profile: { type: "string", description: "Path to an optional slicer profile/config file for auto-slicing." },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)." },
                                use_ams: { type: "boolean", description: "Whether to use the AMS; defaults to auto-detect from the 3MF mapping." },
                                ams_mapping: { type: "array", description: "AMS slot mapping array used by both local MCP printing and FULU PrintParams.", items: { type: "number" } },
                                ams_mapping_bridge: { type: "string", description: "Raw JSON string override for FULU PrintParams ams_mapping when the automatic array is not enough." },
                                ams_mapping2: { type: "string", description: "Raw JSON string for FULU PrintParams ams_mapping2, matching OrcaSlicer-bambulab's v1 AMS mapping field." },
                                ams_mapping_info: { type: "string", description: "Raw JSON string for FULU PrintParams ams_mapping_info, matching OrcaSlicer-bambulab's detailed AMS mapping field." },
                                nozzle_mapping: { type: "string", description: "Raw JSON string for FULU PrintParams nozzle_mapping." },
                                nozzles_info: { type: "string", description: "Raw JSON string for FULU PrintParams nozzles_info." },
                                bed_leveling: { type: "boolean", description: "Enable auto bed leveling in FULU PrintParams (default: true)." },
                                flow_calibration: { type: "boolean", description: "Enable flow calibration in FULU PrintParams (default: true)." },
                                vibration_calibration: { type: "boolean", description: "Enable vibration calibration in FULU PrintParams (default: true)." },
                                layer_inspect: { type: "boolean", description: "Enable first-layer inspection where supported (default: false for BambuNetwork bridge)." },
                                timelapse: { type: "boolean", description: "Enable timelapse recording in FULU PrintParams (default: false)." },
                                use_ssl_for_ftp: { type: "boolean", description: "Whether FULU local print should use SSL for FTP (default: true)." },
                                use_ssl_for_mqtt: { type: "boolean", description: "Whether FULU local print should use SSL for MQTT (default: true)." },
                                external_change_assist: { type: "boolean", description: "Enable FULU PrintParams task_ext_change_assist for external filament change assistance." },
                                try_emmc_print: { type: "boolean", description: "Enable FULU PrintParams try_emmc_print for printers that support internal storage printing." },
                                extra_options: { type: "string", description: "Raw JSON string or text for FULU PrintParams extra_options." },
                                client_job_id: { type: "number", description: "Optional client job id sent to the bridge; defaults to the current timestamp." }
                            },
                            required: ["three_mf_path", "bambu_model"]
                        }
                    },
                    {
                        name: "upload_gcode",
                        description: "Upload a G-code file to the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name for the file on the printer" },
                                gcode: { type: "string", description: "G-code content to upload, or a readable local .gcode path. For large files, prefer gcode_path." },
                                gcode_path: { type: "string", description: "Local path to a .gcode file to upload. This avoids sending large G-code bodies through the MCP request." },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename"],
                            anyOf: [
                                { required: ["gcode"] },
                                { required: ["gcode_path"] }
                            ]
                        }
                    },
                    {
                        name: "upload_file",
                        description: "Upload a local file to the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                file_path: { type: "string", description: "Local path to the file to upload" },
                                filename: { type: "string", description: "Name for the file on the printer" },
                                print: { type: "boolean", description: "Start printing after upload (default: false)" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "Required when print is true. Bambu Lab printer model used as a safety confirmation before starting the uploaded file."
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["file_path", "filename"]
                        }
                    },
                    {
                        name: "start_print",
                        description: "Start printing a G-code file already on the Bambu Lab printer. Alias of start_print_job for upstream MCP compatibility.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name of the file to print" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Starting G-code for the wrong model can damage the printer."
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename", "bambu_model"]
                        }
                    },
                    {
                        name: "start_print_job",
                        description: "Start printing a G-code file already on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name of the file to print" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Starting G-code for the wrong model can damage the printer."
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename", "bambu_model"]
                        }
                    },
                    {
                        name: "cancel_print",
                        description: "Cancel the current print job on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            }
                        }
                    },
                    {
                        name: "set_temperature",
                        description: "Set the temperature of a printer component (bed, nozzle)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                component: { type: "string", description: "Component to heat: bed, nozzle, or extruder" },
                                temperature: { type: "number", description: "Target temperature in °C" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["component", "temperature"]
                        }
                    },
                    {
                        name: "print_3mf",
                        description: "Print a 3MF file on a Bambu Lab printer. Auto-slices if the 3MF has no gcode. IMPORTANT: bambu_model must be specified to ensure safe printer operation.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                three_mf_path: { type: "string", description: "Path to the 3MF file to print" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                connection_mode: {
                                    type: "string",
                                    enum: ["lan_mqtt_ftps", "bambu_network"],
                                    description: "Print path to use: lan_mqtt_ftps uses this MCP's direct local MQTT/FTPS path; bambu_network uses FULU OrcaSlicer-bambulab's restored BambuNetwork bridge."
                                },
                                connection_type: { type: "string", enum: ["cloud", "lan"], description: "BambuNetwork connection type when connection_mode is bambu_network; cloud uses restored internet printing, lan uses local bridge printing." },
                                bambu_network_method: { type: "string", enum: BAMBU_NETWORK_PRINT_METHODS, description: "FULU print method when connection_mode is bambu_network; defaults to start_print for cloud and start_local_print for lan." },
                                dev_id: { type: "string", description: "Bambu device id for FULU BambuNetwork printing; defaults to BAMBU_DEV_ID or BAMBU_SERIAL." },
                                dev_ip: { type: "string", description: "Printer IP address for FULU BambuNetwork LAN/local print methods; defaults to host when provided." },
                                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND." },
                                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the FULU BambuNetwork agent." },
                                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the FULU bridge agent." },
                                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string passed to net.change_user for the FULU bridge." },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type currently installed (default: textured_plate)"
                                },
                                plate_index: { type: "number", description: "Zero-based plate index to print from the sliced 3MF (default: 0)" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                                slicer_type: {
                                    type: "string",
                                    enum: SLICER_SCHEMA_VALUES,
                                    description: "Slicer to use only if auto-slicing an unsliced 3MF. Use orcaslicer-bambulab for FULU's OrcaSlicer-bambulab fork; aliases such as fulu-orca and orca-studio are accepted."
                                },
                                slicer_path: { type: "string", description: "Path to the slicer executable for auto-slicing (default: value from env or a platform default)" },
                                slicer_profile: { type: "string", description: "Path to an optional slicer profile/config file for auto-slicing" },
                                use_ams: { type: "boolean", description: "Whether to use the AMS (default: auto-detect from 3MF)" },
                                ams_mapping: {
                                    type: "array",
                                    description: "AMS slot mapping array, e.g. [0, 2] maps filaments to AMS slots 0 and 2",
                                    items: { type: "number" }
                                },
                                bed_leveling: { type: "boolean", description: "Enable auto bed leveling (default: true)" },
                                flow_calibration: { type: "boolean", description: "Enable flow calibration (default: true)" },
                                vibration_calibration: { type: "boolean", description: "Enable vibration calibration (default: true)" },
                                layer_inspect: { type: "boolean", description: "Enable first-layer inspection where supported (default: printer/profile behavior)" },
                                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" }
                            },
                            required: ["three_mf_path", "bambu_model"]
                        }
                    },
                    {
                        name: "merge_vertices",
                        description: "Merge vertices in an STL file closer than the specified tolerance",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" },
                                tolerance: { type: "number", description: "Max distance to merge (mm, default: 0.01)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "center_model",
                        description: "Translate the model so its geometric center is at the origin (0,0,0)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "lay_flat",
                        description: "Rotate the model so its largest flat face lies on the XY plane (Z=0)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "blender_mcp_edit_model",
                        description: "Send STL-edit instructions to a Blender MCP bridge command for advanced model edits",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the local STL file" },
                                operations: {
                                    type: "array",
                                    description: "Ordered edit operations for Blender (e.g. remesh, boolean, decimate)",
                                    items: { type: "string" }
                                },
                                bridge_command: { type: "string", description: "Override command for invoking Blender MCP bridge" },
                                execute: { type: "boolean", description: "Execute bridge command (true) or return payload only (false)" }
                            },
                            required: ["stl_path", "operations"]
                        }
                    }
                ]
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const host = String(args?.host || DEFAULT_HOST);
            const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
            const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
            try {
                let result;
                switch (name) {
                    case "get_printer_status":
                        result = await this.bambu.getStatus(host, bambuSerial, bambuToken);
                        break;
                    case "list_printer_files":
                        result = await this.bambu.getFiles(host, bambuSerial, bambuToken);
                        break;
                    case "bambu_network_bridge_status": {
                        const bridgeArgs = args;
                        const options = this.bridgeOptionsFromArgs(bridgeArgs);
                        result = this.bambuNetwork.getStatus(options);
                        if (Boolean(bridgeArgs?.connect)) {
                            const probe = await this.bambuNetwork.ensureAgent(options);
                            result = {
                                ...this.bambuNetwork.getStatus(options),
                                connected: true,
                                agent: probe.agent,
                                handshake: probe.handshake,
                            };
                        }
                        break;
                    }
                    case "bambu_network_call": {
                        if (!args?.method) {
                            throw new Error("Missing required parameter: method");
                        }
                        const bridgeArgs = args;
                        const payload = bridgeArgs.payload && typeof bridgeArgs.payload === "object"
                            ? bridgeArgs.payload
                            : {};
                        const options = this.bridgeOptionsFromArgs(bridgeArgs);
                        result = bridgeArgs.with_agent === false
                            ? await this.bambuNetwork.request(String(bridgeArgs.method), payload, options)
                            : await this.bambuNetwork.callWithAgent(String(bridgeArgs.method), payload, options);
                        break;
                    }
                    case "print_3mf_bambu_network": {
                        result = await this.print3mfViaBambuNetwork(args, host, bambuSerial, bambuToken);
                        break;
                    }
                    case "upload_gcode": {
                        if (!args?.filename) {
                            throw new Error("Missing required parameter: filename");
                        }
                        const uploadSource = resolveUploadGcodeSource(args);
                        try {
                            result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, uploadSource.filePath, String(args.filename), false);
                        }
                        finally {
                            if (uploadSource.cleanupDir) {
                                fs.rmSync(uploadSource.cleanupDir, { recursive: true, force: true });
                            }
                        }
                        break;
                    }
                    case "upload_file":
                        if (!args?.file_path || !args?.filename) {
                            throw new Error("Missing required parameters: file_path and filename");
                        }
                        if (Boolean(args.print ?? false)) {
                            await this.resolveBambuModel(args?.bambu_model);
                        }
                        result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, String(args.file_path), String(args.filename), Boolean(args.print ?? false));
                        break;
                    case "start_print":
                    case "start_print_job":
                        if (!args?.filename) {
                            throw new Error("Missing required parameter: filename");
                        }
                        await this.resolveBambuModel(args?.bambu_model);
                        result = await this.bambu.startJob(host, bambuSerial, bambuToken, String(args.filename));
                        break;
                    case "cancel_print":
                        result = await this.bambu.cancelJob(host, bambuSerial, bambuToken);
                        break;
                    case "set_temperature":
                        if (!args?.component || args?.temperature === undefined) {
                            throw new Error("Missing required parameters: component and temperature");
                        }
                        result = await this.bambu.setTemperature(host, bambuSerial, bambuToken, String(args.component), Number(args.temperature));
                        break;
                    case "extend_stl_base":
                        if (!args?.stl_path || args?.extension_height === undefined) {
                            throw new Error("Missing required parameters: stl_path and extension_height");
                        }
                        result = await this.stlManipulator.extendBase(String(args.stl_path), Number(args.extension_height));
                        break;
                    case "scale_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.scaleSTL(String(args.stl_path), [
                            args.scale_x !== undefined ? Number(args.scale_x) : 1.0,
                            args.scale_y !== undefined ? Number(args.scale_y) : 1.0,
                            args.scale_z !== undefined ? Number(args.scale_z) : 1.0,
                        ]);
                        break;
                    case "rotate_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.rotateSTL(String(args.stl_path), [
                            args.angle_x !== undefined ? Number(args.angle_x) : 0,
                            args.angle_y !== undefined ? Number(args.angle_y) : 0,
                            args.angle_z !== undefined ? Number(args.angle_z) : 0,
                        ]);
                        break;
                    case "get_stl_info":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.getSTLInfo(String(args.stl_path));
                        break;
                    case "slice_stl": {
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        const { slicerType, slicerPath, slicerProfile } = resolveSlicerConfig(args);
                        const sliceModel = await this.resolveBambuModel(args?.bambu_model);
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        // Resolve printer preset for BambuStudio slicer
                        const printerPreset = BAMBU_MODEL_PRESETS[sliceModel]?.(nozzleDiam);
                        const sliceBambuOptions = {};
                        if (args?.uptodate !== undefined)
                            sliceBambuOptions.uptodate = Boolean(args.uptodate);
                        if (args?.repetitions !== undefined)
                            sliceBambuOptions.repetitions = Number(args.repetitions);
                        if (args?.orient !== undefined)
                            sliceBambuOptions.orient = Boolean(args.orient);
                        if (args?.arrange !== undefined)
                            sliceBambuOptions.arrange = Boolean(args.arrange);
                        if (args?.ensure_on_bed !== undefined)
                            sliceBambuOptions.ensureOnBed = Boolean(args.ensure_on_bed);
                        if (args?.clone_objects !== undefined)
                            sliceBambuOptions.cloneObjects = String(args.clone_objects);
                        if (args?.skip_objects !== undefined)
                            sliceBambuOptions.skipObjects = String(args.skip_objects);
                        if (args?.load_filaments !== undefined &&
                            args?.filament_profile !== undefined &&
                            String(args.load_filaments) !== String(args.filament_profile)) {
                            throw new Error("Provide either load_filaments or filament_profile, not conflicting values.");
                        }
                        if (args?.load_filaments !== undefined) {
                            sliceBambuOptions.loadFilaments = String(args.load_filaments);
                        }
                        else if (args?.filament_profile !== undefined) {
                            sliceBambuOptions.loadFilaments = String(args.filament_profile);
                        }
                        if (args?.load_filament_ids !== undefined)
                            sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
                        if (args?.enable_timelapse !== undefined)
                            sliceBambuOptions.enableTimelapse = Boolean(args.enable_timelapse);
                        if (args?.allow_mix_temp !== undefined)
                            sliceBambuOptions.allowMixTemp = Boolean(args.allow_mix_temp);
                        if (args?.scale !== undefined)
                            sliceBambuOptions.scale = Number(args.scale);
                        if (args?.rotate !== undefined)
                            sliceBambuOptions.rotate = Number(args.rotate);
                        if (args?.rotate_x !== undefined)
                            sliceBambuOptions.rotateX = Number(args.rotate_x);
                        if (args?.rotate_y !== undefined)
                            sliceBambuOptions.rotateY = Number(args.rotate_y);
                        if (args?.min_save !== undefined)
                            sliceBambuOptions.minSave = Boolean(args.min_save);
                        if (args?.skip_modified_gcodes !== undefined)
                            sliceBambuOptions.skipModifiedGcodes = Boolean(args.skip_modified_gcodes);
                        if (args?.slice_plate !== undefined)
                            sliceBambuOptions.slicePlate = Number(args.slice_plate);
                        result = await this.stlManipulator.sliceSTL(String(args.stl_path), slicerType, slicerPath, slicerProfile || undefined, undefined, // progressCallback
                        printerPreset, sliceBambuOptions);
                        break;
                    }
                    case "print_3mf": {
                        if (!args?.three_mf_path) {
                            throw new Error("Missing required parameter: three_mf_path");
                        }
                        if (String(args?.connection_mode || "lan_mqtt_ftps") === "bambu_network") {
                            result = await this.print3mfViaBambuNetwork(args, host, bambuSerial, bambuToken);
                            break;
                        }
                        if (!bambuSerial || !bambuToken) {
                            throw new Error("Bambu serial number and access token are required for print_3mf.");
                        }
                        const { slicerType, slicerPath, slicerProfile } = resolveSlicerConfig(args);
                        const printModel = await this.resolveBambuModel(args?.bambu_model);
                        const printBedType = resolveBedType(args?.bed_type);
                        const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
                        const plateIndex = args?.plate_index !== undefined ? Number(args.plate_index) : 0;
                        if (!Number.isInteger(plateIndex) || plateIndex < 0) {
                            throw new Error("plate_index must be a non-negative integer.");
                        }
                        let threeMFPath = String(args.three_mf_path);
                        // Auto-slice if 3MF has no gcode
                        try {
                            const JSZip = (await import('jszip')).default;
                            const zipData = fs.readFileSync(threeMFPath);
                            const zip = await JSZip.loadAsync(zipData);
                            const hasGcode = Object.keys(zip.files).some(f => f.match(/Metadata\/plate_\d+\.gcode/i) || f.endsWith('.gcode'));
                            if (!hasGcode) {
                                console.log(`3MF has no gcode - auto-slicing with ${slicerType} for ${printModel}`);
                                const autoSliceOptions = {
                                    uptodate: true,
                                    ensureOnBed: true,
                                    minSave: true,
                                    skipModifiedGcodes: true,
                                };
                                threeMFPath = await this.stlManipulator.sliceSTL(threeMFPath, slicerType, slicerPath, slicerProfile || undefined, undefined, // progressCallback
                                printPreset, autoSliceOptions);
                                console.log("Auto-sliced to: " + threeMFPath);
                            }
                        }
                        catch (sliceCheckErr) {
                            console.warn("Could not check/slice 3MF, proceeding with original:", sliceCheckErr.message);
                        }
                        const parsed3MFData = await parse3MF(threeMFPath);
                        let parsedAmsMapping;
                        if (parsed3MFData.slicerConfig?.ams_mapping) {
                            const slots = Object.values(parsed3MFData.slicerConfig.ams_mapping)
                                .filter(v => typeof v === 'number');
                            if (slots.length > 0) {
                                parsedAmsMapping = slots.sort((a, b) => a - b);
                            }
                        }
                        let finalAmsMapping = parsedAmsMapping;
                        const explicitUseAMS = args?.use_ams !== undefined;
                        let useAMS = explicitUseAMS ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
                        if (args?.ams_mapping) {
                            let userMappingOverride;
                            if (Array.isArray(args.ams_mapping)) {
                                userMappingOverride = args.ams_mapping.filter((v) => typeof v === 'number');
                            }
                            else if (typeof args.ams_mapping === 'object') {
                                userMappingOverride = Object.values(args.ams_mapping)
                                    .filter((v) => typeof v === 'number')
                                    .sort((a, b) => a - b);
                            }
                            if (userMappingOverride && userMappingOverride.length > 0) {
                                finalAmsMapping = userMappingOverride;
                                useAMS = true;
                            }
                        }
                        if (args?.use_ams === false) {
                            finalAmsMapping = undefined;
                            useAMS = false;
                        }
                        if ((!finalAmsMapping || finalAmsMapping.length === 0) && !explicitUseAMS) {
                            useAMS = false;
                        }
                        const threeMfFilename = path.basename(threeMFPath);
                        const projectName = threeMfFilename.replace(/\.3mf$/i, '');
                        result = await this.bambu.print3mf(host, bambuSerial, bambuToken, {
                            projectName,
                            filePath: threeMFPath,
                            plateIndex,
                            useAMS: useAMS,
                            amsMapping: finalAmsMapping,
                            bedType: printBedType,
                            bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                            flowCalibration: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                            vibrationCalibration: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : undefined,
                            layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                            timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
                        });
                        result = `Print command for ${threeMfFilename} sent successfully.`;
                        break;
                    }
                    case "merge_vertices":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.mergeVertices(String(args.stl_path), args.tolerance !== undefined ? Number(args.tolerance) : undefined);
                        break;
                    case "center_model":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.centerModel(String(args.stl_path));
                        break;
                    case "lay_flat":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.layFlat(String(args.stl_path));
                        break;
                    case "blender_mcp_edit_model":
                        if (!args?.stl_path || !Array.isArray(args.operations)) {
                            throw new Error("Missing required parameters: stl_path and operations");
                        }
                        result = await this.invokeBlenderBridge({
                            stlPath: String(args.stl_path),
                            operations: args.operations.map((entry) => String(entry)),
                            execute: Boolean(args.execute ?? false),
                            bridgeCommand: args.bridge_command
                                ? String(args.bridge_command)
                                : this.runtimeConfig.blenderBridgeCommand,
                        });
                        break;
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
                }
                const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                if (this.runtimeConfig.enableJsonResponse && typeof result === "object") {
                    return {
                        content: [{ type: "text", text }],
                        structuredContent: result,
                    };
                }
                return { content: [{ type: "text", text }] };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const structured = {
                    status: "error",
                    retryable: false,
                    suggestion: `Check parameters and try again. Error: ${message}`,
                    message,
                    tool: name,
                };
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    structuredContent: structured,
                    isError: true,
                };
            }
        });
    }
    async invokeBlenderBridge(params) {
        const payload = {
            stlPath: params.stlPath,
            operations: params.operations,
        };
        if (!params.execute || !params.bridgeCommand) {
            return {
                status: "prepared",
                payload,
                note: params.bridgeCommand
                    ? "Set execute=true to run the Blender bridge command."
                    : "No BLENDER_MCP_BRIDGE_COMMAND configured. Set the env var or pass bridge_command.",
            };
        }
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync(params.bridgeCommand, [], {
            env: { ...process.env, MCP_BLENDER_PAYLOAD: JSON.stringify(payload) },
            timeout: 120000,
        });
        return {
            status: "executed",
            stdout: stdout.trim(),
            stderr: stderr.trim(),
        };
    }
    async startStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Bambu Printer MCP server running on stdio");
    }
    async startHttp() {
        const { httpHost, httpPort, httpPath, statefulSession, enableJsonResponse, allowedOrigins } = this.runtimeConfig;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: statefulSession ? () => randomUUID() : undefined,
            enableJsonResponse,
        });
        await this.server.connect(transport);
        const httpServer = createHttpServer(async (req, res) => {
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            if (url.pathname !== httpPath) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            if (allowedOrigins.size > 0) {
                const origin = req.headers.origin ?? "";
                if (origin && !allowedOrigins.has(origin)) {
                    res.writeHead(403);
                    res.end("Forbidden");
                    return;
                }
            }
            await transport.handleRequest(req, res);
        });
        httpServer.listen(httpPort, httpHost, () => {
            console.error(`Bambu Printer MCP server running on http://${httpHost}:${httpPort}${httpPath}`);
        });
        this.httpRuntime = { transport, httpServer };
    }
    async run() {
        if (this.runtimeConfig.transport === "streamable-http") {
            await this.startHttp();
        }
        else {
            await this.startStdio();
        }
    }
}
const server = new BambuPrinterMCPServer();
server.run().catch(console.error);
