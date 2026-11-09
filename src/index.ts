#!/usr/bin/env node
import {CAMERA_STREAM_TOOLS} from "./printers/camera-tools.js";
import { withAnnotations } from "./tool-annotations.js";
import { withRemote } from "./counterpart/remote.js";
import { refusalReport, slicedFileFacts, slicerReport } from "./counterpart/sliced-file.js";
import { listModelPlates } from "./counterpart/model-plates.js";

/** The slicer's verdict beside its result.json (`slicer_report`). */
function reportOf(result: unknown): { slicer_report?: ReturnType<typeof slicerReport> } {
  const report = slicerReport(result);
  return report ? { slicer_report: report } : {};
}
function withSlicerReport<T extends { slicer_result?: unknown }>(sliced: T): T & { slicer_report?: ReturnType<typeof slicerReport> } {
  return { ...sliced, ...reportOf(sliced.slicer_result) };
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { PRINT_ROUTES, connectionForRoute, ownLocalOf, routeOf, routeOptions, writeEnvValues, type PrintRoute } from "./counterpart/route.js";
import fs from "fs";
import os from "node:os";
import path from "path";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  STLManipulator,
  SLICER_TYPES,
  normalizeSlicerType,
  SlicerRunError,
  type BambuSliceOptions,
  type SlicerType,
} from "./stl/stl-manipulator.js";
import { BambuNetworkBridge, bridgeSnapshotRoot, describeBambuNetworkPrintError, type BambuNetworkBridgeOptions, type BridgeJobUpdate } from "./bambu-network-bridge.js";
import {
  assertBambuNativeAvailable,
  bambuNativeControlsAvailable,
  bambuNativeUnavailableReason,
  interruptNativeOperations,
  validateBambuNativeMetadata,
  buildBambuNativeFanCommand,
  buildBambuNativeTemperatureCommand,
  printWithBambuNative,
  sendCommandWithBambuNative,
  uploadWithBambuNative,
  type BambuNativeUpdateCallback,
} from "./bambu-native.js";
import { importFileViaBambuConnect } from "./bambu-connect.js";
import { BlenderMcpBridge } from "./blender-mcp-bridge.js";
import { FUSION_EXPORT_OUTPUT_SCHEMA, FUSION_MCP_DEFAULT_ARGS, FUSION_MCP_PIN, FUSION_NEW_DESIGN_OUTPUT_SCHEMA, FUSION_STATUS_OUTPUT_SCHEMA, FusionMcpBridge, addinAddress } from "./fusion-mcp-bridge.js";
import { BLENDER_SETUP_OUTPUT_SCHEMA, BlenderAddonSetup, FUSION_ADDIN_REPOSITORY, FUSION_SETUP_OUTPUT_SCHEMA, FusionAddinSetup, defaultSetupSystem, parseAddonHandshake, type BlenderAddonHandshake } from "./design-app-setup.js";
import { bridgeAmsMapping2Entry, bridgeAmsMappingValue, externalTrayForNozzle, hasAmsMappingInput, normalizeAmsMappingObject, normalizeBridgeAmsTrayValue, studioAmsMapping, studioAmsMappingInfo, trayColour } from "./ams-mapping.js";
import { analyze3MFAmsRequirements, analyze3MFPlateObjects, analyzeCollarCharm3MF, extractBambuTemplateSettings, getCollarCharmRolePolicy, hasBambuProjectSettings, hasSlicerSettingsFile, parse3MF, withExtractedSettingsCleanup } from './3mf_parser.js';
import type { ThreeMFAmsRequirements } from "./types.js";
import { BambuImplementation, assertDirectPrintSupported, checkedFile, defaultResumeStateDir } from "./printers/bambu.js";
import { resolveStudioPrintOptions, usedNozzleCount, type CallerPrintOptions } from "./studio-print-options.js";
import { inspectPrintFile } from "./safety/print-file.js";
import { previewPrintFile } from "./safety/print-preview.js";
import { loadSafe3mfArchive } from "./safety/archive.js";
import { SERIAL_MODELS, externalStorageState, validatePrinterState } from "./safety/printer-state.js";
import { isDualNozzleModel } from "./safety/limits.js";
import { withPrinterOperation, withPrintSnapshot, uniquePrintName } from "./safety/artifact.js";
import { detectProfilesRoot } from "./slicer/profile-flatten.js";
import { bambuPrinterInfo, bambuSliceCapabilities } from "./counterpart/info.js";
import { DISCOVER_OUTPUT_SCHEMA, discoverBambu } from "./counterpart/discovery.js";
import { SETUP_FIELDS_OUTPUT_SCHEMA, bambuSetupFields, slicerSetup, type SlicerSetup } from "./counterpart/setup.js";
import { PROPOSE_FILAMENTS_INPUT_PROPERTIES, PROPOSE_FILAMENTS_OUTPUT_SCHEMA, NO_COLOUR_NAMES, bambuTrayLabel, loadColourNames, proposeFilaments, spoolName, type ColourNames, type ProposalTray } from "./counterpart/filaments.js";
import { DESIGN_PROMPTS, FDM_CAPABILITY_GUIDANCE, FDM_CAPABILITY_RESOURCE, FDM_CAPABILITY_URI, FDM_SLICING_PROMPT, SERVER_INSTRUCTIONS, slicingGuidance } from "./design-guidance.js";
import { bambuProgress, offlineProgress } from "./counterpart/progress.js";
import { makeCounterpart3mf } from "./counterpart/make-3mf.js";
import { MAKE_3MF_OUTPUT_SCHEMA, PRINT_PROGRESS_OUTPUT_SCHEMA, PRINTER_INFO_OUTPUT_SCHEMA } from "./counterpart/schemas.js";
import { parseProcessOverrides } from "./slicer/process-overrides.js";
import { PRINT_QUALITY_PROPERTIES, withPrintQuality } from "./slicer/print-quality.js";
import { PrinterRefusal } from "./refusal.js";
import { uploadProgressReporter } from "./upload-progress.js";
import { machinePauseGcode, parsePauseLayers, pausedLayers, readPlateGcode } from "./slicer/layer-pauses.js";

dotenv.config();

const DEFAULT_HOST = process.env.BAMBU_PRINTER_HOST || process.env.PRINTER_HOST || "localhost";
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_PRINTER_SERIAL || process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN =
  process.env.BAMBU_PRINTER_ACCESS_TOKEN || process.env.BAMBU_TOKEN || "";
const DEFAULT_BAMBU_DEV_ID = process.env.BAMBU_DEV_ID || DEFAULT_BAMBU_SERIAL;
// os.tmpdir(), not process.cwd() — a packaged Claude Desktop extension is
// spawned with a cwd we don't control (and may not be writable), so a
// cwd-relative default here can throw at module load via the mkdirSync
// below and kill the server before it ever opens the stdio transport.
const AUTOMATIC_TEMP_DIR = process.env.TEMP_DIR ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "bambu-printer-mcp-"));
// Resolve an explicit TEMP_DIR (e.g. ./temp) against the server's working
// directory, as dotenv's own .env lookup is. Slicer CLIs receive paths under
// it, and BambuStudio fails every 3MF export to a relative --outputdir.
const TEMP_DIR = process.env.TEMP_DIR ? path.resolve(process.env.TEMP_DIR) : AUTOMATIC_TEMP_DIR!;
if (AUTOMATIC_TEMP_DIR) {
  // The exit event also covers startup failures and normal event-loop exit.
  // Only the directory created above belongs to us; explicit TEMP_DIR is retained.
  process.once("exit", () => {
    try {
      fs.rmSync(AUTOMATIC_TEMP_DIR, { recursive: true, force: true });
    } catch (error) {
      console.error("Unable to remove the server's temporary directory:", error);
    }
  });
}

// Printer model and bed type
const DEFAULT_BAMBU_MODEL =
  process.env.BAMBU_PRINTER_MODEL?.trim().toLowerCase() ||
  process.env.BAMBU_MODEL?.trim().toLowerCase() ||
  "";
// counterpart_print_route changes these at run time (and in the .env file they came from).
let DEFAULT_BAMBU_CONNECTION_MODE =
  process.env.BAMBU_DEFAULT_CONNECTION_MODE?.trim().toLowerCase() || "";
let DEFAULT_BAMBU_CONNECTION_TYPE =
  process.env.BAMBU_DEFAULT_CONNECTION_TYPE?.trim().toLowerCase() || "";
/** The connection configured at start, before counterpart_print_route changes it: its own local route is kept. */
const CONFIGURED_CONNECTION = { mode: DEFAULT_BAMBU_CONNECTION_MODE, type: DEFAULT_BAMBU_CONNECTION_TYPE };
const CONNECTION_MODES = ["lan_mqtt_ftps", "bambu_native", "bambu_network", "bambu_connect"];

/**
 * The one route decision for a printer: print_3mf and every print control
 * (cancel, pause, resume) resolve it here, so a job is never controlled over a
 * different connection than the one that started it. Arguments override the
 * server's configured defaults; without either, X2D uses its native route and
 * every other model direct LAN MQTT/FTPS.
 */
function resolveConnection(args: Record<string, unknown> | undefined, model?: string): { mode: string; type: string } {
  const mode = String(args?.connection_mode || DEFAULT_BAMBU_CONNECTION_MODE || (model === "x2d" ? "bambu_native" : "lan_mqtt_ftps")).trim().toLowerCase();
  if (!CONNECTION_MODES.includes(mode)) throw new Error("Unsupported connection_mode.");
  const type = String(args?.connection_type || DEFAULT_BAMBU_CONNECTION_TYPE || "cloud").trim().toLowerCase();
  if (!["cloud", "lan"].includes(type)) throw new Error('connection_type must be "cloud" or "lan".');
  return { mode, type };
}
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";
/** MCP initialize name/version; counterpart_printer_info reports the same values. */
const SERVER_INFO = {
  name: "bambu-printer-mcp",
  version: String(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version),
};
/** Tools that declare an outputSchema: they always return structuredContent, and errors carry none. */
const OUTPUT_SCHEMA_TOOLS = new Set([
  "counterpart_printer_info", "counterpart_print_progress", "counterpart_make_3mf",
  "counterpart_discover_printers", "counterpart_setup_fields", "counterpart_propose_filaments",
  "fusion_mcp_status", "fusion_mcp_new_design", "fusion_mcp_export",
  "camera_stream_start", "camera_frame", "camera_stream_stop",
]);

/** Bound for each Linux X2D emergency MQTT send (BAMBU_EMERGENCY_MQTT_TIMEOUT_MS, 1–60000 ms). */
function withEmergencyMqttTimeout<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const raw = Number(process.env.BAMBU_EMERGENCY_MQTT_TIMEOUT_MS?.trim() || 15_000);
  const ms = Number.isInteger(raw) && raw >= 1 && raw <= 60_000 ? raw : 15_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no MQTT confirmation within ${ms / 1000} s`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => send(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether an X2D native print stores its job on the SD card or USB stick
 * (true) or internal storage (eMMC). An explicit try_emmc_print wins, then
 * BAMBU_NATIVE_TRY_EMMC_PRINT read as the helper reads it; otherwise a ready
 * card is used, as OrcaSlicer does, so the job can be reprinted from the
 * printer and read over FTPS.
 */
function nativeExternalStorage(tryEmmcPrint: boolean | undefined, raw: unknown): boolean {
  if (tryEmmcPrint !== undefined) return !tryEmmcPrint;
  const configured = process.env.BAMBU_NATIVE_TRY_EMMC_PRINT?.trim();
  if (configured) return !["1", "true", "TRUE", "yes"].includes(configured);
  return externalStorageState(raw) === "normal";
}

function requestedPrintNozzles(args: Record<string, any>): number[] | undefined {
  if (args.nozzle_diameters !== undefined && args.nozzle_diameter !== undefined) {
    throw new Error("Supply nozzle_diameters or nozzle_diameter, not both.");
  }
  const raw = args.nozzle_diameters !== undefined ? args.nozzle_diameters :
    args.nozzle_diameter !== undefined ? [args.nozzle_diameter] : undefined;
  // A pre-sliced job already declares every nozzle; compare those with the
  // printer rather than broadcasting the CLI's default diameter over them.
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 2 || raw.some(value =>
    (typeof value !== "number" && typeof value !== "string") || ![0.2, 0.4, 0.6, 0.8].includes(Number(value)))) {
    throw new Error("Nozzle diameters must contain one or two supported sizes: 0.2, 0.4, 0.6, 0.8 mm.");
  }
  return raw.map(Number);
}

function assertUniformCliNozzles(args: Record<string, any>): void {
  const nozzles = requestedPrintNozzles(args);
  if (nozzles && new Set(nozzles).size > 1) {
    throw new Error("Mixed nozzle diameters require a pre-sliced 3MF with complete per-nozzle metadata. Export it from the slicer GUI before printing.");
  }
}

const VALID_BAMBU_MODELS = ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2dpro", "h2s", "h2c", "x2d"] as const;

/** The Send dialog options a caller set explicitly; the rest resolve as Bambu Studio does (studio-print-options.ts). */
function callerPrintOptions(args: Record<string, any> | undefined): CallerPrintOptions {
  const flag = (value: unknown) => value === undefined ? undefined : Boolean(value);
  const int = (value: unknown, label: string) => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error(`${label} must be an integer.`);
    return number;
  };
  const options: CallerPrintOptions = {
    bedLeveling: flag(args?.bed_leveling),
    flowCalibration: flag(args?.flow_calibration),
    vibrationCalibration: flag(args?.vibration_calibration),
    layerInspect: flag(args?.layer_inspect),
    autoBedLeveling: int(args?.auto_bed_leveling, "auto_bed_leveling"),
    autoFlowCali: int(args?.auto_flow_cali, "auto_flow_cali"),
    autoOffsetCali: int(args?.auto_offset_cali, "auto_offset_cali"),
    extruderCaliManualMode: int(args?.extruder_cali_manual_mode, "extruder_cali_manual_mode"),
  };
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as CallerPrintOptions;
}
type BambuModel = typeof VALID_BAMBU_MODELS[number];
// X2D uses the same project_file/ams_mapping2 family of LAN print fields as
// the dual-nozzle H2 path. Keep it in this gate so pre-sliced multi-filament
// jobs take the correct branch instead of the legacy 5-slot mapping.
const H2_BAMBU_MODELS = new Set<string>(["h2d", "h2dpro", "h2s", "h2c", "x2d"]);

const VALID_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"] as const;
const VALID_NOZZLE_TYPES = ["stainless_steel", "hardened_steel", "tungsten_carbide", "brass"] as const;

/** The installed hotend material. Bambu machine presets assume the stock nozzle; the print gate compares this with the printer. */
function resolveNozzleType(value: unknown): string | undefined {
  const raw = value === undefined || value === null || value === "" ? process.env.BAMBU_NOZZLE_TYPE?.trim() : value;
  if (raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!(VALID_NOZZLE_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid nozzle type "${raw}". Valid types: ${VALID_NOZZLE_TYPES.join(", ")}`);
  }
  return normalized;
}

/** BambuStudio's nozzle_volume_type value for each tool argument value. */
const NOZZLE_VOLUME_TYPES = { standard: "Standard", high_flow: "High Flow" } as const;
const VALID_NOZZLE_VOLUME_TYPES = Object.keys(NOZZLE_VOLUME_TYPES) as (keyof typeof NOZZLE_VOLUME_TYPES)[];

/** The installed nozzle's flow type. Bambu machine presets assume Standard; the print gate compares this with the printer. */
function resolveNozzleVolumeType(value: unknown): "Standard" | "High Flow" | undefined {
  const raw = value === undefined || value === null || value === "" ? process.env.BAMBU_NOZZLE_VOLUME_TYPE?.trim() : value;
  if (raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!(VALID_NOZZLE_VOLUME_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid nozzle volume type "${raw}". Valid types: ${VALID_NOZZLE_VOLUME_TYPES.join(", ")}`);
  }
  return NOZZLE_VOLUME_TYPES[normalized as keyof typeof NOZZLE_VOLUME_TYPES];
}
const VALID_BAMBUSTUDIO_CLI_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"] as const;

// Map model IDs to BambuStudio --load-machine preset names
const BAMBU_MODEL_PRESETS: Record<string, (nozzle: string) => string> = {
  p1s: (n) => `Bambu Lab P1S ${n} nozzle`,
  p1p: (n) => `Bambu Lab P1P ${n} nozzle`,
  p2s: (n) => `Bambu Lab P2S ${n} nozzle`,
  x1c: (n) => `Bambu Lab X1 Carbon ${n} nozzle`,
  x1e: (n) => `Bambu Lab X1E ${n} nozzle`,
  a1: (n) => `Bambu Lab A1 ${n} nozzle`,
  a1mini: (n) => `Bambu Lab A1 mini ${n} nozzle`,
  h2d: (n) => `Bambu Lab H2D ${n} nozzle`,
  h2dpro: (n) => `Bambu Lab H2D Pro ${n} nozzle`,
  h2s: (n) => `Bambu Lab H2S ${n} nozzle`,
  h2c: (n) => `Bambu Lab H2C ${n} nozzle`,
  x2d: (n) => `Bambu Lab X2D ${n} nozzle`,
};

const FILAMENT_MODEL_CODES: Record<string, string> = {
  p1s: "P1S",
  p1p: "P1P",
  p2s: "P2S",
  x1c: "X1C",
  x1e: "X1E",
  a1: "A1",
  a1mini: "A1M",
  h2d: "H2D",
  h2dpro: "H2DP",
  h2s: "H2S",
  h2c: "H2C",
  x2d: "X2D",
};

type FilamentProfileIndex = {
  byName: Map<string, string>;
  baseNameByFilamentId: Map<string, string>;
};

type PrinterFilamentInventory = {
  current_slot: number | null;
  current_source: "ams" | "external" | null;
  summary: {
    loaded_slots: number;
    resolved_profile_slots: number;
    unresolved_loaded_slots: number;
    empty_slots: number;
    current_slot: number | null;
    current_source: "ams" | "external" | null;
    recommended_slot: number | null;
    recommended_reason: string | null;
  };
  trays: Array<{
    ams_id: number | null;
    tray_id: number | null;
    slot: number | null;
    state: number;
    loaded: boolean;
    tray_info_idx: string | null;
    tray_type: string | null;
    tray_sub_brands: string | null;
    tray_color: string | null;
    remain_percent: number | null;
    nozzle_temp_min: number | null;
    nozzle_temp_max: number | null;
    resolved_base_profile_name: string | null;
    resolved_profile_path: string | null;
    profile_resolution: "exact-model-nozzle" | "model" | "generic" | "unresolved";
    match_confidence: "high" | "medium" | "low" | "none";
    display_name: string;
    /** Where the tray sits, as Bambu Studio labels it ("A2"). */
    label: string | null;
    /** The spool as a person names it: Bambu's colour name and product ("Sunflower Yellow PLA Basic"). */
    spool_name: string | null;
    profile_candidates: string[];
  }>;
  recommended: {
    slot: number | null;
    tray_info_idx: string | null;
    tray_type: string | null;
    resolved_profile_path: string | null;
    load_filaments: string | null;
    reason: string;
  } | null;
  load_filaments_all: string | null;
};

const COLLAR_CHARM_POLICY = getCollarCharmRolePolicy();

let filamentProfileIndexCache: FilamentProfileIndex | null = null;

/** The configured slicer's BBL filament profile folder, when the slicer configuration resolves. */
function filamentProfileDirectory(): string | undefined {
  try {
    const { slicerType, slicerPath } = resolveSlicerConfig(undefined);
    return path.join(detectProfilesRoot(slicerPath, slicerType), "BBL", "filament");
  } catch { return undefined; }
}
/** An executable path, or a bare command found on PATH. */
function executableExists(command: string): boolean {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\")) return fs.existsSync(command);
  return (process.env.PATH ?? "").split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, command)));
}
/** A Bambu profile tree: BBL's machine profiles, or Orca's packed BBL.opc. */
function bblProfilesAt(root: string): boolean {
  return fs.existsSync(path.join(root, "BBL", "machine")) || fs.existsSync(path.join(root, "BBL.opc"));
}
/** The slicer this server would run now and the settings that choose it, for counterpart_setup_fields. */
function slicerSetupNow(): SlicerSetup {
  let config: { slicerType: string; slicerPath: string };
  try { config = resolveSlicerConfig(undefined); } catch { config = { slicerType: String(DEFAULT_SLICER_TYPE), slicerPath: "" }; }
  if (config.slicerType === "orca-slicer-api") return slicerSetup({ types: SLICER_TYPES, type: config.slicerType, found: Boolean(process.env.SLICER_API_URL), remote: true });
  const bbl = ["bambustudio", "orcaslicer", "orcaslicer-bambulab"].includes(config.slicerType);
  let profilesRoot: string | undefined;
  try { profilesRoot = bbl ? detectProfilesRoot(config.slicerPath, config.slicerType) : undefined; } catch { profilesRoot = undefined; }
  return slicerSetup({ types: SLICER_TYPES, type: config.slicerType, path: config.slicerPath, found: executableExists(config.slicerPath),
    ...(bbl ? { profilesFound: Boolean(profilesRoot && bblProfilesAt(profilesRoot)), ...(profilesRoot ? { profilesRoot } : {}) } : {}) });
}
let colourNamesCache: ColourNames | null = null;
/** Bambu Studio's own colour names for its filaments, read once from the configured slicer's profiles. */
function colourNames(): ColourNames {
  if (colourNamesCache) return colourNamesCache;
  const names = loadColourNames(filamentProfileDirectory());
  // A slicer installed later still names its colours: only a table that loaded is kept.
  if (names !== NO_COLOUR_NAMES) colourNamesCache = names;
  return names;
}

function buildFilamentProfileIndex(): FilamentProfileIndex {
  const byName = new Map<string, string>();
  const baseNameByFilamentId = new Map<string, string>();
  let filamentProfileDir: string;
  try {
    const { slicerType, slicerPath } = resolveSlicerConfig(undefined);
    filamentProfileDir = path.join(detectProfilesRoot(slicerPath, slicerType), "BBL", "filament");
  } catch {
    // Profile suggestions are optional; invalid slicer configuration must not hide AMS inventory.
    return { byName, baseNameByFilamentId };
  }

  let profileEntries: string[];
  try {
    profileEntries = fs.readdirSync(filamentProfileDir);
  } catch {
    // Ignore unavailable profile suggestions while keeping live inventory readable.
    return { byName, baseNameByFilamentId };
  }

  for (const entry of profileEntries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = path.join(filamentProfileDir, entry);

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
    } catch {
      // Ignore malformed or non-profile JSON files.
    }
  }

  return { byName, baseNameByFilamentId };
}

function getFilamentProfileIndex(): FilamentProfileIndex {
  if (!filamentProfileIndexCache) {
    filamentProfileIndexCache = buildFilamentProfileIndex();
  }

  return filamentProfileIndexCache;
}

function resolveFilamentProfileCandidates(
  trayInfoIdx: string,
  bambuModel?: string,
  nozzleDiameter?: string
): {
  baseName: string | null;
  paths: string[];
  resolution: "exact-model-nozzle" | "model" | "generic" | "unresolved";
} {
  const index = getFilamentProfileIndex();
  const baseName = index.baseNameByFilamentId.get(trayInfoIdx) || null;
  if (!baseName) {
    return { baseName: null, paths: [], resolution: "unresolved" };
  }

  const bareName = baseName.replace(/\s*@base$/, "");
  const modelCode = bambuModel ? FILAMENT_MODEL_CODES[bambuModel] : undefined;
  const candidateNames: string[] = [];

  if (modelCode && nozzleDiameter) {
    candidateNames.push(`${bareName} @BBL ${modelCode} ${nozzleDiameter} nozzle`);
  }
  if (modelCode) {
    candidateNames.push(`${bareName} @BBL ${modelCode}`);
  }
  candidateNames.push(bareName, baseName);

  const resolvedPaths: string[] = [];
  let resolution: "exact-model-nozzle" | "model" | "generic" | "unresolved" = "unresolved";

  for (const [candidateIndex, candidateName] of candidateNames.entries()) {
    const candidatePath = index.byName.get(candidateName);
    if (!candidatePath || resolvedPaths.includes(candidatePath)) continue;
    resolvedPaths.push(candidatePath);
    if (resolution === "unresolved") {
      if (candidateIndex === 0 && modelCode && nozzleDiameter) {
        resolution = "exact-model-nozzle";
      } else if (
        (candidateIndex === 0 && modelCode && !nozzleDiameter) ||
        (candidateIndex === 1 && modelCode && nozzleDiameter)
      ) {
        resolution = "model";
      } else {
        resolution = "generic";
      }
    }
  }

  return { baseName, paths: resolvedPaths, resolution };
}

function parseIntegerOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePrinterFilamentInventory(
  status: any,
  bambuModel?: string,
  nozzleDiameter?: string
): PrinterFilamentInventory {
  const rawAms = status?.raw?.ams || status?.ams || {};
  const trayNow = parseIntegerOrNull(rawAms?.tray_now);
  const trays: PrinterFilamentInventory["trays"] = [];

  const amsArray = Array.isArray(rawAms?.ams) ? rawAms.ams : [];
  for (const [amsIndex, amsUnit] of amsArray.entries()) {
    const trayArray = Array.isArray(amsUnit?.tray) ? amsUnit.tray : [];
    for (const [trayIndex, tray] of trayArray.entries()) {
      const amsId = parseIntegerOrNull(amsUnit?.id) ?? amsIndex;
      const trayId = parseIntegerOrNull(tray?.id) ?? trayIndex;
      const slot = amsId !== null && trayId !== null ? amsId * 4 + trayId : null;
      const state = parseIntegerOrNull(tray?.state) ?? 0;
      const trayInfoIdx = typeof tray?.tray_info_idx === "string" ? tray.tray_info_idx : null;
      const profileResolution =
        trayInfoIdx
          ? resolveFilamentProfileCandidates(trayInfoIdx, bambuModel, nozzleDiameter)
          : { baseName: null, paths: [], resolution: "unresolved" as const };
      const resolvedProfilePath = profileResolution.paths[0] || null;
      const matchConfidence =
        profileResolution.resolution === "exact-model-nozzle" ? "high" :
        profileResolution.resolution === "model" ? "medium" :
        profileResolution.resolution === "generic" ? "low" :
        "none";
      const trayType = typeof tray?.tray_type === "string" ? tray.tray_type : null;
      const traySubBrands = typeof tray?.tray_sub_brands === "string" ? tray.tray_sub_brands : null;
      const trayColor = typeof tray?.tray_color === "string" ? tray.tray_color : null;
      const displayParts = [
        traySubBrands && traySubBrands !== trayType ? traySubBrands : null,
        trayType,
        trayColor ? `#${normalizeRgbColor(trayColor) ?? trayColor.replace(/^#/, "").slice(0, 6)}` : null,
      ].filter(Boolean);

      trays.push({
        ams_id: amsId,
        tray_id: trayId,
        slot,
        state,
        loaded: state !== 0 && Boolean(trayInfoIdx),
        tray_info_idx: trayInfoIdx,
        tray_type: trayType,
        tray_sub_brands: traySubBrands,
        tray_color: trayColor,
        remain_percent:
          typeof tray?.remain === "number" && tray.remain >= 0 ? tray.remain : null,
        nozzle_temp_min: parseIntegerOrNull(tray?.nozzle_temp_min),
        nozzle_temp_max: parseIntegerOrNull(tray?.nozzle_temp_max),
        resolved_base_profile_name: profileResolution.baseName,
        resolved_profile_path: resolvedProfilePath,
        profile_resolution: profileResolution.resolution,
        match_confidence: matchConfidence,
        display_name: displayParts.length > 0 ? displayParts.join(" ") : "empty/unknown",
        label: amsId !== null && trayId !== null ? bambuTrayLabel(amsId, trayId) : null,
        spool_name: trayType ? spoolName(traySubBrands || trayType,
          trayInfoIdx && trayColor ? colourNames().spool(trayInfoIdx, trayColor) : undefined) : null,
        profile_candidates: profileResolution.paths,
      });
    }
  }

  const loadedTrays = trays.filter((tray) => tray.loaded);
  const recommendedTray =
    loadedTrays.find((tray) => tray.slot === trayNow && tray.resolved_profile_path) ||
    loadedTrays.find((tray) => tray.resolved_profile_path) ||
    null;
  const recommendedReason =
    recommendedTray?.slot === trayNow
      ? "current AMS slot with resolved slicer profile"
      : recommendedTray
        ? "first loaded AMS slot with resolved slicer profile"
        : null;

  const allProfilePaths = Array.from(
    new Set(
      loadedTrays
        .map((tray) => tray.resolved_profile_path)
        .filter((candidate): candidate is string => Boolean(candidate))
    )
  );
  const emptySlots = trays.filter((tray) => !tray.loaded).length;
  const resolvedProfileSlots = loadedTrays.filter((tray) => tray.resolved_profile_path).length;

  return {
    current_slot: trayNow !== null && trayNow >= 0 && trayNow < 254 ? trayNow : null,
    current_source:
      trayNow === 254 ? "external" : trayNow !== null && trayNow >= 0 && trayNow < 254 ? "ams" : null,
    summary: {
      loaded_slots: loadedTrays.length,
      resolved_profile_slots: resolvedProfileSlots,
      unresolved_loaded_slots: loadedTrays.length - resolvedProfileSlots,
      empty_slots: emptySlots,
      current_slot: trayNow !== null && trayNow >= 0 && trayNow < 254 ? trayNow : null,
      current_source:
        trayNow === 254 ? "external" : trayNow !== null && trayNow >= 0 && trayNow < 254 ? "ams" : null,
      recommended_slot: recommendedTray?.slot ?? null,
      recommended_reason: recommendedReason,
    },
    trays,
    recommended: recommendedTray
      ? {
          slot: recommendedTray.slot,
          tray_info_idx: recommendedTray.tray_info_idx,
          tray_type: recommendedTray.tray_type,
          resolved_profile_path: recommendedTray.resolved_profile_path,
          load_filaments: recommendedTray.resolved_profile_path,
          reason: recommendedReason ?? "resolved slicer profile",
        }
      : null,
    load_filaments_all: allProfilePaths.length > 0 ? allProfilePaths.join(";") : null,
  };
}

