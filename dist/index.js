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
import { STLManipulator } from "./stl/stl-manipulator.js";
import { analyze3MFAmsRequirements, analyze3MFPlateObjects, analyzeCollarCharm3MF, extractBambuTemplateSettings, getCollarCharmRolePolicy, parse3MF } from './3mf_parser.js';
import { BambuImplementation } from "./printers/bambu.js";
dotenv.config();
const DEFAULT_HOST = process.env.BAMBU_PRINTER_HOST || process.env.PRINTER_HOST || "localhost";
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_PRINTER_SERIAL || process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_PRINTER_ACCESS_TOKEN || process.env.BAMBU_TOKEN || "";
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), "temp");
// Printer model and bed type
const DEFAULT_BAMBU_MODEL = process.env.BAMBU_PRINTER_MODEL?.trim().toLowerCase() ||
    process.env.BAMBU_MODEL?.trim().toLowerCase() ||
    "";
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";
const VALID_BAMBU_MODELS = ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"];
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
    h2s: (n) => `Bambu Lab H2S ${n} nozzle`,
};
const FILAMENT_PROFILE_DIR = "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament";
const FILAMENT_MODEL_CODES = {
    p1s: "P1S",
    p1p: "P1P",
    x1c: "X1C",
    x1e: "X1E",
    a1: "A1",
    a1mini: "A1M",
    h2d: "H2D",
    h2s: "H2S",
};
const COLLAR_CHARM_POLICY = getCollarCharmRolePolicy();
let filamentProfileIndexCache = null;
function buildFilamentProfileIndex() {
    const byName = new Map();
    const baseNameByFilamentId = new Map();
    if (!fs.existsSync(FILAMENT_PROFILE_DIR)) {
        return { byName, baseNameByFilamentId };
    }
    for (const entry of fs.readdirSync(FILAMENT_PROFILE_DIR)) {
        if (!entry.endsWith(".json"))
            continue;
        const filePath = path.join(FILAMENT_PROFILE_DIR, entry);
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
            const filamentId = typeof parsed?.filament_id === "string" ? parsed.filament_id.trim() : "";
            if (name) {
                byName.set(name, filePath);
            }
            if (name && filamentId) {
                baseNameByFilamentId.set(filamentId, name);
            }
        }
        catch {
            // Ignore malformed or non-profile JSON files.
        }
    }
    return { byName, baseNameByFilamentId };
}
function getFilamentProfileIndex() {
    if (!filamentProfileIndexCache) {
        filamentProfileIndexCache = buildFilamentProfileIndex();
    }
    return filamentProfileIndexCache;
}
function resolveFilamentProfileCandidates(trayInfoIdx, bambuModel, nozzleDiameter) {
    const index = getFilamentProfileIndex();
    const baseName = index.baseNameByFilamentId.get(trayInfoIdx) || null;
    if (!baseName) {
        return { baseName: null, paths: [] };
    }
    const bareName = baseName.replace(/\s*@base$/, "");
    const modelCode = bambuModel ? FILAMENT_MODEL_CODES[bambuModel] : undefined;
    const candidateNames = [];
    if (modelCode && nozzleDiameter) {
        candidateNames.push(`${bareName} @BBL ${modelCode} ${nozzleDiameter} nozzle`);
    }
    if (modelCode) {
        candidateNames.push(`${bareName} @BBL ${modelCode}`);
    }
    candidateNames.push(bareName, baseName);
    const resolvedPaths = Array.from(new Set(candidateNames
        .map((candidate) => index.byName.get(candidate))
        .filter((candidate) => Boolean(candidate))));
    return { baseName, paths: resolvedPaths };
}
function parseIntegerOrNull(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}
function normalizePrinterFilamentInventory(status, bambuModel, nozzleDiameter) {
    const rawAms = status?.raw?.ams || status?.ams || {};
    const trayNow = parseIntegerOrNull(rawAms?.tray_now);
    const trays = [];
    const amsArray = Array.isArray(rawAms?.ams) ? rawAms.ams : [];
    for (const [amsIndex, amsUnit] of amsArray.entries()) {
        const trayArray = Array.isArray(amsUnit?.tray) ? amsUnit.tray : [];
        for (const [trayIndex, tray] of trayArray.entries()) {
            const amsId = parseIntegerOrNull(amsUnit?.id) ?? amsIndex;
            const trayId = parseIntegerOrNull(tray?.id) ?? trayIndex;
            const slot = amsId !== null && trayId !== null ? amsId * 4 + trayId : null;
            const state = parseIntegerOrNull(tray?.state) ?? 0;
            const trayInfoIdx = typeof tray?.tray_info_idx === "string" ? tray.tray_info_idx : null;
            const profileResolution = trayInfoIdx
                ? resolveFilamentProfileCandidates(trayInfoIdx, bambuModel, nozzleDiameter)
                : { baseName: null, paths: [] };
            trays.push({
                ams_id: amsId,
                tray_id: trayId,
                slot,
                state,
                loaded: state !== 0 && Boolean(trayInfoIdx),
                tray_info_idx: trayInfoIdx,
                tray_type: typeof tray?.tray_type === "string" ? tray.tray_type : null,
                tray_sub_brands: typeof tray?.tray_sub_brands === "string" ? tray.tray_sub_brands : null,
                tray_color: typeof tray?.tray_color === "string" ? tray.tray_color : null,
                remain_percent: typeof tray?.remain === "number" && tray.remain >= 0 ? tray.remain : null,
                nozzle_temp_min: parseIntegerOrNull(tray?.nozzle_temp_min),
                nozzle_temp_max: parseIntegerOrNull(tray?.nozzle_temp_max),
                resolved_base_profile_name: profileResolution.baseName,
                resolved_profile_path: profileResolution.paths[0] || null,
                profile_candidates: profileResolution.paths,
            });
        }
    }
    const loadedTrays = trays.filter((tray) => tray.loaded);
    const recommendedTray = loadedTrays.find((tray) => tray.slot === trayNow && tray.resolved_profile_path) ||
        loadedTrays.find((tray) => tray.resolved_profile_path) ||
        null;
    const allProfilePaths = Array.from(new Set(loadedTrays
        .flatMap((tray) => tray.profile_candidates)
        .filter((candidate) => Boolean(candidate))));
    return {
        current_slot: trayNow !== null && trayNow >= 0 && trayNow < 254 ? trayNow : null,
        current_source: trayNow === 254 ? "external" : trayNow !== null && trayNow >= 0 && trayNow < 254 ? "ams" : null,
        trays,
        recommended: recommendedTray
            ? {
                slot: recommendedTray.slot,
                tray_info_idx: recommendedTray.tray_info_idx,
                tray_type: recommendedTray.tray_type,
                resolved_profile_path: recommendedTray.resolved_profile_path,
                load_filaments: recommendedTray.resolved_profile_path,
            }
            : null,
        load_filaments_all: allProfilePaths.length > 0 ? allProfilePaths.join(";") : null,
    };
}
function resolveAmsSlotsFromRequirements(requirements, inventory) {
    const matches = [];
    const missing = [];
    const amsSlots = [];
    for (const filament of requirements.filaments) {
        if (!filament.tray_info_idx) {
            missing.push({
                filament_position: filament.filamentPosition,
                tray_info_idx: null,
            });
            continue;
        }
        const tray = inventory.trays.find((candidate) => candidate.loaded &&
            candidate.slot !== null &&
            candidate.tray_info_idx === filament.tray_info_idx);
        if (!tray || tray.slot === null) {
            missing.push({
                filament_position: filament.filamentPosition,
                tray_info_idx: filament.tray_info_idx,
            });
            continue;
        }
        amsSlots.push(tray.slot);
        matches.push({
            filament_position: filament.filamentPosition,
            tray_info_idx: filament.tray_info_idx,
            slot: tray.slot,
        });
    }
    return { ams_slots: amsSlots, matches, missing };
}
function extractPrinterDiagnostics(status) {
    const raw = status?.raw && typeof status.raw === "object" ? status.raw : {};
    const diagnosticFields = {};
    for (const [key, value] of Object.entries(raw)) {
        if (/(hms|error|fail|warn)/i.test(key)) {
            diagnosticFields[key] = value;
        }
    }
    return {
        connected: Boolean(status?.connected),
        serial: status?.serial ?? null,
        printer_status: status?.status ?? null,
        active_error: raw.print_error ??
            raw.print_error_code ??
            raw.mc_print_error_code ??
            raw.fail_reason ??
            null,
        hms: raw.hms ?? raw.hms_info ?? raw.hms_list ?? null,
        diagnostic_fields: diagnosticFields,
    };
}
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
const DEFAULT_SLICER_PATH = process.env.BAMBU_STUDIO_PATH ||
    process.env.SLICER_PATH ||
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
const DEFAULT_SLICER_PROFILE = process.env.BAMBU_SLICER_PROFILE || process.env.SLICER_PROFILE || "";
const DEFAULT_TEMPLATE_3MF_PATH = process.env.BAMBU_TEMPLATE_3MF_PATH || "";
const DEFAULT_TEMPLATE_DIR = process.env.BAMBU_TEMPLATE_DIR ||
    path.join(process.env.HOME || process.cwd(), "Sync", "bambu", "templates");
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
async function resolveSlicerProfilePath(requestedProfile, template3mfPath, tempDir) {
    if (requestedProfile) {
        return requestedProfile;
    }
    if (template3mfPath) {
        return extractBambuTemplateSettings(template3mfPath, tempDir);
    }
    return undefined;
}
function hasExplicitSlicerProfile(args) {
    return typeof args?.slicer_profile === "string" && args.slicer_profile.trim().length > 0;
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
function parseLooseSlicerConfig(content) {
    try {
        return JSON.parse(content);
    }
    catch {
        const config = {};
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
                continue;
            const separatorIndex = trimmed.indexOf("=");
            if (separatorIndex === -1)
                continue;
            const key = trimmed.slice(0, separatorIndex).trim();
            const value = trimmed.slice(separatorIndex + 1).trim();
            if (key) {
                config[key] = value;
            }
        }
        return config;
    }
}
function summarizeSliceSettings(config) {
    return {
        printer_settings_id: typeof config.printer_settings_id === "string" ? config.printer_settings_id : null,
        default_print_profile: typeof config.default_print_profile === "string" ? config.default_print_profile : null,
        default_filament_profile: Array.isArray(config.default_filament_profile)
            ? config.default_filament_profile
            : typeof config.default_filament_profile === "string"
                ? [config.default_filament_profile]
                : [],
        filament_settings_id: Array.isArray(config.filament_settings_id)
            ? config.filament_settings_id.filter((value) => typeof value === "string" && value.length > 0)
            : [],
        filament_type: Array.isArray(config.filament_type)
            ? config.filament_type.filter((value) => typeof value === "string" && value.length > 0)
            : [],
        inherits: typeof config.inherits === "string" ? config.inherits : null,
        print_settings_id: typeof config.print_settings_id === "string" ? config.print_settings_id : null,
        compatible_printers: Array.isArray(config.compatible_printers)
            ? config.compatible_printers.filter((value) => typeof value === "string" && value.length > 0)
            : [],
        layer_height: config.layer_height !== undefined && config.layer_height !== null
            ? Number(config.layer_height)
            : null,
        first_layer_height: config.initial_layer_print_height !== undefined && config.initial_layer_print_height !== null
            ? Number(config.initial_layer_print_height)
            : config.first_layer_height !== undefined && config.first_layer_height !== null
                ? Number(config.first_layer_height)
                : null,
        sparse_infill_density: config.sparse_infill_density !== undefined && config.sparse_infill_density !== null
            ? String(config.sparse_infill_density)
            : null,
        wall_loops: config.wall_loops !== undefined && config.wall_loops !== null
            ? Number(config.wall_loops)
            : null,
        top_shell_layers: config.top_shell_layers !== undefined && config.top_shell_layers !== null
            ? Number(config.top_shell_layers)
            : null,
        bottom_shell_layers: config.bottom_shell_layers !== undefined && config.bottom_shell_layers !== null
            ? Number(config.bottom_shell_layers)
            : null,
        brim_width: config.brim_width !== undefined && config.brim_width !== null
            ? Number(config.brim_width)
            : null,
        support_enabled: config.enable_support !== undefined
            ? String(config.enable_support) === "1" || String(config.enable_support).toLowerCase() === "true"
            : config.support_enabled !== undefined
                ? Boolean(config.support_enabled)
                : null,
        support_type: typeof config.support_type === "string" ? config.support_type : null,
        bed_type: typeof config.curr_bed_type === "string"
            ? config.curr_bed_type
            : typeof config.bed_type === "string"
                ? config.bed_type
                : null,
        nozzle_temperature: Array.isArray(config.nozzle_temperature)
            ? config.nozzle_temperature
            : config.nozzle_temperature !== undefined
                ? [config.nozzle_temperature]
                : [],
    };
}
function sanitizeTemplateName(templateName) {
    return templateName
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9/_-]/g, "_");
}
function scanTemplateRegistry(templateDir) {
    if (!fs.existsSync(templateDir)) {
        return [];
    }
    const allowedExtensions = new Set([".3mf", ".json", ".config"]);
    const entries = [];
    const stack = [templateDir];
    while (stack.length > 0) {
        const currentDir = stack.pop();
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            const extension = path.extname(entry.name).toLowerCase();
            if (!allowedExtensions.has(extension)) {
                continue;
            }
            const relativePath = path.relative(templateDir, fullPath);
            const templateName = relativePath
                .replace(/\\/g, "/")
                .replace(/(\.gcode)?\.3mf$/i, "")
                .replace(/\.(json|config)$/i, "");
            entries.push({
                name: templateName,
                path: fullPath,
                source_type: extension === ".3mf" ? "3mf" : extension === ".json" ? "json" : "config",
                relative_path: relativePath,
            });
        }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
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
        // No model from args or env — ask the user via elicitation
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
                                { const: "h2s", title: "H2S" },
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
            // Elicitation not supported by this client — fall back to a clear error
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
    async getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, bambuModel, nozzleDiameter) {
        const status = await this.bambu.getStatus(host, bambuSerial, bambuToken);
        return normalizePrinterFilamentInventory(status, bambuModel, nozzleDiameter);
    }
    async inspectSliceSettings(sourcePath) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Slice settings source not found: ${sourcePath}`);
        }
        const extension = path.extname(sourcePath).toLowerCase();
        const tempDir = path.join(TEMP_DIR, "slice-settings");
        fs.mkdirSync(tempDir, { recursive: true });
        if (extension === ".3mf") {
            const parsed = await parse3MF(sourcePath);
            const extractedSettingsPath = await extractBambuTemplateSettings(sourcePath, tempDir);
            const config = (parsed.slicerConfig || {});
            return {
                source_path: sourcePath,
                source_type: "3mf",
                extracted_settings_path: extractedSettingsPath,
                object_count: parsed.objects.length,
                build_item_count: parsed.build.items.length,
                metadata_keys: Object.keys(parsed.metadata),
                summary: summarizeSliceSettings(config),
                raw_key_count: Object.keys(config).length,
            };
        }
        const content = fs.readFileSync(sourcePath, "utf8");
        const config = parseLooseSlicerConfig(content);
        return {
            source_path: sourcePath,
            source_type: extension === ".json" ? "json" : extension === ".config" ? "config" : "text",
            extracted_settings_path: sourcePath,
            summary: summarizeSliceSettings(config),
            raw_key_count: Object.keys(config).length,
        };
    }
    async resolveCollarCharmPrepared3MF(sourcePath, template3mfPath, slicerType, slicerPath, slicerProfile, printModel, printNozzle, bedType, host, bambuSerial, bambuToken) {
        if (!sourcePath.toLowerCase().endsWith(".3mf")) {
            throw new Error("print_collar_charm requires a prepared .3mf project or sliced 3MF.");
        }
        try {
            const JSZip = (await import('jszip')).default;
            const zipData = fs.readFileSync(sourcePath);
            const zip = await JSZip.loadAsync(zipData);
            const hasGcode = Object.keys(zip.files).some((fileName) => fileName.match(/Metadata\/plate_\d+\.gcode/i) || fileName.endsWith('.gcode'));
            if (hasGcode) {
                return sourcePath;
            }
        }
        catch (error) {
            throw new Error(`Failed to inspect collar charm 3MF before slicing: ${error.message}`);
        }
        const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
        const autoSliceOptions = {
            uptodate: true,
            ensureOnBed: true,
            minSave: true,
            skipModifiedGcodes: true,
            bedType,
        };
        try {
            const liveFilaments = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, printModel, printNozzle);
            if (liveFilaments.recommended?.load_filaments) {
                autoSliceOptions.loadFilaments = liveFilaments.recommended.load_filaments;
            }
        }
        catch (filamentError) {
            console.warn("Could not resolve live printer filaments for collar charm auto-slicing:", filamentError);
        }
        return this.stlManipulator.sliceSTL(sourcePath, slicerType, slicerPath, slicerProfile || template3mfPath || undefined, undefined, printPreset, autoSliceOptions);
    }
    async preflightCollarCharmPolicy(host, bambuSerial, bambuToken, bambuModel, nozzleDiameter) {
        const inventory = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, bambuModel, nozzleDiameter);
        const requiredSlots = [COLLAR_CHARM_POLICY.amsSlots.inner, COLLAR_CHARM_POLICY.amsSlots.outer];
        for (const slot of requiredSlots) {
            const tray = inventory.trays.find((candidate) => candidate.slot === slot);
            if (!tray) {
                throw new Error(`Collar charm wrapper requires AMS tray ${slot}, but that tray is not reported by the printer.`);
            }
            if (!tray.loaded) {
                throw new Error(`Collar charm wrapper requires AMS tray ${slot} to be loaded, but it is currently empty or unavailable.`);
            }
        }
        return inventory;
    }
    listTemplateRegistry(templateDir) {
        const resolvedTemplateDir = templateDir && templateDir.trim().length > 0
            ? templateDir
            : DEFAULT_TEMPLATE_DIR;
        return {
            template_dir: resolvedTemplateDir,
            templates: scanTemplateRegistry(resolvedTemplateDir),
        };
    }
    resolveTemplatePath(templateName, templateDir) {
        if (!templateName || templateName.trim().length === 0) {
            return undefined;
        }
        const registry = this.listTemplateRegistry(templateDir);
        const normalizedName = sanitizeTemplateName(templateName).toLowerCase();
        const match = registry.templates.find((entry) => entry.name.toLowerCase() === normalizedName);
        if (!match) {
            throw new Error(`Template "${templateName}" not found in ${registry.template_dir}.`);
        }
        return match.path;
    }
    saveTemplate(sourcePath, templateName, templateDir) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Template source not found: ${sourcePath}`);
        }
        const resolvedTemplateDir = templateDir && templateDir.trim().length > 0
            ? templateDir
            : DEFAULT_TEMPLATE_DIR;
        fs.mkdirSync(resolvedTemplateDir, { recursive: true });
        const sourceBaseName = path.basename(sourcePath);
        const extension = path.extname(sourceBaseName).toLowerCase();
        if (![".3mf", ".json", ".config"].includes(extension)) {
            throw new Error("Templates must be .3mf, .json, or .config files.");
        }
        const baseName = templateName && templateName.trim().length > 0
            ? sanitizeTemplateName(templateName)
            : sanitizeTemplateName(sourceBaseName
                .replace(/(\.gcode)?\.3mf$/i, "")
                .replace(/\.(json|config)$/i, ""));
        const destinationPath = path.join(resolvedTemplateDir, `${baseName}${extension}`);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        const registryEntry = this.resolveTemplatePath(baseName, resolvedTemplateDir);
        return {
            saved: true,
            template_name: baseName,
            source_path: sourcePath,
            destination_path: destinationPath,
            template_dir: resolvedTemplateDir,
            resolved_path: registryEntry,
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
                    },
                    {
                        uri: `printer://${DEFAULT_HOST}/hms`,
                        name: "Bambu Printer HMS Diagnostics",
                        mimeType: "application/json",
                        description: "HMS and error-related fields from the latest printer status"
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
                    },
                    {
                        uriTemplate: "printer://{host}/hms",
                        name: "Bambu Printer HMS Diagnostics",
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
            else if (resource === "hms") {
                const status = await this.bambu.getStatus(host || DEFAULT_HOST, bambuSerial, bambuToken);
                content = extractPrinterDiagnostics(status);
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
                        name: "get_printer_filaments",
                        description: "Get the live AMS/external filament inventory from the printer over MQTT, including resolved slicer profile paths when the printer model is known.",
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
                                },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "Optional model hint used to resolve Bambu/Orca filament profile JSONs for each tray."
                                },
                                nozzle_diameter: {
                                    type: "string",
                                    description: "Optional nozzle diameter used when resolving model-specific filament profile JSONs (default: 0.4)."
                                }
                            }
                        }
                    },
                    {
                        name: "resolve_3mf_ams_slots",
                        description: "Inspect a sliced 3MF and match its tray_info_idx filament requirements against the live AMS inventory. Does not upload or start a print.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                three_mf_path: { type: "string", description: "Path to a sliced 3MF/.gcode.3mf file" },
                                plate_index: { type: "number", description: "0-based plate index to inspect (default: 0)" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "Optional model hint used to resolve Bambu/Orca filament profile JSONs for each tray."
                                },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["three_mf_path"]
                        }
                    },
                    {
                        name: "list_3mf_plate_objects",
                        description: "List object IDs from a sliced 3MF plate. Use these IDs with skip_objects during a running print.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                three_mf_path: { type: "string", description: "Path to a sliced 3MF/.gcode.3mf file" },
                                plate_index: { type: "number", description: "0-based plate index to inspect (default: 0)" }
                            },
                            required: ["three_mf_path"]
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
                        name: "list_templates",
                        description: "List saved slicing templates from the local template registry directory.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                template_dir: {
                                    type: "string",
                                    description: "Optional template directory override. Defaults to BAMBU_TEMPLATE_DIR or the server's configured local template registry."
                                }
                            }
                        }
                    },
                    {
                        name: "save_template",
                        description: "Copy a 3MF, JSON, or config file into the local template registry and register it under a template name.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                source_path: {
                                    type: "string",
                                    description: "Path to a local .3mf, .json, or .config file to save into the template registry."
                                },
                                template_name: {
                                    type: "string",
                                    description: "Optional template name. Defaults to the source filename without extension."
                                },
                                template_dir: {
                                    type: "string",
                                    description: "Optional template directory override. Defaults to BAMBU_TEMPLATE_DIR or the server's configured local template registry."
                                }
                            },
                            required: ["source_path"]
                        }
                    },
                    {
                        name: "get_slice_settings",
                        description: "Inspect slicer settings from a saved 3MF template or a JSON/config slicer profile without slicing anything.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                source_path: {
                                    type: "string",
                                    description: "Path to a 3MF template, extracted project_settings.config, or slicer profile JSON."
                                },
                                template_name: {
                                    type: "string",
                                    description: "Optional named template from the local registry. If provided, resolves source_path automatically."
                                },
                                template_dir: {
                                    type: "string",
                                    description: "Optional template directory override when resolving template_name."
                                }
                            },
                            anyOf: [
                                { required: ["source_path"] },
                                { required: ["template_name"] }
                            ]
                        }
                    },
                    {
                        name: "slice_with_template",
                        description: "Slice an STL or 3MF using a named template from the local registry. This is a higher-level wrapper around slice_stl for template-based workflows.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL or 3MF file to slice" },
                                template_name: { type: "string", description: "Named template from the local registry." },
                                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                slicer_type: {
                                    type: "string",
                                    description: "Type of slicer to use (bambustudio, prusaslicer, cura, slic3r, orcaslicer) (default: bambustudio)"
                                },
                                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env)" },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type to encode in BambuStudio slicer settings (default: textured_plate)"
                                },
                                use_printer_filaments: { type: "boolean", description: "When true, and no explicit slicer profile or load_filaments override is provided, use the printer's current or first loaded AMS filament as the slicer filament profile." },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs." },
                                load_filament_ids: { type: "string", description: "Optional filament-to-object mapping string." },
                                ensure_on_bed: { type: "boolean", description: "Lift floating models onto the bed." },
                                arrange: { type: "boolean", description: "Auto-arrange objects on the build plate." },
                                orient: { type: "boolean", description: "Auto-orient model for optimal printability." },
                                repetitions: { type: "number", description: "Number of copies to print." },
                                scale: { type: "number", description: "Uniform scale factor." },
                                rotate: { type: "number", description: "Z-axis rotation in degrees." },
                                rotate_x: { type: "number", description: "X-axis rotation in degrees." },
                                rotate_y: { type: "number", description: "Y-axis rotation in degrees." },
                                min_save: { type: "boolean", description: "Produce smaller output 3MF." },
                                skip_modified_gcodes: { type: "boolean", description: "Ignore stale custom gcodes in the 3MF." },
                                slice_plate: { type: "number", description: "Which plate index to slice. 0 = all plates." }
                            },
                            required: ["stl_path", "template_name", "bambu_model"]
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
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                slicer_type: {
                                    type: "string",
                                    description: "Type of slicer to use (bambustudio, prusaslicer, cura, slic3r, orcaslicer) (default: bambustudio)"
                                },
                                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file (optional, overrides bambu_model preset)" },
                                template_3mf_path: { type: "string", description: "Optional template 3MF whose embedded Bambu slicer settings should be reused when slicing a new STL or 3MF." },
                                template_name: { type: "string", description: "Optional named template from the local registry. Resolves to template_3mf_path automatically." },
                                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type to encode in BambuStudio slicer settings (default: textured_plate)"
                                },
                                use_printer_filaments: { type: "boolean", description: "When true, and no explicit slicer profile or load_filaments override is provided, use the printer's current or first loaded AMS filament as the slicer filament profile. Template 3MF process settings can still be used at the same time." },
                                uptodate: { type: "boolean", description: "Refresh 3MF preset configs to match the latest BambuStudio version. Use when slicing downloaded or older 3MF files to prevent stale-config failures." },
                                repetitions: { type: "number", description: "Print N identical copies of the model. Each copy gets its own plate placement. Example: 3 prints three copies." },
                                orient: { type: "boolean", description: "Auto-orient the model for optimal printability (minimize supports, maximize bed adhesion). Recommended for raw STL imports that lack a pre-set orientation." },
                                arrange: { type: "boolean", description: "Auto-arrange all objects on the build plate with optimal spacing. Recommended when importing STLs or adding multiple objects. Set false to preserve existing plate layout." },
                                ensure_on_bed: { type: "boolean", description: "Detect models floating above the bed and lower them onto the build surface. Safety net for imported models with incorrect Z origins." },
                                clone_objects: { type: "string", description: "Duplicate specific objects on the plate. Comma-separated clone counts per object index, e.g. '1,3,1,10' clones object 0 once, object 1 three times, etc." },
                                skip_objects: { type: "string", description: "Skip specific objects during slicing by index. Comma-separated, e.g. '3,5,10'. Useful for multi-object 3MFs where you only want to print some parts." },
                                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs, e.g. 'pla_basic.json;petg_cf.json'." },
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
                        name: "upload_gcode",
                        description: "Upload a G-code file to the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name for the file on the printer" },
                                gcode: { type: "string", description: "G-code content to upload" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename", "gcode"]
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
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["file_path", "filename"]
                        }
                    },
                    {
                        name: "start_print_job",
                        description: "Start printing a G-code file already on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name of the file to print" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename"]
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
                        name: "pause_print",
                        description: "Pause the current print job on the Bambu Lab printer (resumable via resume_print)",
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
                        name: "resume_print",
                        description: "Resume a paused print job on the Bambu Lab printer",
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
                        name: "clear_hms_errors",
                        description: "Clear HMS or print error state on the Bambu Lab printer using the clean_print_error MQTT command.",
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
                        name: "set_print_speed",
                        description: "Set the active print speed mode: silent, standard, sport, or ludicrous.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                mode: {
                                    type: "string",
                                    enum: ["silent", "standard", "sport", "ludicrous", "1", "2", "3", "4"],
                                    description: "Speed mode to apply: silent/1, standard/2, sport/3, or ludicrous/4"
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["mode"]
                        }
                    },
                    {
                        name: "set_airduct_mode",
                        description: "Set H2/P2 airduct mode to cooling or heating.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                mode: {
                                    type: "string",
                                    enum: ["cooling", "heating"],
                                    description: "Airduct mode to apply"
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["mode"]
                        }
                    },
                    {
                        name: "reread_ams_rfid",
                        description: "Trigger a Bambu AMS RFID re-read for one AMS slot. This can move AMS filament; use only when the printer is idle and unloaded.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                ams_id: { type: "number", description: "AMS unit index from 0 to 3" },
                                slot_id: { type: "number", description: "Slot index within that AMS, from 0 to 3" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["ams_id", "slot_id"]
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
                        name: "set_fan_speed",
                        description: "Set a Bambu printer fan speed percentage using the printer's MQTT fan command",
                        inputSchema: {
                            type: "object",
                            properties: {
                                fan: {
                                    type: "string",
                                    description: "Fan to control: part, auxiliary, chamber, 1, 2, or 3"
                                },
                                speed: { type: "number", description: "Fan speed percentage from 0 to 100" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["fan", "speed"]
                        }
                    },
                    {
                        name: "set_light",
                        description: "Set a Bambu printer light node mode using the printer's MQTT LED command",
                        inputSchema: {
                            type: "object",
                            properties: {
                                light: {
                                    type: "string",
                                    description: "Light node to control, for example chamber_light"
                                },
                                mode: {
                                    type: "string",
                                    enum: ["on", "off", "flashing"],
                                    description: "Light mode to apply"
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["light", "mode"]
                        }
                    },
                    {
                        name: "skip_objects",
                        description: "Skip specific object IDs during a running multi-object print using the printer's MQTT skip_objects command",
                        inputSchema: {
                            type: "object",
                            properties: {
                                object_ids: {
                                    type: "array",
                                    description: "Object IDs to skip. Use list_3mf_plate_objects on the sliced 3MF to find IDs.",
                                    items: { type: "number" }
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["object_ids"]
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
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type currently installed (default: textured_plate)"
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                                use_ams: { type: "boolean", description: "Whether to use the AMS (default: auto-detect from 3MF)" },
                                ams_mapping: {
                                    type: "array",
                                    description: "Project-level AMS mapping array. Position = project filament index, value = absolute AMS tray (0-3=AMS 0, 4-7=AMS 1, 8-11=AMS 2, 128+=AMS-HT, 254=external, -1=unused). Prefer ams_slots unless you know the project-level layout.",
                                    items: { type: "number" }
                                },
                                ams_slots: {
                                    type: "array",
                                    description: "Preferred AMS input: one absolute tray index per USED filament in plate order, e.g. [1] for a single-filament print pulling from AMS 0 slot 1. Expanded to project-level ams_mapping automatically from the 3MF's plate_N.json and gcode header.",
                                    items: { type: "number" }
                                },
                                auto_match_ams: {
                                    type: "boolean",
                                    description: "When true, match the sliced 3MF's tray_info_idx requirements against live AMS inventory and use the resulting ams_slots. Ignored when ams_mapping or ams_slots is provided."
                                },
                                bed_leveling: { type: "boolean", description: "Enable auto bed leveling (default: true)" },
                                flow_calibration: { type: "boolean", description: "Enable flow calibration (default: true)" },
                                vibration_calibration: { type: "boolean", description: "Enable vibration calibration (default: true)" },
                                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file for auto-slicing (optional)." },
                                template_3mf_path: { type: "string", description: "Optional template 3MF whose embedded Bambu slicer settings should be reused when auto-slicing this print job." },
                                template_name: { type: "string", description: "Optional named template from the local registry. Resolves to template_3mf_path automatically." },
                                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" }
                            },
                            required: ["three_mf_path", "bambu_model"]
                        }
                    },
                    {
                        name: "print_collar_charm",
                        description: "Print a prepared two-part dog collar charm project using the fixed tray policy: inner/smaller object -> black on AMS 1 slot 1, outer/larger object -> white on AMS 2 slot 1.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                source_path: { type: "string", description: "Path to a prepared collar charm .3mf project or sliced 3MF." },
                                template_name: { type: "string", description: "Named collar charm template from the local registry. Resolves source_path automatically." },
                                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"],
                                    description: "REQUIRED: Bambu Lab printer model. H2D and H2S are the primary intended paths."
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type currently installed (default: textured_plate)"
                                },
                                bed_leveling: { type: "boolean", description: "Enable auto bed leveling (default: true)" },
                                flow_calibration: { type: "boolean", description: "Enable flow calibration (default: true)" },
                                vibration_calibration: { type: "boolean", description: "Enable vibration calibration (default: true)" },
                                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file for auto-slicing (optional)." },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" }
                            },
                            anyOf: [
                                { required: ["source_path", "bambu_model"] },
                                { required: ["template_name", "bambu_model"] }
                            ]
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
            const slicerType = String(args?.slicer_type || DEFAULT_SLICER_TYPE);
            const slicerPath = String(args?.slicer_path || DEFAULT_SLICER_PATH);
            const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
            const requestedTemplateDir = typeof args?.template_dir === "string" && args.template_dir.trim().length > 0
                ? String(args.template_dir)
                : undefined;
            const resolvedTemplatePathFromName = this.resolveTemplatePath(typeof args?.template_name === "string" ? String(args.template_name) : undefined, requestedTemplateDir);
            const template3mfPath = String(resolvedTemplatePathFromName || args?.template_3mf_path || DEFAULT_TEMPLATE_3MF_PATH);
            try {
                let result;
                switch (name) {
                    case "get_printer_status":
                        result = await this.bambu.getStatus(host, bambuSerial, bambuToken);
                        break;
                    case "get_printer_filaments": {
                        const requestedModel = (String(args?.bambu_model ?? DEFAULT_BAMBU_MODEL ?? "")).trim().toLowerCase();
                        const normalizedModel = requestedModel ? validateBambuModel(requestedModel) : undefined;
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        result = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, normalizedModel, nozzleDiam);
                        break;
                    }
                    case "resolve_3mf_ams_slots": {
                        if (!args?.three_mf_path) {
                            throw new Error("Missing required parameter: three_mf_path");
                        }
                        const requestedModel = (String(args?.bambu_model ?? DEFAULT_BAMBU_MODEL ?? "")).trim().toLowerCase();
                        const normalizedModel = requestedModel ? validateBambuModel(requestedModel) : undefined;
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const requirements = await analyze3MFAmsRequirements(String(args.three_mf_path), args?.plate_index !== undefined ? Number(args.plate_index) : 0);
                        const inventory = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, normalizedModel, nozzleDiam);
                        const resolved = resolveAmsSlotsFromRequirements(requirements, inventory);
                        result = {
                            status: resolved.missing.length === 0 ? "matched" : "missing",
                            requirements,
                            ams_slots: resolved.ams_slots,
                            matches: resolved.matches,
                            missing: resolved.missing,
                        };
                        break;
                    }
                    case "list_3mf_plate_objects": {
                        if (!args?.three_mf_path) {
                            throw new Error("Missing required parameter: three_mf_path");
                        }
                        result = await analyze3MFPlateObjects(String(args.three_mf_path), args?.plate_index !== undefined ? Number(args.plate_index) : 0);
                        break;
                    }
                    case "list_templates":
                        result = this.listTemplateRegistry(requestedTemplateDir);
                        break;
                    case "save_template":
                        if (!args?.source_path) {
                            throw new Error("Missing required parameter: source_path");
                        }
                        result = this.saveTemplate(String(args.source_path), typeof args?.template_name === "string" ? String(args.template_name) : undefined, requestedTemplateDir);
                        break;
                    case "list_printer_files":
                        result = await this.bambu.getFiles(host, bambuSerial, bambuToken);
                        break;
                    case "upload_gcode": {
                        if (!args?.filename || !args?.gcode) {
                            throw new Error("Missing required parameters: filename and gcode");
                        }
                        const tmpPath = path.join(TEMP_DIR, String(args.filename));
                        fs.writeFileSync(tmpPath, String(args.gcode));
                        result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, tmpPath, String(args.filename), false);
                        break;
                    }
                    case "upload_file":
                        if (!args?.file_path || !args?.filename) {
                            throw new Error("Missing required parameters: file_path and filename");
                        }
                        result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, String(args.file_path), String(args.filename), Boolean(args.print ?? false));
                        break;
                    case "start_print_job":
                        if (!args?.filename) {
                            throw new Error("Missing required parameter: filename");
                        }
                        result = await this.bambu.startJob(host, bambuSerial, bambuToken, String(args.filename));
                        break;
                    case "cancel_print":
                        result = await this.bambu.cancelJob(host, bambuSerial, bambuToken);
                        break;
                    case "pause_print":
                        result = await this.bambu.pauseJob(host, bambuSerial, bambuToken);
                        break;
                    case "resume_print":
                        result = await this.bambu.resumeJob(host, bambuSerial, bambuToken);
                        break;
                    case "clear_hms_errors":
                        result = await this.bambu.clearHmsErrors(host, bambuSerial, bambuToken);
                        break;
                    case "set_print_speed":
                        if (!args?.mode) {
                            throw new Error("Missing required parameter: mode");
                        }
                        result = await this.bambu.setPrintSpeed(host, bambuSerial, bambuToken, String(args.mode));
                        break;
                    case "set_airduct_mode":
                        if (!args?.mode) {
                            throw new Error("Missing required parameter: mode");
                        }
                        result = await this.bambu.setAirductMode(host, bambuSerial, bambuToken, String(args.mode));
                        break;
                    case "reread_ams_rfid":
                        if (args?.ams_id === undefined || args?.slot_id === undefined) {
                            throw new Error("Missing required parameters: ams_id and slot_id");
                        }
                        result = await this.bambu.rereadAmsRfid(host, bambuSerial, bambuToken, Number(args.ams_id), Number(args.slot_id));
                        break;
                    case "set_temperature":
                        if (!args?.component || args?.temperature === undefined) {
                            throw new Error("Missing required parameters: component and temperature");
                        }
                        result = await this.bambu.setTemperature(host, bambuSerial, bambuToken, String(args.component), Number(args.temperature));
                        break;
                    case "set_fan_speed":
                        if (!args?.fan || args?.speed === undefined) {
                            throw new Error("Missing required parameters: fan and speed");
                        }
                        result = await this.bambu.setFanSpeed(host, bambuSerial, bambuToken, String(args.fan), Number(args.speed));
                        break;
                    case "set_light":
                        if (!args?.light || !args?.mode) {
                            throw new Error("Missing required parameters: light and mode");
                        }
                        result = await this.bambu.setLight(host, bambuSerial, bambuToken, String(args.light), String(args.mode));
                        break;
                    case "skip_objects":
                        if (!Array.isArray(args?.object_ids)) {
                            throw new Error("Missing required parameter: object_ids");
                        }
                        result = await this.bambu.skipObjects(host, bambuSerial, bambuToken, args.object_ids.map((id) => Number(id)));
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
                    case "get_slice_settings":
                        if (!args?.source_path && !args?.template_name) {
                            throw new Error("Missing required parameter: source_path or template_name");
                        }
                        result = await this.inspectSliceSettings(String(resolvedTemplatePathFromName || args.source_path));
                        break;
                    case "slice_with_template": {
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        if (!args?.template_name) {
                            throw new Error("Missing required parameter: template_name");
                        }
                        const sliceModel = await this.resolveBambuModel(args?.bambu_model);
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const activeSlicerProfile = await resolveSlicerProfilePath(slicerProfile || undefined, resolvedTemplatePathFromName || template3mfPath || undefined, TEMP_DIR);
                        const explicitSlicerProfile = hasExplicitSlicerProfile(args);
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
                        if (args?.load_filaments !== undefined)
                            sliceBambuOptions.loadFilaments = String(args.load_filaments);
                        if (args?.load_filament_ids !== undefined)
                            sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
                        sliceBambuOptions.bedType = resolveBedType(args?.bed_type);
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
                        const usePrinterFilaments = args?.use_printer_filaments !== undefined ? Boolean(args.use_printer_filaments) : true;
                        if (usePrinterFilaments &&
                            !explicitSlicerProfile &&
                            !sliceBambuOptions.loadFilaments &&
                            bambuSerial &&
                            bambuToken) {
                            try {
                                const liveFilaments = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, sliceModel, nozzleDiam);
                                if (liveFilaments.recommended?.load_filaments) {
                                    sliceBambuOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                                }
                            }
                            catch (filamentError) {
                                console.warn("Could not resolve live printer filaments for slicing:", filamentError);
                            }
                        }
                        result = await this.stlManipulator.sliceSTL(String(args.stl_path), slicerType, slicerPath, activeSlicerProfile, undefined, printerPreset, sliceBambuOptions);
                        break;
                    }
                    case "slice_stl": {
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        const sliceModel = await this.resolveBambuModel(args?.bambu_model);
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const activeSlicerProfile = await resolveSlicerProfilePath(slicerProfile || undefined, template3mfPath || undefined, TEMP_DIR);
                        const explicitSlicerProfile = hasExplicitSlicerProfile(args);
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
                        if (args?.load_filaments !== undefined)
                            sliceBambuOptions.loadFilaments = String(args.load_filaments);
                        if (args?.load_filament_ids !== undefined)
                            sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
                        sliceBambuOptions.bedType = resolveBedType(args?.bed_type);
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
                        const usePrinterFilaments = args?.use_printer_filaments !== undefined ? Boolean(args.use_printer_filaments) : true;
                        if (usePrinterFilaments &&
                            !explicitSlicerProfile &&
                            !sliceBambuOptions.loadFilaments &&
                            bambuSerial &&
                            bambuToken) {
                            try {
                                const liveFilaments = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, sliceModel, nozzleDiam);
                                if (liveFilaments.recommended?.load_filaments) {
                                    sliceBambuOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                                }
                            }
                            catch (filamentError) {
                                console.warn("Could not resolve live printer filaments for slicing:", filamentError);
                            }
                        }
                        result = await this.stlManipulator.sliceSTL(String(args.stl_path), slicerType, slicerPath, activeSlicerProfile, undefined, // progressCallback
                        printerPreset, sliceBambuOptions);
                        break;
                    }
                    case "print_3mf": {
                        if (!args?.three_mf_path) {
                            throw new Error("Missing required parameter: three_mf_path");
                        }
                        if (!bambuSerial || !bambuToken) {
                            throw new Error("Bambu serial number and access token are required for print_3mf.");
                        }
                        const printModel = await this.resolveBambuModel(args?.bambu_model);
                        const printBedType = resolveBedType(args?.bed_type);
                        const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const activeSlicerProfile = await resolveSlicerProfilePath(slicerProfile || undefined, template3mfPath || undefined, TEMP_DIR);
                        const explicitSlicerProfile = hasExplicitSlicerProfile(args);
                        const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
                        let threeMFPath = String(args.three_mf_path);
                        // Auto-slice if 3MF has no gcode
                        try {
                            const JSZip = (await import('jszip')).default;
                            const zipData = fs.readFileSync(threeMFPath);
                            const zip = await JSZip.loadAsync(zipData);
                            const hasGcode = Object.keys(zip.files).some(f => f.match(/Metadata\/plate_\d+\.gcode/i) || f.endsWith('.gcode'));
                            if (!hasGcode) {
                                console.log(`3MF has no gcode — auto-slicing with ${slicerType} for ${printModel}`);
                                const autoSliceOptions = {
                                    uptodate: true,
                                    ensureOnBed: true,
                                    minSave: true,
                                    skipModifiedGcodes: true,
                                    bedType: printBedType,
                                };
                                if (!explicitSlicerProfile) {
                                    try {
                                        const liveFilaments = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, printModel, printNozzle);
                                        if (liveFilaments.recommended?.load_filaments) {
                                            autoSliceOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                                        }
                                    }
                                    catch (filamentError) {
                                        console.warn("Could not resolve live printer filaments for auto-slicing:", filamentError);
                                    }
                                }
                                threeMFPath = await this.stlManipulator.sliceSTL(threeMFPath, slicerType, slicerPath, activeSlicerProfile, undefined, // progressCallback
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
                        let finalAmsSlots;
                        let useAMS = args?.use_ams !== undefined ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
                        const hasUserAmsMapping = Boolean(args?.ams_mapping);
                        const hasUserAmsSlots = Array.isArray(args?.ams_slots);
                        if (hasUserAmsMapping) {
                            let userMappingOverride;
                            if (Array.isArray(args.ams_mapping)) {
                                userMappingOverride = args.ams_mapping.filter((v) => typeof v === 'number');
                            }
                            else if (args.ams_mapping && typeof args.ams_mapping === 'object') {
                                userMappingOverride = Object.values(args.ams_mapping)
                                    .filter((v) => typeof v === 'number')
                                    .sort((a, b) => a - b);
                            }
                            if (userMappingOverride && userMappingOverride.length > 0) {
                                finalAmsMapping = userMappingOverride;
                                useAMS = true;
                            }
                        }
                        if (hasUserAmsSlots) {
                            const userSlots = args.ams_slots.filter((v) => typeof v === 'number');
                            if (userSlots.length > 0) {
                                finalAmsSlots = userSlots;
                                finalAmsMapping = undefined;
                                useAMS = true;
                            }
                        }
                        if (!hasUserAmsMapping && !hasUserAmsSlots && args?.auto_match_ams === true && args?.use_ams !== false) {
                            const requirements = await analyze3MFAmsRequirements(threeMFPath, 0);
                            const inventory = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, printModel, printNozzle);
                            const resolved = resolveAmsSlotsFromRequirements(requirements, inventory);
                            if (resolved.missing.length > 0) {
                                throw new Error(`auto_match_ams could not find loaded AMS trays for: ${resolved.missing
                                    .map((missing) => missing.tray_info_idx || `filament position ${missing.filament_position}`)
                                    .join(", ")}`);
                            }
                            finalAmsMapping = undefined;
                            finalAmsSlots = resolved.ams_slots;
                            useAMS = finalAmsSlots.length > 0;
                        }
                        if (args?.use_ams === false) {
                            finalAmsMapping = undefined;
                            finalAmsSlots = undefined;
                            useAMS = false;
                        }
                        if ((!finalAmsMapping || finalAmsMapping.length === 0) && (!finalAmsSlots || finalAmsSlots.length === 0)) {
                            useAMS = false;
                        }
                        const threeMfFilename = path.basename(threeMFPath);
                        const projectName = threeMfFilename.replace(/\.3mf$/i, '');
                        result = await this.bambu.print3mf(host, bambuSerial, bambuToken, {
                            projectName,
                            filePath: threeMFPath,
                            plateIndex: 0,
                            useAMS: useAMS,
                            amsMapping: finalAmsMapping,
                            amsSlots: finalAmsSlots,
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
                    case "print_collar_charm": {
                        const resolvedSourcePath = String(resolvedTemplatePathFromName || args?.source_path || "");
                        if (!resolvedSourcePath) {
                            throw new Error("Missing required parameter: source_path or template_name");
                        }
                        if (!bambuSerial || !bambuToken) {
                            throw new Error("Bambu serial number and access token are required for print_collar_charm.");
                        }
                        const printModel = await this.resolveBambuModel(args?.bambu_model);
                        const printBedType = resolveBedType(args?.bed_type);
                        const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const activeSlicerProfile = await resolveSlicerProfilePath(slicerProfile || undefined, resolvedTemplatePathFromName || template3mfPath || undefined, TEMP_DIR);
                        const preparedThreeMFPath = await this.resolveCollarCharmPrepared3MF(resolvedSourcePath, resolvedTemplatePathFromName || template3mfPath || undefined, slicerType, slicerPath, activeSlicerProfile || undefined, printModel, printNozzle, printBedType, host, bambuSerial, bambuToken);
                        const collarAnalysis = await analyzeCollarCharm3MF(preparedThreeMFPath, 0);
                        const inventory = await this.preflightCollarCharmPolicy(host, bambuSerial, bambuToken, printModel, printNozzle);
                        const projectName = path.basename(preparedThreeMFPath).replace(/\.3mf$/i, '');
                        result = await this.bambu.print3mf(host, bambuSerial, bambuToken, {
                            projectName,
                            filePath: preparedThreeMFPath,
                            plateIndex: collarAnalysis.plateIndex,
                            useAMS: true,
                            amsSlots: collarAnalysis.amsSlots,
                            bedType: printBedType,
                            bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : true,
                            flowCalibration: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : true,
                            vibrationCalibration: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : true,
                            timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : false,
                        });
                        result = {
                            ...result,
                            source_path: resolvedSourcePath,
                            prepared_three_mf_path: preparedThreeMFPath,
                            tray_policy: {
                                inner: {
                                    color: COLLAR_CHARM_POLICY.colors.inner,
                                    absolute_tray: COLLAR_CHARM_POLICY.amsSlots.inner,
                                },
                                outer: {
                                    color: COLLAR_CHARM_POLICY.colors.outer,
                                    absolute_tray: COLLAR_CHARM_POLICY.amsSlots.outer,
                                },
                            },
                            collar_roles: collarAnalysis.roles,
                            inventory_slots_checked: inventory.trays
                                .filter((tray) => tray.slot === COLLAR_CHARM_POLICY.amsSlots.inner || tray.slot === COLLAR_CHARM_POLICY.amsSlots.outer)
                                .map((tray) => ({
                                slot: tray.slot,
                                loaded: tray.loaded,
                                tray_color: tray.tray_color,
                                tray_type: tray.tray_type,
                                tray_info_idx: tray.tray_info_idx,
                            })),
                        };
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