/**
 * Normalize a hex color string to lowercase 6-char RGB (drop leading "#"
 * and any trailing alpha bytes). Returns null if the input doesn't look
 * like a hex color.
 *
 * Bambu mixes formats: 3MF project_settings stores `#FFFFFF` or
 * `#FF911A80` (RGB or RGBA with leading #). AMS push_status reports
 * `FFFFFFFF` (RGBA without #). Comparing alpha is risky -- the same
 * filament can show up as `#000000` in one place and `000000FF` in
 * another. RGB-only is the right key.
 */
function normalizeRgbColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const hex = color.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
  return hex.slice(0, 6);
}

function resolveAmsSlotsFromRequirements(
  requirements: ThreeMFAmsRequirements,
  inventory: PrinterFilamentInventory
): {
  ams_slots: number[];
  matches: Array<{ filament_position: number; tray_info_idx: string; slot: number; matched_color?: string | null; match_strategy: "color" | "sku-only" }>;
  missing: Array<{ filament_position: number; tray_info_idx: string | null; required_color?: string | null; reason: "no_sku" | "no_loaded_match" | "color_mismatch" | "exhausted" }>;
} {
  const matches: Array<{ filament_position: number; tray_info_idx: string; slot: number; matched_color?: string | null; match_strategy: "color" | "sku-only" }> = [];
  const missing: Array<{ filament_position: number; tray_info_idx: string | null; required_color?: string | null; reason: "no_sku" | "no_loaded_match" | "color_mismatch" | "exhausted" }> = [];
  const amsSlots: number[] = [];

  // Track which AMS slots have already been claimed by an earlier
  // requirement so two filaments with the same SKU don't collapse onto
  // the same physical slot.
  const claimedSlots = new Set<number>();

  for (const filament of requirements.filaments) {
    if (!filament.tray_info_idx) {
      missing.push({
        filament_position: filament.filamentPosition,
        tray_info_idx: null,
        required_color: filament.color ?? null,
        reason: "no_sku",
      });
      continue;
    }

    const requiredColor = normalizeRgbColor(filament.color);

    // Pool of trays loaded with the required SKU that aren't already claimed.
    const skuPool = inventory.trays.filter(
      (candidate) =>
        candidate.loaded &&
        candidate.slot !== null &&
        candidate.tray_info_idx === filament.tray_info_idx &&
        !claimedSlots.has(candidate.slot)
    );

    if (skuPool.length === 0) {
      // No trays of this SKU loaded at all (or all already claimed).
      const reason: "no_loaded_match" | "exhausted" = inventory.trays.some(
        (t) => t.tray_info_idx === filament.tray_info_idx
      )
        ? "exhausted"
        : "no_loaded_match";
      missing.push({
        filament_position: filament.filamentPosition,
        tray_info_idx: filament.tray_info_idx,
        required_color: filament.color ?? null,
        reason,
      });
      continue;
    }

    // Prefer an exact RGB color match. This is what disambiguates
    // same-SKU different-color cases (e.g. two GFG02 PETG HF trays
    // loaded -- one black, one white).
    let chosen = skuPool.find(
      (candidate) => normalizeRgbColor(candidate.tray_color) === requiredColor && requiredColor !== null
    );
    let strategy: "color" | "sku-only" = "color";

    // Fall back to SKU-only when the requirement has no color (legacy
    // 3MF) or when only one tray of this SKU is loaded (no ambiguity).
    if (!chosen) {
      if (!requiredColor || skuPool.length === 1) {
        chosen = skuPool[0];
        strategy = "sku-only";
      } else {
        // Color was specified, multiple SKU candidates loaded, none
        // match the requested color. Surface clearly rather than pick
        // a wrong color silently.
        missing.push({
          filament_position: filament.filamentPosition,
          tray_info_idx: filament.tray_info_idx,
          required_color: filament.color ?? null,
          reason: "color_mismatch",
        });
        continue;
      }
    }

    if (chosen.slot === null) {
      // Defensive: shouldn't happen because of the filter above, but
      // keep the type contract honest.
      missing.push({
        filament_position: filament.filamentPosition,
        tray_info_idx: filament.tray_info_idx,
        required_color: filament.color ?? null,
        reason: "no_loaded_match",
      });
      continue;
    }

    claimedSlots.add(chosen.slot);
    amsSlots.push(chosen.slot);
    matches.push({
      filament_position: filament.filamentPosition,
      tray_info_idx: filament.tray_info_idx,
      slot: chosen.slot,
      matched_color: chosen.tray_color ?? null,
      match_strategy: strategy,
    });
  }

  return { ams_slots: amsSlots, matches, missing };
}

function extractPrinterDiagnostics(status: any): Record<string, unknown> {
  const raw = status?.raw && typeof status.raw === "object" ? status.raw : {};
  const diagnosticFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (/(hms|error|fail|warn)/i.test(key)) {
      diagnosticFields[key] = value;
    }
  }

  return {
    connected: Boolean(status?.connected),
    serial: status?.serial ?? null,
    printer_status: status?.status ?? null,
    active_error:
      raw.print_error ??
      raw.print_error_code ??
      raw.mc_print_error_code ??
      raw.fail_reason ??
      null,
    hms: raw.hms ?? raw.hms_info ?? raw.hms_list ?? null,
    diagnostic_fields: diagnosticFields,
  };
}

/** Parse "#RRGGBB;#RRGGBB" (leading '#' optional) into positional slot colours. */
function parseFilamentColours(value: string): string[] {
  const colours = value.split(";").map((c) => c.trim()).filter(Boolean)
    .map((c) => (c.startsWith("#") ? c : `#${c}`).toUpperCase());
  for (const c of colours) {
    if (!/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(c)) {
      throw new Error(`Invalid filament colour "${c}"; expected #RRGGBB.`);
    }
  }
  if (colours.length === 0) throw new Error("filament_colours must list at least one colour.");
  return colours;
}

function validateBambuModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!VALID_BAMBU_MODELS.includes(normalized as BambuModel)) {
    throw new Error(
      `Invalid bambu_model: "${model}". Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
    );
  }
  return normalized;
}

function resolveBedType(argsBedType: string | undefined): string {
  const bedType = (argsBedType || DEFAULT_BED_TYPE).trim().toLowerCase();
  if (!(VALID_BED_TYPES as readonly string[]).includes(bedType)) {
    throw new Error(
      `Invalid bed_type: "${bedType}". Valid types: ${VALID_BED_TYPES.join(", ")}`
    );
  }
  return bedType;
}

function resolveBambuStudioCliBedType(argsBedType: string | undefined): string {
  const bedType = resolveBedType(argsBedType);
  if (!(VALID_BAMBUSTUDIO_CLI_BED_TYPES as readonly string[]).includes(bedType)) {
    throw new Error(
      `BambuStudio CLI bed_type "${bedType}" is not one of: ${VALID_BAMBUSTUDIO_CLI_BED_TYPES.join(", ")}`
    );
  }
  return bedType;
}

// Slicer configuration (defaults to bambustudio)
const DEFAULT_SLICER_TYPE = process.env.SLICER_TYPE || "bambustudio";
const DEFAULT_SLICER_PROFILE = process.env.BAMBU_SLICER_PROFILE || process.env.SLICER_PROFILE || "";
const DEFAULT_TEMPLATE_3MF_PATH = process.env.BAMBU_TEMPLATE_3MF_PATH || "";
const DEFAULT_TEMPLATE_DIR =
  process.env.BAMBU_TEMPLATE_DIR ||
  path.join(process.env.HOME || process.cwd(), "Sync", "bambu", "templates");
const SLICER_SCHEMA_VALUES = [
  ...SLICER_TYPES,
  "fulu-orca",
  "fulu-orcaslicer",
  "orca-studio",
  "orca-bambulab",
];

function firstExistingPath(paths: string[], fallback: string): string {
  return paths.find((candidate) => fs.existsSync(candidate)) || fallback;
}

function defaultSlicerPathFor(slicerType: SlicerType): string {
  if (slicerType === "orcaslicer" || slicerType === "orcaslicer-bambulab") {
    if (process.platform === "darwin") {
      return firstExistingPath(
        [
          "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
          "/Applications/Orca Studio.app/Contents/MacOS/Orca Studio",
          "/Applications/OrcaSlicer-BMCU.app/Contents/MacOS/OrcaSlicer",
        ],
        "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
      );
    }
    if (process.platform === "win32") {
      return "C:\\Program Files\\OrcaSlicer\\OrcaSlicer.exe";
    }
    return "OrcaSlicer";
  }

  if (slicerType === "bambustudio") {
    if (process.env.BAMBU_STUDIO_PATH) {
      return process.env.BAMBU_STUDIO_PATH;
    }
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

function resolveSlicerConfig(args: Record<string, unknown> | undefined): {
  slicerType: SlicerType;
  slicerPath: string;
  slicerProfile: string;
} {
  const slicerType = normalizeSlicerType(String(args?.slicer_type || DEFAULT_SLICER_TYPE));
  const slicerPath = slicerType === "orca-slicer-api" ? "" : String(args?.slicer_path || process.env.SLICER_PATH || defaultSlicerPathFor(slicerType));
  const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
  return { slicerType, slicerPath, slicerProfile };
}

type RuntimeConfig = {
  transport: "stdio" | "streamable-http";
  httpHost: string;
  httpPort: number;
  httpPath: string;
  statefulSession: boolean;
  enableJsonResponse: boolean;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  blenderBridgeCommand?: string;
  ffmpegPath?: string;
  allowExecutableArg: boolean;
  allowBridgeCommandArg: boolean;
};

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) return fallback;
  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

// Someone confirming a hardware action may have to walk to the printer, so the
// SDK's 60-second request default is too short for human confirmation.
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 600_000;
const MIN_CONFIRMATION_TIMEOUT_MS = 1_000;
const MAX_CONFIRMATION_TIMEOUT_MS = 3_600_000;

/** Out-of-range values fall back to the default; Node clamps huge timer delays to 1 ms. */
function parseConfirmationTimeout(value: string | undefined): number {
  const parsed = Number(value?.trim() || NaN);
  return Number.isInteger(parsed) && parsed >= MIN_CONFIRMATION_TIMEOUT_MS && parsed <= MAX_CONFIRMATION_TIMEOUT_MS
    ? parsed
    : DEFAULT_CONFIRMATION_TIMEOUT_MS;
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} minute(s)` : `${Math.round(ms / 100) / 10} second(s)`;
}

function isElicitationTimeout(error: any): boolean {
  return error?.code === ErrorCode.RequestTimeout;
}

/** Only a missing method or capability means the client cannot show the prompt. */
function isElicitationUnsupported(error: any): boolean {
  const message = String(error?.message ?? error);
  return error?.code === ErrorCode.MethodNotFound || error?.code === ErrorCode.InvalidRequest ||
    /does not support (form |url )?elicitation/i.test(message);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT value: ${value}`);
  }
  return parsed;
}

function normalizePath(pathValue: string | undefined): string {
  const value = (pathValue ?? "/mcp").trim();
  if (!value) return "/mcp";
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * The lowercase hostname of a Host header, without its port or a trailing dot; undefined when malformed.
 * `bareIpv6` accepts an unbracketed IPv6 address, as a bind address or configured host is written but a Host header is not.
 */
function hostHeaderName(value: string | undefined, bareIpv6 = false): string | undefined {
  if (!value) return undefined;
  const bracketed = bareIpv6 && !value.startsWith("[") && value.indexOf(":") !== value.lastIndexOf(":") ? `[${value}]` : value;
  try {
    const url = new URL(`http://${bracketed}`);
    return url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash ? url.hostname.toLowerCase().replace(/\.$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hostnames a request's Host header may name, which blocks DNS rebinding: loopback names, a specific bind address and
 * MCP_HTTP_ALLOWED_HOSTS. Undefined (no check) only for a wildcard bind with no configured hosts.
 */
function allowedRequestHostnames(httpHost: string, configured: Set<string>): Set<string> | undefined {
  const bind = hostHeaderName(httpHost, true);
  const wildcard = bind === "0.0.0.0" || bind === "[::]";
  if (wildcard && configured.size === 0) return undefined;
  return new Set(["localhost", "127.0.0.1", "[::1]", ...(bind && !wildcard ? [bind] : []), ...configured]);
}

function parseCsvEnv(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((e) => e.trim()).filter((e) => e.length > 0));
}

async function resolveSlicerProfilePath(
  requestedProfile: string | undefined,
  templatePath: string | undefined,
  tempDir: string
): Promise<string | undefined> {
  if (requestedProfile) {
    return requestedProfile;
  }

  if (templatePath) {
    return resolveTemplateSlicerProfilePath(templatePath, tempDir);
  }

  return undefined;
}

async function resolveTemplateSlicerProfilePath(
  templatePath: string,
  tempDir: string
): Promise<string> {
  const extension = path.extname(templatePath).toLowerCase();
  if (extension === ".3mf") {
    return extractBambuTemplateSettings(templatePath, tempDir);
  }
  if (extension === ".json" || extension === ".config") {
    return templatePath;
  }
  throw new Error(`Template profile must be a .3mf, .json, or .config file: ${templatePath}`);
}

/** inspect_print_file's preview: drawn from the snapshot's own bytes, refused if they aren't the inspected ones. */
async function previewOfSnapshot(snapshot: string, plateIndex: number, sha256: string) {
  const bytes = await fs.promises.readFile(snapshot);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("The file changed while it was being inspected; nothing was previewed.");
  let gcode: string, projectColours: unknown[] | undefined;
  if (snapshot.toLowerCase().endsWith(".3mf")) {
    const zip = await loadSafe3mfArchive(bytes);
    const entry = zip.file(`Metadata/plate_${plateIndex + 1}.gcode`);
    if (!entry) return undefined;
    gcode = await entry.async("string");
    const settings = zip.file("Metadata/project_settings.config");
    if (settings) {
      try { const parsed = JSON.parse(await settings.async("string")); if (Array.isArray(parsed?.filament_colour)) projectColours = parsed.filament_colour; } catch { /* colours fall back to the G-code header */ }
    }
  } else gcode = bytes.toString("utf8");
  const preview = await previewPrintFile({ gcode, ...(projectColours ? { projectColours } : {}) });
  return preview ? { ...preview, artifact_sha256: sha256, plate_index: plateIndex } : undefined;
}

/**
 * The slice's arguments change a resolved process: an explicit value (layer height, walls, infill, supports), or a
 * quality or strength other than standard. Invalid values throw, as slice_stl's own parsing does.
 */
function changesProcess(args: Record<string, unknown>): boolean {
  // slice_stl's own validation of these values (quality, strength, layer height, walls, infill, supports).
  const nozzle = Number(args.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
  parseProcessOverrides(withPrintQuality(args, nozzle), nozzle);
  return ["layer_height", "wall_loops", "sparse_infill_density", "enable_support", "support_type", "support_threshold_angle"].some(key => args[key] !== undefined)
    || (args.quality !== undefined && args.quality !== "standard") || (args.strength !== undefined && args.strength !== "standard");
}

function hasExplicitSlicerProfile(args: any): boolean {
  return typeof args?.slicer_profile === "string" && args.slicer_profile.trim().length > 0;
}

/**
 * A 3MF that carries its own process (a designer's project) as its slicing template, when the call names
 * no profile or template of its own. A configured default profile or template must not replace the
 * designer's layer height, walls and infill; the machine still comes from the chosen printer preset.
 */
/** The template this call names: template_name (resolved by the caller) or template_3mf_path. */
function namedTemplatePath(args: any, fromName: string | undefined): string | undefined {
  return fromName || (typeof args?.template_3mf_path === "string" && args.template_3mf_path.trim() ? String(args.template_3mf_path) : undefined);
}

async function ownProcessTemplate(args: any, modelPath: string, requestedTemplatePath: string | undefined): Promise<string | undefined> {
  if (hasExplicitSlicerProfile(args) || requestedTemplatePath || !modelPath.toLowerCase().endsWith(".3mf")) return undefined;
  return await hasBambuProjectSettings(modelPath) ? modelPath : undefined;
}

async function resolveTemplateFirstSlicerProfilePath(
  args: any,
  configuredProfile: string | undefined,
  template3mfPath: string | undefined,
  tempDir: string
): Promise<string | undefined> {
  if (hasExplicitSlicerProfile(args)) {
    return configuredProfile || undefined;
  }

  if (template3mfPath) {
    return resolveTemplateSlicerProfilePath(template3mfPath, tempDir);
  }

  return configuredProfile || undefined;
}

function readRuntimeConfig(): RuntimeConfig {
  const rawTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  const transport =
    rawTransport === "streamable-http" || rawTransport === "http"
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
    allowedHosts: new Set([...parseCsvEnv(process.env.MCP_HTTP_ALLOWED_HOSTS)].flatMap(host => hostHeaderName(host, true) ?? [])),
    blenderBridgeCommand: process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() || undefined,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
    allowExecutableArg: parseBooleanEnv(process.env.MCP_ALLOW_EXECUTABLE_ARG, false),
    allowBridgeCommandArg: parseBooleanEnv(process.env.MCP_ALLOW_BRIDGE_COMMAND_ARG, false),
  };
}

type StructuredToolError = {
  status: "error";
  retryable: boolean;
  suggestion: string;
  message: string;
  tool: string;
  /** A stable refusal code (src/refusal.ts) when the printer refused; clients act on it, not on the words. */
  code?: string;
  slicer_result?: Record<string, unknown>;
};

type UploadGcodeSource = {
  filePath: string;
  cleanupDir?: string;
};

function expandUserPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") {
    return process.env.HOME || trimmed;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(process.env.HOME || "", trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function readableFilePathFromString(value: string): string | undefined {
  if (!value.trim() || value.includes("\n") || value.includes("\r")) {
    return undefined;
  }

  const candidate = expandUserPath(value);
  try {
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeGcodeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
    return false;
  }
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.includes("\\") ||
    /\.(gcode|gco|gc)$/i.test(trimmed)
  );
}

function requireReadableFilePath(rawPath: string, label: string): string {
  const candidate = expandUserPath(rawPath);
  try {
    if (!fs.statSync(candidate).isFile()) {
      throw new Error(`${label} is not a file: ${candidate}`);
    }
  } catch (error) {
    if ((error as Error).message.startsWith(`${label} is not a file:`)) {
      throw error;
    }
    throw new Error(`${label} does not exist or is not readable: ${candidate}`);
  }
  return candidate;
}

function writeGcodeContentToTempFile(filename: string, gcode: string): UploadGcodeSource {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const cleanupDir = fs.mkdtempSync(path.join(TEMP_DIR, "upload-gcode-"));
  const safeName = path.basename(filename.replace(/^\/+/, "")) || "upload.gcode";
  const filePath = path.join(cleanupDir, safeName);
  fs.writeFileSync(filePath, gcode);
  return { filePath, cleanupDir };
}

function resolveUploadGcodeSource(args: Record<string, unknown>): UploadGcodeSource {
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
    throw new Error(
      "gcode looks like a local G-code path, but the file is not readable. " +
      "Pass readable gcode_path or literal G-code content."
    );
  }

  return writeGcodeContentToTempFile(String(args.filename), gcode);
}

const BAMBU_NETWORK_PRINT_METHODS = [
  "start_print",
  "start_local_print",
  "start_local_print_with_record",
  "start_send_gcode_to_sdcard",
  "start_sdcard_print",
] as const;

type BambuNetworkPrintMethod = typeof BAMBU_NETWORK_PRINT_METHODS[number];

function resolveBambuNetworkPrintMethod(
  rawMethod: string | undefined,
  connectionType: string
): BambuNetworkPrintMethod {
  const defaultMethod = connectionType === "lan" ? "start_local_print" : "start_print";
  const method = (rawMethod || defaultMethod).trim();

  if (!(BAMBU_NETWORK_PRINT_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `Invalid bambu_network_method: "${method}". Valid methods: ${BAMBU_NETWORK_PRINT_METHODS.join(", ")}`
    );
  }

  return method as BambuNetworkPrintMethod;
}

function toBridgeMethod(method: BambuNetworkPrintMethod): string {
  return `net.${method}`;
}

function stringifyBridgeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function nativeAmsMapping2(mapping: number[] | undefined, dualNozzle = false): string | undefined {
  if (!mapping || mapping.length === 0) return undefined;
  return JSON.stringify(mapping.map((value) => bridgeAmsMapping2Entry(value, dualNozzle)));
}

function redactPrintParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    password: params.password ? "[redacted]" : "",
  };
}

function parseLooseSlicerConfig(content: string): Record<string, any> {
  try {
    return JSON.parse(content);
  } catch {
    const config: Record<string, any> = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key) {
        config[key] = value;
      }
    }
    return config;
  }
}

function summarizeSliceSettings(config: Record<string, any>) {
  return {
    printer_settings_id:
      typeof config.printer_settings_id === "string" ? config.printer_settings_id : null,
    default_print_profile:
      typeof config.default_print_profile === "string" ? config.default_print_profile : null,
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
    layer_height:
      config.layer_height !== undefined && config.layer_height !== null
        ? Number(config.layer_height)
        : null,
    first_layer_height:
      config.initial_layer_print_height !== undefined && config.initial_layer_print_height !== null
        ? Number(config.initial_layer_print_height)
        : config.first_layer_height !== undefined && config.first_layer_height !== null
          ? Number(config.first_layer_height)
          : null,
    sparse_infill_density:
      config.sparse_infill_density !== undefined && config.sparse_infill_density !== null
        ? String(config.sparse_infill_density)
        : null,
    wall_loops:
      config.wall_loops !== undefined && config.wall_loops !== null
        ? Number(config.wall_loops)
        : null,
    top_shell_layers:
      config.top_shell_layers !== undefined && config.top_shell_layers !== null
        ? Number(config.top_shell_layers)
        : null,
    bottom_shell_layers:
      config.bottom_shell_layers !== undefined && config.bottom_shell_layers !== null
        ? Number(config.bottom_shell_layers)
        : null,
    brim_width:
      config.brim_width !== undefined && config.brim_width !== null
        ? Number(config.brim_width)
        : null,
    support_enabled:
      config.enable_support !== undefined
        ? String(config.enable_support) === "1" || String(config.enable_support).toLowerCase() === "true"
        : config.support_enabled !== undefined
          ? Boolean(config.support_enabled)
          : null,
    support_type: typeof config.support_type === "string" ? config.support_type : null,
    bed_type:
      typeof config.curr_bed_type === "string"
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

type TemplateEntry = {
  name: string;
  path: string;
  source_type: "3mf" | "json" | "config";
  relative_path: string;
};
type TemplateSourceType = TemplateEntry["source_type"];

function sanitizeTemplateName(templateName: string): string {
  return templateName
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9/_-]/g, "_");
}

function scanTemplateRegistry(templateDir: string): TemplateEntry[] {
  if (!fs.existsSync(templateDir)) {
    return [];
  }

  const allowedExtensions = new Set([".3mf", ".json", ".config"]);
  const entries: TemplateEntry[] = [];
  const stack = [templateDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
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
  private server: Server;
  private bambu: BambuImplementation;
  private bambuNetwork: BambuNetworkBridge;
  private readonly blender = new BlenderMcpBridge();
  private readonly fusion = new FusionMcpBridge();
  // Downloads and installer output are staged in this server's own temporary folder.
  private readonly blenderSetup = new BlenderAddonSetup(() => this.blenderAddonHandshake(), { ...defaultSetupSystem, tmp: TEMP_DIR });
  private readonly fusionSetup = new FusionAddinSetup(() => addinAddress().port, FUSION_MCP_DEFAULT_ARGS, { ...defaultSetupSystem, tmp: TEMP_DIR });
  private stlManipulator: STLManipulator;
  private readonly runtimeConfig: RuntimeConfig;
  private httpRuntime?: { transport: StreamableHTTPServerTransport; httpServer: HttpServer };
  private shuttingDown = false;
  private readonly confirmationTimeoutMs = parseConfirmationTimeout(process.env.BAMBU_CONFIRMATION_TIMEOUT_MS);

  constructor() {
    this.runtimeConfig = readRuntimeConfig();
    this.server = new Server(
      SERVER_INFO,
      {
        capabilities: {
          prompts: {},
          resources: {},
          tools: {}
        },
        instructions: SERVER_INSTRUCTIONS
      }
    );

    this.bambu = new BambuImplementation(async message => {
      try {
        const response = await this.server.elicitInput({
          mode: "form",
          message,
          requestedSchema: {
            type: "object",
            properties: { confirmed: { type: "boolean", title: "I checked the printer and confirm this operation", default: false } },
            required: ["confirmed"],
          },
        }, { timeout: this.confirmationTimeoutMs });
        if (response.action === "accept" && response.content?.confirmed !== true) {
          throw new Error("Hardware confirmation checkbox was not checked. Check it only after inspecting the printer, or cancel. No command was sent.");
        }
        return response.action === "accept" && response.content?.confirmed === true;
      } catch (error: any) {
        if (isElicitationTimeout(error)) {
          throw new Error(`No hardware confirmation within ${describeDuration(this.confirmationTimeoutMs)}; nothing was sent to the printer. Retry when someone can check the printer, or raise BAMBU_CONFIRMATION_TIMEOUT_MS.`);
        }
        if (isElicitationUnsupported(error)) {
          throw new Error("Human hardware confirmation requires an MCP client with elicitation support. Only clearing hardware errors, the first print after a clear, and resuming a file that could not be re-read ask.");
        }
        throw new Error(`Human hardware confirmation failed: ${error?.message ?? error}. Nothing was sent to the printer.`);
      }
    }, { resumeStateDir: defaultResumeStateDir() });
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
    this.setupPromptHandlers();
    this.setupToolHandlers();
  }

  /** The running Blender add-on's get_addon_status, read through this server's Blender bridge (undefined when it has none). */
  private async blenderAddonHandshake(): Promise<BlenderAddonHandshake | undefined> {
    const signal = AbortSignal.timeout(20_000);
    const status = await this.blender.status({ connect: true, timeout_ms: 15_000 }, signal) as { connected?: boolean; tools?: { name?: string }[] };
    if (status?.connected !== true || !status.tools?.some(tool => tool.name === "get_addon_status")) return undefined;
    return parseAddonHandshake(await this.blender.call({ tool_name: "get_addon_status", arguments: {}, timeout_ms: 15_000 }, signal));
  }

  /**
   * The model for display-only counterpart tools: the argument, then the
   * configured model, then the serial prefix. Never a safety decision and
   * never elicited; print routes use resolveBambuModel and fresh identity.
   */
  private displayModel(args: Record<string, unknown> | undefined, serial: string): string | undefined {
    const requested = typeof args?.bambu_model === "string" ? args.bambu_model.trim() : "";
    return requested || DEFAULT_BAMBU_MODEL || SERIAL_MODELS[serial.trim().toUpperCase().slice(0, 3)] || undefined;
  }

  /**
   * Resolve the Bambu printer model from args, env, or by asking the user via elicitation.
   * This is critical for safety: the wrong model can cause physical damage to the printer.
   */
  private async resolveBambuModel(argsModel: string | undefined): Promise<string> {
    const fromArgs = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
    if (fromArgs) {
      return validateBambuModel(fromArgs);
    }

    // No model from args or env — ask the user via elicitation
    try {
      const result = await this.server.elicitInput({
        mode: "form" as const,
        message:
          "Your Bambu Lab printer model is required for safe operation. " +
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
                { const: "p2s", title: "P2S" },
                { const: "x1c", title: "X1 Carbon" },
                { const: "x1e", title: "X1E" },
                { const: "a1", title: "A1" },
                { const: "a1mini", title: "A1 Mini" },
                { const: "h2d", title: "H2D" },
                { const: "h2dpro", title: "H2D Pro" },
                { const: "h2s", title: "H2S" },
                { const: "h2c", title: "H2C" },
                { const: "x2d", title: "X2D" },
              ],
            },
          },
          required: ["bambu_model"],
        },
      }, { timeout: this.confirmationTimeoutMs });

      if (result.action === "accept" && result.content?.bambu_model) {
        return validateBambuModel(String(result.content.bambu_model));
      }

      throw new Error(
        "Printer model selection was cancelled. Cannot proceed without knowing the printer model."
      );
    } catch (elicitError: any) {
      if (isElicitationTimeout(elicitError)) {
        throw new Error(
          `No printer model was selected within ${describeDuration(this.confirmationTimeoutMs)}; nothing was sent to the printer. ` +
          "Set BAMBU_MODEL or pass bambu_model in the tool call."
        );
      }
      // Elicitation not supported by this client — fall back to a clear error
      if (isElicitationUnsupported(elicitError)) {
        throw new Error(
          "bambu_model is required but your MCP client does not support elicitation. " +
          `Set the BAMBU_MODEL environment variable or pass bambu_model in the tool call. ` +
          `Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
        );
      }
      throw elicitError;
    }
  }

  private bridgeOptionsFromArgs(
    args: Record<string, any> | undefined,
    toolName: string
  ): BambuNetworkBridgeOptions {
    return {
      bridgeCommand: this.resolveExecutableSelectorArg(
        args?.bridge_command,
        toolName,
        "bridge_command",
        true
      ),
      configDir: args?.bambu_network_config_dir !== undefined ? String(args.bambu_network_config_dir) : undefined,
      countryCode: args?.country_code !== undefined ? String(args.country_code) : undefined,
      userInfo: args?.user_info !== undefined ? String(args.user_info) : undefined,
      timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
    };
  }

  private resolveExecutableSelectorArg(
    rawValue: unknown,
    toolName: string,
    argumentName: string,
    allowLegacyBridgeArg = false
  ): string | undefined {
    if (rawValue === undefined) {
      return undefined;
    }

    const value = String(rawValue);
    if (value.length === 0) {
      return undefined;
    }

    const isAllowed =
      this.runtimeConfig.allowExecutableArg ||
      (allowLegacyBridgeArg && this.runtimeConfig.allowBridgeCommandArg);
    if (!isAllowed) {
      throw new Error(
        `${toolName}: the ${argumentName} argument cannot select an executable by default. ` +
        "Executable paths and commands are read from server environment configuration. Set " +
        `MCP_ALLOW_EXECUTABLE_ARG=1 to accept ${argumentName} for process execution.`
      );
    }

    return value;
  }

  private resolveSlicerConfigFromArgs(
    args: Record<string, unknown> | undefined,
    toolName: string
  ): ReturnType<typeof resolveSlicerConfig> {
    const config = resolveSlicerConfig(args);
    if (args?.slicer_path !== undefined) {
      if (config.slicerType === "orca-slicer-api") {
        throw new Error(`${toolName}: remote slicing uses trusted SLICER_API_URL and BAMBU_PROFILES_ROOT configuration; slicer_path is unsupported.`);
      }
      const resolvedSlicerPath = this.resolveExecutableSelectorArg(
        args.slicer_path,
        toolName,
        "slicer_path"
      );
      if (resolvedSlicerPath !== undefined) {
        config.slicerPath = resolvedSlicerPath;
      }
    }
    return config;
  }

  private async ensurePrintableThreeMFPath(
    args: Record<string, any>,
    printModel: string,
    printPreset: string | undefined,
    bedType?: string
  ): Promise<{ threeMFPath: string; autoSliced: boolean }> {
    const { slicerType, slicerPath, slicerProfile } =
      this.resolveSlicerConfigFromArgs(args, "print_3mf_bambu_network");
    let threeMFPath = String(args.three_mf_path);

    const JSZip = (await import('jszip')).default;
    const zipData = fs.readFileSync(threeMFPath);
    const zip = await JSZip.loadAsync(zipData);
    const hasGcode = Object.values(zip.files).some(entry => !entry.dir && /\.gcode$/i.test(entry.name));

    if (hasGcode) {
      return { threeMFPath, autoSliced: false };
    }
    assertUniformCliNozzles(args);

    console.error(`3MF has no gcode - auto-slicing with ${slicerType} for ${printModel}`);
    const autoSliceOptions: BambuSliceOptions = {
      ...(slicerType === "orca-slicer-api" ? {} : {
        uptodate: true, ensureOnBed: true, minSave: true, skipModifiedGcodes: true,
      }),
      ...(slicerType === "orca-slicer-api" ? { slicePlate: Number(args.plate_index ?? 0) + 1 } : {}),
      bedType: bedType ? resolveBambuStudioCliBedType(bedType) : undefined,
      nozzleType: resolveNozzleType(args?.nozzle_type),
      nozzleVolumeType: resolveNozzleVolumeType(args?.nozzle_volume_type),
    };
    // A designer's project slices with its own process here too, as slice_stl and the LAN route do.
    const ownProcess = await ownProcessTemplate(args, threeMFPath, namedTemplatePath(args, typeof args?.template_name === "string" && args.template_name.trim() ? String(args.template_name) : undefined));
    threeMFPath = await this.stlManipulator.sliceSTL(
      threeMFPath, slicerType, slicerPath, ownProcess ? await resolveTemplateSlicerProfilePath(ownProcess, TEMP_DIR) : slicerProfile || undefined,
      undefined,
      printPreset,
      autoSliceOptions
    );
    console.error("Auto-sliced to: " + threeMFPath);
    return { threeMFPath, autoSliced: true };
  }

  private async resolveAmsPrintSettings(
    threeMFPath: string,
    args: Record<string, any>,
    host: string,
    bambuSerial: string,
    bambuToken: string,
    printModel?: string,
    printNozzle?: string
  ): Promise<{ useAMS: boolean; finalAmsMapping?: number[]; finalAmsSlots?: number[] }> {
    const parsed3MFData = await parse3MF(threeMFPath);
    let parsedAmsMapping: number[] | undefined;
    const trayOptions = { dualNozzle: isDualNozzleModel(printModel) };

    if (parsed3MFData.slicerConfig?.ams_mapping) {
      const slots = normalizeAmsMappingObject(parsed3MFData.slicerConfig.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
      if (slots.length > 0) {
        parsedAmsMapping = slots;
      }
    }

    let finalAmsMapping = parsedAmsMapping;
    let finalAmsSlots: number[] | undefined;
    let useAMS = args?.use_ams !== undefined ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
    const hasUserAmsMapping = hasAmsMappingInput(args?.ams_mapping);
    const hasUserAmsSlots = Array.isArray(args?.ams_slots);

    if (hasUserAmsMapping) {
      let userMappingOverride: number[] | undefined;
      if (Array.isArray(args.ams_mapping)) {
        userMappingOverride = args.ams_mapping.map((v: unknown, i: number) =>
          normalizeBridgeAmsTrayValue(v, `ams_mapping[${i}]`, trayOptions)
        );
      } else if (args.ams_mapping && typeof args.ams_mapping === 'object') {
        userMappingOverride = normalizeAmsMappingObject(args.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
      }
      if (userMappingOverride && userMappingOverride.length > 0) {
        finalAmsMapping = userMappingOverride;
        finalAmsSlots = undefined;
        useAMS = true;
      }
    }

    if (!hasUserAmsMapping && hasUserAmsSlots) {
      const userSlots = args.ams_slots.map((slot: unknown, i: number) =>
        normalizeBridgeAmsTrayValue(slot, `ams_slots[${i}]`, trayOptions)
      );
      finalAmsSlots = userSlots;
      finalAmsMapping = undefined;
      useAMS = userSlots.length > 0;
    }

    if (!hasUserAmsMapping && !hasUserAmsSlots && args?.auto_match_ams) {
      const requirements = await analyze3MFAmsRequirements(
        threeMFPath,
        args?.plate_index !== undefined ? Number(args.plate_index) : 0
      );
      const inventory = await this.getResolvedPrinterFilamentInventory(
        host,
        bambuSerial,
        bambuToken,
        printModel,
        printNozzle
      );
      const resolved = resolveAmsSlotsFromRequirements(requirements, inventory);
      if (resolved.missing.length > 0) {
        throw new Error(`Could not auto-match AMS slots: ${JSON.stringify(resolved.missing)}`);
      }
      finalAmsSlots = resolved.ams_slots;
      finalAmsMapping = undefined;
      useAMS = true;
    }

    if (args?.use_ams === false) {
      if (!hasUserAmsMapping) finalAmsMapping = undefined;
      if (!hasUserAmsSlots) finalAmsSlots = undefined;
      useAMS = false;
    }
    if ((!finalAmsMapping || finalAmsMapping.length === 0) && (!finalAmsSlots || finalAmsSlots.length === 0)) {
      if (args.use_ams === true || (args.use_ams !== false && (hasUserAmsMapping || hasUserAmsSlots))) {
        throw new Error("AMS printing requires a nonempty ams_mapping, ams_slots, or auto_match_ams result.");
      }
      useAMS = false;
    }

    return { useAMS, finalAmsMapping, finalAmsSlots };
  }

  private async print3mfViaBambuNetwork(
    args: Record<string, any>,
    host: string,
    bambuSerial: string,
    bambuToken: string,
    native?: { onUpdate?: BambuNativeUpdateCallback; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    if (!args?.three_mf_path) {
      throw new Error("Missing required parameter: three_mf_path");
    }
    if (args?.try_emmc_print !== undefined && typeof args.try_emmc_print !== "boolean") {
      throw new Error("try_emmc_print must be true or false.");
    }

    const printModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
    const printBedType = resolveBedType(args?.bed_type as string | undefined);
    const printNozzles = requestedPrintNozzles(args);
    const printNozzle = String(printNozzles?.[0] ?? DEFAULT_NOZZLE_DIAMETER);
    const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
    const plateIndex = args?.plate_index !== undefined ? Number(args.plate_index) : 0;

    if (!Number.isInteger(plateIndex) || plateIndex < 0) {
      throw new Error("plate_index must be a non-negative integer.");
    }

    const connectionType = resolveConnection(args).type;

    // With no method given, a cloud print follows Bambu Studio's order for a cloud-bound printer it can
    // reach on the LAN (PrintJob.cpp): start_local_print_with_record in the cloud session, then start_print.
    // This server always has the printer's IP and access code, which Studio needs for the first.
    const studioCloudRoute = connectionType === "cloud" && args?.bambu_network_method === undefined;
    const bridgePrintMethod = studioCloudRoute ? "start_local_print_with_record" : resolveBambuNetworkPrintMethod(
      args?.bambu_network_method !== undefined ? String(args.bambu_network_method) : undefined,
      connectionType
    );
    let bridgeMethod = toBridgeMethod(bridgePrintMethod);
    const isLocalBridgePrint = bridgePrintMethod !== "start_print";
    const inCloudSession = studioCloudRoute || !isLocalBridgePrint;
    let cloudFallbackMethod = studioCloudRoute ? toBridgeMethod("start_print") : undefined;

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

    if (!bambuSerial || devId !== bambuSerial || !devIp || devIp === "localhost" || !(password || bambuToken)) {
      throw new Error("Bridge printing requires a matching bambu_serial/dev_id, printer host, and LAN access token for fresh MQTT safety verification, including cloud dispatch.");
    }
    for (const field of ["config_filename", "ftp_file", "ftp_file_md5", "ams_mapping_bridge", "ams_mapping2", "ams_mapping_info", "nozzle_mapping", "nozzles_info", "extra_options"]) {
      if (args[field] !== undefined && args[field] !== "") throw new Error(`${field} cannot override a verified print. Use the structured plate, nozzle, and AMS arguments.`);
    }

    const { threeMFPath, autoSliced } = await this.ensurePrintableThreeMFPath(
      args,
      printModel,
      printPreset,
      printBedType
    );
    const { useAMS, finalAmsMapping, finalAmsSlots } = await this.resolveAmsPrintSettings(
      threeMFPath,
      args,
      host,
      bambuSerial,
      bambuToken,
      printModel,
      printNozzle
    );
    if (native && args.use_ams !== false && !useAMS) {
      throw new Error("Native X2D printing requires ams_mapping, ams_slots, auto_match_ams, or explicit use_ams: false for an external spool.");
    }
    const threeMfFilename = path.basename(threeMFPath);
    const projectName = String(args?.project_name || args?.task_name || threeMfFilename.replace(/\.3mf$/i, ''));
    const presetName = String(args?.preset_name || `${projectName}_plate_${plateIndex + 1}`);
    const clientJobId = args?.client_job_id !== undefined ? Number(args.client_job_id) : Date.now();

    return withPrinterOperation(devIp, devId, assertActive => withPrintSnapshot(threeMFPath, async (snapshot, retainForDispatchedUpload) => {
      const inspection = await inspectPrintFile(snapshot, { model: printModel, nozzleDiameters: printNozzles, plateIndex, bedType: printBedType });
      const resumeFile = await checkedFile(inspection, snapshot);
      // The options Bambu Studio's Send dialog would send; explicit ones win.
      const studio = resolveStudioPrintOptions(printModel, callerPrintOptions(args), { usedNozzles: usedNozzleCount(inspection) });
      // Bambu Studio maps only the plate's own filaments; every other project filament is -1 (SelectMachine.cpp:1463-1500).
      let mapping = finalAmsMapping ? studioAmsMapping(finalAmsMapping, inspection.usedFilamentPositions) : undefined;
      if (finalAmsSlots) {
        if (finalAmsSlots.length !== inspection.usedFilamentPositions.length) throw new Error("ams_slots must supply exactly one physical tray per used filament.");
        mapping = Array(inspection.materials.length).fill(-1);
        inspection.usedFilamentPositions.forEach((position, index) => { mapping![position] = finalAmsSlots[index]; });
      }
      if (!useAMS) {
        mapping ??= Array(inspection.materials.length).fill(-1);
        const dualNozzle = isDualNozzleModel(printModel);
        for (const position of inspection.usedFilamentPositions) {
          if (mapping[position] === undefined || mapping[position] < 0) {
            mapping[position] = externalTrayForNozzle(inspection.filamentNozzleIndices?.[position], dualNozzle);
          }
          if (mapping[position] !== 254 && !(dualNozzle && mapping[position] === 255)) {
            throw new Error("use_ams:false requires an external-spool mapping for every used filament.");
          }
        }
      }
      const requirements = { ...inspection, amsMapping: mapping, useAMS };
      const initialStatus = await this.bambu.getSafetyStatus(devIp, devId, password || bambuToken);
      validatePrinterState(initialStatus, requirements);
      const preflight = await this.bambu.confirmPrintPreflight(devId, initialStatus, inspection);
      const confirmedStatus = await this.bambu.getSafetyStatus(devIp, devId, password || bambuToken);
      validatePrinterState(confirmedStatus, requirements);
      this.bambu.assertPrintPreflight(confirmedStatus, preflight);
      const amsMapping = stringifyBridgeJson(mapping?.map(value => bridgeAmsMappingValue(value, isDualNozzleModel(printModel))));
      const remoteFileName = uniquePrintName(threeMFPath);
      const checkedName = remoteFileName.replace(/(?:\.gcode)?\.3mf$/i, "");
      if (cloudFallbackMethod && externalStorageState(confirmedStatus.raw) !== "normal") {
        // Studio sends straight through the cloud when the printer has no storage for the LAN upload.
        bridgeMethod = cloudFallbackMethod;
        cloudFallbackMethod = undefined;
      }
      const params: Record<string, unknown> = {
        dev_id: devId,
        // Firmware can report the task name instead of the uploaded filename.
        // Bind either report to this inspected artifact for a later safe resume.
        task_name: checkedName,
        // The plug-in names the uploaded file and the printer's job from
        // project_name, so it carries the same unique checked name, as the
        // native route already passes; a reused name would overwrite a stored
        // job and break the resume binding.
        project_name: checkedName,
        preset_name: presetName,
        filename: snapshot,
        config_filename: snapshot,
        plate_index: plateIndex + 1,
        ftp_folder: String(args?.ftp_folder || ""),
        ftp_file: String(args?.ftp_file || ""),
        ftp_file_md5: String(args?.ftp_file_md5 || ""),
        nozzle_mapping: stringifyBridgeJson(args?.nozzle_mapping) || "",
        ams_mapping: amsMapping || "",
        ams_mapping2: nativeAmsMapping2(mapping, isDualNozzleModel(printModel)) || "",
        // Bambu Studio and FULU's slicer send this with every job (get_ams_mapping_result).
        ams_mapping_info: mapping && inspection.projectFilaments?.length
          ? JSON.stringify(studioAmsMappingInfo(inspection.projectFilaments, mapping, tray => trayColour(confirmedStatus.raw, tray)))
          : "",
        nozzles_info: stringifyBridgeJson(args?.nozzles_info) || "",
        connection_type: connectionType,
        comments: String(args?.comments || ""),
        origin_profile_id: args?.origin_profile_id !== undefined ? Number(args.origin_profile_id) : 0,
        stl_design_id: args?.stl_design_id !== undefined ? Number(args.stl_design_id) : 0,
        origin_model_id: String(args?.origin_model_id || ""),
        print_type: String(args?.print_type || "from_normal"),
        dst_file: remoteFileName,
        dev_name: String(args?.dev_name || ""),
        dev_ip: devIp,
        use_ssl_for_ftp: args?.use_ssl_for_ftp !== undefined ? Boolean(args.use_ssl_for_ftp) : true,
        use_ssl_for_mqtt: args?.use_ssl_for_mqtt !== undefined ? Boolean(args.use_ssl_for_mqtt) : true,
        username: String(args?.username || "bblp"),
        password,
        task_bed_leveling: studio.task_bed_leveling,
        task_flow_cali: studio.task_flow_cali,
        task_vibration_cali: studio.task_vibration_cali,
        task_layer_inspect: studio.task_layer_inspect,
        task_record_timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : false,
        task_use_ams: useAMS,
        task_bed_type: printBedType,
        extra_options: stringifyBridgeJson(args?.extra_options) || "",
        auto_bed_leveling: studio.auto_bed_leveling,
        auto_flow_cali: studio.auto_flow_cali,
        auto_offset_cali: studio.auto_offset_cali,
        extruder_cali_manual_mode: studio.extruder_cali_manual_mode,
        task_ext_change_assist: args?.external_change_assist !== undefined ? Boolean(args.external_change_assist) : false,
        try_emmc_print: args?.try_emmc_print !== undefined ? Boolean(args.try_emmc_print) : false,
      };

      assertActive();
      if (native) {
        const externalStorage = nativeExternalStorage(args?.try_emmc_print, confirmedStatus.raw);
        if (externalStorage && externalStorageState(confirmedStatus.raw) !== "normal") {
          throw new Error("External storage was requested, but the printer reports no ready SD card or USB stick.");
        }
        // Release the telemetry client before the installed plug-in opens its session.
        await this.bambu.disconnectAll();
        assertActive();
        const nativeResult = await printWithBambuNative({
          host: devIp, serial: devId, token: password || bambuToken, filePath: snapshot,
          projectName: String(params.task_name), presetName, remoteName: remoteFileName,
          plateIndex, bedType: printBedType, useAMS,
          amsMapping, amsMapping2: nativeAmsMapping2(mapping, isDualNozzleModel(printModel)),
          bedLeveling: params.task_bed_leveling as boolean,
          flowCalibration: params.task_flow_cali as boolean,
          vibrationCalibration: params.task_vibration_cali as boolean,
          layerInspect: params.task_layer_inspect as boolean,
          autoBedLeveling: studio.auto_bed_leveling,
          autoFlowCali: studio.auto_flow_cali,
          autoOffsetCali: studio.auto_offset_cali,
          extruderCaliManualMode: studio.extruder_cali_manual_mode,
          timelapse: params.task_record_timelapse as boolean,
          externalStorage,
        }, native.onUpdate, { signal: native.signal, assertActive, beforeDispatch: async () => {
          assertActive();
          const dispatchStatus = await this.bambu.getSafetyStatus(devIp, devId, password || bambuToken);
          validatePrinterState(dispatchStatus, requirements);
          this.bambu.assertPrintPreflight(dispatchStatus, preflight);
          if (externalStorage && externalStorageState(dispatchStatus.raw) !== "normal") {
            throw new Error("The printer's SD card or USB stick is no longer ready. Check it and start the print again.");
          }
          assertActive();
        } });
        assertActive();
        this.bambu.recordCheckedJob(devIp, devId, remoteFileName, requirements, resumeFile, false);
        return { ...nativeResult, autoSliced, projectName, plateIndex, useAMS, amsMapping: mapping };
      }
      const bridgeOptions: BambuNetworkBridgeOptions = {
        ...this.bridgeOptionsFromArgs(args, "print_3mf_bambu_network"),
        beforeDispatch: async method => {
          if (method !== bridgeMethod && method !== cloudFallbackMethod) return;
          assertActive();
          const dispatchStatus = await this.bambu.getSafetyStatus(devIp, devId, password || bambuToken);
          validatePrinterState(dispatchStatus, requirements);
          this.bambu.assertPrintPreflight(dispatchStatus, preflight);
        },
        assertDispatchAllowed: method => { if (method === bridgeMethod || method === cloudFallbackMethod) assertActive(); },
        onDispatched: method => { if (method === bridgeMethod || method === cloudFallbackMethod) retainForDispatchedUpload(); },
      };
      let jobUpdates: BridgeJobUpdate[] = [];
      let bridgeResult: unknown;
      let firstFailure: number | undefined;
      if (!inCloudSession) {
        ({ result: bridgeResult, jobUpdates } = await this.bambuNetwork.startLocalPrint(
          { devId, devIp, username: String(params.username), password, useSsl: params.use_ssl_for_mqtt as boolean },
          bridgeMethod,
          { client_job_id: clientJobId, params },
          bridgeOptions,
          assertActive
        ));
      } else {
        ({ result: bridgeResult, jobUpdates, firstFailure } = await this.bambuNetwork.startCloudPrint(devId, bridgeMethod, { client_job_id: clientJobId, params }, bridgeOptions, assertActive, undefined, cloudFallbackMethod));
        if (firstFailure !== undefined) bridgeMethod = cloudFallbackMethod!;
      }
      const firstAttempt = firstFailure !== undefined
        ? ` It first tried net.start_local_print_with_record, as Bambu Studio does, which returned ${firstFailure}${describeBambuNetworkPrintError(firstFailure)}.` : "";

      if (typeof bridgeResult === "object" && bridgeResult !== null && (bridgeResult as { ok?: unknown }).ok === false) {
        throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} failed: ${String((bridgeResult as { error?: unknown }).error || "unknown bridge error")}`);
      }
      if (
        typeof bridgeResult === "object" &&
        bridgeResult !== null &&
        typeof (bridgeResult as { value?: unknown }).value === "number" &&
        (bridgeResult as { value: number }).value !== 0
      ) {
        const value = (bridgeResult as { value: number }).value;
        const reported = jobUpdates.filter(update => update.code !== 0 || update.msg).slice(-3)
          .map(update => `status ${update.status}, code ${update.code}${update.msg ? `: ${update.msg}` : ""}`).join("; ");
        throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} returned non-zero result ${value}${describeBambuNetworkPrintError(value)}.` +
          (reported ? ` Plug-in reported: ${reported}.` : "") + firstAttempt);
      }

      assertActive();
      this.bambu.recordCheckedJob(devIp, devId, remoteFileName, requirements, resumeFile, false);

      return {
        status: "success",
        message: `FULU BambuNetwork ${bridgeMethod.replace(/^net\./, "")} command for ${threeMfFilename} sent successfully.${firstAttempt}`,
        bridgeMethod,
        bridgeResult,
        clientJobId,
        autoSliced,
        projectName,
        plateIndex,
        bridgePlateIndex: plateIndex + 1,
        printerJobName: checkedName,
        useAMS,
        amsMapping: mapping,
        params: redactPrintParams(params),
      };
    }, bridgeSnapshotRoot()));
  }

  private async handoff3mfViaBambuConnect(
    args: Record<string, any>
  ): Promise<Record<string, unknown>> {
    if (!args?.three_mf_path) {
      throw new Error("Missing required parameter: three_mf_path");
    }

    const printModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
    const printBedType = resolveBedType(args?.bed_type as string | undefined);
    const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
    const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
    const plateIndex = args?.plate_index !== undefined ? Number(args.plate_index) : 0;

    if (!Number.isInteger(plateIndex) || plateIndex < 0) {
      throw new Error("plate_index must be a non-negative integer.");
    }

    const { threeMFPath, autoSliced } = await this.ensurePrintableThreeMFPath(
      args,
      printModel,
      printPreset,
      printBedType
    );
    const threeMfFilename = path.basename(threeMFPath);
    const projectName = String(
      args?.project_name || threeMfFilename.replace(/\.3mf$/i, "")
    );
    const handoff = await importFileViaBambuConnect({
      filePath: threeMFPath,
      name: projectName,
      version: args?.version !== undefined ? String(args.version) : undefined,
    });

    return {
      ...handoff,
      autoSliced,
      plateIndex,
      printer_model: printModel,
      bed_type: printBedType,
      note: "The printable file was handed to Bambu Connect. Check the selected printer and plate in Bambu Connect before starting; no print command was sent by this MCP route.",
    };
  }

  private async print3mfViaBambuNative(
    args: Record<string, any>, host: string, bambuSerial: string, bambuToken: string,
    onUpdate?: BambuNativeUpdateCallback, signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    assertBambuNativeAvailable();
    const model = await this.resolveBambuModel(args.bambu_model);
    if (model !== "x2d") throw new Error("connection_mode=bambu_native is restricted to X2D.");
    return this.print3mfViaBambuNetwork(
      { ...args, bambu_model: model, connection_type: "lan", bambu_network_method: "start_local_print" },
      host, bambuSerial, bambuToken, { onUpdate, signal }
    );
  }

  private async uploadFileViaBambuNative(
    args: Record<string, any>, host: string, bambuSerial: string, bambuToken: string,
    onUpdate?: BambuNativeUpdateCallback, signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (args.print) throw new Error("Native upload never starts printing; use print_3mf.");
    // Resolve and enforce the model first, as the print path does, so a
    // non-X2D request is never told to install the native helper.
    const model = await this.resolveBambuModel(args.bambu_model);
    if (model !== "x2d") throw new Error("connection_mode=bambu_native is restricted to X2D.");
    assertBambuNativeAvailable();
    const unsupported = ["use_ams", "ams_mapping", "ams_mapping2", "ams_mapping_info", "nozzle_mapping", "nozzles_info",
      "bed_leveling", "flow_calibration", "vibration_calibration", "layer_inspect", "timelapse"];
    for (const key of unsupported) {
      if (args[key] !== undefined) throw new Error(`${key} is not supported for native upload-only requests; use print_3mf for checked print settings.`);
    }
    for (const key of ["project_name", "preset_name"]) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].trim())) {
        throw new Error(`${key} must be a non-empty string.`);
      }
    }
    const plateIndex = args.plate_index ?? 0;
    if (!Number.isSafeInteger(plateIndex) || plateIndex < 0) throw new Error("plate_index must be a non-negative integer.");
    if (path.extname(String(args.file_path)).toLowerCase() !== ".3mf" && plateIndex !== 0) {
      throw new Error("plate_index is only supported for 3MF uploads.");
    }
    const bedType = resolveBedType(args.bed_type ?? "textured_plate");
    return this.bambu.uploadFile(host, bambuSerial, bambuToken, String(args.file_path), String(args.filename), false, model,
      async (snapshot, destination, assertActive) => {
        if (path.extname(snapshot).toLowerCase() === ".3mf") {
          await inspectPrintFile(snapshot, { model, plateIndex, bedType });
        }
        assertActive();
        await this.bambu.disconnectAll();
        await uploadWithBambuNative({
          host, serial: bambuSerial, token: bambuToken, filePath: snapshot,
          remoteName: destination, projectName: args.project_name ?? path.posix.basename(String(args.filename)),
          presetName: args.preset_name ?? "checked-upload", plateIndex, bedType, useAMS: false,
        }, onUpdate, { signal, assertActive });
      });
  }

  private async getResolvedPrinterFilamentInventory(
    host: string,
    bambuSerial: string,
    bambuToken: string,
    bambuModel?: string,
    nozzleDiameter?: string
  ): Promise<PrinterFilamentInventory> {
    const status = await this.bambu.getStatus(host, bambuSerial, bambuToken);
    let inventory = normalizePrinterFilamentInventory(status, bambuModel, nozzleDiameter);
    // The first MQTT push from an idle printer is sparse (model/modules
    // only). AMS data arrives on a second push a short while later. If
    // we have a live connection but no loaded trays, wait for the follow-
    // up push and retry.
    if (inventory.trays.length === 0 && status.connected) {
      await new Promise((r) => setTimeout(r, 1500));
      const retryStatus = await this.bambu.getStatus(host, bambuSerial, bambuToken);
      inventory = normalizePrinterFilamentInventory(retryStatus, bambuModel, nozzleDiameter);
    }
    return inventory;
  }

  /**
   * `sliceArgs`: the slice_stl arguments a client would send with this file (slicer_profile, template_name,
   * template_3mf_path, layer_height, wall_loops, sparse_infill_density, quality, strength). `requestedTemplatePath`:
   * their template, resolved. own_process says whether that slice prints the process the 3MF carries, unchanged.
   */
  private async inspectSliceSettings(sourcePath: string, sliceArgs: Record<string, unknown> = {}, requestedTemplatePath?: string) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Slice settings source not found: ${sourcePath}`);
    }

    const extension = path.extname(sourcePath).toLowerCase();
    const tempDir = path.join(TEMP_DIR, "slice-settings");
    fs.mkdirSync(tempDir, { recursive: true });

    if (extension === ".3mf") {
      const parsed = await parse3MF(sourcePath);
      const config = (parsed.slicerConfig || {}) as Record<string, any>;
      // A 3MF with no settings file says so (raw_key_count 0) rather than failing, so a client can tell a file with
      // none to keep from one whose settings couldn't be read, which stays an error.
      const hasSettingsFile = await hasSlicerSettingsFile(sourcePath);
      if (hasSettingsFile && !Object.keys(config).length) throw new Error(`The slicer settings in ${sourcePath} couldn't be read.`);
      // Returned to the caller, so it stays.
      const extractedSettingsPath = hasSettingsFile ? await extractBambuTemplateSettings(sourcePath, tempDir, { keep: true }) : undefined;
      return {
        source_path: sourcePath,
        source_type: "3mf",
        ...(extractedSettingsPath ? { extracted_settings_path: extractedSettingsPath } : {}),
        object_count: parsed.objects.length,
        build_item_count: parsed.build.items.length,
        metadata_keys: Object.keys(parsed.metadata),
        summary: summarizeSliceSettings(config),
        raw_key_count: Object.keys(config).length,
        // ownProcessTemplate itself, with the slice's own arguments, so this can't drift from slicing; an explicit
        // value or a quality or strength other than standard changes the process the file carries.
        // Validated first, so an invalid value is refused even when a named profile or template decides the answer.
        own_process: !changesProcess(sliceArgs) && (await ownProcessTemplate(sliceArgs, sourcePath, requestedTemplatePath)) !== undefined,
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

  private async resolveCollarCharmPrepared3MF(
    sourcePath: string,
    template3mfPath: string | undefined,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile: string | undefined,
    printModel: string,
    printNozzle: string,
    bedType: string,
    host: string,
    bambuSerial: string,
    bambuToken: string
  ): Promise<string> {
    if (!sourcePath.toLowerCase().endsWith(".3mf")) {
      throw new Error("print_collar_charm requires a prepared .3mf project or sliced 3MF.");
    }

    try {
      const JSZip = (await import('jszip')).default;
      const zipData = fs.readFileSync(sourcePath);
      const zip = await JSZip.loadAsync(zipData);
      const hasGcode = Object.keys(zip.files).some(
        (fileName) => fileName.match(/Metadata\/plate_\d+\.gcode/i) || fileName.endsWith('.gcode')
      );
      if (hasGcode) {
        return sourcePath;
      }
    } catch (error: any) {
      throw new Error(`Failed to inspect collar charm 3MF before slicing: ${error.message}`);
    }

    const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
    const autoSliceOptions: BambuSliceOptions = {
      ...(slicerType === "orca-slicer-api" ? {} : {
        uptodate: true, ensureOnBed: true, minSave: true, skipModifiedGcodes: true,
      }),
      bedType,
    };

    try {
      const liveFilaments = await this.getResolvedPrinterFilamentInventory(
        host,
        bambuSerial,
        bambuToken,
        printModel,
        printNozzle
      );
      if (liveFilaments.recommended?.load_filaments) {
        autoSliceOptions.loadFilaments = liveFilaments.recommended.load_filaments;
      }
    } catch (filamentError) {
      console.warn("Could not resolve live printer filaments for collar charm auto-slicing:", filamentError);
    }

    return this.stlManipulator.sliceSTL(
      sourcePath,
      slicerType,
      slicerPath,
      slicerProfile || template3mfPath || undefined,
      undefined,
      printPreset,
      autoSliceOptions
    );
  }

  private async preflightCollarCharmPolicy(
    host: string,
    bambuSerial: string,
    bambuToken: string,
    bambuModel: string,
    nozzleDiameter: string
  ): Promise<PrinterFilamentInventory> {
    const inventory = await this.getResolvedPrinterFilamentInventory(
      host,
      bambuSerial,
      bambuToken,
      bambuModel,
      nozzleDiameter
    );

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

  private listTemplateRegistry(templateDir?: string): {
    template_dir: string;
    templates: TemplateEntry[];
  } {
    const resolvedTemplateDir = templateDir && templateDir.trim().length > 0
      ? templateDir
      : DEFAULT_TEMPLATE_DIR;
    return {
      template_dir: resolvedTemplateDir,
      templates: scanTemplateRegistry(resolvedTemplateDir),
    };
  }

  private resolveTemplatePath(
    templateName?: string,
    templateDir?: string,
    sourceTypes?: TemplateSourceType[]
  ): string | undefined {
    if (!templateName || templateName.trim().length === 0) {
      return undefined;
    }

    const registry = this.listTemplateRegistry(templateDir);
    const normalizedName = sanitizeTemplateName(templateName).toLowerCase();
    const requestedName = templateName.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const nameMatches = registry.templates.filter((entry) =>
      entry.name.toLowerCase() === requestedName ||
      sanitizeTemplateName(entry.name).toLowerCase() === normalizedName
    );
    const searchTypes = sourceTypes && sourceTypes.length > 0
      ? sourceTypes
      : (["3mf", "json", "config"] as TemplateSourceType[]);
    const match = searchTypes
      .map((sourceType) => nameMatches.find((entry) => entry.source_type === sourceType))
      .find((entry): entry is TemplateEntry => Boolean(entry));
    if (!match) {
      const typeHint = sourceTypes && sourceTypes.length > 0
        ? ` with source type ${sourceTypes.join("/")}`
        : "";
      const availableTypes = nameMatches.length > 0
        ? ` Available source types: ${Array.from(new Set(nameMatches.map((entry) => entry.source_type))).join(", ")}.`
        : "";
      throw new Error(
        `Template "${templateName}"${typeHint} not found in ${registry.template_dir}.${availableTypes}`
      );
    }

    return match.path;
  }

  private saveTemplate(sourcePath: string, templateName?: string, templateDir?: string) {
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
      : sanitizeTemplateName(
          sourceBaseName
            .replace(/(\.gcode)?\.3mf$/i, "")
            .replace(/\.(json|config)$/i, "")
        );

    const destinationPath = path.join(resolvedTemplateDir, `${baseName}${extension}`);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);

    const sourceType: TemplateSourceType =
      extension === ".3mf" ? "3mf" : extension === ".json" ? "json" : "config";
    const registryEntry = this.resolveTemplatePath(baseName, resolvedTemplateDir, [sourceType]);
    return {
      saved: true,
      template_name: baseName,
      source_path: sourcePath,
      destination_path: destinationPath,
      template_dir: resolvedTemplateDir,
      resolved_path: registryEntry,
    };
  }

  /** The FDM design guidance as MCP prompts: the client decides when to attach each one. */
  setupPromptHandlers() {
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [...DESIGN_PROMPTS, FDM_SLICING_PROMPT].map(({ name, title, description }) => ({ name, title, description })),
    }));
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name === FDM_SLICING_PROMPT.name) {
        // The slicer slice_stl uses by default, and what it applies there (as counterpart_printer_info reports it).
        const slicerType = normalizeSlicerType(DEFAULT_SLICER_TYPE);
        return {
          description: FDM_SLICING_PROMPT.description,
          messages: [{ role: "user" as const, content: { type: "text" as const, text: slicingGuidance(slicerType, bambuSliceCapabilities(slicerType)) } }],
        };
      }
      const prompt = DESIGN_PROMPTS.find(item => item.name === request.params.name);
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
      return {
        description: prompt.description,
        messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text } }],
      };
    });
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
          },
          FDM_CAPABILITY_RESOURCE
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
      if (uri === FDM_CAPABILITY_URI) {
        return { contents: [{ uri, mimeType: FDM_CAPABILITY_RESOURCE.mimeType, text: FDM_CAPABILITY_GUIDANCE }] };
      }
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
      } else if (resource === "files") {
        content = await this.bambu.getFiles(host || DEFAULT_HOST, bambuSerial, bambuToken);
      } else if (resource === "hms") {
        const status = await this.bambu.getStatus(host || DEFAULT_HOST, bambuSerial, bambuToken);
        let diagnostics = extractPrinterDiagnostics(status);
        // The first MQTT status push may not include HMS data — the printer
        // sends basic state first, then pushes HMS/error fields on a subsequent
        // report. If we got a connection but no HMS data, wait briefly and
        // retry so the incremental merge has time to arrive.
        if (!diagnostics.hms && status.connected) {
          await new Promise((r) => setTimeout(r, 1500));
          const retryStatus = await this.bambu.getStatus(host || DEFAULT_HOST, bambuSerial, bambuToken);
          diagnostics = extractPrinterDiagnostics(retryStatus);
        }
        content = diagnostics;
      } else {
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
            description: "Get the live AMS/external filament inventory from the printer over MQTT, including loaded/empty slot summary, resolved slicer profile paths, match confidence, and recommended load_filaments when the printer model is known.",
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
                  enum: [...VALID_BAMBU_MODELS],
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
                  enum: [...VALID_BAMBU_MODELS],
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
            name: "list_3mf_plates",
            description: "List a Bambu Studio or OrcaSlicer 3MF's plates as its designer laid them out, before slicing: plate_count, and for each plate its index (from 0; slice_stl's slice_plate is index + 1, inspect_print_file's plate_index is index), name, the objects on it, each object copy's identify_id (instances: the ids slice_stl's skip_objects takes) whether the file already holds its G-code (sliced), and filaments: the project filaments that plate prints with and only those (index from 1 = slice_stl's load_filaments/filament_colours position and print_3mf's ams_mapping position + 1; colour, material, filament_id, and the first part using it), from the slice when there is one, otherwise worked out as Bambu Studio does from the plate's parts, painting, support, layer ranges and tool changes. filaments_complete is false when a part's mesh was too large to read its painting: that plate then lists every declared filament, so offer them all rather than miss one that prints. project_filaments lists every filament the project declares, used or not (slice_stl takes one load_filaments profile per declared filament). A plain 3MF without plate metadata is one plate. include_thumbnails adds each plate's own preview from the file (thumbnail_png_base64). Read-only.",
            inputSchema: {
              type: "object",
              properties: {
                three_mf_path: { type: "string", description: "Path to the 3MF (a designer's project, sliced or not)" },
                include_thumbnails: { type: "boolean", description: "Include each plate's own preview PNG from the file, base64 (default false)" }
              },
              required: ["three_mf_path"]
            }
          },
          {
            name: "list_3mf_plate_objects",
            description: "List the objects of a sliced 3MF plate that the printer can skip, one per copy, as Bambu Studio's skip dialog lists them: identify_id (id), name, whether it is already skipped, and labelObjectEnabled (the plate was sliced with object labels, which skipping needs). Use these ids with skip_objects during a running print.",
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
            description: "Inspect slicer settings from a saved 3MF template or a JSON/config slicer profile without slicing anything. For a 3MF given as source_path, own_process is true when slice_stl, given this call's other arguments as it would take them (slicer_profile, template_name, template_3mf_path, layer_height, wall_loops, sparse_infill_density, quality, strength), prints the process the file carries (a designer's Bambu Studio or Orca project) unchanged. A 3MF with no slicer settings reports raw_key_count 0; a file that can't be read is an error.",
            inputSchema: {
              type: "object",
              properties: {
                source_path: {
                  type: "string",
                  description: "Path to a 3MF template, extracted project_settings.config, or slicer profile JSON."
                },
                template_name: {
                  type: "string",
                  description: "Optional named template from the local registry. Without source_path it is the source read; with source_path it is the slice's template, for own_process."
                },
                template_dir: {
                  type: "string",
                  description: "Optional template directory override when resolving template_name."
                },
                slicer_profile: { type: "string", description: "For own_process: the slicer_profile slice_stl would be given." },
                template_3mf_path: { type: "string", description: "For own_process: the template_3mf_path slice_stl would be given." },
                layer_height: { type: "number", description: "For own_process: the layer_height slice_stl would be given." },
                nozzle_diameter: { type: "string", description: "For own_process: the nozzle_diameter slice_stl would be given; layer heights are checked against it." },
                wall_loops: { type: "number", description: "For own_process: the wall_loops slice_stl would be given." },
                sparse_infill_density: { type: "string", description: "For own_process: the sparse_infill_density slice_stl would be given." },
                enable_support: { type: "boolean", description: "For own_process: the enable_support slice_stl would be given." },
                support_type: { type: "string", description: "For own_process: the support_type slice_stl would be given." },
                ...PRINT_QUALITY_PROPERTIES
              }
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
                  enum: [...VALID_BAMBU_MODELS],
                  description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                },
                slicer_type: {
                  type: "string",
                  enum: SLICER_SCHEMA_VALUES,
                  description: "Type of slicer to use. Bambu-compatible choices (bambustudio, orcaslicer, orcaslicer-bambulab) export sliced 3MF; aliases such as fulu-orca and orca-studio are accepted."
                },
                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                slicer_profile: { type: "string", description: "Explicit slicer profile/config file. Overrides the named template only when provided in the tool call." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"],
                  description: "Bed plate type for slicing (default: textured_plate)."
                },
                nozzle_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_TYPES],
                  description: "Bambu-compatible slicing: the hotend nozzle material installed on the printer (default: BAMBU_NOZZLE_TYPE, else the model preset's stock nozzle, usually stainless_steel). Printing compares it with the printer's reported nozzle."
                },
                nozzle_volume_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_VOLUME_TYPES],
                  description: "Bambu-compatible slicing: the flow type of the nozzle installed on the printer (default: BAMBU_NOZZLE_VOLUME_TYPE, else standard). high_flow uses the presets' High Flow values, such as the filament's High Flow max volumetric speed, and is refused if the machine preset has no High Flow variant. Printing compares it with the printer's reported nozzle flow."
                },
                use_printer_filaments: { type: "boolean", description: "When true, and no explicit slicer profile or load_filaments override is provided, use the printer's current or first loaded AMS filament as the slicer filament profile." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs." },
                load_filament_ids: { type: "string", description: "Optional filament-to-object mapping string." },
                filament_colours: { type: "string", description: "Optional slot colours, one #RRGGBB per filament slot in order, separated by ';' (e.g. '#161616;#FFFFFF'). Defaults to the input 3MF's project colours, else the BambuStudio default." },
                ensure_on_bed: { type: "boolean", description: "Lift floating models onto the bed." },
                arrange: { type: "boolean", description: "Auto-arrange objects on the build plate." },
                orient: { type: "boolean", description: "Auto-orient model for optimal printability." },
                repetitions: { type: "number", description: "Total copies of an STL, using clone_objects internally. Do not also pass clone_objects. The slicer may place copies on multiple plates; print_3mf prints one selected plate per call. For 3MF input, select slice_plate explicitly." },
                scale: { type: "number", description: "Uniform scale factor." },
                rotate: { type: "number", description: "Z-axis rotation in degrees." },
                rotate_x: { type: "number", description: "X-axis rotation in degrees." },
                rotate_y: { type: "number", description: "Y-axis rotation in degrees." },
                min_save: { type: "boolean", description: "Produce smaller output 3MF." },
                skip_modified_gcodes: { type: "boolean", description: "Ignore stale custom gcodes in the 3MF." },
                pause_at_layers: { type: "array", items: { type: "integer", minimum: 2 }, description: "Pause before each of these layers (1-based, as Bambu Studio and OrcaSlicer number them in the preview), for example to drop in magnets or nuts. The slicer writes the printer's own pause G-code there (M400 U1 on Bambu printers); the printer stops by itself and waits for Resume. Bambu Studio or OrcaSlicer CLI only. Pauses already in a project 3MF are kept." },
                slice_plate: { type: "number", description: "Which plate index to slice. 0 = all plates." }
              },
              required: ["stl_path", "template_name", "bambu_model"]
            }
          },
          {
            name: "slice_stl",
            description: "Slice an STL or 3MF file using a slicer to generate printable G-code or sliced 3MF. IMPORTANT: bambu_model must be specified to ensure the slicer generates safe G-code for the correct printer. The text result is the sliced file's path. When Bambu Studio or OrcaSlicer writes a result.json, structuredContent.slicer_result carries it verbatim, success or error: error_string, return_code and each sliced_plates[].warning_message, such as a floating cantilever. structuredContent.slicer_report says whether it failed; for a failure, its message is a plain sentence for a person and slicer_message keeps the slicer's words, which a failed slice's text gives after that sentence. A 3MF that carries its own process settings (a designer's Bambu Studio or Orca project) slices with them unless slicer_profile, template_name or template_3mf_path is given; the machine still comes from bambu_model. quality and strength adjust that process, and strength never lowers its walls or infill.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the STL or 3MF file to slice" },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                },
                slicer_type: {
                  type: "string",
                  enum: SLICER_SCHEMA_VALUES,
                  description: "Type of slicer to use. Bambu-compatible choices (bambustudio, orcaslicer, orcaslicer-bambulab) export sliced 3MF; aliases such as fulu-orca and orca-studio are accepted."
                },
                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                slicer_profile: { type: "string", description: "Path to an optional process profile/config file. The exact bambu_model/nozzle machine preset is still required." },
                template_3mf_path: { type: "string", description: "Optional template 3MF whose embedded Bambu slicer settings should be reused when slicing a new STL or 3MF." },
                template_name: { type: "string", description: "Optional named template from the local registry. Resolves to template_3mf_path automatically." },
                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"],
                  description: "Bed plate type for slicing (default: textured_plate)."
                },
                nozzle_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_TYPES],
                  description: "Bambu-compatible slicing: the hotend nozzle material installed on the printer (default: BAMBU_NOZZLE_TYPE, else the model preset's stock nozzle, usually stainless_steel). Printing compares it with the printer's reported nozzle."
                },
                nozzle_volume_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_VOLUME_TYPES],
                  description: "Bambu-compatible slicing: the flow type of the nozzle installed on the printer (default: BAMBU_NOZZLE_VOLUME_TYPE, else standard). high_flow uses the presets' High Flow values, such as the filament's High Flow max volumetric speed, and is refused if the machine preset has no High Flow variant. Printing compares it with the printer's reported nozzle flow."
                },
                use_printer_filaments: { type: "boolean", description: "When true, and no explicit slicer profile or load_filaments override is provided, use the printer's current or first loaded AMS filament as the slicer filament profile. Template 3MF process settings can still be used at the same time." },
                uptodate: { type: "boolean", description: "Refresh 3MF preset configs to match the latest BambuStudio version. Use when slicing downloaded or older 3MF files to prevent stale-config failures." },
                repetitions: { type: "number", description: "Slice N identical copies of the model. Bambu Studio and OrcaSlicer copy an STL with --clone-objects; do not also pass clone_objects. Copies may need multiple plates; print_3mf prints one selected plate per call. For 3MF input, select slice_plate explicitly." },
                orient: { type: "boolean", description: "Auto-orient the model for optimal printability (minimize supports, maximize bed adhesion). Recommended for raw STL imports that lack a pre-set orientation." },
                arrange: { type: "boolean", description: "Auto-arrange all objects on the build plate with optimal spacing; STL input is arranged by default. Set false only to keep a 3MF's existing layout: an STL that is not already on the plate then fails to slice." },
                ensure_on_bed: { type: "boolean", description: "Detect models floating above the bed and lower them onto the build surface. Safety net for imported models with incorrect Z origins." },
                clone_objects: { type: "string", description: "Clone the loaded model: total copies as a single integer, e.g. '3'. The Bambu-style CLIs count copies per input file and this tool loads one file, so a comma-separated list is rejected by the slicer." },
                skip_objects: { type: "string", description: "Skip these object copies when slicing, by identify_id, comma-separated (e.g. '78,92'). The ids are the instances list_3mf_plates gives for each plate; they are not positions. Useful for multi-object 3MFs where you only want to print some parts." },
                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs, e.g. 'pla_basic.json;petg_cf.json'." },
                filament_profile: { type: "string", description: "Compatibility alias for load_filaments. Semicolon-separated Orca/Bambu filament profile JSON paths." },
                load_filament_ids: { type: "string", description: "Map filaments to objects/parts. Comma-separated IDs matching load_filaments order, e.g. '1,2,3,1' assigns filament 1 to objects 0 and 3." },
                filament_colours: { type: "string", description: "Optional slot colours, one #RRGGBB per filament slot in order, separated by ';' (e.g. '#161616;#FFFFFF'). Defaults to the input 3MF's project colours, else the BambuStudio default." },
                enable_timelapse: { type: "boolean", description: "Insert timelapse parking moves into gcode. The toolhead parks at a fixed position each layer for camera capture. Adds ~10% print time." },
                allow_mix_temp: { type: "boolean", description: "Allow filaments with different temperature requirements on the same plate. Required for multi-material prints mixing e.g. PLA and PETG." },
                scale: { type: "number", description: "Uniform scale factor applied to all axes. 1.0 = original size, 2.0 = double, 0.5 = half. Applied before slicing." },
                rotate: { type: "number", description: "Rotate the model around the Z-axis (vertical) by this many degrees before slicing. Positive = counterclockwise when viewed from above." },
                rotate_x: { type: "number", description: "Rotate the model around the X-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                rotate_y: { type: "number", description: "Rotate the model around the Y-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                min_save: { type: "boolean", description: "Write a smaller output 3MF by omitting non-essential metadata. Reduces file size for faster FTP upload to the printer." },
                skip_modified_gcodes: { type: "boolean", description: "Strip custom start/end gcodes embedded in the 3MF. Recommended for downloaded 3MFs since custom gcodes from other users' profiles may be unsafe for your printer." },
                pause_at_layers: { type: "array", items: { type: "integer", minimum: 2 }, description: "Pause before each of these layers (1-based, as Bambu Studio and OrcaSlicer number them in the preview), for example to drop in magnets or nuts. The slicer writes the printer's own pause G-code there (M400 U1 on Bambu printers); the printer stops by itself and waits for Resume. Bambu Studio or OrcaSlicer CLI only. Pauses already in a project 3MF are kept." },
                slice_plate: { type: "number", description: "Which plate index to slice. 0 = all plates for local slicers; remote slicing defaults to plate 1 and rejects 0. Use 1, 2, etc. to slice only a specific plate in multi-plate 3MF projects." },
                ...PRINT_QUALITY_PROPERTIES,
                layer_height: { type: "number", exclusiveMinimum: 0, description: "Layer height in mm, such as 0.28 (draft), 0.2 (standard) or 0.12 (fine). Written as the process preset's layer_height over the machine and process preset this tool resolves; at most the nozzle diameter. Bambu-compatible slicers only." },
                wall_loops: { type: "integer", minimum: 0, maximum: 1000, description: "Number of walls (perimeters), written as the process preset's wall_loops. Bambu-compatible slicers only." },
                sparse_infill_density: { type: "string", pattern: "^\\s*\\d+(\\.\\d+)?\\s*%\\s*$", description: "Sparse infill density as a percentage, such as \"15%\", written as the process preset's sparse_infill_density. Bambu-compatible slicers only." },
                enable_support: { type: "boolean", description: "Turn support generation on or off, written as the process preset's enable_support. Bambu-compatible slicers only." },
                support_type: { type: "string", enum: ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"], description: "Support style, written as the process preset's support_type. Bambu-compatible slicers only." },
                support_threshold_angle: { type: "integer", minimum: 0, maximum: 90, description: "Overhang threshold in degrees for automatic supports, written as the process preset's support_threshold_angle (0 lets the slicer decide). Bambu-compatible slicers only." }
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
            name: "bambu_connect_import_file",
            description: "Open an existing G-code or sliced 3MF file in the signed-in Bambu Connect app through its official URL scheme. This is a cloud-mode handoff and does not start printing by itself.",
            inputSchema: {
              type: "object",
              properties: {
                file_path: { type: "string", description: "Readable local path to a .gcode, .3mf, or .gcode.3mf file" },
                name: { type: "string", description: "Optional project name shown by Bambu Connect" },
                version: { type: "string", description: "Optional integration version sent to Bambu Connect (default: 1.0.0)" }
              },
              required: ["file_path"]
            }
          },
          {
            name: "bambu_network_bridge_status",
            description: "Inspect or probe the FULU OrcaSlicer-bambulab BambuNetwork bridge runtime used for cloud and restored BambuNetwork printing.",
            inputSchema: {
              type: "object",
              properties: {
                connect: { type: "boolean", description: "When true, start the bridge command and run a handshake plus agent initialization probe." },
                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
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
                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
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
                  enum: [...VALID_BAMBU_MODELS],
                  description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                },
                connection_type: { type: "string", enum: ["cloud", "lan"], description: "BambuNetwork connection type to put in FULU PrintParams; cloud uses restored internet printing, lan uses local bridge printing." },
                bambu_network_method: { type: "string", enum: BAMBU_NETWORK_PRINT_METHODS, description: "FULU print method to invoke; defaults to start_local_print for lan, and for cloud to Bambu Studio's order: start_local_print_with_record, then start_print if that fails." },
                dev_id: { type: "string", description: "Bambu device id used by BambuNetwork; defaults to BAMBU_DEV_ID or BAMBU_SERIAL." },
                dev_ip: { type: "string", description: "Printer IP address for LAN/local bridge methods; defaults to host when provided." },
                host: { type: "string", description: "Printer host or IP address, used as dev_ip for LAN/local bridge methods." },
                bambu_serial: { type: "string", description: "Fallback Bambu device id when dev_id is not supplied." },
                bambu_token: { type: "string", description: "Printer access code/password for LAN/local bridge methods." },
                username: { type: "string", description: "Printer username for LAN/local bridge methods; defaults to bblp." },
                password: { type: "string", description: "Printer password/access code override for LAN/local bridge methods." },
                bed_type: { type: "string", enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"], description: "Bed plate type currently installed (default: textured_plate)." },
                nozzle_type: { type: "string", enum: [...VALID_NOZZLE_TYPES], description: "Installed nozzle material, used when the 3MF must be auto-sliced (default: BAMBU_NOZZLE_TYPE, else the preset's stock nozzle)." },
                nozzle_volume_type: { type: "string", enum: [...VALID_NOZZLE_VOLUME_TYPES], description: "Installed nozzle flow type, used when the 3MF must be auto-sliced (default: BAMBU_NOZZLE_VOLUME_TYPE, else standard)." },
                plate_index: { type: "number", description: "Zero-based plate index to print from the sliced 3MF; converted to FULU's one-based PrintParams plate_index." },
                project_name: { type: "string", description: "Optional project name returned in the result; defaults to the 3MF filename without extension. The printer job and stored file use the server's unique checked name so resume_print can bind to the inspected file." },
                preset_name: { type: "string", description: "Optional preset name sent in FULU PrintParams; defaults to project plus one-based plate index." },
                task_name: { type: "string", description: "Optional project label when project_name is omitted. The submitted task name uses a unique inspected-job identity for safe resume." },
                config_filename: { type: "string", description: "Optional config 3MF path for cloud print; defaults to the same 3MF path." },
                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the BambuNetwork agent; defaults to BAMBU_NETWORK_CONFIG_DIR or a user config directory." },
                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the agent during startup." },
                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string to pass to net.change_user after the agent starts." },
                timeout_ms: { type: "number", description: "Bridge request timeout in milliseconds." },
                slicer_type: { type: "string", enum: SLICER_SCHEMA_VALUES, description: "Slicer to use only if auto-slicing an unsliced 3MF; use orcaslicer-bambulab for FULU's fork." },
                slicer_path: { type: "string", description: "Path to the slicer executable for auto-slicing; defaults to value from env or a platform default. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                slicer_profile: { type: "string", description: "Path to an optional slicer profile/config file for auto-slicing." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)." },
                nozzle_diameters: { type: "array", minItems: 1, maxItems: 2, items: { type: "number", enum: [0.2, 0.4, 0.6, 0.8] }, description: "Complete per-nozzle diameters for pre-sliced jobs, e.g. [0.4, 0.6]. Omit to verify file metadata against every reported nozzle; cannot combine with nozzle_diameter." },
                use_ams: { type: "boolean", description: "Whether to use the AMS; defaults to auto-detect from the 3MF mapping." },
                ams_mapping: { type: "array", description: "AMS slot mapping array used by both local MCP printing and FULU PrintParams. Same tray values as print_3mf: 254 = external spool; on dual-nozzle printers 254 = left/deputy nozzle external and 255 = right/main nozzle external.", items: { type: "number" } },
                ams_slots: { type: "array", description: "Per-used-filament AMS slot list, matching the local LAN print path (254/255 external spool rules as in print_3mf).", items: { type: "number" } },
                ams_mapping_bridge: { type: "string", description: "Raw JSON string override for FULU PrintParams ams_mapping when the automatic array is not enough." },
                ams_mapping2: { type: "string", description: "Raw JSON string for FULU PrintParams ams_mapping2, matching OrcaSlicer-bambulab's v1 AMS mapping field." },
                ams_mapping_info: { type: "string", description: "Raw JSON string for FULU PrintParams ams_mapping_info, matching OrcaSlicer-bambulab's detailed AMS mapping field." },
                nozzle_mapping: { type: "string", description: "Raw JSON string for FULU PrintParams nozzle_mapping." },
                nozzles_info: { type: "string", description: "Raw JSON string for FULU PrintParams nozzles_info." },
                bed_leveling: { type: "boolean", description: "Auto bed leveling on or off. Omit to send what Bambu Studio's Send dialog would: the choice saved in BambuStudio.conf for this printer, else Studio's default." },
                flow_calibration: { type: "boolean", description: "Flow calibration on or off. Omit to send what Bambu Studio's Send dialog would (auto on P1/P1S)." },
                vibration_calibration: { type: "boolean", description: "Vibration calibration (default false, as Bambu Studio sends)." },
                layer_inspect: { type: "boolean", description: "First-layer inspection where supported (default true, as Bambu Studio sends)." },
                timelapse: { type: "boolean", description: "Enable timelapse recording in FULU PrintParams (default: false)." },
                use_ssl_for_ftp: { type: "boolean", description: "Whether FULU local print should use SSL for FTP (default: true)." },
                use_ssl_for_mqtt: { type: "boolean", description: "Whether FULU local print should use SSL for MQTT (default: true)." },
                external_change_assist: { type: "boolean", description: "Enable FULU PrintParams task_ext_change_assist for external filament change assistance." },
                try_emmc_print: { type: "boolean", description: "Store the job on internal storage (eMMC) instead of the SD card or USB stick. FULU bridge: default false. X2D native printing: omit to use a ready card, else eMMC." },
                extra_options: { type: "string", description: "Raw JSON string or text for FULU PrintParams extra_options." },
                client_job_id: { type: "number", description: "Optional client job id sent to the bridge; defaults to the current timestamp." }
              },
              required: ["three_mf_path", "bambu_model"]
            }
          },
          ...CAMERA_STREAM_TOOLS,
          {
            name: "camera_snapshot",
            description: "Capture a single JPEG frame from the printer's chamber camera. A1/P1 use TCP-on-6000; X1/P2S/H2/X2D use RTSP via ffmpeg. Returns JPEG as base64; pass save_path to also write the bytes to disk.",
            inputSchema: {
              type: "object",
              properties: {
                save_path: { type: "string", description: "Optional absolute path to write the JPEG to disk. If omitted, only the base64 payload is returned." },
                timeout_ms: { type: "number", description: "Max ms to wait for a live frame (default 8000). A1/P1 cameras first replay a buffered frame, which is skipped, so a live frame takes about 3 s, longer on cold start." },
                bambu_model: { type: "string", description: "Printer model. Used to route to the correct protocol or fail fast on unsupported models. Defaults to BAMBU_MODEL." },
                experimental: { type: "boolean", description: "Deprecated and ignored. Earlier this flag let callers probe H2 series via the A1/P1 TCP-on-6000 path; live testing on an H2S confirmed H2 uses RTSP instead, so the flag has no effect now." },
                ffmpeg_path: { type: "string", description: "Override path to the ffmpeg binary used by the RTSP path. Defaults to FFMPEG_PATH or ffmpeg via $PATH. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1. Required only for the RTSP transport (X1, P2S, H2 series, X2D)." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              }
            }
          },
          {
            name: "delete_printer_file",
            description: "Delete a file from the Bambu Lab printer's SD card via FTPS. Destructive: requires confirm:true. Restricted to cache/, timelapse/, and logs/ directories. Path traversal segments (..) are rejected.",
            inputSchema: {
              type: "object",
              properties: {
                filename: {
                  type: "string",
                  description: "File to delete. Bare names default to cache/<name>; pass a relative path like timelapse/foo.mp4 to target other allowed directories."
                },
                confirm: {
                  type: "boolean",
                  description: "Must be true to actually delete. When false or omitted the call returns without sending an FTP request."
                },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              },
              required: ["filename"]
            }
          },
          {
            name: "upload_gcode",
            description: "Inspect a G-code file and upload a uniquely named copy without overwriting existing printer files.",
            inputSchema: {
              type: "object",
              properties: {
                filename: { type: "string", description: "Name for the file on the printer" },
                gcode: { type: "string", description: "G-code content to upload, or a readable local .gcode path. Required unless gcode_path is provided. For large files, prefer gcode_path." },
                gcode_path: { type: "string", description: "Local path to a .gcode file to upload. Required unless gcode is provided. This avoids sending large G-code bodies through the MCP request." },
                bambu_model: { type: "string", enum: [...VALID_BAMBU_MODELS], description: "Required printer model for inspecting the uploaded G-code, even when not starting it." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              },
              required: ["filename"]
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
                connection_mode: {
                  type: "string",
                  enum: ["lan_mqtt_ftps", "bambu_native"],
                  description: "Upload transport; bambu_native uses the installed Bambu networking plug-in for X2D and never starts printing."
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Required for every printable .gcode or .3mf upload, including upload-only operations."
                },
                project_name: { type: "string", description: "Optional project name passed to the native X2D uploader; defaults to filename." },
                preset_name: { type: "string", description: "Optional printer preset name passed to the native X2D uploader." },
                bed_type: { type: "string", enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"], description: "Bed plate type for the native X2D uploader (default: textured_plate)." },
                plate_index: { type: "integer", minimum: 0, description: "Zero-based plate index passed to the native X2D uploader (default: 0)." },
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
                  enum: [...VALID_BAMBU_MODELS],
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
                  enum: [...VALID_BAMBU_MODELS],
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
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                connection_mode: { type: "string", enum: ["lan_mqtt_ftps", "bambu_network", "bambu_native"], description: "The connection the print used. Defaults to BAMBU_DEFAULT_CONNECTION_MODE, the same default print_3mf uses, else the model's route." },
                connection_type: { type: "string", enum: ["lan", "cloud"], description: "FULU BambuNetwork connection type the print used. Defaults to BAMBU_DEFAULT_CONNECTION_TYPE, as for print_3mf. Authenticated controls support lan." }
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
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                connection_mode: { type: "string", enum: ["lan_mqtt_ftps", "bambu_network", "bambu_native"], description: "The connection the print used. Defaults to BAMBU_DEFAULT_CONNECTION_MODE, the same default print_3mf uses, else the model's route." },
                connection_type: { type: "string", enum: ["lan", "cloud"], description: "FULU BambuNetwork connection type the print used. Defaults to BAMBU_DEFAULT_CONNECTION_TYPE, as for print_3mf. Authenticated controls support lan." }
              }
            }
          },
          {
            name: "resume_print",
            description: "Resume a paused job that this server inspected and started. It re-downloads the job's file over FTPS and compares its SHA-256, asks a person to confirm only when the file could not be re-read, and reads the printer again before sending. A job that was cancelled, ended or replaced is never resumed. Returns jobName and bytesVerified.",
            inputSchema: {
              type: "object",
              properties: {
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                connection_mode: { type: "string", enum: ["lan_mqtt_ftps", "bambu_network", "bambu_native"], description: "The connection the print used. Defaults to BAMBU_DEFAULT_CONNECTION_MODE, the same default print_3mf uses, else the model's route." },
                connection_type: { type: "string", enum: ["lan", "cloud"], description: "FULU BambuNetwork connection type the print used. Defaults to BAMBU_DEFAULT_CONNECTION_TYPE, as for print_3mf. Authenticated controls support lan." }
              }
            }
          },
          {
            name: "x2d_native_control",
            description: "Read calibration results or update X2D AMS metadata/calibration selection through the installed plug-in. Raw motion, heating, task control, and safety-setting changes are rejected.",
            inputSchema: {
              type: "object",
              properties: {
                message_json: { type: "string", description: "JSON print envelope for ams_filament_setting, extrusion_cali_sel, extrusion_cali_get, extrusion_cali_get_result, or flowrate_get_result. A sequence_id is required; extra fields are rejected." },
                qos: { type: "number", description: "MQTT QoS used by Bambu Studio (0 or 1; default 0)." },
                flag: { type: "number", description: "Bambu networking plug-in command flag (0 or 1; default 0)." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              },
              required: ["message_json"]
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
            description: "Trigger a Bambu AMS RFID re-read for one AMS slot. X2D on macOS, or Linux with the native helper installed, uses the native official plug-in route. This can move AMS filament; use only when the printer is idle and unloaded.",
            inputSchema: {
              type: "object",
              properties: {
                ams_id: { type: "number", description: "AMS unit index from 0 to 3, or 128 for an X2D AMS-HT." },
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
            description: "Set a checked bed or nozzle temperature. Positive heating requires matching fresh printer telemetry; nozzle heating also requires declared material. Zero turns the heater off.",
            inputSchema: {
              type: "object",
              properties: {
                component: { type: "string", description: "Component to heat: bed, nozzle, or extruder" },
                temperature: { type: "number", minimum: 0, description: "Finite target temperature in °C, checked against model/component and declared material limits" },
                bambu_model: { type: "string", enum: [...VALID_BAMBU_MODELS], description: "Printer model, required for positive heating unless configured in the environment" },
                material: { type: "string", description: "Loaded material, for example PLA or PETG. Required for positive nozzle heating, including non-RFID spools." },
                nozzle_diameter: { type: "number", enum: [0.2, 0.4, 0.6, 0.8], description: "Installed nozzle diameter to compare with printer-reported configuration (default 0.4)" },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              },
              required: ["component", "temperature"]
            }
          },
          {
            name: "set_fan_speed",
            description: "Set a Bambu printer fan speed percentage. X2D on macOS, or Linux with the native helper installed, uses Bambu's networking plug-in without UI automation; other models use MQTT.",
            inputSchema: {
              type: "object",
              properties: {
                fan: {
                  type: "string",
                  description: "Fan to control: part, auxiliary, right_auxiliary, chamber, 1, 2, 3, or 10"
                },
                speed: { type: "number", description: "Fan speed percentage from 0 to 100" },
                confirm_during_print: { type: "boolean", description: "Required for X2D fan changes while a print is running." },
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
                  description: "identify_id values of the object copies to skip. Use list_3mf_plate_objects on the sliced 3MF to find them.",
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
            name: "set_ams_drying",
            description: "Start or stop the AMS filament drying cycle. X2D on macOS, or Linux with the native helper installed, uses the native official plug-in route and supports AMS-HT id 128.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["start", "stop"],
                  description: "Whether to start or stop the drying cycle"
                },
                ams_id: {
                  type: "number",
                  description: "AMS unit index from 0 to 3, or 128 for an X2D AMS-HT."
                },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              },
              required: ["action", "ams_id"]
            }
          },
          {
            name: "inspect_print_file",
            description: "Inspect an exact private snapshot of a prepared sliced 3MF or textual G-code file and selected plate without contacting a printer. Returns versioned file-only evidence; no printer readiness or permission to dispatch is established. Does not auto-slice.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                file_path: { type: "string", minLength: 1, description: "Local prepared .3mf or textual .gcode artifact to inspect; checksum-only and unsliced projects reject." },
                bambu_model: { type: "string", enum: [...VALID_BAMBU_MODELS], description: "Explicit file-inspection target model; never inferred from environment or live state." },
                plate_index: { type: "integer", minimum: 0, description: "Zero-based selected plate; defaults to 0. Raw G-code only supports 0." },
                nozzle_diameters: { type: "array", minItems: 1, maxItems: 2, items: { type: "number", enum: [0.2, 0.4, 0.6, 0.8] }, description: "Optional requested nozzle diameters to compare with file declarations; this does not observe installed hardware." },
                bed_type: { type: "string", enum: [...VALID_BED_TYPES], description: "Optional declared bed type to compare with file metadata." },
                include_preview: { type: "boolean", description: "Also return preview: PNG pictures drawn from this exact file's G-code (every extruding line in its filament's colour; the top as it sits on the bed, and the bed side turned over), with the artifact's sha256. Large (tens of KB of base64); for apps that show the person what will print, not for agents." },
              },
              required: ["file_path", "bambu_model"],
            },
          },
          {
            name: "print_3mf",
            description: "Print a 3MF file on a Bambu Lab printer. Auto-slices if the 3MF has no gcode. IMPORTANT: bambu_model must be specified to ensure safe printer operation.",
            inputSchema: {
              type: "object",
              properties: {
                three_mf_path: { type: "string", description: "Path to the 3MF file to print" },
                pause_at_layers: { type: "array", items: { type: "integer", minimum: 2 }, description: "Pause before each of these layers (1-based, as Bambu Studio and OrcaSlicer number them in the preview), for example to drop in magnets or nuts. The slicer writes the printer's own pause G-code there (M400 U1 on Bambu printers); the printer stops by itself and waits for Resume. Bambu Studio or OrcaSlicer CLI only. Used when the 3MF has no G-code yet; a sliced 3MF must already carry these pauses, or it is refused." },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                },
                connection_mode: {
                  type: "string",
                  enum: ["lan_mqtt_ftps", "bambu_network", "bambu_native", "bambu_connect"],
                  description: "Print path: bambu_connect hands a printable file to the signed-in Bambu Connect app for cloud-mode review; X2D otherwise defaults to bambu_native (Bambu Studio's installed local networking plug-in, storing the job on a ready SD card or USB stick, otherwise internal eMMC); lan_mqtt_ftps is the legacy direct MQTT/FTPS path; bambu_network uses the FULU bridge."
                },
                try_emmc_print: { type: "boolean", description: "X2D native printing: true stores the job on internal storage (eMMC), false on the SD card or USB stick (refused unless the printer reports one ready). Omit to use the card when ready, else eMMC; BAMBU_NATIVE_TRY_EMMC_PRINT sets a server default." },
                connection_type: { type: "string", enum: ["cloud", "lan"], description: "BambuNetwork connection type when connection_mode is bambu_network; cloud uses restored internet printing, lan uses local bridge printing." },
                bambu_network_method: { type: "string", enum: BAMBU_NETWORK_PRINT_METHODS, description: "FULU print method when connection_mode is bambu_network; defaults to start_local_print for lan, and for cloud to Bambu Studio's order: start_local_print_with_record, then start_print if that fails." },
                dev_id: { type: "string", description: "Bambu device id for FULU BambuNetwork printing; defaults to BAMBU_DEV_ID or BAMBU_SERIAL." },
                dev_ip: { type: "string", description: "Printer IP address for FULU BambuNetwork LAN/local print methods; defaults to host when provided." },
                bridge_command: { type: "string", description: "Override command for the FULU bridge host or macOS/WSL wrapper; defaults to BAMBU_NETWORK_BRIDGE_COMMAND. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                bambu_network_config_dir: { type: "string", description: "Config/log directory used by the FULU BambuNetwork agent." },
                country_code: { type: "string", description: "BambuNetwork country code, such as US, used by the FULU bridge agent." },
                user_info: { type: "string", description: "Optional BambuNetwork user_info JSON string passed to net.change_user for the FULU bridge." },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"],
                  description: "Bed plate type currently installed (default: textured_plate)"
                },
                nozzle_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_TYPES],
                  description: "Installed nozzle material, used when the 3MF must be auto-sliced (default: BAMBU_NOZZLE_TYPE, else the preset's stock nozzle)."
                },
                nozzle_volume_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_VOLUME_TYPES],
                  description: "Installed nozzle flow type, used when the 3MF must be auto-sliced (default: BAMBU_NOZZLE_VOLUME_TYPE, else standard)."
                },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                plate_index: { type: "number", description: "Zero-based plate index to print from the sliced 3MF (default: 0)" },
                slicer_type: {
                  type: "string",
                  enum: SLICER_SCHEMA_VALUES,
                  description: "Slicer to use only if auto-slicing an unsliced 3MF. Bambu-compatible slicer aliases such as fulu-orca and orca-studio are accepted."
                },
                slicer_path: { type: "string", description: "Path to the slicer executable for auto-slicing (default: value from env or a platform default). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                use_ams: { type: "boolean", description: "Whether to use the AMS (default: auto-detect from 3MF)" },
                ams_mapping: {
                  type: "array",
                  description: "Project-level AMS mapping array. Position = project filament index, value = absolute AMS tray. Positions the selected plate does not print are sent as -1, as Bambu Studio sends them, whatever is passed there (0-3=AMS 0, 4-7=AMS 1, 8-11=AMS 2, 128+=AMS-HT, 254=external, -1=unused). On dual-nozzle printers (H2D, H2D Pro, H2C, X2D) 254 is the LEFT/deputy nozzle external spool and 255 the RIGHT/main nozzle external spool, matching Bambu Studio's virtual tray ids; the gcode header's filament_map (1=left, 2=right) says which nozzle each filament was sliced for. Prefer ams_slots unless you know the project-level layout.",
                  items: { type: "number" }
                },
                ams_slots: {
                  type: "array",
                  description: "Preferred AMS input: one absolute tray index per USED filament in plate order, e.g. [1] for a single-filament print pulling from AMS 0 slot 1. Use 254 for the external spool (on dual-nozzle printers: 254 = left/deputy nozzle external, 255 = right/main nozzle external). Expanded to project-level ams_mapping automatically from the 3MF's plate_N.json and gcode header.",
                  items: { type: "number" }
                },
                auto_match_ams: {
                  type: "boolean",
                  description: "When true, match the sliced 3MF's tray_info_idx requirements against live AMS inventory and use the resulting ams_slots. Ignored when ams_mapping or ams_slots is provided."
                },
                bed_leveling: { type: "boolean", description: "Auto bed leveling on or off. Omit to send what Bambu Studio's Send dialog would: the choice saved in BambuStudio.conf for this printer, else Studio's default." },
                                flow_calibration: { type: "boolean", description: "Flow calibration on or off. Omit to send what Bambu Studio's Send dialog would (auto on P1/P1S)." },
                                vibration_calibration: { type: "boolean", description: "Vibration calibration (default false, as Bambu Studio sends)." },
                                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file for auto-slicing (optional)." },
                                template_3mf_path: { type: "string", description: "Optional template 3MF whose embedded Bambu slicer settings should be reused when auto-slicing this print job." },
                                template_name: { type: "string", description: "Optional named template from the local registry. Resolves to template_3mf_path automatically." },
                                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" },
                nozzle_diameters: { type: "array", minItems: 1, maxItems: 2, items: { type: "number", enum: [0.2, 0.4, 0.6, 0.8] }, description: "Complete per-nozzle diameters for a pre-sliced job, e.g. [0.4, 0.6]. Omit to verify its declared diameters against live telemetry; cannot combine with nozzle_diameter." }
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
                source_path: { type: "string", description: "Path to a prepared collar charm .3mf project or sliced 3MF. Required unless template_name is provided." },
                template_name: { type: "string", description: "Named collar charm template from the local registry. Required unless source_path is provided; resolves source_path automatically." },
                template_dir: { type: "string", description: "Optional template directory override when resolving template_name." },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "REQUIRED: Bambu Lab printer model. H2D, H2S, and H2C are the primary intended paths. X2D direct printing is not supported."
                },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate", "supertack_plate"],
                  description: "Bed plate type currently installed (default: textured_plate)"
                },
                bed_leveling: { type: "boolean", description: "Auto bed leveling on or off. Omit to send what Bambu Studio's Send dialog would: the choice saved in BambuStudio.conf for this printer, else Studio's default." },
                flow_calibration: { type: "boolean", description: "Flow calibration on or off. Omit to send what Bambu Studio's Send dialog would (auto on P1/P1S)." },
                vibration_calibration: { type: "boolean", description: "Vibration calibration (default false, as Bambu Studio sends)." },
                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                slicer_profile: { type: "string", description: "Path to the slicer profile/config file for auto-slicing (optional)." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" }
              },
              required: ["bambu_model"]
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
            description: "Rotate the model so a face rests on the bed (Z=0), choosing the orientation with the least part and support volume per mm² of bed contact. A face counts only if nothing hangs below it. Returns the new STL path; structuredContent.laid_flat is false, with the input path, when no orientation qualifies.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the STL file" }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "blender_mcp_status",
            description: "Inspect Blender MCP configuration or connect and discover the remote server's tools and schemas. Connecting does not edit the scene; use get_scene_info through blender_mcp_call to check the Blender addon.",
            inputSchema: {
              type: "object",
              properties: {
                connect: { type: "boolean", description: "Initialize the configured stdio MCP server and discover its tools (default false)." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection and discovery deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_call",
            description: "Call a discovered tool on the configured Blender MCP server, preserving its full MCP content and errors. Discover tool schemas with blender_mcp_status first; execute_blender_code accepts Python code and user_prompt. Calls can modify the active Blender scene and are never automatically retried.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Exact name advertised by Blender MCP, such as get_scene_info or execute_blender_code." },
                arguments: { type: "object", description: "Arguments matching the remote tool's discovered input schema. Preserve the user's own words in user_prompt when the remote tool requests it." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection, discovery, and tool deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              required: ["tool_name"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_edit_model",
            description: "Import, edit, and export a local STL through standard Blender MCP with verified output and existing scene objects preserved. Requires a shared local filesystem and Blender Object Mode. Also supports a separately configured legacy executable bridge.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the local STL file" },
                operations: {
                  type: "array",
                  description: "Ordered operations: decimate:<ratio greater than 0 and at most 1>, remesh:<positive voxel size in STL units>, boolean_union:<STL path>. Legacy custom bridges define their own operations.",
                  minItems: 1,
                  maxItems: 64,
                  items: { type: "string" }
                },
                output_path: { type: "string", description: "Required for standard MCP previews and execution: new local STL output path whose parent exists. Existing files are never overwritten. Optional for legacy-only bridge configuration." },
                user_prompt: { type: "string", description: "The user's own words describing the edit, passed unchanged to Blender MCP." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total Blender request deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." },
                bridge_command: { type: "string", description: "Legacy custom bridge executable override, not a standard MCP command. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                execute: { type: "boolean", description: "Apply edits and export (true) or validate and return the prepared request without connecting (false, default)." }
              },
              required: process.env.BLENDER_MCP_COMMAND?.trim()
                ? ["stl_path", "operations", "output_path"]
                : ["stl_path", "operations"],
              additionalProperties: false
            }
          },
          {
            name: "counterpart_printer_info",
            description: "Counterpart contract (counterpart/1): this server's name and version, the configured Bambu printer, and which progress, layer, camera, filament, pause/resume/cancel and print features it has. Sends nothing to the printer.",
            inputSchema: {
              type: "object",
              properties: {
                bambu_model: { type: "string", description: "Printer model; defaults to BAMBU_MODEL. Selects the camera transport." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env); never returned." }
              }
            },
            outputSchema: PRINTER_INFO_OUTPUT_SCHEMA
          },
          {
            name: "counterpart_discover_printers",
            description: "Counterpart contract (counterpart/1): Bambu printers on the local network, from their own SSDP announcements (UDP 2021), with serial, model (as bambu_model names it), name and firmware. Listens for duration_ms (default 4000). network is \"unavailable\" when another app holds the port. Never connects to or authenticates with a printer.",
            inputSchema: {
              type: "object",
              properties: { duration_ms: { type: "integer", minimum: 500, maximum: 15000, description: "How long to listen (default 4000)." } },
              additionalProperties: false
            },
            outputSchema: DISCOVER_OUTPUT_SCHEMA
          },
          {
            name: "counterpart_setup_fields",
            description: "Counterpart contract (counterpart/1): the printers this server drives and the settings it reads for each, by .env variable name (first canonical, then aliases): label, hint, whether required, the model choices and the model each serial-number prefix names. Pass serial to get the model it names. Sends nothing to a printer and returns no configured values.",
            inputSchema: {
              type: "object",
              properties: { serial: { type: "string", maxLength: 64, description: "A Bambu serial number: model is the one it names, when known." } },
              additionalProperties: false
            },
            outputSchema: SETUP_FIELDS_OUTPUT_SCHEMA
          },
          {
            name: "counterpart_propose_filaments",
            description: "Counterpart contract (counterpart/1): which loaded AMS spool prints each of a model's colours, before slicing. Reads the live AMS once. trays lists the spools a person may choose (label like \"A2\", a person-readable name, colour, material, feed). proposal gives each filament its nearest spool in OKLab colour with the asked-for material preferred, and a verdict: same-colour, closest (that colour isn't loaded; note says so), no-colour or none. One print feeds from one source. Pass chosen to check the person's spools against what is loaded now; mapping then lists every filament slot's spool (painted slots included), and problems says why a choice can't print.",
            inputSchema: {
              type: "object",
              properties: {
                ...PROPOSE_FILAMENTS_INPUT_PROPERTIES,
                bambu_model: { type: "string", description: "Printer model; defaults to BAMBU_MODEL. Selects the filament profiles that decide which spools can slice." },
                nozzle_diameter: { type: "string", description: "Nozzle diameter (default NOZZLE_DIAMETER or 0.4)." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env); never returned." }
              },
              required: ["filaments"],
              additionalProperties: false
            },
            outputSchema: PROPOSE_FILAMENTS_OUTPUT_SCHEMA
          },
          {
            name: "counterpart_print_route",
            description: "Counterpart contract (counterpart/1): how this server reaches the printer for prints and for Stop/Pause/Resume. route is \"lan\" (the local network through FULU's BambuNetwork bridge, or the configured X2D native or Bambu Connect mode), \"cloud\" (Bambu Cloud through FULU's bridge) or \"developer\" (the local network straight to a printer in LAN Only + Developer Mode, whose Pause, Resume and Stop need no Bambu app). options lists each with its label, whether it can be chosen here (and why not) and what controls do on it; choices lists the ids that can be chosen. mode and type are BAMBU_DEFAULT_CONNECTION_MODE and BAMBU_DEFAULT_CONNECTION_TYPE as resolved. Pass route to change it: the change applies to the next print and control at once, and is saved to the .env file in this server's working directory when that file exists (savedTo; null otherwise). Sends nothing to the printer.",
            inputSchema: {
              type: "object",
              properties: {
                route: { type: "string", enum: ["lan", "cloud", "developer"], description: "Change the route. Omit to read it." }
              },
              additionalProperties: false
            }
          },
          {
            name: "counterpart_print_progress",
            description: "Counterpart contract (counterpart/1): the printer's state, current job (name, task id, percent, time left, layers, stage words), temperatures, active filament and problems with Bambu's HMS messages and links. Read from the MQTT report this server keeps, so a held session asks the printer nothing; observedAt is when the printer sent it. An unreachable printer reports state offline. Read-only; not a safety check.",
            inputSchema: {
              type: "object",
              properties: {
                bambu_model: { type: "string", description: "Printer model; defaults to BAMBU_MODEL. Used for the chamber sensor and Bambu's per-model messages." },
                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                bambu_token: { type: "string", description: "Access token (default: value from env)" }
              }
            },
            outputSchema: PRINT_PROGRESS_OUTPUT_SCHEMA
          },
          {
            name: "counterpart_make_3mf",
            description: "Counterpart contract (counterpart/1): combine STL parts exported separately (for example each body of a design) into one new 3MF for multi-colour printing. The parts keep their relative positions as one assembly, and each part prints with its filament number (default: part 1 uses filament 1, part 2 filament 2, and so on). Slice it with slice_stl, passing one load_filaments profile per filament number, then print it with print_3mf and ams_mapping or ams_slots. Never overwrites a file.",
            inputSchema: {
              type: "object",
              properties: {
                parts: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  description: "The parts, in filament order.",
                  items: {
                    type: "object",
                    properties: {
                      stl_path: { type: "string", description: "Path to the part's STL file." },
                      name: { type: "string", description: "The part's name, shown in the slicer." },
                      filament: { type: "integer", minimum: 1, maximum: 64, description: "1-based project filament for this part; defaults to the part's position (1, 2, ...)." }
                    },
                    required: ["stl_path", "name"],
                    additionalProperties: false
                  }
                },
                out_path: { type: "string", description: "New .3mf path whose parent directory exists. Existing files are never overwritten." }
              },
              required: ["parts", "out_path"],
              additionalProperties: false
            },
            outputSchema: MAKE_3MF_OUTPUT_SCHEMA
          },
          {
            name: "blender_mcp_setup",
            description: "Check or update the MCP for Blender add-on that the configured Blender bridge (BLENDER_MCP_COMMAND uvx, BLENDER_MCP_ARGS naming mcp-for-blender or blender-mcp) needs. Without update: which add-on file Blender loads, its protocol and the protocol the package expects, whether Blender is listening and the running add-on's own handshake. Changes nothing. With update: true, stages the add-on with the package's own installer (mcp-for-blender install-addon) at the inspected version, checks it, keeps the old file as a backup next to it and renames the new one into place. Never starts, stops or edits Blender; a running Blender uses the new add-on once it is re-enabled or restarted. A custom bridge returns supported false.",
            inputSchema: {
              type: "object",
              properties: { update: { type: "boolean", description: "Replace the installed add-on with the package's own (default false: check only)." } },
              additionalProperties: false
            },
            outputSchema: BLENDER_SETUP_OUTPUT_SCHEMA
          },
          {
            name: "fusion_mcp_setup",
            description: `Check or install what the Fusion bridge needs on macOS: Autodesk Fusion itself (found, never installed), the Fusion360MCP add-in from ${FUSION_ADDIN_REPOSITORY} at ${FUSION_MCP_PIN} (every file checked against its pinned SHA-256) set to run on startup, a login item that sets FUSION_MCP_PORT for Fusion however it is opened, and this server's FUSION_MCP_* settings. Without install: reports them and changes nothing. With install: true, installs what is missing and adds the missing settings to this server's own .env (after a copy of it), keeping a configured FUSION_MCP_COMMAND and its arguments. Never starts or quits Fusion; check the connection with fusion_mcp_status.`,
            inputSchema: {
              type: "object",
              properties: { install: { type: "boolean", description: "Install what is missing (default false: check only)." } },
              additionalProperties: false
            },
            outputSchema: FUSION_SETUP_OUTPUT_SCHEMA
          },
          {
            name: "fusion_mcp_status",
            description: `Check Autodesk Fusion through the configured Fusion MCP server (fusion360-mcp-server, faust-machines or the pinned fork with document binding): whether it is configured, Fusion is running, the Fusion360MCP add-in answers on its port, and the server's tools and schemas. connected is true only when the add-in answers. With launch: true, starts Fusion on macOS when it is not running and waits up to 90 s for the add-in. Configure FUSION_MCP_COMMAND (uvx) and FUSION_MCP_ARGS (${JSON.stringify(FUSION_MCP_DEFAULT_ARGS)}), or run fusion_mcp_setup.`,
            inputSchema: {
              type: "object",
              properties: {
                launch: { type: "boolean", description: "Start Autodesk Fusion (open -a \"Autodesk Fusion\") when it is not running, then wait up to 90 s for the add-in." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Connection and discovery deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              additionalProperties: false
            },
            outputSchema: FUSION_STATUS_OUTPUT_SCHEMA
          },
          {
            name: "fusion_mcp_call",
            description: "Call a discovered tool on the configured Fusion MCP server, such as create_sketch, extrude, fillet, create_parameter, set_parameter, check_interference or execute_code, preserving its full MCP content and errors. Discover tool schemas with fusion_mcp_status first. Calls change the open Fusion design and are never automatically retried. Most tools need an open design: call fusion_mcp_new_design first.",
            inputSchema: {
              type: "object",
              properties: {
                document_id: { type: "string", minLength: 1, description: "Session identity returned by a bound new design. Every operation targets this document, even if the user changes tabs." },
                tool_name: { type: "string", description: "Exact tool name advertised by the Fusion MCP server." },
                arguments: { type: "object", description: "Arguments matching the remote tool's discovered input schema." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Total deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              required: ["tool_name"],
              additionalProperties: false
            }
          },
          {
            name: "fusion_mcp_new_design",
            description: "Open a new parametric design document in Fusion (execute_code with app.documents.add(FusionDesignDocumentType)). The Fusion MCP tools work on the open design, so a design pass calls this first.",
            inputSchema: {
              type: "object",
              properties: {
                bind_document: { type: "boolean", description: "Create an isolated document and return its session identity, restoring the previously active document. Requires document-binding support in the configured bridge/add-in." },
                source_f3d: { type: "string", description: "With bind_document, import this absolute F3D path into a new document for revision." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Total deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              additionalProperties: false
            },
            outputSchema: FUSION_NEW_DESIGN_OUTPUT_SCHEMA
          },
          {
            name: "fusion_mcp_export",
            description: "Export the open Fusion design into an existing directory as <name>.stl (export_stl of one body), <name>.f3d (export_f3d) and <name>.parameters.json (its user parameters), and return their absolute paths. The STL is checked as a finite triangle mesh; slice it like any other model. Fusion must run on this computer, and existing files are never overwritten.",
            inputSchema: {
              type: "object",
              properties: {
                document_id: { type: "string", minLength: 1, description: "Session identity returned by a bound new design. Every operation targets this document, even if the user changes tabs." },
                output_dir: { type: "string", description: "Existing directory for the three files." },
                name: { type: "string", description: "File name without extension, such as bracket." },
                body_name: { type: "string", description: "The body to export as STL. Optional when the design has exactly one body." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Total deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              required: ["output_dir", "name"],
              additionalProperties: false
            },
            outputSchema: FUSION_EXPORT_OUTPUT_SCHEMA
          }
        ].map(withAnnotations).map(withRemote)
      };
    });

    // A designer's settings extracted for this call are removed when it settles.
    this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => withExtractedSettingsCleanup(async () => {
      const { name, arguments: args } = request.params;
      const sendNativeCommand = (
        options: Parameters<typeof sendCommandWithBambuNative>[0],
        execution: Parameters<typeof sendCommandWithBambuNative>[1] = {}
      ) => sendCommandWithBambuNative(options, { signal: extra.signal, ...execution });

      const progressToken = extra._meta?.progressToken;
      let progressNotifications = Promise.resolve();
      const reportNativeUpdate: BambuNativeUpdateCallback | undefined = progressToken === undefined
        ? undefined
        : (line) => {
            const match = /^native_update status=(-?\d+) code=(-?\d+) msg=(.*)$/.exec(line);
            if (!match) return;

            const stage = Number(match[1]);
            const code = Number(match[2]);
            const message = match[3];
            progressNotifications = progressNotifications
              .then(() => extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: code,
                  total: 100,
                  message: `native_update status=${stage} code=${code} msg=${message}`,
                },
              }))
              .catch(() => {});
          };

      // counterpart/1: print_3mf reports its FTPS upload as MCP progress (src/upload-progress.ts).
      const reportUpload = progressToken === undefined
        ? undefined
        : uploadProgressReporter(params => {
            progressNotifications = progressNotifications
              .then(() => extra.sendNotification({ method: "notifications/progress", params: { progressToken, ...params } }))
              .catch(() => {});
          });

      const host = String(args?.host || DEFAULT_HOST);
      const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
      const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
      const x2dTarget = bambuSerial.trim().toUpperCase().startsWith("20P") ||
        (DEFAULT_BAMBU_MODEL === "x2d" && bambuSerial === DEFAULT_BAMBU_SERIAL);
      // Resolved lazily: the Linux availability check reads files, and most
      // tools (status, slicing, STL) never need it.
      // One resolution per request; null means native X2D controls are usable.
      let nativeUnavailable: string | null | undefined;
      const nativeUnavailableReason = () =>
        (nativeUnavailable ??= x2dTarget ? bambuNativeUnavailableReason() ?? null : "The selected printer is not an X2D.");
      const nativeControls = () => nativeUnavailableReason() === null;
      // Linux sent X2D stop and heater-off over MQTT before the native route
      // existed. Send them over both routes there: a stuck helper must not
      // delay an emergency control, and a repeated stop or heater-off is
      // harmless. The immediate MQTT send can precede the exit of an older
      // print or heating helper that then still dispatches, so MQTT is sent
      // again once every older helper for this printer has exited, and only
      // that send counts. Either counted route succeeding is success. macOS
      // stays native-only.
      // Print controls go over the same connection as the print (resolveConnection).
      // undefined keeps the direct MQTT route in BambuImplementation.
      const printerControl = (command: "stop" | "pause" | "resume") => {
        const nativeCommand = (assertActive?: () => void, beforeDispatch?: () => Promise<void>) => sendNativeCommand({ host, serial: bambuSerial, token: bambuToken,
          messageJson: JSON.stringify({ print: { command, param: "", sequence_id: String(Date.now()) } }), qos: 1 },
          command === "resume" ? { signal: extra.signal, assertActive, beforeDispatch } : undefined);
        // The selected route decides first: a job started over FULU's bridge (LAN or cloud) is controlled there,
        // even on an X2D whose native plug-in is installed. Otherwise an X2D uses its native route when it can.
        const route = resolveConnection(args);
        if (route.mode !== "bambu_network" && nativeControls()) {
          return command === "stop"
            ? linuxEmergency(() => nativeCommand(), signal => this.bambu.sendStopOverMqtt(host, bambuSerial, bambuToken, signal))
            : nativeCommand;
        }
        if (route.mode === "bambu_native") throw new Error(nativeUnavailableReason()!);
        if (route.mode !== "bambu_network") return undefined;
        return (assertActive?: () => void, beforeDispatch?: () => Promise<void>) => {
          const options = { assertDispatchAllowed: () => { extra.signal.throwIfAborted(); assertActive?.(); } };
          return route.type === "cloud"
            ? this.bambuNetwork.sendCloudPrintCommand(bambuSerial, command, options, beforeDispatch)
            : this.bambuNetwork.sendLocalPrintCommand({ devId: bambuSerial, devIp: host, username: "bblp", password: bambuToken, useSsl: true }, command, options, beforeDispatch);
        };
      };
      const linuxEmergency = (native: () => Promise<any>, mqtt: (signal: AbortSignal) => Promise<any>) => async () => {
        if (process.platform !== "linux") return native();
        // An unreachable printer makes the MQTT connect retry forever; bound each
        // MQTT send so it cannot hold back a stop the native route already sent.
        const immediate = withEmergencyMqttTimeout(mqtt);
        const [nativeResult, immediateResult, mqttResult] = await Promise.allSettled([
          native(),
          immediate,
          // Finish the first attempt before reusing its cached publisher: its
          // expiry must never close the later, counted send's transport.
          Promise.allSettled([interruptNativeOperations(bambuSerial), immediate]).then(results => {
            if (results[0].status === "rejected") throw results[0].reason;
            return withEmergencyMqttTimeout(mqtt);
          }),
        ]);
        const reason = (result: PromiseSettledResult<any>) =>
          result.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : undefined;
        if (nativeResult.status === "rejected" && mqttResult.status === "rejected") {
          throw new Error(`native route: ${reason(nativeResult)}; MQTT route: ${reason(mqttResult)}`);
        }
        const state = (result: PromiseSettledResult<any>) => result.status === "fulfilled" ? "sent" : "failed";
        return {
          status: "success",
          routes: { native: state(nativeResult), mqtt: state(mqttResult), mqtt_immediate: state(immediateResult) },
          ...(reason(nativeResult) ? { native_error: reason(nativeResult) } : {}),
          ...(reason(mqttResult) ? { mqtt_error: reason(mqttResult) } : {}),
        };
      };
      const requestedTemplateDir =
        typeof args?.template_dir === "string" && args.template_dir.trim().length > 0
          ? String(args.template_dir)
          : undefined;
      const requestedTemplateName =
        typeof args?.template_name === "string" ? String(args.template_name) : undefined;
      const resolveTemplatePathFromName = (sourceTypes?: TemplateSourceType[]) =>
        this.resolveTemplatePath(requestedTemplateName, requestedTemplateDir, sourceTypes);
      const explicitTemplatePath = String(args?.template_3mf_path || DEFAULT_TEMPLATE_3MF_PATH);

      try {
        let result;

        switch (name) {
          case "inspect_print_file": {
            const allowed = new Set(["file_path", "bambu_model", "plate_index", "nozzle_diameters", "bed_type", "include_preview"]);
            if (!args || Object.keys(args).some(key => !allowed.has(key))) throw new Error("inspect_print_file accepts only file/model/plate/nozzle/bed/preview arguments.");
            if (args.include_preview !== undefined && typeof args.include_preview !== "boolean") throw new Error("include_preview must be true or false.");
            if (typeof args.file_path !== "string" || !args.file_path.trim() || args.file_path.includes("\0")) throw new Error("file_path must name a local prepared artifact.");
            if (typeof args.bambu_model !== "string" || !args.bambu_model.trim()) throw new Error("An explicit bambu_model is required for file inspection.");
            const model = validateBambuModel(args.bambu_model);
            const plateIndex = args.plate_index === undefined ? 0 : args.plate_index;
            if (typeof plateIndex !== "number" || !Number.isSafeInteger(plateIndex) || plateIndex < 0) throw new Error("plate_index must be a nonnegative safe integer.");
            if (args.nozzle_diameters !== undefined && (!Array.isArray(args.nozzle_diameters) || args.nozzle_diameters.some(value => typeof value !== "number"))) throw new Error("nozzle_diameters must be numeric sizes.");
            const nozzles = requestedPrintNozzles(args);
            if (args.bed_type !== undefined && (typeof args.bed_type !== "string" || !args.bed_type.trim())) throw new Error("bed_type must be a supported plate type.");
            const bedType = args.bed_type === undefined ? undefined : resolveBedType(args.bed_type);
            if (extra.signal.aborted) throw new Error("File inspection cancelled.");
            result = await withPrintSnapshot(args.file_path, async snapshot => {
              const inspection = await inspectPrintFile(snapshot, { model, nozzleDiameters: nozzles, plateIndex, bedType });
              if (extra.signal.aborted) throw new Error("File inspection cancelled.");
              const byteLength = (await fs.promises.stat(snapshot)).size;
              // The picture is drawn from these same snapshot bytes, so it is of exactly the file inspected.
              const preview = args.include_preview === true ? await previewOfSnapshot(snapshot, plateIndex, inspection.sha256) : undefined;
              return {
                receipt_version: "1",
                evidence: "file-only",
                dispatch_authorized: false,
                artifact: { sha256: inspection.sha256, byte_length: byteLength, file_format: path.extname(snapshot).toLowerCase() === ".3mf" ? "3mf" : "gcode" },
                selection: { bambu_model: model, plate_index: plateIndex, ...(nozzles === undefined ? {} : { nozzle_diameters: nozzles }), ...(bedType === undefined ? {} : { bed_type: bedType }) },
                inspection,
                // The plate's estimate and slice settings, and the file's plate count, read here so clients don't parse slicer files.
                sliced: await slicedFileFacts(snapshot, plateIndex),
                ...(preview ? { preview } : {}),
              };
            });
            break;
          }
          case "get_printer_status":
            result = await this.bambu.getStatus(host, bambuSerial, bambuToken);
            break;

          case "get_printer_filaments": {
            const requestedModel = (String(args?.bambu_model ?? DEFAULT_BAMBU_MODEL ?? "")).trim().toLowerCase();
            const normalizedModel = requestedModel ? validateBambuModel(requestedModel) : undefined;
            const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            result = await this.getResolvedPrinterFilamentInventory(
              host,
              bambuSerial,
              bambuToken,
              normalizedModel,
              nozzleDiam
            );
            break;
          }

          case "resolve_3mf_ams_slots": {
            if (!args?.three_mf_path) {
              throw new Error("Missing required parameter: three_mf_path");
            }
            const requestedModel = (String(args?.bambu_model ?? DEFAULT_BAMBU_MODEL ?? "")).trim().toLowerCase();
            const normalizedModel = requestedModel ? validateBambuModel(requestedModel) : undefined;
            const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            const requirements = await analyze3MFAmsRequirements(
              String(args.three_mf_path),
              args?.plate_index !== undefined ? Number(args.plate_index) : 0
            );
            const inventory = await this.getResolvedPrinterFilamentInventory(
              host,
              bambuSerial,
              bambuToken,
              normalizedModel,
              nozzleDiam
            );
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

          case "list_3mf_plates": {
            if (typeof args?.three_mf_path !== "string" || !args.three_mf_path) throw new Error("Missing required parameter: three_mf_path");
            if (args.include_thumbnails !== undefined && typeof args.include_thumbnails !== "boolean") throw new Error("include_thumbnails must be a boolean.");
            const plates = await listModelPlates(args.three_mf_path, { thumbnails: args.include_thumbnails === true });
            return { content: [{ type: "text", text: JSON.stringify(plates) }], structuredContent: plates };
          }
          case "list_3mf_plate_objects": {
            if (!args?.three_mf_path) {
              throw new Error("Missing required parameter: three_mf_path");
            }
            result = await analyze3MFPlateObjects(
              String(args.three_mf_path),
              args?.plate_index !== undefined ? Number(args.plate_index) : 0
            );
            break;
          }

          case "list_templates":
            result = this.listTemplateRegistry(requestedTemplateDir);
            break;

          case "save_template":
            if (!args?.source_path) {
              throw new Error("Missing required parameter: source_path");
            }
            result = this.saveTemplate(
              String(args.source_path),
              typeof args?.template_name === "string" ? String(args.template_name) : undefined,
              requestedTemplateDir
            );
            break;

          case "list_printer_files":
            result = await this.bambu.getFiles(host, bambuSerial, bambuToken);
            break;

          case "bambu_connect_import_file":
            if (!args?.file_path) {
              throw new Error("Missing required parameter: file_path");
            }
            result = await importFileViaBambuConnect({
              filePath: String(args.file_path),
              name: args?.name !== undefined ? String(args.name) : undefined,
              version: args?.version !== undefined ? String(args.version) : undefined,
            });
            break;

          case "bambu_network_bridge_status": {
            const bridgeArgs = args as Record<string, any> | undefined;
            const options = this.bridgeOptionsFromArgs(
              bridgeArgs,
              "bambu_network_bridge_status"
            );
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
            const bridgeArgs = args as Record<string, any>;
            const readMethods = new Set(["bridge.handshake", "net.is_user_login", "net.get_user_id", "net.get_user_name", "net.get_user_avatar", "net.get_user_nickanme"]);
            if (!readMethods.has(String(bridgeArgs.method))) {
              throw new Error("Raw bridge mutations and unknown methods are disabled. Use print_3mf_bambu_network for verified printing or a dedicated printer tool.");
            }
            const payload = bridgeArgs.payload && typeof bridgeArgs.payload === "object"
              ? bridgeArgs.payload as Record<string, unknown>
              : {};
            const options = this.bridgeOptionsFromArgs(bridgeArgs, "bambu_network_call");
            result = bridgeArgs.with_agent === false
              ? await this.bambuNetwork.request(String(bridgeArgs.method), payload, options)
              : await this.bambuNetwork.callWithAgent(String(bridgeArgs.method), payload, options);
            break;
          }

          case "print_3mf_bambu_network": {
            result = await this.print3mfViaBambuNetwork(args as Record<string, any>, host, bambuSerial, bambuToken);
            break;
          }

          case "camera_stream_start":
            result = this.bambu.cameraStreamStart(host, bambuSerial, bambuToken, {
              bambuModel: (args?.bambu_model as string | undefined) ?? process.env.BAMBU_MODEL ?? process.env.BAMBU_PRINTER_MODEL,
              fps: args?.fps as number | undefined, idleTimeoutMs: args?.idle_timeout_ms as number | undefined,
              ffmpegPath: this.runtimeConfig.ffmpegPath,
            });
            break;
          case "camera_frame":
            result = await this.bambu.cameraStreamFrame(host, bambuSerial, {
              sinceSeq: args?.since_seq as number | undefined, waitMs: args?.wait_ms as number | undefined,
              maxWidth: args?.max_width as number | undefined, maxBytes: args?.max_bytes as number | undefined, changedOnly: args?.changed_only as boolean | undefined,
              minChange: args?.min_change as number | undefined, signal: extra.signal,
            });
            break;
          case "camera_stream_stop":
            result = this.bambu.cameraStreamStop(host, bambuSerial);
            break;

          case "camera_snapshot": {
            const snapshotModel = (args?.bambu_model as string | undefined) ?? process.env.BAMBU_MODEL ?? process.env.BAMBU_PRINTER_MODEL;
            result = await this.bambu.cameraSnapshot(host, bambuSerial, bambuToken, {
              savePath: args?.save_path ? String(args.save_path) : undefined,
              timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
              bambuModel: snapshotModel ? String(snapshotModel) : undefined,
              experimental: Boolean(args?.experimental),
              ffmpegPath: this.resolveExecutableSelectorArg(
                args?.ffmpeg_path,
                "camera_snapshot",
                "ffmpeg_path"
              ) ?? this.runtimeConfig.ffmpegPath,
            });
            break;
          }

          case "delete_printer_file":
            if (!args?.filename) {
              throw new Error("Missing required parameter: filename");
            }
            result = await this.bambu.deleteFile(
              host,
              bambuSerial,
              bambuToken,
              String(args.filename),
              args.confirm
            );
            break;

          case "upload_gcode": {
            if (!args?.filename) {
              throw new Error("Missing required parameter: filename");
            }
            const uploadSource = resolveUploadGcodeSource(args as Record<string, unknown>);
            try {
              const uploadModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
              result = await this.bambu.uploadFile(
                host, bambuSerial, bambuToken, uploadSource.filePath, String(args.filename), false, uploadModel
              );
            } finally {
              if (uploadSource.cleanupDir) {
                fs.rmSync(uploadSource.cleanupDir, { recursive: true, force: true });
              }
            }
            break;
          }

          case "upload_file": {
            if (!args?.file_path || !args?.filename) {
              throw new Error("Missing required parameters: file_path and filename");
            }
            if (String(args?.connection_mode || "").trim().toLowerCase() === "bambu_native") {
              result = await this.uploadFileViaBambuNative(
                args as Record<string, any>, host, bambuSerial, bambuToken, reportNativeUpdate, extra.signal
              );
            } else {
              const print = Boolean(args.print ?? false);
              const printableUpload = /\.(?:gcode|3mf)$/i.test(String(args.file_path)) || /\.(?:gcode|3mf)$/i.test(String(args.filename));
              const uploadModel = print || printableUpload ? await this.resolveBambuModel(args?.bambu_model as string | undefined) : undefined;
              if (print) assertDirectPrintSupported(uploadModel, bambuSerial);
              result = await this.bambu.uploadFile(
                host, bambuSerial, bambuToken,
                String(args.file_path), String(args.filename),
                print, uploadModel
              );
            }
            break;
          }

          case "start_print":
          case "start_print_job": {
            if (!args?.filename) {
              throw new Error("Missing required parameter: filename");
            }
            const startModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            assertDirectPrintSupported(startModel, bambuSerial);
            result = await this.bambu.startJob(host, bambuSerial, bambuToken, String(args.filename), startModel);
            break;
          }

          case "cancel_print":
            result = await this.bambu.cancelJob(host, bambuSerial, bambuToken, printerControl("stop"));
            break;

          case "pause_print":
            result = await this.bambu.pauseJob(host, bambuSerial, bambuToken, printerControl("pause"));
            break;

          case "resume_print":
            result = await this.bambu.resumeJob(host, bambuSerial, bambuToken, printerControl("resume"));
            break;

          case "x2d_native_control": {
            if (!args?.message_json) {
              throw new Error("Missing required parameter: message_json");
            }
            if (!nativeControls()) {
              throw new Error("x2d_native_control is restricted to a selected X2D printer on macOS, or on Linux with the native helper installed. " +
                nativeUnavailableReason());
            }
            const messageJson = validateBambuNativeMetadata(String(args.message_json));
            result = await sendNativeCommand({
              host,
              serial: bambuSerial,
              token: bambuToken,
              messageJson,
              qos: args?.qos === undefined ? 0 : Number(args.qos),
              flag: args?.flag === undefined ? 0 : Number(args.flag),
            });
            break;
          }

          case "clear_hms_errors":
            result = await this.bambu.clearHmsErrors(host, bambuSerial, bambuToken,
              nativeControls()
                ? (assertActive, beforeDispatch) => sendNativeCommand({ host, serial: bambuSerial, token: bambuToken,
                    messageJson: JSON.stringify({ print: { command: "clean_print_error", param: "", sequence_id: String(Date.now()) } }), qos: 1 }, { signal: extra.signal, assertActive, beforeDispatch })
                : undefined);
            break;

          case "set_print_speed":
            if (!args?.mode) {
              throw new Error("Missing required parameter: mode");
            }
            if (nativeControls()) {
              const normalized = String(args.mode).trim().toLowerCase();
              const mode = normalized === "silent" ? 1
                : normalized === "standard" ? 2
                  : normalized === "sport" ? 3
                    : normalized === "ludicrous" ? 4
                      : Number(normalized);
              if (!Number.isInteger(mode) || mode < 1 || mode > 4) {
                throw new Error("Print speed mode must be one of: silent, standard, sport, ludicrous, 1, 2, 3, 4.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  print: { command: "print_speed", param: String(mode), sequence_id: String(Date.now()) },
                }),
              });
            } else {
              result = await this.bambu.setPrintSpeed(host, bambuSerial, bambuToken, String(args.mode));
            }
            break;

          case "set_airduct_mode":
            if (!args?.mode) {
              throw new Error("Missing required parameter: mode");
            }
            if (nativeControls()) {
              const mode = String(args.mode).trim().toLowerCase();
              if (mode !== "cooling" && mode !== "heating") {
                throw new Error("Airduct mode must be one of: cooling, heating.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  print: {
                    command: "set_airduct",
                    modeId: mode === "cooling" ? 0 : 1,
                    submode: -1,
                    sequence_id: String(Date.now()),
                  },
                }),
              });
            } else {
              result = await this.bambu.setAirductMode(host, bambuSerial, bambuToken, String(args.mode));
            }
            break;

          case "reread_ams_rfid":
            if (args?.ams_id === undefined || args?.slot_id === undefined) {
              throw new Error("Missing required parameters: ams_id and slot_id");
            }
            if (nativeControls()) {
              const amsId = Number(args.ams_id);
              const slotId = Number(args.slot_id);
              if ((!Number.isInteger(amsId) || (amsId < 0 || amsId > 3)) && amsId !== 128) {
                throw new Error("X2D ams_id must be 0 to 3, or 128 for AMS-HT.");
              }
              if (!Number.isInteger(slotId) || slotId < 0 || slotId > 3 || (amsId === 128 && slotId !== 0)) {
                throw new Error("slot_id must be an integer from 0 to 3; AMS-HT supports only slot 0.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  print: {
                    command: "ams_get_rfid",
                    sequence_id: String(Date.now()),
                    ams_id: amsId,
                    slot_id: slotId,
                  },
                }),
              });
            } else {
              result = await this.bambu.rereadAmsRfid(
                host,
                bambuSerial,
                bambuToken,
                Number(args.ams_id),
                Number(args.slot_id)
              );
            }
            break;

          case "set_temperature": {
            if (!args?.component || args?.temperature === undefined) {
              throw new Error("Missing required parameters: component and temperature");
            }
            if (typeof args.temperature !== "number" || !Number.isFinite(args.temperature) || args.temperature < 0) {
              throw new Error("Temperature must be a finite, non-negative number in °C.");
            }
            const heaterModel = args.temperature === 0
              ? String(args.bambu_model || DEFAULT_BAMBU_MODEL).trim().toLowerCase()
              : await this.resolveBambuModel(args.bambu_model as string | undefined);
            result = await this.bambu.setTemperature(
              host, bambuSerial, bambuToken,
              String(args.component), args.temperature,
              heaterModel || undefined,
              args?.material !== undefined ? String(args.material) : undefined,
              Number(args?.nozzle_diameter ?? DEFAULT_NOZZLE_DIAMETER),
              (args.temperature === 0 ? nativeControls() : heaterModel === "x2d" && bambuNativeControlsAvailable())
                ? (heater, target, assertActive, beforeDispatch) => {
                    const native = () => sendNativeCommand({ host, serial: bambuSerial, token: bambuToken,
                      messageJson: buildBambuNativeTemperatureCommand(heater, target).messageJson }, { signal: extra.signal, assertActive, beforeDispatch });
                    return target === 0
                      ? linuxEmergency(native, signal => this.bambu.sendHeaterOffOverMqtt(host, bambuSerial, bambuToken, heater, signal))()
                      : native();
                  }
                : undefined
            );
            break;
          }

          case "set_fan_speed":
            if (!args?.fan || args?.speed === undefined) {
              throw new Error("Missing required parameters: fan and speed");
            }
            if (nativeControls()) {
              const status = await this.bambu.getStatus(host, bambuSerial, bambuToken);
              const printerState = String(status?.raw?.gcode_state ?? status?.raw?.print?.gcode_state ?? status?.gcode_state ?? status?.status ?? "").toUpperCase();
              if (printerState === "RUNNING" && args?.confirm_during_print !== true) {
                throw new Error("The X2D is currently printing. Re-submit with confirm_during_print=true after explicit user confirmation.");
              }
              const fanCommand = buildBambuNativeFanCommand(String(args.fan), Number(args.speed));
              result = {
                ...await sendNativeCommand({
                  host,
                  serial: bambuSerial,
                  token: bambuToken,
                  messageJson: fanCommand.messageJson,
                }),
                fan: fanCommand.fan,
                fan_index: fanCommand.fanIndex,
                requested_speed: fanCommand.requestedSpeed,
                speed: fanCommand.speed,
              };
            } else {
              result = await this.bambu.setFanSpeed(
                host,
                bambuSerial,
                bambuToken,
                String(args.fan),
                Number(args.speed)
              );
            }
            break;

          case "set_light":
            if (!args?.light || !args?.mode) {
              throw new Error("Missing required parameters: light and mode");
            }
            if (nativeControls()) {
              const light = String(args.light).trim();
              const mode = String(args.mode).trim().toLowerCase();
              if (light !== "chamber_light" && light !== "chamber_light2") {
                throw new Error("X2D light must be chamber_light or chamber_light2.");
              }
              if (!["on", "off", "flashing"].includes(mode)) {
                throw new Error("Light mode must be one of: on, off, flashing.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  system: {
                    command: "ledctrl",
                    led_node: light,
                    led_mode: mode,
                    led_on_time: 500,
                    led_off_time: 500,
                    loop_times: 0,
                    interval_time: 0,
                    sequence_id: String(Date.now()),
                  },
                }),
              });
            } else {
              result = await this.bambu.setLight(
                host,
                bambuSerial,
                bambuToken,
                String(args.light),
                String(args.mode)
              );
            }
            break;

          case "skip_objects":
            if (!Array.isArray(args?.object_ids)) {
              throw new Error("Missing required parameter: object_ids");
            }
            if (nativeControls()) {
              const objectIds = args.object_ids.map((id: unknown) => Number(id));
              if (objectIds.length === 0 || objectIds.some((id: number) => !Number.isInteger(id) || id < 0)) {
                throw new Error("object_ids must contain one or more non-negative integers.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  print: { command: "skip_objects", obj_list: objectIds, sequence_id: String(Date.now()) },
                }),
                qos: 1,
              });
            } else {
              result = await this.bambu.skipObjects(
                host,
                bambuSerial,
                bambuToken,
                args.object_ids.map((id: unknown) => Number(id))
              );
            }
            break;

          case "set_ams_drying":
            if (!args?.action || args?.ams_id === undefined) {
              throw new Error("Missing required parameters: action and ams_id");
            }
            if (nativeControls()) {
              const action = String(args.action).trim().toLowerCase();
              const amsId = Number(args.ams_id);
              if (action !== "start" && action !== "stop") {
                throw new Error("AMS drying action must be one of: start, stop.");
              }
              if ((!Number.isInteger(amsId) || (amsId < 0 || amsId > 3)) && amsId !== 128) {
                throw new Error("X2D ams_id must be 0 to 3, or 128 for AMS-HT.");
              }
              result = await sendNativeCommand({
                host,
                serial: bambuSerial,
                token: bambuToken,
                messageJson: JSON.stringify({
                  print: {
                    command: "ams_control",
                    sequence_id: String(Date.now()),
                    ams_id: amsId,
                    param: action === "start" ? "start_drying" : "stop_drying",
                  },
                }),
              });
            } else {
              result = await this.bambu.setAmsDrying(
                host,
                bambuSerial,
                bambuToken,
                String(args.action),
                Number(args.ams_id)
              );
            }
            break;

          case "extend_stl_base":
            if (!args?.stl_path || args?.extension_height === undefined) {
              throw new Error("Missing required parameters: stl_path and extension_height");
            }
            result = await this.stlManipulator.extendBase(
              String(args.stl_path), Number(args.extension_height)
            );
            break;

          case "scale_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.scaleSTL(
              String(args.stl_path),
              [
                args.scale_x !== undefined ? Number(args.scale_x) : 1.0,
                args.scale_y !== undefined ? Number(args.scale_y) : 1.0,
                args.scale_z !== undefined ? Number(args.scale_z) : 1.0,
              ]
            );
            break;

          case "rotate_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.rotateSTL(
              String(args.stl_path),
              [
                args.angle_x !== undefined ? Number(args.angle_x) : 0,
                args.angle_y !== undefined ? Number(args.angle_y) : 0,
                args.angle_z !== undefined ? Number(args.angle_z) : 0,
              ]
            );
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
            // With source_path, the other arguments are the slice's (template_name is its template), as slice_stl takes them.
            result = args?.source_path
              ? await this.inspectSliceSettings(String(args.source_path), args as Record<string, unknown>,
                namedTemplatePath(args, typeof args?.template_name === "string" && args.template_name.trim() ? resolveTemplatePathFromName(["json", "config", "3mf"]) : undefined))
              : await this.inspectSliceSettings(String(resolveTemplatePathFromName(["3mf", "json", "config"])));
            break;

          case "slice_with_template": {
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            if (!args?.template_name) {
              throw new Error("Missing required parameter: template_name");
            }
            const { slicerType, slicerPath, slicerProfile } = this.resolveSlicerConfigFromArgs(
              args as Record<string, unknown> | undefined,
              "slice_with_template"
            );
            const sliceModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            const activeSlicerProfile = await resolveTemplateFirstSlicerProfilePath(
              args,
              slicerProfile || undefined,
              resolveTemplatePathFromName(["json", "config", "3mf"]) || explicitTemplatePath || undefined,
              TEMP_DIR
            );
            const explicitSlicerProfile = hasExplicitSlicerProfile(args);
            const printerPreset = BAMBU_MODEL_PRESETS[sliceModel]?.(nozzleDiam);

            const sliceBambuOptions: BambuSliceOptions = {};
            if (args?.uptodate !== undefined) sliceBambuOptions.uptodate = Boolean(args.uptodate);
            if (args?.repetitions !== undefined) sliceBambuOptions.repetitions = Number(args.repetitions);
            if (args?.orient !== undefined) sliceBambuOptions.orient = Boolean(args.orient);
            if (args?.arrange !== undefined) sliceBambuOptions.arrange = Boolean(args.arrange);
            if (args?.ensure_on_bed !== undefined) sliceBambuOptions.ensureOnBed = Boolean(args.ensure_on_bed);
            if (args?.clone_objects !== undefined) sliceBambuOptions.cloneObjects = String(args.clone_objects);
            if (args?.skip_objects !== undefined) sliceBambuOptions.skipObjects = String(args.skip_objects);
            if (
              args?.load_filaments !== undefined &&
              args?.filament_profile !== undefined &&
              String(args.load_filaments) !== String(args.filament_profile)
            ) {
              throw new Error("Provide either load_filaments or filament_profile, not conflicting values.");
            }
            if (args?.load_filaments !== undefined) {
              sliceBambuOptions.loadFilaments = String(args.load_filaments);
            } else if (args?.filament_profile !== undefined) {
              sliceBambuOptions.loadFilaments = String(args.filament_profile);
            }
            if (args?.load_filament_ids !== undefined) sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
            if (args?.filament_colours !== undefined) sliceBambuOptions.filamentColours = parseFilamentColours(String(args.filament_colours));
            sliceBambuOptions.bedType = resolveBambuStudioCliBedType(args?.bed_type as string | undefined);
            sliceBambuOptions.nozzleType = resolveNozzleType(args?.nozzle_type);
            sliceBambuOptions.nozzleVolumeType = resolveNozzleVolumeType(args?.nozzle_volume_type);
            if (args?.enable_timelapse !== undefined) sliceBambuOptions.enableTimelapse = Boolean(args.enable_timelapse);
            if (args?.allow_mix_temp !== undefined) sliceBambuOptions.allowMixTemp = Boolean(args.allow_mix_temp);
            if (args?.scale !== undefined) sliceBambuOptions.scale = Number(args.scale);
            if (args?.rotate !== undefined) sliceBambuOptions.rotate = Number(args.rotate);
            if (args?.rotate_x !== undefined) sliceBambuOptions.rotateX = Number(args.rotate_x);
            if (args?.rotate_y !== undefined) sliceBambuOptions.rotateY = Number(args.rotate_y);
            if (args?.min_save !== undefined) sliceBambuOptions.minSave = Boolean(args.min_save);
            if (args?.skip_modified_gcodes !== undefined) sliceBambuOptions.skipModifiedGcodes = Boolean(args.skip_modified_gcodes);
            if (args?.slice_plate !== undefined) sliceBambuOptions.slicePlate = Number(args.slice_plate);
            { const pauses = parsePauseLayers(args?.pause_at_layers); if (pauses) sliceBambuOptions.pauseAtLayers = pauses; }
            const usePrinterFilaments =
              args?.use_printer_filaments !== undefined ? Boolean(args.use_printer_filaments) : true;
            if (
              usePrinterFilaments &&
              !explicitSlicerProfile &&
              !sliceBambuOptions.loadFilaments &&
              bambuSerial &&
              bambuToken
            ) {
              try {
                const liveFilaments = await this.getResolvedPrinterFilamentInventory(
                  host,
                  bambuSerial,
                  bambuToken,
                  sliceModel,
                  nozzleDiam
                );
                if (liveFilaments.recommended?.load_filaments) {
                  sliceBambuOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                }
              } catch (filamentError) {
                console.warn("Could not resolve live printer filaments for slicing:", filamentError);
              }
            }

            result = await this.stlManipulator.sliceSTL(
              String(args.stl_path), slicerType, slicerPath,
              activeSlicerProfile,
              undefined,
              printerPreset,
              sliceBambuOptions
            );
            break;
          }

          case "slice_stl": {
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            const { slicerType, slicerPath, slicerProfile } = this.resolveSlicerConfigFromArgs(
              args as Record<string, unknown> | undefined,
              "slice_stl"
            );
            // Copies only where the backend makes them (counterpart_printer_info capabilities.slicing); elsewhere one copy
            // would be sliced without a word.
            if (args?.repetitions !== undefined && Number(args.repetitions) > 1 && !bambuSliceCapabilities(slicerType).copies) {
              throw new Error(`Copies (repetitions) need the Bambu Studio or OrcaSlicer CLI, not ${slicerType}; nothing was sliced.`);
            }
            const sliceModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            const explicitSlicerProfile = hasExplicitSlicerProfile(args);
            const requestedTemplatePath = namedTemplatePath(args, resolveTemplatePathFromName(["json", "config", "3mf"]));
            const ownProcess3mf = await ownProcessTemplate(args, String(args.stl_path), requestedTemplatePath);
            const activeSlicerProfile = ownProcess3mf
              ? await resolveSlicerProfilePath(undefined, ownProcess3mf, TEMP_DIR)
              : await resolveSlicerProfilePath(
                slicerProfile || undefined,
                requestedTemplatePath || explicitTemplatePath || undefined,
                TEMP_DIR
              );
            // Resolve printer preset for BambuStudio slicer
            const printerPreset = BAMBU_MODEL_PRESETS[sliceModel]?.(nozzleDiam);

            const sliceBambuOptions: BambuSliceOptions = {};
            if (args?.uptodate !== undefined) sliceBambuOptions.uptodate = Boolean(args.uptodate);
            if (args?.repetitions !== undefined) sliceBambuOptions.repetitions = Number(args.repetitions);
            if (args?.orient !== undefined) sliceBambuOptions.orient = Boolean(args.orient);
            if (args?.arrange !== undefined) sliceBambuOptions.arrange = Boolean(args.arrange);
            if (args?.ensure_on_bed !== undefined) sliceBambuOptions.ensureOnBed = Boolean(args.ensure_on_bed);
            if (args?.clone_objects !== undefined) sliceBambuOptions.cloneObjects = String(args.clone_objects);
            if (args?.skip_objects !== undefined) sliceBambuOptions.skipObjects = String(args.skip_objects);
            if (
              args?.load_filaments !== undefined &&
              args?.filament_profile !== undefined &&
              String(args.load_filaments) !== String(args.filament_profile)
            ) {
              throw new Error("Provide either load_filaments or filament_profile, not conflicting values.");
            }
            if (args?.load_filaments !== undefined) {
              sliceBambuOptions.loadFilaments = String(args.load_filaments);
            } else if (args?.filament_profile !== undefined) {
              sliceBambuOptions.loadFilaments = String(args.filament_profile);
            }
            if (args?.load_filament_ids !== undefined) sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
            if (args?.filament_colours !== undefined) sliceBambuOptions.filamentColours = parseFilamentColours(String(args.filament_colours));
            sliceBambuOptions.bedType = resolveBambuStudioCliBedType(args?.bed_type as string | undefined);
            sliceBambuOptions.nozzleType = resolveNozzleType(args?.nozzle_type);
            sliceBambuOptions.nozzleVolumeType = resolveNozzleVolumeType(args?.nozzle_volume_type);
            if (args?.enable_timelapse !== undefined) sliceBambuOptions.enableTimelapse = Boolean(args.enable_timelapse);
            if (args?.allow_mix_temp !== undefined) sliceBambuOptions.allowMixTemp = Boolean(args.allow_mix_temp);
            if (args?.scale !== undefined) sliceBambuOptions.scale = Number(args.scale);
            if (args?.rotate !== undefined) sliceBambuOptions.rotate = Number(args.rotate);
            if (args?.rotate_x !== undefined) sliceBambuOptions.rotateX = Number(args.rotate_x);
            if (args?.rotate_y !== undefined) sliceBambuOptions.rotateY = Number(args.rotate_y);
            if (args?.min_save !== undefined) sliceBambuOptions.minSave = Boolean(args.min_save);
            if (args?.skip_modified_gcodes !== undefined) sliceBambuOptions.skipModifiedGcodes = Boolean(args.skip_modified_gcodes);
            if (args?.slice_plate !== undefined) sliceBambuOptions.slicePlate = Number(args.slice_plate);
            { const pauses = parsePauseLayers(args?.pause_at_layers); if (pauses) sliceBambuOptions.pauseAtLayers = pauses; }
            const processOverrides = parseProcessOverrides(withPrintQuality(args as Record<string, unknown>, Number(nozzleDiam)), Number(nozzleDiam));
            if (processOverrides) sliceBambuOptions.processOverrides = processOverrides;
            if (sliceBambuOptions.loadFilamentIds && String(args.stl_path).toLowerCase().endsWith(".3mf")) {
              // Bambu Studio's CLI refuses --load-filament-ids for 3MF input and counts it per input file.
              throw new Error("load_filament_ids applies only to STL input. In a 3MF, each object or part names its own filament; counterpart_make_3mf writes it from parts[].filament.");
            }
            const usePrinterFilaments =
              args?.use_printer_filaments !== undefined ? Boolean(args.use_printer_filaments) : true;
            if (
              usePrinterFilaments &&
              !explicitSlicerProfile &&
              !sliceBambuOptions.loadFilaments &&
              bambuSerial &&
              bambuToken
            ) {
              try {
                const liveFilaments = await this.getResolvedPrinterFilamentInventory(
                  host,
                  bambuSerial,
                  bambuToken,
                  sliceModel,
                  nozzleDiam
                );
                if (liveFilaments.recommended?.load_filaments) {
                  sliceBambuOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                }
              } catch (filamentError) {
                console.warn("Could not resolve live printer filaments for slicing:", filamentError);
              }
            }

            // A client that cancels this call (it no longer wants the slice) stops the slicer.
            sliceBambuOptions.signal = extra.signal;
            const sliced = await this.stlManipulator.sliceSTLWithResult(
              String(args.stl_path), slicerType, slicerPath,
              activeSlicerProfile,
              undefined, // progressCallback
              printerPreset,
              sliceBambuOptions
            );
            await progressNotifications;
            // The text stays the sliced file's path; slicer_result is the slicer's own result.json, verbatim, and
            // slicer_report its verdict and words, so clients don't read the slicer's format.
            return { content: [{ type: "text", text: sliced.path }], structuredContent: withSlicerReport(sliced) };
          }

          case "print_3mf": {
            if (!args?.three_mf_path) {
              throw new Error("Missing required parameter: three_mf_path");
            }
            const printModel = await this.resolveBambuModel(args.bambu_model as string | undefined);
            const resolvedArgs = { ...args, bambu_model: printModel };
            const requestedModel = printModel;
            const connectionMode = resolveConnection(args, requestedModel).mode;
            // X2D firmware accepts the Bambu Studio :6000/eMMC route but
            // rejects the legacy direct FTPS STOR operation with 553. Keep
            // an explicit old-mode request from re-entering that known-bad
            // path; callers still get a fully scriptable local print.
            const effectiveConnectionMode =
              connectionMode === "lan_mqtt_ftps" && requestedModel === "x2d"
                ? "bambu_native"
                : connectionMode;
            if (effectiveConnectionMode === "bambu_connect") {
              result = await this.handoff3mfViaBambuConnect(resolvedArgs);
              break;
            }
            if (effectiveConnectionMode === "bambu_network") {
              result = await this.print3mfViaBambuNetwork(resolvedArgs, host, bambuSerial, bambuToken);
              break;
            }
            if (effectiveConnectionMode === "bambu_native") {
              result = await this.print3mfViaBambuNative(
                resolvedArgs, host, bambuSerial, bambuToken, reportNativeUpdate, extra.signal
              );
              break;
            }
            if (!bambuSerial || !bambuToken) {
              throw new Error("Bambu serial number and access token are required for print_3mf.");
            }

            const { slicerType, slicerPath, slicerProfile } = this.resolveSlicerConfigFromArgs(
              args as Record<string, unknown> | undefined,
              "print_3mf"
            );
            assertDirectPrintSupported(printModel, bambuSerial);
            const printBedType = resolveBedType(args?.bed_type as string | undefined);
            const printNozzles = requestedPrintNozzles(args as Record<string, any>);
            const printNozzle = String(printNozzles?.[0] ?? DEFAULT_NOZZLE_DIAMETER);
            const requestedPrintTemplate = namedTemplatePath(args, resolveTemplatePathFromName(["json", "config", "3mf"]));
            const ownPrintProcess = await ownProcessTemplate(args, String(args.three_mf_path), requestedPrintTemplate);
            const activeSlicerProfile = ownPrintProcess
              ? await resolveTemplateSlicerProfilePath(ownPrintProcess, TEMP_DIR)
              : await resolveTemplateFirstSlicerProfilePath(
                args,
                slicerProfile || undefined,
                requestedPrintTemplate || explicitTemplatePath || undefined,
                TEMP_DIR
              );
            const explicitSlicerProfile = hasExplicitSlicerProfile(args);
            const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
            const plateIndex = args?.plate_index !== undefined ? Number(args.plate_index) : 0;

            if (!Number.isInteger(plateIndex) || plateIndex < 0) {
              throw new Error("plate_index must be a non-negative integer.");
            }

            let threeMFPath = String(args.three_mf_path);

            // Inspect and auto-slice before upload. Preserve any failure instead of sending an unsliced project.
            const JSZip = (await import('jszip')).default;
            const zipData = fs.readFileSync(threeMFPath);
            const zip = await JSZip.loadAsync(zipData);
            const hasGcode = Object.values(zip.files).some(
              entry => !entry.dir && /\.gcode$/i.test(entry.name)
            );
            const pauseLayers = parsePauseLayers(args?.pause_at_layers);
            if (hasGcode && pauseLayers) {
              // Already sliced: its G-code is what prints, so the pauses must already be in it.
              const gcode = await readPlateGcode(threeMFPath, Number(args?.plate_index ?? 0) + 1);
              const placed = gcode ? pausedLayers(gcode, machinePauseGcode(gcode)) : [];
              const missing = pauseLayers.filter(layer => !placed.includes(layer));
              if (missing.length) {
                throw new Error(`This 3MF is already sliced without a pause before layer ${missing.join(", ")}. Slice it again with pause_at_layers (slice_stl), or add the pause in Bambu Studio or OrcaSlicer.`);
              }
            }
            if (!hasGcode) {
              assertUniformCliNozzles(args as Record<string, any>);
              console.error(`3MF has no gcode — auto-slicing with ${slicerType} for ${printModel}`);
              const autoSliceOptions: BambuSliceOptions = {
                ...(slicerType === "orca-slicer-api" ? { slicePlate: plateIndex + 1 } : {
                  uptodate: true, ensureOnBed: true, minSave: true, skipModifiedGcodes: true,
                }),
                bedType: printBedType,
                nozzleType: resolveNozzleType(args?.nozzle_type),
                nozzleVolumeType: resolveNozzleVolumeType(args?.nozzle_volume_type),
                // A pause belongs to the plate being printed; the CLI carries custom G-code for one plate only.
                ...(pauseLayers ? { pauseAtLayers: pauseLayers, slicePlate: plateIndex + 1 } : {}),
              };
              if (!explicitSlicerProfile) {
                try {
                  const liveFilaments = await this.getResolvedPrinterFilamentInventory(
                    host,
                    bambuSerial,
                    bambuToken,
                    printModel,
                    printNozzle
                  );
                  if (liveFilaments.recommended?.load_filaments) {
                    autoSliceOptions.loadFilaments = liveFilaments.recommended.load_filaments;
                  }
                } catch (filamentError) {
                  console.warn("Could not resolve live printer filaments for auto-slicing:", filamentError);
                }
              }
              threeMFPath = await this.stlManipulator.sliceSTL(
                threeMFPath, slicerType, slicerPath, activeSlicerProfile,
                undefined, // progressCallback
                printPreset,
                autoSliceOptions
              );
              console.error("Auto-sliced to: " + threeMFPath);
            }

            const parsed3MFData = await parse3MF(threeMFPath);
            const isH2Print = H2_BAMBU_MODELS.has(printModel);
            const trayOptions = { dualNozzle: isDualNozzleModel(printModel) };
            let parsedAmsMapping: number[] | undefined;
            if (!isH2Print && parsed3MFData.slicerConfig?.ams_mapping) {
              const slots = normalizeAmsMappingObject(parsed3MFData.slicerConfig.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
              if (slots.length > 0) {
                parsedAmsMapping = slots;
              }
            }

            let finalAmsMapping = parsedAmsMapping;
            let finalAmsSlots: number[] | undefined;
            let useAMS = args?.use_ams !== undefined ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
            const hasUserAmsMapping = hasAmsMappingInput(args?.ams_mapping);
            const hasUserAmsSlots = Array.isArray(args?.ams_slots);

            if (hasUserAmsMapping) {
              let userMappingOverride: number[] | undefined;
              if (Array.isArray(args.ams_mapping)) {
                userMappingOverride = args.ams_mapping.map((v: unknown, i: number) =>
                  normalizeBridgeAmsTrayValue(v, `ams_mapping[${i}]`, trayOptions)
                );
              } else if (args.ams_mapping && typeof args.ams_mapping === 'object') {
                userMappingOverride = normalizeAmsMappingObject(args.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
              }
              if (userMappingOverride && userMappingOverride.length > 0) {
                finalAmsMapping = userMappingOverride;
                useAMS = true;
              }
            }
            if (hasUserAmsSlots) {
              const userSlots = (args.ams_slots as unknown[]).filter((v: any) => typeof v === 'number');
              if (userSlots.length > 0) {
                finalAmsSlots = userSlots;
                finalAmsMapping = undefined;
                useAMS = true;
              }
            }
            if (!hasUserAmsMapping && !hasUserAmsSlots && args?.auto_match_ams === true && args?.use_ams !== false) {
              const requirements = await analyze3MFAmsRequirements(threeMFPath, plateIndex);
              const inventory = await this.getResolvedPrinterFilamentInventory(
                host,
                bambuSerial,
                bambuToken,
                printModel,
                printNozzle
              );
              const resolved = resolveAmsSlotsFromRequirements(requirements, inventory);
              if (resolved.missing.length > 0) {
                throw new Error(
                  `auto_match_ams could not find loaded AMS trays for: ${resolved.missing
                    .map((missing) => missing.tray_info_idx || `filament position ${missing.filament_position}`)
                    .join(", ")}`
                );
              }
              finalAmsMapping = undefined;
              finalAmsSlots = resolved.ams_slots;
              useAMS = finalAmsSlots.length > 0;
            }
            if (
              isH2Print &&
              args?.use_ams !== false &&
              !hasUserAmsMapping &&
              !hasUserAmsSlots &&
              args?.auto_match_ams !== true &&
              (!finalAmsMapping || finalAmsMapping.length === 0) &&
              (!finalAmsSlots || finalAmsSlots.length === 0)
            ) {
              const requirements = await analyze3MFAmsRequirements(threeMFPath, plateIndex);
              if (requirements.usedFilamentPositions.length > 0) {
                throw new Error(
                  `H2 ${printModel.toUpperCase()} pre-sliced jobs with declared filaments require ams_slots, ams_mapping, or auto_match_ams: true. Plate uses project filament positions ${JSON.stringify(requirements.usedFilamentPositions)}; pass one physical tray per used filament, for example ams_slots: [0] for AMS 0 slot 0 or [1] for AMS 0 slot 1.`
                );
              }
            }

            if (args?.use_ams === false) {
              if (!hasUserAmsMapping) finalAmsMapping = undefined;
              if (!hasUserAmsSlots) finalAmsSlots = undefined;
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
              bambuModel: printModel,
              nozzleDiameters: printNozzles,
              plateIndex,
              useAMS: useAMS,
              amsMapping: finalAmsMapping,
              amsSlots: finalAmsSlots,
              bedType: printBedType,
              ...callerPrintOptions(args),
              timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
              onUploadProgress: reportUpload,
            });
            // Report what the printer did, not merely that a command was published.
            break;
          }

          case "print_collar_charm": {
            const resolvedTemplateSourcePath = resolveTemplatePathFromName(["3mf"]);
            const resolvedSourcePath = String(resolvedTemplateSourcePath || args?.source_path || "");
            if (!resolvedSourcePath) {
              throw new Error("Missing required parameter: source_path or template_name");
            }
            if (!bambuSerial || !bambuToken) {
              throw new Error("Bambu serial number and access token are required for print_collar_charm.");
            }

            const { slicerType, slicerPath, slicerProfile } = this.resolveSlicerConfigFromArgs(
              args as Record<string, unknown> | undefined,
              "print_collar_charm"
            );
            const printModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            assertDirectPrintSupported(printModel, bambuSerial);
            const printBedType = resolveBedType(args?.bed_type as string | undefined);
            const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            const activeSlicerProfile = await resolveTemplateFirstSlicerProfilePath(
              args,
              slicerProfile || undefined,
              resolvedTemplateSourcePath || explicitTemplatePath || undefined,
              TEMP_DIR
            );

            const preparedThreeMFPath = await this.resolveCollarCharmPrepared3MF(
              resolvedSourcePath,
              resolvedTemplateSourcePath || explicitTemplatePath || undefined,
              slicerType,
              slicerPath,
              activeSlicerProfile || undefined,
              printModel,
              printNozzle,
              printBedType,
              host,
              bambuSerial,
              bambuToken
            );

            const collarAnalysis = await analyzeCollarCharm3MF(preparedThreeMFPath, 0);
            const inventory = await this.preflightCollarCharmPolicy(
              host,
              bambuSerial,
              bambuToken,
              printModel,
              printNozzle
            );

            const projectName = path.basename(preparedThreeMFPath).replace(/\.3mf$/i, '');
            result = await this.bambu.print3mf(host, bambuSerial, bambuToken, {
              projectName,
              filePath: preparedThreeMFPath,
              bambuModel: printModel,
              nozzleDiameters: [Number(printNozzle)],
              plateIndex: collarAnalysis.plateIndex,
              useAMS: true,
              amsSlots: collarAnalysis.amsSlots,
              bedType: printBedType,
              ...callerPrintOptions(args),
              timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : false,
              onUploadProgress: reportUpload,
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
            if (!args?.stl_path) throw new Error("Missing required parameter: stl_path");
            result = await this.stlManipulator.mergeVertices(
              String(args.stl_path),
              args.tolerance !== undefined ? Number(args.tolerance) : undefined
            );
            break;

          case "center_model":
            if (!args?.stl_path) throw new Error("Missing required parameter: stl_path");
            result = await this.stlManipulator.centerModel(String(args.stl_path));
            break;

          case "lay_flat": {
            if (!args?.stl_path) throw new Error("Missing required parameter: stl_path");
            const layFlatResult = await this.stlManipulator.layFlatWithResult(String(args.stl_path));
            await progressNotifications;
            // The text stays the STL path clients read; structuredContent says whether it was laid flat.
            return { content: [{ type: "text", text: layFlatResult.path }], structuredContent: layFlatResult };
          }

          case "blender_mcp_status":
            result = await this.blender.status(args ?? {}, extra.signal);
            break;

          case "blender_mcp_call":
            return await this.blender.call(args ?? {}, extra.signal);

          case "blender_mcp_edit_model":
            result = await this.blender.edit(
              args ?? {},
              this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "blender_mcp_edit_model",
                "bridge_command",
                true
              ) ?? (!process.env.BLENDER_MCP_COMMAND?.trim() ? this.runtimeConfig.blenderBridgeCommand : undefined),
              extra.signal
            );
            break;

          case "counterpart_discover_printers": {
            const requested = Number(args?.duration_ms);
            const found = await discoverBambu(Number.isFinite(requested) ? requested : 4000);
            // Only models bambu_model accepts: the X1 (serial 00W) has none, so it stays unset.
            result = { contract: "counterpart/1", network: found.state, printers: found.printers.map(({ model, ...printer }) =>
              ({ ...printer, ...(model && (VALID_BAMBU_MODELS as readonly string[]).includes(model) ? { model } : {}) })) };
            break;
          }

          case "counterpart_setup_fields":
            result = bambuSetupFields({ server: SERVER_INFO, models: VALID_BAMBU_MODELS, slicer: slicerSetupNow(), ...(typeof args?.serial === "string" ? { serial: args.serial } : {}) });
            break;

          case "counterpart_propose_filaments": {
            const requestedModel = (String(args?.bambu_model ?? DEFAULT_BAMBU_MODEL ?? "")).trim().toLowerCase();
            const normalizedModel = requestedModel ? validateBambuModel(requestedModel) : undefined;
            const inventory = await this.getResolvedPrinterFilamentInventory(host, bambuSerial, bambuToken, normalizedModel,
              String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER));
            const trays: ProposalTray[] = inventory.trays.flatMap(tray => {
              const colour = normalizeRgbColor(tray.tray_color);
              if (!tray.loaded || tray.slot === null || !colour || !tray.tray_type || !tray.label) return [];
              // print_3mf's tray value: an AMS-HT unit (id 128 and up, one tray) is its unit id, not ams_id × 4 + tray.
              const slot = tray.ams_id !== null && tray.ams_id >= 128 ? tray.ams_id : tray.slot;
              return [{ slot, label: tray.label, name: tray.spool_name ?? tray.tray_type, colour: `#${colour.toUpperCase()}`,
                material: tray.tray_type, filamentId: tray.tray_info_idx ?? "", feed: "ams", sliceable: Boolean(tray.resolved_profile_path),
                ...(tray.resolved_profile_path ? { profile: tray.resolved_profile_path } : {}) }];
            });
            result = proposeFilaments({ trays, filaments: Array.isArray(args?.filaments) ? args.filaments : [],
              ...(Array.isArray(args?.painted) ? { painted: args.painted } : {}), ...(Array.isArray(args?.chosen) ? { chosen: args.chosen } : {}),
              sliced: args?.sliced === true, names: colourNames() });
            break;
          }

          case "counterpart_printer_info":
            result = bambuPrinterInfo({ server: SERVER_INFO, host, serial: bambuSerial, model: this.displayModel(args, bambuSerial), slicerType: normalizeSlicerType(DEFAULT_SLICER_TYPE) });
            break;

          case "counterpart_print_route": {
            let savedTo: string | null = null;
            // FULU's bridge is set up, so the routes through it can be used.
            const bridgeConfigured = Boolean(this.bambuNetwork.resolveBridgeCommand());
            const routeModel = this.displayModel(args, bambuSerial);
            // The printer's own local route (X2D native by default, or a configured native/Bambu Connect mode),
            // resolved from the start-up configuration so it survives choosing another route.
            const ownLocal = ownLocalOf({ mode: CONFIGURED_CONNECTION.mode || (routeModel === "x2d" ? "bambu_native" : ""), type: CONFIGURED_CONNECTION.type || "lan" });
            if (args?.route !== undefined) {
              if (!PRINT_ROUTES.includes(args.route as PrintRoute)) throw new Error('route must be "lan", "cloud" or "developer".');
              const next = connectionForRoute(args.route as PrintRoute, resolveConnection({}, routeModel), bridgeConfigured, ownLocal);
              // dotenv loaded .env from the working directory at start; a client's own env block has no file to update.
              const file = path.resolve(process.cwd(), ".env");
              if (fs.existsSync(file)) {
                writeEnvValues(file, {
                  ...(next.mode ? { BAMBU_DEFAULT_CONNECTION_MODE: next.mode } : {}),
                  ...(next.type ? { BAMBU_DEFAULT_CONNECTION_TYPE: next.type } : {}),
                });
                savedTo = file;
              }
              DEFAULT_BAMBU_CONNECTION_MODE = next.mode;
              DEFAULT_BAMBU_CONNECTION_TYPE = next.type;
            }
            const connection = resolveConnection({}, routeModel);
            const options = routeOptions(connection, bridgeConfigured, ownLocal);
            result = { route: routeOf(connection), mode: connection.mode, type: connection.type,
              choices: options.filter(option => option.available).map(option => option.id), options, savedTo };
            break;
          }

          case "counterpart_print_progress": {
            const report = await this.bambu.readProgressReport(host, bambuSerial, bambuToken);
            result = report
              ? bambuProgress(report.raw, { receivedAt: report.receivedAt, serial: bambuSerial, model: this.displayModel(args, bambuSerial) })
              : offlineProgress(Date.now());
            break;
          }

          case "counterpart_make_3mf":
            result = await makeCounterpart3mf(args ?? {});
            break;

          case "blender_mcp_setup":
            if (args?.update !== undefined && typeof args.update !== "boolean") throw new Error("update must be a boolean.");
            result = args?.update === true ? await this.blenderSetup.update(extra.signal) : await this.blenderSetup.check();
            break;

          case "fusion_mcp_setup":
            if (args?.install !== undefined && typeof args.install !== "boolean") throw new Error("install must be a boolean.");
            result = args?.install === true ? await this.fusionSetup.install(extra.signal) : await this.fusionSetup.check();
            break;

          case "fusion_mcp_status":
            result = await this.fusion.status(args ?? {}, extra.signal);
            break;

          case "fusion_mcp_call": {
            // Preserve polymorphic text/images/errors. An invented empty structured result
            // masks useful text in clients that prefer structuredContent.
            return await this.fusion.call(args ?? {}, extra.signal);
          }

          case "fusion_mcp_new_design":
            result = await this.fusion.newDesign(args ?? {}, extra.signal);
            break;

          case "fusion_mcp_export":
            result = await this.fusion.export(args ?? {}, extra.signal);
            break;

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        await progressNotifications;
        // A stream image belongs in structuredContent once. Repeating its base64 in text
        // doubles the wire budget; text-only clients still receive useful frame metadata.
        const textResult = name === "camera_frame" && result && typeof result === "object"
          ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "base64")) : result;
        const text = typeof textResult === "string" ? textResult : JSON.stringify(textResult, null, 2);

        // A declared outputSchema obliges structuredContent whatever MCP_HTTP_JSON_RESPONSE says.
        if ((this.runtimeConfig.enableJsonResponse || OUTPUT_SCHEMA_TOOLS.has(name)) && typeof result === "object") {
          return {
            content: [{ type: "text", text }],
            structuredContent: result,
          };
        }

        return { content: [{ type: "text", text }] };

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Refusals and printer rejections repeat unchanged; say what to fix instead of "try again".
        const refused = /nothing was (?:sent|uploaded)|no command was sent|does not match the job|is ambiguous|is missing or ambiguous|rejected the print command|are refused|is refused|refused because|refused until|refused before/i.test(message);
        const structured: StructuredToolError = {
          status: "error",
          retryable: false,
          suggestion: refused
            ? `Retrying unchanged repeats this refusal. Fix the reported cause (file, arguments, printer settings, or printer state) first. Error: ${message}`
            : `Check parameters and try again. Error: ${message}`,
          message,
          tool: name,
          ...(error instanceof PrinterRefusal ? { code: error.code } : {}),
          // The slicer's own result.json; the message starts with its error_string and warnings.
          // A slicer failure always carries slicer_report: the plain sentence a person sees, the slicer's words for the log.
          // The report always says failed (a result.json that says success can still leave no output file).
          ...(error instanceof SlicerRunError ? {
            ...(error.slicerResult ? { slicer_result: error.slicerResult } : {}),
            slicer_report: { ...refusalReport(error.words), message: error.plain ?? error.words.slice(0, 2000) },
          } : {}),
        };

        // MCP clients validate structuredContent against a declared outputSchema even on
        // errors (SDK 1.32 Client.callTool), so those tools return the error as text only.
        return {
          // A slicer's refusal leads with its plain sentence, then the slicer's own words.
          content: [{ type: "text", text: error instanceof SlicerRunError && error.plain ? message : `Error: ${message}` }],
          ...(OUTPUT_SCHEMA_TOOLS.has(name) ? {} : { structuredContent: structured }),
          isError: true,
        };
      }
    }));
  }

  async startStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stdin.once("end", () => { void this.shutdown(); });
    console.error("Bambu Printer MCP server running on stdio");
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      // Close camera sockets/processes first, waking any waiting frame requests.
      this.bambu.cameraStreams.stopAll();
      // Closing the MCP transport aborts its active requests before exit cleanup.
      await this.server.close();
      await this.fusion.close();
      // The FULU host's container (BAMBU_NETWORK_BRIDGE_IMAGE) is removed with the server, not left running.
      await this.bambuNetwork.stop();
      this.httpRuntime?.httpServer.close();
    } catch (error) {
      console.error("[MCP Shutdown]", error);
    } finally {
      process.exit(exitCode);
    }
  }

  async startHttp() {
    const { httpHost, httpPort, httpPath, statefulSession, enableJsonResponse, allowedOrigins, allowedHosts } =
      this.runtimeConfig;
    const allowedHostnames = allowedRequestHostnames(httpHost, allowedHosts);
    if (!allowedHostnames) {
      console.error(`[MCP HTTP] Bound to ${httpHost} without MCP_HTTP_ALLOWED_HOSTS: Host headers are not checked, so DNS rebinding is not blocked.`);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: statefulSession ? () => randomUUID() : undefined,
      enableJsonResponse,
    });

    await this.server.connect(transport);

    const reject = (res: ServerResponse, status: number, message: string) => {
      res.writeHead(status);
      res.end(message);
    };

    const httpServer = createHttpServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const hostname = hostHeaderName(req.headers.host);
          if (!hostname) return reject(res, 400, "Bad Request");
          if (allowedHostnames && !allowedHostnames.has(hostname)) return reject(res, 403, "Forbidden");

          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname !== httpPath) return reject(res, 404, "Not found");

          const origin = req.headers.origin;
          if (origin) {
            if (allowedOrigins.size > 0) {
              if (!allowedOrigins.has(origin)) return reject(res, 403, "Forbidden");
            } else if (allowedHostnames) {
              let originHostname: string | undefined;
              try { originHostname = new URL(origin).hostname.toLowerCase(); } catch { originHostname = undefined; }
              if (!originHostname || !allowedHostnames.has(originHostname)) return reject(res, 403, "Forbidden");
            }
          }

          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("[MCP HTTP] Request failed:", error);
          if (!res.headersSent) reject(res, 500, "Internal Server Error");
          else res.end();
        }
      }
    );

    httpServer.listen(httpPort, httpHost, () => {
      console.error(`Bambu Printer MCP server running on http://${httpHost}:${httpPort}${httpPath}`);
    });

    this.httpRuntime = { transport, httpServer };
  }

  async run() {
    if (this.runtimeConfig.transport === "streamable-http") {
      await this.startHttp();
    } else {
      await this.startStdio();
    }
  }
}

const server = new BambuPrinterMCPServer();
process.once("SIGINT", () => { void server.shutdown(130); });
process.once("SIGTERM", () => { void server.shutdown(143); });
server.run().catch(console.error);
