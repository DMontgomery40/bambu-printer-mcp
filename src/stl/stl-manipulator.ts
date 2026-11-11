import { customGcodesWithPauses, layerTops, machinePauseGcode, pausedLayers, readPlateGcode, readProjectCustomGcodes } from "../slicer/layer-pauses.js";
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { keepSlice, restoreSlice, sliceCacheKey } from '../slicer/slice-cache.js';
import { listModelPlates } from '../counterpart/model-plates.js';
import { flattenForCli, detectProfilesRoot, resolveBblMachineProfile } from '../slicer/profile-flatten.js';
import { plainSlicerError, UNKNOWN_SLICER_ERROR } from '../slicer/slicer-messages.js';
import { bambuCliExitCode } from '../slicer/cli-exit-codes.js';
import { applyProcessOverrides, type ProcessOverrides } from '../slicer/process-overrides.js';
import { profileJsonFiles } from '../slicer/profile-files.js';
import { materializeOrcaProfilesRoot, stageOrcaCliProfiles } from '../slicer/orca-profile-cache.js';
import { sliceWithOrcaApi, validateRemoteSliceOptions } from '../slicer/remote-slicer.js';

/** How long a slice's folder (its sliced file and result.json) is kept: a day, then a later slice removes it. */
const SLICE_FOLDER_LIFETIME_MS = 24 * 60 * 60 * 1000;
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const BAMBU_PROFILE_ROOTS = [
  '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL',
  '/Applications/OrcaSlicer.app/Contents/Resources/profiles/BBL',
];
// curr_bed_type's enum keys (Bambu Studio 02.08.02.61 libslic3r/PrintConfig.cpp:437-445).
const BAMBU_CLI_BED_TYPES: Record<string, string> = {
  textured_plate: 'Textured PEI Plate',
  cool_plate: 'Cool Plate',
  engineering_plate: 'Engineering Plate',
  hot_plate: 'High Temp Plate',
  supertack_plate: 'Supertack Plate',
};

// Define types for progress tracking
export type ProgressCallback = (progress: number, message?: string) => void;
export type OperationResult = {
  success: boolean;
  filePath?: string;
  error?: string;
  operationId: string;
};

// Define possible transformation operations
export type TransformationType = 'scale' | 'rotate' | 'translate' | 'extendBase' | 'customModify';
export type TransformationAxis = 'x' | 'y' | 'z' | 'all';
export type BoundingBox = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  dimensions: THREE.Vector3;
};

// Define transformation parameters
export type TransformationParams = {
  type: TransformationType;
  axis?: TransformationAxis;
  value: number | number[];
  relative?: boolean;
  selectionBounds?: THREE.Box3;
};

export const SLICER_TYPES = [
  'bambustudio',
  'orcaslicer',
  'orcaslicer-bambulab',
  'orca-slicer-api',
  'prusaslicer',
  'cura',
  'slic3r',
] as const;

export type SlicerType = typeof SLICER_TYPES[number];

const SLICER_TYPE_ALIASES: Record<string, SlicerType> = {
  bambustudio: 'bambustudio',
  'bambu-studio': 'bambustudio',
  bblstudio: 'bambustudio',
  orcaslicer: 'orcaslicer',
  'orca-slicer': 'orcaslicer',
  orca: 'orcaslicer',
  'orcaslicer-bambulab': 'orcaslicer-bambulab',
  'orca-slicer-bambulab': 'orcaslicer-bambulab',
  'orca-bambulab': 'orcaslicer-bambulab',
  'fulu-orca': 'orcaslicer-bambulab',
  'fulu-orcaslicer': 'orcaslicer-bambulab',
  'fulu-orca-slicer': 'orcaslicer-bambulab',
  'orca-studio': 'orcaslicer-bambulab',
  orcastudio: 'orcaslicer-bambulab',
  'orcaslicer-bmcu': 'orcaslicer-bambulab',
  'orca-bmcu': 'orcaslicer-bambulab',
  'orca-slicer-api': 'orca-slicer-api',
  'orcaslicer-api': 'orca-slicer-api',
  prusaslicer: 'prusaslicer',
  'prusa-slicer': 'prusaslicer',
  cura: 'cura',
  curaengine: 'cura',
  slic3r: 'slic3r',
};

export function normalizeSlicerType(rawSlicerType: string): SlicerType {
  const key = rawSlicerType.trim().toLowerCase().replace(/_/g, '-');
  const normalized = SLICER_TYPE_ALIASES[key];

  if (!normalized) {
    throw new Error(
      `Unsupported slicer_type: "${rawSlicerType}". Valid values: ${SLICER_TYPES.join(', ')}`
    );
  }

  return normalized;
}

export function isBambuCompatibleSlicer(slicerType: SlicerType): boolean {
  return (
    slicerType === 'bambustudio' ||
    slicerType === 'orcaslicer' ||
    slicerType === 'orcaslicer-bambulab' ||
    slicerType === 'orca-slicer-api'
  );
}

function isPathLikeExecutable(slicerPath: string): boolean {
  return (
    path.isAbsolute(slicerPath) ||
    slicerPath.startsWith("./") ||
    slicerPath.startsWith("../") ||
    slicerPath.includes("/") ||
    slicerPath.includes("\\") ||
    /^[A-Za-z]:/.test(slicerPath)
  );
}

function configuredBambuProfileDirs(): string[] {
  const override = process.env.BAMBU_SLICER_PROFILE_DIRS;
  if (override !== undefined) {
    return override.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  }

  const home = os.homedir();
  const macAppSupport = path.join(home, 'Library', 'Application Support');
  const linuxConfig = path.join(home, '.config');
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const appNames = [
    'BambuStudio',
    'Bambu Studio',
    'OrcaSlicer',
    'Orca Slicer',
    'OrcaStudio',
    'Orca Studio',
  ];

  const roots = [
    macAppSupport,
    linuxConfig,
    ...(appData ? [appData] : []),
    ...(localAppData ? [localAppData] : []),
  ];

  return roots.flatMap((root) =>
    appNames.map((appName) => path.join(root, appName, 'system', 'BBL'))
  );
}

// Bambu-compatible slicer CLI flags exposed via the slice_stl tool
export interface BambuSliceOptions {
  /** The request's own cancellation: aborting it stops the slicer (the MCP client cancelled the call). */
  signal?: AbortSignal;
  uptodate?: boolean;          // --uptodate: update 3MF configs to latest presets
  repetitions?: number;        // STL: --clone-objects N; 3MF: --repetitions N on the selected plate
  orient?: boolean;            // --orient 1: auto-orient for printability
  arrange?: boolean;           // --arrange 1: auto-arrange objects on plate
  ensureOnBed?: boolean;       // --ensure-on-bed: lift floating models onto bed
  cloneObjects?: string;       // --clone-objects "1,3,1,10": clone counts per object
  skipObjects?: string;        // --skip-objects "3,5,10": skip specific objects
  loadFilaments?: string;      // --load-filaments "f1.json;f2.json": filament profiles
  loadFilamentIds?: string;    // --load-filament-ids "1,2,3,1": filament-to-object mapping
  filamentColours?: string[];  // positional #RRGGBB per loaded filament slot
  bedType?: string;            // Bambu bed type, e.g. textured_plate or cool_plate
  nozzleType?: string;         // installed hotend material written into the machine preset
  nozzleVolumeType?: 'Standard' | 'High Flow'; // installed nozzle flow, the machine preset's nozzle_volume_type
  enableTimelapse?: boolean;   // --enable-timelapse: timelapse-aware slicing
  allowMixTemp?: boolean;      // --allow-mix-temp: allow mixed-temp filaments
  scale?: number;              // --scale factor: uniform scale
  rotate?: number;             // --rotate degrees: Z-axis rotation
  rotateX?: number;            // --rotate-x degrees
  rotateY?: number;            // --rotate-y degrees
  minSave?: boolean;           // --min-save: smaller output 3MF
  skipModifiedGcodes?: boolean;// --skip-modified-gcodes: ignore stale custom gcodes
  slicePlate?: number;         // --slice N: which plate (default: 0 = all)
  processOverrides?: ProcessOverrides; // layer_height / wall_loops / sparse_infill_density over the resolved process preset
  pauseAtLayers?: number[];    // pause before each 1-based layer (the slicer's "Add pause"); Bambu-compatible CLIs only
  customGcodesFile?: string;   // --load-custom-gcodes <json>: set by sliceSTLWithResult, not by callers
}

interface BambuSettingsBundle {
  settingsArg?: string;
  filamentPaths: string[];
  /** Positional slot colours declared by the input 3MF project. */
  filamentColours?: string[];
  /** Saved per-plate tower coordinates must survive default process loading. */
  projectTowerPosition?: { wipe_tower_x?: unknown; wipe_tower_y?: unknown };
  /** Identity provenance before the process is merged into a generated file. */
  processSource?: { filePath: string; profile: Record<string, unknown> };
}

/** Keys every profile kind carries; they describe the file, not machine hardware. */
const PROFILE_METADATA_KEYS = new Set([
  'name', 'type', 'from', 'inherits', 'instantiation', 'setting_id', 'version', 'is_custom_defined',
  'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
]);

/**
 * Why the slicer process failed. execFile's message already carries stderr;
 * a crash often leaves stderr empty (FULU OrcaSlicer-bambulab v1.0.0
 * segfaults with no output), so name the signal or exit code and add the end
 * of stdout instead.
 */
/** Where a Bambu-style CLI writes result.json, and when this run started. */
type CliResultSource = { resultPath: string; startedAt: number };

/** Bambu Studio's or OrcaSlicer's own result.json, parsed verbatim. */
export type SlicerResult = Record<string, unknown>;

/** A sliced file, with the slicer's own result.json when it wrote one. */
export type SliceOutput = { path: string; slicer_result?: SlicerResult };

/**
 * A slicer failure that keeps the slicer's own result.json. The message starts
 * with the slicer's own words (`slicerText`), when it gave any, then `detail`.
 */
export class SlicerRunError extends Error {
  readonly slicerText: string;
  /** What a person is told for a slicer's refusal: a plain sentence, never its own words (src/slicer/slicer-messages.ts). */
  readonly plain?: string;
  /** The slicer's words and this server's detail, after the plain sentence: what slicer_report.slicer_message keeps. */
  readonly words: string;
  constructor(detail: string, readonly slicerResult?: SlicerResult) {
    const slicerText = slicerResult ? slicerResultText(slicerResult) : "";
    const words = slicerText ? `${slicerText}\n${detail}` : detail;
    // A known refusal, or one in the slicer's own words, is said plainly. A fault of the setup (no slicer, a crash,
    // no output) stays in this server's own words, which say what to fix.
    const plain = plainSlicerError(words) ?? (slicerText ? UNKNOWN_SLICER_ERROR : undefined);
    super(plain ? `${plain}\nThe slicer said: ${words}` : words);
    this.name = "SlicerRunError";
    this.slicerText = slicerText;
    this.plain = plain;
    this.words = words;
  }
}

/**
 * The result.json this run wrote. Bambu Studio 02.08.02.61 writes it on macOS
 * for successes and failures alike; an older file must not describe this run.
 */
function readCliResult(cli: CliResultSource): SlicerResult | undefined {
  try {
    if (fs.statSync(cli.resultPath).mtimeMs < cli.startedAt) return undefined;
    const result: unknown = JSON.parse(fs.readFileSync(cli.resultPath, "utf8"));
    return result && typeof result === "object" && !Array.isArray(result) ? result as SlicerResult : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The slicer's own words: its error_string when it reports a failing
 * return_code (not "Success."), then each plate's warning_message.
 */
function slicerResultText(result: SlicerResult): string {
  const plates = Array.isArray(result.sliced_plates) ? result.sliced_plates : [];
  return [
    result.return_code === 0 ? undefined : result.error_string,
    ...plates.map(plate => plate && typeof plate === "object" ? (plate as Record<string, unknown>).warning_message : undefined),
  ].filter((text): text is string => typeof text === "string" && text.trim() !== "").map(text => text.trim()).join("\n");
}

function describeSlicerFailure(
  error: { message: string; code?: unknown; signal?: unknown },
  stdout: string,
  stderr: string,
  cli?: CliResultSource
): string {
  const status = typeof error.signal === "string" && error.signal
    ? `crashed with ${error.signal}`
    : typeof error.code === "number" ? `exited with code ${error.code}` : "failed";
  const reason = cli ? bambuCliFailureReason(error.code, cli) : undefined;
  const output = stderr.trim() ? "" : stdout.trim().split("\n").slice(-20).join("\n");
  return `Slicer failed: the slicer ${status}${reason ? ` (${reason})` : ""}. ${error.message.trim()}${output ? `\nSlicer output: ${output}` : ""}`;
}

function bambuCliFailureReason(exitCode: unknown, cli: CliResultSource): string | undefined {
  const result = readCliResult(cli);
  if (typeof result?.error_string === "string" && result.error_string.trim()) {
    return `${result.error_string.trim()} [${result.return_code}]`;
  }
  if (typeof exitCode !== "number") return undefined;
  const known = bambuCliExitCode(exitCode);
  return known ? `${known.sentence} [${known.code}]` : undefined;
}

export class STLManipulator extends EventEmitter {
  private tempDir: string;
  private activeOperations: Map<string, boolean> = new Map();

  constructor(tempDir: string = path.join(process.cwd(), 'temp')) {
    super();
    // Every slicer output and generated profile lives here; keep it absolute.
    this.tempDir = path.resolve(tempDir);
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Generate a unique operation ID
   */
  private generateOperationId(): string {
    return crypto.randomUUID();
  }

  /**
   * A new folder for one slice's outputs, under TEMP_DIR/slices. A sliced file's path stays valid for a day after
   * its slice (callers print from it); older slice folders are removed as new slices start.
   */
  private async newSliceFolder(operationId: string): Promise<string> {
    const root = path.join(this.tempDir, 'slices');
    await fs.promises.mkdir(root, { recursive: true });
    const cutoff = Date.now() - SLICE_FOLDER_LIFETIME_MS;
    for (const name of await fs.promises.readdir(root).catch(() => [] as string[])) {
      const folder = path.join(root, name);
      const info = await fs.promises.stat(folder).catch(() => undefined);
      if (info?.isDirectory() && info.mtimeMs < cutoff) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
    const folder = path.join(root, operationId);
    await fs.promises.mkdir(folder);
    return folder;
  }

  private getAvailableProfileRoots(): string[] {
    const selectedRoot = process.env.BAMBU_PROFILES_ROOT;
    return [
      ...(selectedRoot ? [path.resolve(selectedRoot, 'BBL')] : []),
      ...configuredBambuProfileDirs(),
      ...BAMBU_PROFILE_ROOTS,
    ].filter((root) => fs.existsSync(root));
  }

  private findProfileFile(
    category: 'machine' | 'process' | 'filament',
    profileName?: string,
    roots = this.getAvailableProfileRoots()
  ): string | undefined {
    if (!profileName) {
      return undefined;
    }

    for (const root of roots) {
      const candidate = profileJsonFiles(path.join(root, category))
        .find(file => path.basename(file) === `${profileName}.json`);
      if (candidate) return candidate;
    }

    return undefined;
  }

  private buildFilamentIdIndex(roots = this.getAvailableProfileRoots()): Map<string, string> {
    const index = new Map<string, string>();

    for (const root of roots) {
      const filamentDir = path.join(root, 'filament');
      if (!fs.existsSync(filamentDir)) {
        continue;
      }

      for (const filePath of profileJsonFiles(filamentDir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const filamentId = typeof parsed?.filament_id === 'string' ? parsed.filament_id.trim() : '';
          if (filamentId && !index.has(filamentId)) {
            index.set(filamentId, filePath);
          }
        } catch {
          // Ignore malformed JSON.
        }
      }
    }

    return index;
  }

  private readJsonFile(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  private stripAbsoluteExtruderResets(value: unknown): unknown {
    if (typeof value === 'string') {
      return value
        .split(/\r?\n/)
        .filter((line) => line.trim().toUpperCase() !== 'G92 E0')
        .join('\n');
    }

    if (Array.isArray(value)) {
      return value.filter((line) => String(line).trim().toUpperCase() !== 'G92 E0');
    }

    return value;
  }

  private sanitizeProcessForOrca(processConfig: any, printerPreset?: string, preserveExtrusionMode = false): any {
    const sanitized = { ...processConfig };

    sanitized.type = 'process';
    if (!sanitized.from || sanitized.from === 'project') {
      sanitized.from = 'User';
    }

    if (printerPreset) {
      sanitized.compatible_printers = [printerPreset];
    }

    if (
      sanitized.prime_tower_brim_width !== undefined &&
      Number(sanitized.prime_tower_brim_width) < 0
    ) {
      sanitized.prime_tower_brim_width = '0';
    } else if (sanitized.prime_tower_brim_width !== undefined) {
      sanitized.prime_tower_brim_width = String(sanitized.prime_tower_brim_width);
    }

    return preserveExtrusionMode ? sanitized : this.useAbsoluteExtrusionForOrca(sanitized);
  }

  /** Orca slices with absolute E distances; per-layer `G92 E0` resets would break them. */
  private useAbsoluteExtrusionForOrca(config: any): any {
    const normalized = { ...config };
    normalized.use_relative_e_distances = '0';
    normalized.before_layer_change_gcode = this.stripAbsoluteExtruderResets(
      normalized.before_layer_change_gcode
    );
    normalized.layer_gcode = this.stripAbsoluteExtruderResets(normalized.layer_gcode);
    normalized.layer_change_gcode = this.stripAbsoluteExtruderResets(
      normalized.layer_change_gcode
    );

    return normalized;
  }

  private writeTempJson(outputBase: string, suffix: string, value: any): string {
    const serialized = JSON.stringify(value, null, 2);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    const outPath = path.join(this.tempDir, `${outputBase}_${suffix}_${hash}.json`);
    // A slice running now may be reading this very file (it is named by its content): write it whole elsewhere and
    // rename it into place, so a reader never sees it truncated or half-written.
    const partial = `${outPath}.${crypto.randomUUID()}.partial`;
    fs.writeFileSync(partial, serialized);
    fs.renameSync(partial, outPath);
    return outPath;
  }

  private async resolveBambuLikeSettingsBundle(
    outputBase: string,
    slicerType: 'orcaslicer' | 'orcaslicer-bambulab' | 'bambustudio',
    slicerProfile?: string,
    printerPreset?: string,
    bambuOptions?: BambuSliceOptions,
    activeProfilesRoot?: string,
    preserveOrcaExtrusionMode = false
  ): Promise<BambuSettingsBundle> {
    const roots = activeProfilesRoot
      ? [path.join(activeProfilesRoot, 'BBL')]
      : this.getAvailableProfileRoots();
    const findProfile = (kind: 'machine' | 'process' | 'filament', name?: string) =>
      this.findProfileFile(kind, name, kind === 'machine' ? roots : [...roots, ...configuredBambuProfileDirs()]);
    if (!printerPreset) {
      throw new Error('Printer preset is required for Bambu-compatible CLI slicing; select the exact bambu_model and nozzle_diameter.');
    }
    const machinePath = findProfile('machine', printerPreset);
    if (!machinePath) {
      throw new Error(`Printer profile "${printerPreset}" was not found. Set BAMBU_PROFILES_ROOT to the matching ${slicerType} profile tree; refusing to use printer defaults.`);
    }
    let machineConfig: any;
    try {
      machineConfig = this.readJsonFile(machinePath);
      if (!machineConfig || Array.isArray(machineConfig) || machineConfig.name !== printerPreset) {
        throw new Error('expected a JSON machine profile with the selected preset name');
      }
    } catch (error: any) {
      throw new Error(`Printer profile "${printerPreset}" is invalid: ${error?.message ?? error}`);
    }
    // Some FULU/Orca machine leaves inherit their default process/filaments.
    // Resolve those selections before building the positional CLI bundle.
    machineConfig = await resolveBblMachineProfile(
      activeProfilesRoot ?? path.dirname(path.dirname(path.dirname(machinePath))), printerPreset);
    const hasSlicerProfile = !!slicerProfile && fs.existsSync(slicerProfile);
    const filamentPaths: string[] = [];

    let processPath: string | undefined;
    let parsedProfile: any = null;
    let processSource: BambuSettingsBundle['processSource'];

    if (hasSlicerProfile) {
      try {
        parsedProfile = this.readJsonFile(slicerProfile!);
      } catch {
        parsedProfile = null;
      }
    }

    if (parsedProfile && typeof parsedProfile === 'object') {
      processSource = { filePath: slicerProfile!, profile: parsedProfile };
      const inheritedProcessName =
        (typeof parsedProfile.inherits === 'string' && parsedProfile.inherits) ||
        (typeof parsedProfile.print_settings_id === 'string' &&
        parsedProfile.print_settings_id !== parsedProfile.name
          ? parsedProfile.print_settings_id
          : undefined) ||
        (typeof parsedProfile.default_print_profile === 'string'
          ? parsedProfile.default_print_profile
          : undefined) ||
        (typeof machineConfig?.default_print_profile === 'string'
          ? machineConfig.default_print_profile
          : undefined);

      const inheritedProcessPath = findProfile('process', inheritedProcessName);
      const inheritedProcess =
        inheritedProcessPath && fs.existsSync(inheritedProcessPath)
          ? this.readJsonFile(inheritedProcessPath)
          : {};

      const mergedProcess = {
        ...inheritedProcess,
        ...parsedProfile,
        type: 'process',
      };

      processPath = this.writeTempJson(
        outputBase,
        slicerType === 'orcaslicer' ? 'process_orca' : 'process',
        slicerType === 'orcaslicer'
          ? this.sanitizeProcessForOrca(mergedProcess, printerPreset, preserveOrcaExtrusionMode)
          : mergedProcess
      );

      const defaultFilamentProfiles = !bambuOptions?.loadFilaments && Array.isArray(parsedProfile.default_filament_profile)
        ? parsedProfile.default_filament_profile
        : [];
      for (const profileName of defaultFilamentProfiles) {
        const filamentPath = findProfile('filament', String(profileName));
        if (filamentPath) {
          filamentPaths.push(filamentPath);
        } else {
          throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
        }
      }

      if (!bambuOptions?.loadFilaments && filamentPaths.length === 0 && Array.isArray(parsedProfile.filament_ids)) {
        const filamentIdIndex = this.buildFilamentIdIndex([...roots, ...configuredBambuProfileDirs()]);
        for (const filamentId of parsedProfile.filament_ids) {
          const filamentPath = filamentIdIndex.get(String(filamentId));
          if (filamentPath) {
            filamentPaths.push(filamentPath);
          } else {
            throw new Error(`Filament ID "${String(filamentId)}" could not be resolved; refusing to omit its slot.`);
          }
        }
      }
    } else if (hasSlicerProfile) {
      processPath = slicerProfile;
    }

    if (!processPath) {
      const defaultProcessName =
        typeof machineConfig?.default_print_profile === 'string'
          ? machineConfig.default_print_profile
          : undefined;
      const defaultProcessPath = findProfile('process', defaultProcessName);
      if (defaultProcessPath) {
        processPath =
          slicerType === 'orcaslicer'
            ? this.writeTempJson(
                outputBase,
                'process_default_orca',
                this.sanitizeProcessForOrca(this.readJsonFile(defaultProcessPath), printerPreset, preserveOrcaExtrusionMode)
              )
            : defaultProcessPath;
      }
    }

    if (
      !bambuOptions?.loadFilaments &&
      filamentPaths.length === 0 &&
      Array.isArray(machineConfig?.default_filament_profile)
    ) {
      for (const profileName of machineConfig.default_filament_profile) {
        const filamentPath = findProfile('filament', String(profileName));
        if (filamentPath) {
          filamentPaths.push(filamentPath);
        } else {
          throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
        }
      }
    }

    if (bambuOptions?.loadFilaments) {
      filamentPaths.length = 0;
      for (const filamentPath of bambuOptions.loadFilaments.split(';')) {
        const trimmed = filamentPath.trim();
        if (trimmed) {
          filamentPaths.push(trimmed);
        }
      }
    }

    const settingsParts = [machinePath, processPath].filter(
      (entry): entry is string => Boolean(entry)
    );

    return {
      settingsArg: settingsParts.length > 0 ? settingsParts.join(';') : undefined,
      filamentPaths,
      processSource,
    };
  }

  /** Resolve BBL dependencies before invoking the CLI; failures stop the slice. */
  private async maybeFlattenBundle(
    bundle: BambuSettingsBundle,
    bambuOptions?: BambuSliceOptions,
    activeProfilesRoot?: string
  ): Promise<BambuSettingsBundle> {
    const parts = bundle.settingsArg?.split(';').filter(Boolean) ?? [];
    const readProfile = (filePath: string): Record<string, unknown> => {
      try {
        const data: unknown = this.readJsonFile(filePath);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('expected a JSON profile object');
        }
        return data as Record<string, unknown>;
      } catch (err: any) {
        throw new Error(`Cannot read slicer profile "${filePath}": ${err?.message ?? err}`);
      }
    };
    const settings = parts.map(readProfile);
    // Read every slot: filtering unreadable names would change positional mapping.
    const filaments = bundle.filamentPaths.map(readProfile);
    const profilesRoot = activeProfilesRoot ?? detectProfilesRoot(process.env.SLICER_PATH);
    const profileRoots = [path.join(profilesRoot, 'BBL')];
    const hasReferences = (profile: Record<string, unknown>) =>
      (typeof profile.inherits === 'string' && profile.inherits.length > 0) ||
      (profile.include !== undefined && profile.include !== null);
    const isBundledFile = (filePath: string) =>
      profileRoots.some(root => {
        const relative = path.relative(root, filePath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
    const isBundled = (filePath: string, profile: Record<string, unknown>) =>
      String(profile.from).toLowerCase() === 'system' || isBundledFile(filePath);
    const needsResolution = (filePath: string, profile: Record<string, unknown>) =>
      hasReferences(profile) || isBundled(filePath, profile);
    if (![...settings, ...filaments].some((profile, i) =>
      needsResolution([...parts, ...bundle.filamentPaths][i], profile))) return bundle;
    if (parts.length !== 2) {
      throw new Error('Resolving BBL profiles requires both a machine and process profile; refusing to slice with unresolved settings.');
    }

    const [machinePath, processPath] = parts;
    const [machine, processProfile] = settings;
    const leafName = (filePath: string, profile: Record<string, unknown>): string => {
      // A user preset inherits its system identity, while keeping its own values.
      const name = !isBundled(filePath, profile) && typeof profile.inherits === 'string' && profile.inherits
        ? profile.inherits
        : profile.name;
      if (typeof name !== 'string' || !name) {
        if (needsResolution(filePath, profile)) throw new Error(`Cannot determine the profile name for "${filePath}".`);
        return path.basename(filePath, '.json');
      }
      return name;
    };
    const flat = await flattenForCli({
      machineLeaf: leafName(machinePath, machine),
      // A generated path loses bundled provenance; inherited metadata can also
      // make a custom preset look like a system profile. Use the original source
      // only for identity and retain the prepared values in sourceProfiles below.
      processLeaf: bundle.processSource
        ? leafName(bundle.processSource.filePath, bundle.processSource.profile)
        : leafName(processPath, processProfile),
      filamentLeaves: filaments.map((profile, i) => leafName(bundle.filamentPaths[i], profile)),
      profilesRoot,
      userProfileRoots: configuredBambuProfileDirs(),
      tempDir: this.tempDir,
      bedType: this.resolveBambuStudioBedType(bambuOptions?.bedType),
      nozzleVolumeType: bambuOptions?.nozzleVolumeType,
      filamentColours: bambuOptions?.filamentColours ?? bundle.filamentColours,
      projectTowerPosition: bundle.projectTowerPosition,
      sourceProfiles: {
        machine: isBundledFile(machinePath) ? undefined : machine,
        process: isBundledFile(processPath) ? undefined : processProfile,
        filaments: filaments.map((profile, i) => isBundledFile(bundle.filamentPaths[i]) ? undefined : profile),
      },
    });
    // Standalone files retain their own identity and settings, but still need
    // the CLI colour/tower fields. Do not discard those required overlays when
    // choosing the original profile instead of the normalized BBL output.
    const withCliFields = (filePath: string, profile: Record<string, unknown>, flatPath: string, keys: string[]): string => {
      const flattened = readProfile(flatPath);
      const fields = Object.fromEntries(keys.filter(key => flattened[key] !== undefined).map(key => [key, flattened[key]]));
      if (Object.entries(fields).every(([key, value]) => JSON.stringify(profile[key]) === JSON.stringify(value))) return filePath;
      return this.writeTempJson(path.basename(filePath, '.json'), 'cli', { ...profile, ...fields });
    };
    return {
      settingsArg: [
        needsResolution(machinePath, machine) ? flat.machinePath : machinePath,
        needsResolution(processPath, processProfile) ? flat.processPath
          : withCliFields(processPath, processProfile, flat.processPath, ['wipe_tower_x', 'wipe_tower_y']),
      ].join(';'),
      filamentPaths: filaments.map((profile, i) =>
        needsResolution(bundle.filamentPaths[i], profile) ? flat.filamentPaths[i]
          : withCliFields(bundle.filamentPaths[i], profile, flat.filamentPaths[i], ['filament_colour'])),
    };
  }

  /**
   * The CLI applies every key in every --load-settings/--load-filaments file,
   * so machine settings carried by a process or filament file (for example a
   * template 3MF's project_settings from another printer) would replace the
   * selected preset's start G-code, model, and bed geometry. The machine
   * preset owns those keys; drop them from the other profiles.
   */
  private isolateMachineSettings(bundle: BambuSettingsBundle): BambuSettingsBundle {
    const [machinePath, processPath] = bundle.settingsArg?.split(';') ?? [];
    if (!machinePath || !processPath) return bundle;
    const machineKeys = Object.keys(this.readJsonFile(machinePath)).filter(key => !PROFILE_METADATA_KEYS.has(key));
    const isolate = (filePath: string, label: string): string => {
      const profile = this.readJsonFile(filePath);
      const foreign = machineKeys.filter(key => Object.prototype.hasOwnProperty.call(profile, key));
      if (foreign.length === 0) return filePath;
      const isolated = { ...profile };
      for (const key of foreign) delete isolated[key];
      console.error(
        `Ignoring ${foreign.length} machine setting(s) in ${label} profile ${filePath} ` +
        `(the selected machine preset owns them): ${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ', ...' : ''}`
      );
      return this.writeTempJson(path.basename(filePath, '.json'), `${label}_without_machine`, isolated);
    };
    return {
      ...bundle,
      settingsArg: [machinePath, isolate(processPath, 'process')].join(';'),
      filamentPaths: bundle.filamentPaths.map(filePath => isolate(filePath, 'filament')),
    };
  }

  /** --load-filaments is positional; a single override must cover every project slot. */
  private async expandProjectFilaments(
    inputPath: string,
    bundle: BambuSettingsBundle
  ): Promise<BambuSettingsBundle> {
    if (!inputPath.toLowerCase().endsWith('.3mf') || bundle.filamentPaths.length === 0) return bundle;
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(inputPath));
    const file = zip.file('Metadata/project_settings.config');
    // Geometry-only 3MFs have no embedded filament slots.
    if (!file) return bundle;
    const config: unknown = JSON.parse(await file.async('string'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Cannot determine project filament slots: invalid project_settings.config.');
    }
    const data = config as Record<string, unknown>;
    const count = Math.max(0, ...['filament_settings_id', 'filament_type', 'filament_colour', 'filament_diameter']
      .map(key => Array.isArray(data[key]) ? data[key].length : 0));
    if (count === 0) throw new Error('Cannot determine project filament slots from project_settings.config.');
    // Keep the project's slot colours; loaded profiles carry none of their own.
    const colours = Array.isArray(data.filament_colour) && data.filament_colour.length === count &&
      data.filament_colour.every(c => typeof c === 'string' && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c))
      ? data.filament_colour as string[]
      : undefined;
    const projectTowerPosition = Object.fromEntries(['wipe_tower_x', 'wipe_tower_y']
      .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
    if (bundle.filamentPaths.length === 1) {
      return { ...bundle, filamentPaths: Array(count).fill(bundle.filamentPaths[0]), filamentColours: colours, projectTowerPosition };
    }
    if (bundle.filamentPaths.length !== count) {
      throw new Error(`Project declares ${count} filament slots, but ${bundle.filamentPaths.length} profiles were supplied. Provide one profile for all slots or one per slot.`);
    }
    return { ...bundle, filamentColours: colours, projectTowerPosition };
  }

  private resolveBambuStudioBedType(bedType?: string): string | undefined {
    if (!bedType) return undefined;
    const normalized = bedType.trim().toLowerCase();
    return BAMBU_CLI_BED_TYPES[normalized] || bedType;
  }

  /**
   * Load STL file and return geometry and bounding box
   */
  private async loadSTL(stlFilePath: string, 
                        progressCallback?: ProgressCallback): Promise<{
    geometry: THREE.BufferGeometry;
    boundingBox: THREE.Box3;
    mesh: THREE.Mesh;
  }> {
    try {
      if (progressCallback) progressCallback(10, "Loading STL file...");
      
      // Read the STL file
      const stlData = await readFileAsync(stlFilePath);
      
      if (progressCallback) progressCallback(30, "Parsing STL data...");
      
      // Load the STL data into a Three.js geometry
      const loader = new STLLoader();
      const rawArrayBuffer = stlData.buffer.slice(
        stlData.byteOffset,
        stlData.byteOffset + stlData.byteLength
      ) as ArrayBuffer;
      const geometry = loader.parse(rawArrayBuffer);
      
      // Create a mesh from the geometry
      const material = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      
      // Compute the bounding box
      geometry.computeBoundingBox();
      const boundingBox = geometry.boundingBox!;
      
      if (progressCallback) progressCallback(50, "STL loaded successfully");
      
      return { geometry, boundingBox, mesh };
    } catch (error) {
      console.error("Error loading STL file:", error);
      throw new Error(`Failed to load STL file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save a geometry to STL file
   */
  private async saveSTL(geometry: THREE.BufferGeometry, 
                       outputFilePath: string, 
                       progressCallback?: ProgressCallback): Promise<string> {
    try {
      if (progressCallback) progressCallback(80, "Exporting to STL...");
      
      // Create mesh for export
      const material = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      
      // Export the mesh as STL
      const exporter = new STLExporter();
      const stlString = exporter.parse(mesh);
      
      // Write the STL to file
      await writeFileAsync(outputFilePath, stlString);
      
      if (progressCallback) progressCallback(100, "STL saved successfully");
      
      return outputFilePath;
    } catch (error) {
      console.error("Error saving STL file:", error);
      throw new Error(`Failed to save STL file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get comprehensive information about an STL file
   */
  async getSTLInfo(stlFilePath: string): Promise<{
    filePath: string;
    fileName: string;
    fileSize: number;
    boundingBox: BoundingBox;
    vertexCount: number;
    faceCount: number;
    objects?: Array<{ name: string; vertexCount: number; faceCount: number; boundingBox: BoundingBox }>;
  }> {
    try {
      const fileStats = fs.statSync(stlFilePath);

      // Handle 3MF files: extract mesh data from embedded object models
      if (stlFilePath.toLowerCase().endsWith('.3mf')) {
        return await this.get3MFInfo(stlFilePath, fileStats.size);
      }

      const { geometry, boundingBox } = await this.loadSTL(stlFilePath);

      // Count faces (each face is a triangle in STL)
      const positionAttribute = geometry.getAttribute('position');
      const vertexCount = positionAttribute.count;
      const faceCount = vertexCount / 3;

      // Calculate center and dimensions
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);

      const dimensions = new THREE.Vector3();
      boundingBox.getSize(dimensions);

      return {
        filePath: stlFilePath,
        fileName: path.basename(stlFilePath),
        fileSize: fileStats.size,
        boundingBox: {
          min: boundingBox.min,
          max: boundingBox.max,
          center,
          dimensions
        },
        vertexCount,
        faceCount
      };
    } catch (error) {
      console.error("Error getting STL info:", error);
      throw new Error(`Failed to get STL info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Extract mesh info from a 3MF file by parsing the XML object models.
   */
  private async get3MFInfo(filePath: string, fileSize: number): Promise<{
    filePath: string;
    fileName: string;
    fileSize: number;
    boundingBox: BoundingBox;
    vertexCount: number;
    faceCount: number;
    objects: Array<{ name: string; vertexCount: number; faceCount: number; boundingBox: BoundingBox }>;
  }> {
    const JSZip = (await import('jszip')).default;
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);

    // Find all object model files
    const objectFiles = Object.keys(zip.files).filter(
      (name) => /^3D\/Objects\/.*\.model$/i.test(name)
    );

    const overallBox = new THREE.Box3(
      new THREE.Vector3(Infinity, Infinity, Infinity),
      new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    );
    let totalVerts = 0;
    let totalFaces = 0;
    const objects: Array<{ name: string; vertexCount: number; faceCount: number; boundingBox: BoundingBox }> = [];

    for (const objFile of objectFiles) {
      const content = await zip.file(objFile)!.async('string');
      // Parse vertices from XML: <vertex x="..." y="..." z="..."/>
      const vertexRegex = /<(?:\w+:)?vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
      const triangleRegex = /<(?:\w+:)?triangle\s/g;

      const objBox = new THREE.Box3(
        new THREE.Vector3(Infinity, Infinity, Infinity),
        new THREE.Vector3(-Infinity, -Infinity, -Infinity)
      );
      let vCount = 0;
      let match: RegExpExecArray | null;
      while ((match = vertexRegex.exec(content)) !== null) {
        const x = parseFloat(match[1]);
        const y = parseFloat(match[2]);
        const z = parseFloat(match[3]);
        objBox.expandByPoint(new THREE.Vector3(x, y, z));
        overallBox.expandByPoint(new THREE.Vector3(x, y, z));
        vCount++;
      }

      let fCount = 0;
      while (triangleRegex.exec(content) !== null) fCount++;

      totalVerts += vCount;
      totalFaces += fCount;

      if (vCount > 0) {
        const center = new THREE.Vector3();
        objBox.getCenter(center);
        const dims = new THREE.Vector3();
        objBox.getSize(dims);
        objects.push({
          name: path.basename(objFile),
          vertexCount: vCount,
          faceCount: fCount,
          boundingBox: { min: objBox.min, max: objBox.max, center, dimensions: dims },
        });
      }
    }

    // If no object files found, try the main 3dmodel.model
    if (objects.length === 0) {
      const mainModel = zip.file('3D/3dmodel.model');
      if (mainModel) {
        const content = await mainModel.async('string');
        const vertexRegex = /<(?:\w+:)?vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
        const triangleRegex = /<(?:\w+:)?triangle\s/g;
        let match: RegExpExecArray | null;
        while ((match = vertexRegex.exec(content)) !== null) {
          const x = parseFloat(match[1]);
          const y = parseFloat(match[2]);
          const z = parseFloat(match[3]);
          overallBox.expandByPoint(new THREE.Vector3(x, y, z));
          totalVerts++;
        }
        while (triangleRegex.exec(content) !== null) totalFaces++;
      }
    }

    if (totalVerts === 0) {
      throw new Error('No mesh data found in 3MF file. The archive may not contain any 3D objects.');
    }

    const center = new THREE.Vector3();
    overallBox.getCenter(center);
    const dimensions = new THREE.Vector3();
    overallBox.getSize(dimensions);

    return {
      filePath,
      fileName: path.basename(filePath),
      fileSize,
      boundingBox: { min: overallBox.min, max: overallBox.max, center, dimensions },
      vertexCount: totalVerts,
      faceCount: totalFaces,
      objects,
    };
  }

  /**
   * Scale an STL model uniformly or along specific axes
   */
  async scaleSTL(
    stlFilePath: string,
    scaleFactors: number | [number, number, number],
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting scaling operation...");
      
      // Load the STL file
      const { geometry, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying scaling transformation...");
      
      // Apply scaling
      let scaleX, scaleY, scaleZ;
      if (typeof scaleFactors === 'number') {
        // Uniform scaling
        scaleX = scaleY = scaleZ = scaleFactors;
      } else {
        // Non-uniform scaling
        [scaleX, scaleY, scaleZ] = scaleFactors;
      }
      
      const scaleMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
      geometry.applyMatrix4(scaleMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_scaled.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'scale',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'scale',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Apply slice_stl's scale and rotations to a copy of the mesh as OrcaSlicer's
   * CLI would, about the model's centre. Orca adds each --rotate* to the
   * object's Euler angles (ModelVolume::rotate), so the result rotates about X,
   * then Y, then Z whatever the argument order, after scaling. The slicer then
   * places the result on the plate.
   */
  private async transformMeshForCli(stlFilePath: string, options: BambuSliceOptions): Promise<string> {
    const { geometry, boundingBox } = await this.loadSTL(stlFilePath);
    const center = new THREE.Vector3();
    boundingBox.getCenter(center);
    const radians = (degrees: number) => degrees * Math.PI / 180;
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    if (options.scale !== undefined) geometry.applyMatrix4(new THREE.Matrix4().makeScale(options.scale, options.scale, options.scale));
    if (options.rotateX) geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(radians(options.rotateX)));
    if (options.rotateY) geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(radians(options.rotateY)));
    if (options.rotate) geometry.applyMatrix4(new THREE.Matrix4().makeRotationZ(radians(options.rotate)));
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
    const outputFilePath = path.join(this.tempDir, `${path.basename(stlFilePath, path.extname(stlFilePath))}_transformed_${this.generateOperationId()}.stl`);
    await this.saveSTL(geometry, outputFilePath);
    return outputFilePath;
  }

  /**
   * Rotate an STL model around specific axes
   */
  async rotateSTL(
    stlFilePath: string,
    rotationAngles: [number, number, number], // [x, y, z] in degrees
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting rotation operation...");
      
      // Load the STL file
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying rotation transformation...");
      
      // Convert degrees to radians
      const [rotX, rotY, rotZ] = rotationAngles.map(angle => angle * Math.PI / 180);
      
      // Get the center of the model
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      
      // Create translation matrices to rotate around the center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(rotX, rotY, rotZ, 'XYZ')
      );
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
      
      // Apply the transformations
      geometry.applyMatrix4(toOriginMatrix);
      geometry.applyMatrix4(rotationMatrix);
      geometry.applyMatrix4(fromOriginMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_rotated.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'rotate',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'rotate',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Translate (move) an STL model along specific axes
   */
  async translateSTL(
    stlFilePath: string,
    translationValues: [number, number, number], // [x, y, z] in mm
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting translation operation...");
      
      // Load the STL file
      const { geometry } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying translation transformation...");
      
      // Apply translation
      const [translateX, translateY, translateZ] = translationValues;
      const translationMatrix = new THREE.Matrix4().makeTranslation(translateX, translateY, translateZ);
      geometry.applyMatrix4(translationMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_translated.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'translate',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'translate',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Cancel an ongoing operation
   */
  cancelOperation(operationId: string): boolean {
    if (this.activeOperations.has(operationId)) {
      this.activeOperations.set(operationId, false);
      this.emit('operationCancelled', { operationId });
      return true;
    }
    return false;
  }

  /**
   * Generate an SVG visualization of an STL file from multiple angles
   * @param stlFilePath Path to the STL file
   * @param width Width of each view in pixels
   * @param height Height of each view in pixels
   * @param progressCallback Optional callback for progress updates
   * @returns Path to the generated SVG file
   */
  async generateVisualization(
    stlFilePath: string,
    width: number = 300,
    height: number = 300,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting visualization generation...");
      
      // Load the STL file
      const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(50, "Setting up 3D scene...");
      
      // Create a scene
      const scene = new THREE.Scene();
      scene.add(mesh);
      
      // Create a camera
      const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
      
      // Calculate the ideal camera position based on bounding box
      const size = new THREE.Vector3();
      boundingBox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = camera.fov * (Math.PI / 180);
      const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // 1.5 is a factor for some padding
      
      // Add lighting to the scene
      const ambientLight = new THREE.AmbientLight(0x404040); // soft white light
      scene.add(ambientLight);
      
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
      directionalLight.position.set(1, 1, 1).normalize();
      scene.add(directionalLight);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Generating SVG representation...");
      
      // Since we can't use the DOM-dependent SVGRenderer in a Node.js environment,
      // let's create a simple representation of the model using its bounding box
      // This is a simplified visual representation
      
      // Create SVG content with a simple representation of the STL model
      const viewBox = `0 0 ${width * 2} ${height * 2}`;
      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width * 2}" height="${height * 2}">`;
      
      // Add a title and model info
      svgContent += `
        <text x="10" y="20" font-family="Arial" font-size="16" fill="black">
          STL Visualization: ${path.basename(stlFilePath)}
        </text>
        <text x="10" y="40" font-family="Arial" font-size="12" fill="black">
          Dimensions: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} mm
        </text>
      `;
      
      // Define views
      const views = [
        { name: "front", transform: "rotateY(0deg)" },
        { name: "side", transform: "rotateY(90deg)" },
        { name: "top", transform: "rotateX(90deg)" },
        { name: "isometric", transform: "rotateX(30deg) rotateY(45deg)" }
      ];

      // Draw each view
      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        const x = (i % 2) * width + width / 2;
        const y = Math.floor(i / 2) * height + height / 2 + 50; // Add 50px for the header text
        
        // Calculate a representative size for the simple cube visualization
        const cubeSize = Math.min(width, height) * 0.4;
        
        // Draw a simple cube representation
        svgContent += `
          <g transform="translate(${x}, ${y})">
            <rect x="${-cubeSize/2}" y="${-cubeSize/2}" width="${cubeSize}" height="${cubeSize}" 
                  style="fill:#e0e0e0;stroke:#000;stroke-width:1;opacity:0.8;${view.transform}" />
            <text x="0" y="${cubeSize/2 + 30}" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
              ${view.name}
            </text>
          </g>
        `;
        
        if (progressCallback) progressCallback(60 + (i + 1) * 10, `Generated ${view.name} view`);
      }
      
      // Add STL information
      svgContent += `
        <g transform="translate(20, ${height * 2 - 60})">
          <text font-family="Arial" font-size="14" fill="black">
            File: ${path.basename(stlFilePath)}
          </text>
          <text y="20" font-family="Arial" font-size="12" fill="black">
            Vertices: ${mesh.geometry.attributes.position.count / 3}
          </text>
          <text y="40" font-family="Arial" font-size="12" fill="black">
            Dimensions: W:${size.x.toFixed(2)}mm × H:${size.y.toFixed(2)}mm × D:${size.z.toFixed(2)}mm
          </text>
        </g>
      `;
      
      // Close the SVG
      svgContent += '</svg>';

      if (progressCallback) progressCallback(90, "Visualization generated");
      
      if (progressCallback) progressCallback(90, "Saving visualization...");
      
      // Write the SVG to file
      const outputFileName = path.basename(stlFilePath, '.stl') + '_visualization.svg';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      await writeFileAsync(outputFilePath, svgContent);
      
      if (progressCallback) progressCallback(100, "Visualization saved successfully");
      
      this.emit('operationComplete', {
        operationId,
        type: 'visualization',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      console.error("Error generating visualization:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'visualization',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to generate visualization: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Apply a specific transformation to a selected section of an STL file
   * This allows for targeted modifications of specific parts of a model
   */
  async modifySection(
    stlFilePath: string,
    selection: THREE.Box3 | 'top' | 'bottom' | 'center', 
    transformation: TransformationParams,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting section modification...");
      
      // Load the STL file
      const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(40, "Identifying section to modify...");
      
      // Convert named sections to actual bounding boxes
      let selectionBox: THREE.Box3;
      if (selection === 'top') {
        // Select top third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const topThreshold = boundingBox.max.y - (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, topThreshold, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z)
        );
      } else if (selection === 'bottom') {
        // Select bottom third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const bottomThreshold = boundingBox.min.y + (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, bottomThreshold, boundingBox.max.z)
        );
      } else if (selection === 'center') {
        // Select middle third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const bottomThreshold = boundingBox.min.y + (height / 3);
        const topThreshold = boundingBox.max.y - (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, bottomThreshold, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, topThreshold, boundingBox.max.z)
        );
      } else {
        // Use the provided bounding box
        selectionBox = selection;
      }
      
      if (progressCallback) progressCallback(50, "Applying transformation to selected section...");
      
      // Get position attribute for direct manipulation
      const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
      const positions = positionAttribute.array;
      
      // Create transformation matrix based on the requested operation
      let transformMatrix = new THREE.Matrix4();
      const center = new THREE.Vector3();
      selectionBox.getCenter(center);
      
      // Matrices for transforming around the selection center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
      
      // Build the appropriate transformation matrix
      switch (transformation.type) {
        case 'scale':
          if (typeof transformation.value === 'number') {
            transformMatrix = new THREE.Matrix4().makeScale(
              transformation.value,
              transformation.value,
              transformation.value
            );
          } else {
            const [scaleX, scaleY, scaleZ] = transformation.value as number[];
            transformMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
          }
          break;
          
        case 'rotate':
          const rotValues = (typeof transformation.value === 'number') 
            ? [0, 0, transformation.value * Math.PI / 180] 
            : (transformation.value as number[]).map(v => v * Math.PI / 180);
          
          transformMatrix = new THREE.Matrix4().makeRotationFromEuler(
            new THREE.Euler(rotValues[0], rotValues[1], rotValues[2], 'XYZ')
          );
          break;
          
        case 'translate':
          if (typeof transformation.value === 'number') {
            const translateValue = transformation.value;
            transformMatrix = new THREE.Matrix4().makeTranslation(
              translateValue,
              translateValue,
              translateValue
            );
          } else {
            const [transX, transY, transZ] = transformation.value as number[];
            transformMatrix = new THREE.Matrix4().makeTranslation(transX, transY, transZ);
          }
          break;
          
        default:
          throw new Error(`Unsupported transformation type: ${transformation.type}`);
      }
      
      // Build complete transformation (to origin, transform, back from origin)
      const finalTransform = new THREE.Matrix4()
        .multiply(fromOriginMatrix)
        .multiply(transformMatrix)
        .multiply(toOriginMatrix);
      
      // Create temporary vector for calculations
      const tempVector = new THREE.Vector3();
      
      try {
        // Apply transformation only to vertices within the selection box
        for (let i = 0; i < positionAttribute.count; i++) {
          tempVector.fromBufferAttribute(positionAttribute, i);
          
          // Check if this vertex is within our selection box
          if (selectionBox.containsPoint(tempVector)) {
            // Apply the transformation to this vertex
            tempVector.applyMatrix4(finalTransform);
            
            // Update the position in the buffer
            positionAttribute.setXYZ(i, tempVector.x, tempVector.y, tempVector.z);
          }
        }
        
        // Mark the attribute as needing an update
        positionAttribute.needsUpdate = true;
        
        // Update the geometry's bounding box
        geometry.computeBoundingBox();
      } catch (error) {
        console.error("Error modifying vertices:", error);
        throw new Error(`Failed to modify section: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_modified.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'modifySection',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'modifySection',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Enhanced version of extendBase with progress reporting
   * @param stlFilePath Path to the input STL file
   * @param extensionInches Amount to extend base in inches
   * @param progressCallback Optional callback for progress updates
   * @returns Path to the modified STL file
   */
  async extendBase(
    stlFilePath: string, 
    extensionInches: number,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting base extension operation...");
      console.error(`Extending base of ${stlFilePath} by ${extensionInches} inches`);
      
      // Load the STL file
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Creating extended base geometry...");
      
      // Find the minimum Y value (assuming Y is up, which is common in 3D printing)
      const minY = boundingBox.min.y;
      
      // Convert inches to millimeters (STL files typically use mm)
      const extensionMm = extensionInches * 25.4;
      
      // Create a transformation matrix to move the mesh up by the extension amount
      const matrix = new THREE.Matrix4().makeTranslation(0, extensionMm, 0);
      geometry.applyMatrix4(matrix);
      
      // Create a box geometry for the base extension
      const baseWidth = boundingBox.max.x - boundingBox.min.x;
      const baseDepth = boundingBox.max.z - boundingBox.min.z;
      const baseGeometry = new THREE.BoxGeometry(
        baseWidth,
        extensionMm,
        baseDepth
      );
      
      // Position the base geometry
      const baseMatrix = new THREE.Matrix4().makeTranslation(
        (boundingBox.min.x + boundingBox.max.x) / 2,
        minY + extensionMm / 2,
        (boundingBox.min.z + boundingBox.max.z) / 2
      );
      baseGeometry.applyMatrix4(baseMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(70, "Merging geometries...");
      
      if (progressCallback) progressCallback(75, "Creating merged geometry...");
      
      // Create material for both meshes
      const material = new THREE.MeshStandardMaterial();
      
      // Create individual meshes
      const originalMesh = new THREE.Mesh(geometry, material);
      const baseMesh = new THREE.Mesh(baseGeometry, material);
      
      // Export each mesh separately and merge the STL strings
      const exporter = new STLExporter();
      
      const originalStl = exporter.parse(originalMesh);
      const baseStl = exporter.parse(baseMesh);
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_extended.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);
      
      if (progressCallback) progressCallback(90, "Saving extended STL...");
      
      // Write the combined STL data to file
      await writeFileAsync(outputFilePath, originalStl + baseStl);
      
      if (progressCallback) progressCallback(100, "STL saved successfully");
      
      this.emit('operationComplete', {
        operationId,
        type: 'extendBase',
        success: true,
        output: outputFilePath
      });
      
      console.error(`Modified STL saved to ${outputFilePath}`);
      return outputFilePath;
    } catch (error) {
      console.error("Error extending STL base:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'extendBase',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to extend STL base: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Slice an STL or 3MF file using the specified slicer
   * @param stlFilePath Path to the input STL or 3MF file
   * @param slicerType Type of slicer (prusaslicer, cura, slic3r, orcaslicer, bambustudio)
   * @param slicerPath Path to the slicer executable
   * @param slicerProfile Optional path to the slicer profile/config file
   * @param progressCallback Optional callback for progress updates
   * @param printerPreset Optional BambuStudio printer preset name (e.g., "Bambu Lab P1S 0.4 nozzle")
   * @param bambuOptions Optional BambuStudio-specific CLI flags
   * @returns Path to the generated G-code or sliced 3MF file
   */
  async sliceSTL(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    bambuOptions?: BambuSliceOptions
  ): Promise<string> {
    return (await this.sliceSTLWithResult(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback, printerPreset, bambuOptions)).path;
  }

  /**
   * sliceSTL with the Bambu-compatible CLI's own result.json, parsed verbatim.
   * A failure throws SlicerRunError, whose message starts with the slicer's
   * error_string and plate warnings.
   */
  async sliceSTLWithResult(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    bambuOptions?: BambuSliceOptions
  ): Promise<SliceOutput> {
    const once = (options?: BambuSliceOptions) =>
      this.sliceSTLOnce(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback, printerPreset, options);
    const layers = bambuOptions?.pauseAtLayers?.length ? bambuOptions.pauseAtLayers : undefined;
    const cli = slicerType === 'bambustudio' || slicerType === 'orcaslicer' || slicerType === 'orcaslicer-bambulab';
    // Without new pauses the CLI keeps the project's own pauses and colour changes itself: it loads a
    // Bambu 3MF's Metadata/custom_gcode_per_layer.xml with the project (Bambu Studio 02.08.02.61
    // BambuStudio.cpp:1882, bbs_3mf.cpp:2051), so nothing is passed.
    if (!layers) return once(bambuOptions);
    if (!cli) {
      throw new Error(`Pausing at a layer needs the Bambu Studio or OrcaSlicer CLI, not ${slicerType}.`);
    }
    const chosenPlate = bambuOptions?.slicePlate && bambuOptions.slicePlate > 0 ? bambuOptions.slicePlate : undefined;
    const plate = chosenPlate ?? 1;
    const threeMf = /\.3mf$/i.test(stlFilePath);
    // --load-custom-gcodes replaces the whole per-plate map and holds one plate (--slice N, or plate 1 for
    // --slice 0: BambuStudio.cpp:2224-2233, 4005-4008), so slicing every plate would drop plates 2..n's own.
    if (threeMf && chosenPlate === undefined && (await listModelPlates(stlFilePath)).plate_count > 1) {
      throw new Error('Pausing at a layer works on one plate at a time. Choose the plate with slice_plate.');
    }
    // The map replaces the project's own entries for this plate, so they are merged in.
    const project = threeMf ? await readProjectCustomGcodes(stlFilePath, plate) : undefined;
    const customGcodesFile = path.join(this.tempDir, `custom-gcodes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      // A pause sits at its layer's exact top Z; learn the tops from a slice without pauses.
      if (progressCallback) progressCallback(10, `Finding layer heights for the pause before layer ${layers.join(", ")}`);
      const plain = await once({ ...bambuOptions, pauseAtLayers: undefined, customGcodesFile: undefined });
      const plainGcode = await readPlateGcode(plain.path, plate);
      if (!plainGcode) throw new Error('The slicer wrote no plate G-code, so the pause layers cannot be placed.');
      const tops = layerTops(plainGcode);
      await fs.promises.writeFile(customGcodesFile, JSON.stringify(customGcodesWithPauses(tops, layers, project)));
      const result = await once({ ...bambuOptions, customGcodesFile });
      const gcode = await readPlateGcode(result.path, plate);
      const placed = gcode ? pausedLayers(gcode, machinePauseGcode(gcode)) : [];
      const missing = layers.filter(layer => !placed.includes(layer));
      if (!gcode || missing.length || layerTops(gcode).length !== tops.length) {
        throw new Error(`The slicer did not place the pause before layer ${(missing.length ? missing : layers).join(", ")}. Nothing was sent to the printer.`);
      }
      return result;
    } finally {
      await fs.promises.rm(customGcodesFile, { force: true });
    }
  }

  private async sliceSTLOnce(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    bambuOptions?: BambuSliceOptions
  ): Promise<SliceOutput> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    // A cancelled request stops its slice: the slicer is killed (below) instead of finishing a slice nobody reads.
    const signal = bambuOptions?.signal;
    const cancel = () => { if (this.activeOperations.has(operationId)) this.activeOperations.set(operationId, false); };
    if (signal?.aborted) {
      this.activeOperations.delete(operationId);
      throw new Error("Slicing operation cancelled");
    }

    if (slicerType !== 'orca-slicer-api' && isPathLikeExecutable(slicerPath) && !fs.existsSync(slicerPath)) {
      throw new Error(`Slicer executable not found at: ${slicerPath}`);
    }
    if (slicerProfile && !fs.existsSync(slicerProfile)) {
        console.warn(`Slicer profile specified but not found: ${slicerProfile}. Slicer might use defaults.`);
        // Allow proceeding without profile, slicer might handle it
    }

    const outputFileName = path.basename(stlFilePath, '.stl') + '.gcode';
    let outputFilePath = path.join(this.tempDir, outputFileName);

    if (bambuOptions?.processOverrides && !['bambustudio', 'orcaslicer', 'orcaslicer-bambulab', 'orca-slicer-api'].includes(slicerType)) {
      throw new Error(`layer_height, wall_loops and sparse_infill_density need a Bambu-compatible slicer (bambustudio, orcaslicer, orcaslicer-bambulab or orca-slicer-api), not ${slicerType}.`);
    }

    let args: string[] = [];
    let cliResult: CliResultSource | undefined;
    const orcaTemporaryDirectories: string[] = [];
    const temporaryFiles: string[] = [];
    // This slice's own folder (local Bambu-compatible CLI): removed if the slice fails or is cancelled.
    let sliceDir: string | undefined;

    try {
      signal?.addEventListener('abort', cancel, { once: true });
      if (progressCallback) progressCallback(0, `Starting slicing with ${slicerType}...`);

      switch (slicerType) {
        case 'prusaslicer':
        case 'slic3r': // PrusaSlicer and Slic3r share similar CLI args
          args = [
            '--slice',
            '--output', outputFilePath,
            '--load', slicerProfile || '', // Pass profile path
            stlFilePath
          ];
          // Remove empty profile arg if not provided
          args = args.filter(arg => arg !== ''); 
          break;

        case 'cura':
          // CuraEngine CLI args are different, often requiring -s for settings
          // Example: curaengine slice -v -j cura_settings.json -s layer_height=0.2 -o output.gcode -l input.stl
          // This requires parsing the profile or passing individual settings.
          // Keeping it simple for now, assuming profile contains necessary info.
          args = [
            'slice', 
            '-l', stlFilePath,
            '-o', outputFilePath
          ];
          if (slicerProfile) {
            args.push('-j', slicerProfile); // Load settings from profile definition file
          }
          break;

        case 'bambustudio':
        case 'orcaslicer':
        case 'orcaslicer-bambulab':
        case 'orca-slicer-api':
          // Bambu-compatible CLI: slice and export as 3MF with embedded gcode.
          // FULU's OrcaSlicer-bambulab fork keeps this Bambu-style path.
          // For 3MF input: slice in place and export sliced 3MF
          // For STL input: slice and export as 3MF
          {
            const is3mf = stlFilePath.toLowerCase().endsWith('.3mf');
            const outputBase = path.basename(stlFilePath, is3mf ? '.3mf' : '.stl');
            const remote = slicerType === 'orca-slicer-api';
            if (remote) {
              validateRemoteSliceOptions(bambuOptions);
              if (!process.env.BAMBU_PROFILES_ROOT) throw new Error('Remote slicing requires BAMBU_PROFILES_ROOT pointing to the matching Orca profile tree (a read-only mount is sufficient).');
              if (slicerProfile && !fs.existsSync(slicerProfile)) throw new Error('Remote slicing process profile does not exist.');
            }
            const profileSlicerType = remote ? 'orcaslicer' : slicerType;
            // Every local slice writes into a folder of its own, so two slices at once, even of same-named inputs, never
            // read, replace or delete each other's files. Bambu Studio's CLI (v02.08.02.61) writes fixed names into
            // --outputdir: result.json, each plate's G-code as plate_<n>.gcode (and its .tmp) before packing it into
            // the 3MF, and the exported 3MF's .tmp; its own scratch files under the system temp dir are per process.
            const bambuOutputPath = remote
              ? path.join(this.tempDir, `${outputBase}_${operationId}_sliced.3mf`)
              : path.join(sliceDir = await this.newSliceFolder(operationId), `${outputBase}_sliced.3mf`);
            const outputDir = path.dirname(bambuOutputPath);
            const selectedProfilesRoot = detectProfilesRoot(remote ? undefined : slicerPath, profileSlicerType);
            const profilesRoot = !remote && profileSlicerType === 'orcaslicer'
              ? await materializeOrcaProfilesRoot(selectedProfilesRoot, this.tempDir)
              : selectedProfilesRoot;
            if (profilesRoot !== selectedProfilesRoot) orcaTemporaryDirectories.push(profilesRoot);
            const rawBundle = await this.resolveBambuLikeSettingsBundle(
              outputBase,
              profileSlicerType,
              slicerProfile,
              printerPreset,
              bambuOptions,
              profilesRoot,
              profileSlicerType === 'orcaslicer' && profilesRoot !== selectedProfilesRoot
            );
            // Resolve every BBL dependency before launching the slicer.
            const settingsBundle = await this.maybeFlattenBundle(
              await this.expandProjectFilaments(stlFilePath, rawBundle), bambuOptions, profilesRoot);
            // The machine preset assumes the stock hotend; record the installed one so
            // the sliced job's nozzle_type matches what the printer reports.
            if (bambuOptions?.nozzleType && settingsBundle.settingsArg) {
              const [machinePath, ...rest] = settingsBundle.settingsArg.split(';');
              const machine = this.readJsonFile(machinePath);
              const current = machine.nozzle_type;
              machine.nozzle_type = Array.isArray(current) && current.length > 0
                ? current.map(() => bambuOptions.nozzleType)
                : [bambuOptions.nozzleType];
              settingsBundle.settingsArg = [
                this.writeTempJson(outputBase, `machine_${bambuOptions.nozzleType}`, machine), ...rest,
              ].join(';');
            }
            // Inherited process G-code is now present; apply Orca's existing
            // absolute-extrusion normalization after resolving those ancestors.
            // The machine owns the extrusion mode and layer G-code once process
            // files lose machine keys, so normalize it there as well.
            if (profileSlicerType === 'orcaslicer' && settingsBundle.settingsArg && profilesRoot === selectedProfilesRoot) {
              const [machinePath, processPath] = settingsBundle.settingsArg.split(';');
              settingsBundle.settingsArg = [
                this.writeTempJson(outputBase, 'machine_orca_resolved',
                  this.useAbsoluteExtrusionForOrca(this.readJsonFile(machinePath))),
                this.writeTempJson(outputBase, 'process_orca_resolved',
                  this.sanitizeProcessForOrca(this.readJsonFile(processPath), printerPreset)),
              ].join(';');
            }
            // Print-sheet quality settings go over the fully resolved process
            // preset, after flattening and Orca normalization, so every
            // Bambu-compatible route (local CLI, Orca cache staging, remote API)
            // slices with them and the machine preset is untouched.
            if (bambuOptions?.processOverrides) {
              const [machinePath, processPath, ...rest] = settingsBundle.settingsArg?.split(';') ?? [];
              if (!machinePath || !processPath) {
                throw new Error('layer_height, wall_loops and sparse_infill_density need a resolved machine and process preset.');
              }
              settingsBundle.settingsArg = [
                machinePath,
                this.writeTempJson(outputBase, 'process_override',
                  applyProcessOverrides(this.readJsonFile(processPath), bambuOptions.processOverrides)),
                ...rest,
              ].join(';');
            }
            let cliBundle = this.isolateMachineSettings(settingsBundle);
            let orcaExtraArgs: string[] = [];
            if (!remote && profileSlicerType === 'orcaslicer' && profilesRoot !== selectedProfilesRoot) {
              const staged = await stageOrcaCliProfiles(profilesRoot, this.tempDir, cliBundle);
              cliBundle = { ...cliBundle, settingsArg: staged.settingsArg, filamentPaths: staged.filamentPaths };
              orcaExtraArgs = staged.extraArgs;
              orcaTemporaryDirectories.push(staged.dataDir);
            }
            if (remote) {
              const [machinePath, processPath] = cliBundle.settingsArg?.split(';') ?? [];
              if (!machinePath || !processPath) throw new Error('Remote slicing requires complete prepared machine and process profiles.');
              outputFilePath = await sliceWithOrcaApi({
                inputPath: stlFilePath, machinePath, processPath,
                filamentPaths: cliBundle.filamentPaths, outputPath: bambuOutputPath,
                options: bambuOptions, isCancelled: () => !this.activeOperations.get(operationId),
              });
              break;
            }
            // OrcaSlicer's CLI crashes (SIGSEGV in PartPlate::check_outside,
            // which needs the GUI's Plater) when --scale or --rotate-x/-y move an
            // object below the bed and it arranges, the default for STL; it also
            // rejects --repetitions for one STL. Apply STL transforms to the mesh
            // in the CLI's order instead, and refuse the 3MF case it cannot fix.
            const orcaCli = slicerType === 'orcaslicer' || slicerType === 'orcaslicer-bambulab';
            const tilts = !!bambuOptions?.rotateX || !!bambuOptions?.rotateY;
            const meshTransform = orcaCli && !is3mf && (bambuOptions?.scale !== undefined || tilts);
            if (orcaCli && is3mf && bambuOptions?.arrange === true && ((bambuOptions.scale ?? 1) > 1 || tilts)) {
              throw new Error(
                "OrcaSlicer's CLI crashes when scale above 1, rotate_x or rotate_y moves a 3MF object below the bed while arranging. " +
                "Set arrange to false, or apply the transform in the slicer and export the project."
              );
            }
            if (!is3mf && bambuOptions?.repetitions !== undefined && bambuOptions.cloneObjects) {
              throw new Error("Use either repetitions or clone_objects for an STL, not both.");
            }
            const inputPath = meshTransform ? await this.transformMeshForCli(stlFilePath, bambuOptions!) : stlFilePath;
            if (inputPath !== stlFilePath) temporaryFiles.push(inputPath);
            cliResult = { resultPath: path.join(outputDir, 'result.json'), startedAt: Date.now() };
            // A result.json left by an earlier run must not explain this one.
            await fs.promises.rm(cliResult.resultPath, { force: true });
            // BambuStudio fails exports to a relative --outputdir; give the CLI an
            // absolute path for every file it reads, whichever setting supplied it.
            const absoluteCliPathList = (paths: string[]) => paths.map((entry) => entry && path.resolve(entry)).join(';');
            args = [
              ...orcaExtraArgs,
              '--slice', String(bambuOptions?.slicePlate ?? 0),
              '--outputdir', outputDir,
              '--export-3mf', path.basename(bambuOutputPath),
            ];
            if (cliBundle.settingsArg) {
              args.push('--load-settings', absoluteCliPathList(cliBundle.settingsArg.split(';')));
            }
            // Always allow newer-version 3MF files (the CLI rejects them by default)
            args.push('--allow-newer-file');

            // BambuSliceOptions flags
            if (bambuOptions?.uptodate) args.push('--uptodate');
            if (bambuOptions?.ensureOnBed) args.push('--ensure-on-bed');
            if (bambuOptions?.enableTimelapse) args.push('--enable-timelapse');
            if (bambuOptions?.allowMixTemp) args.push('--allow-mix-temp');
            if (bambuOptions?.minSave) args.push('--min-save');
            if (bambuOptions?.skipModifiedGcodes) args.push('--skip-modified-gcodes');
            if (bambuOptions?.orient !== undefined) args.push('--orient', bambuOptions.orient ? '1' : '0');
            if (bambuOptions?.arrange !== undefined) args.push('--arrange', bambuOptions.arrange ? '1' : '0');
            if (bambuOptions?.repetitions !== undefined) {
              // Both Bambu Studio and Orca count STL copies with --clone-objects.
              // --repetitions > 1 requires a selected existing plate and rejects --slice 0.
              if (!is3mf) args.push('--clone-objects', String(bambuOptions.repetitions));
              else args.push('--repetitions', String(bambuOptions.repetitions));
            }
            if (!meshTransform) {
              if (bambuOptions?.scale !== undefined) args.push('--scale', String(bambuOptions.scale));
              if (bambuOptions?.rotate !== undefined) args.push('--rotate', String(bambuOptions.rotate));
              if (bambuOptions?.rotateX !== undefined) args.push('--rotate-x', String(bambuOptions.rotateX));
              if (bambuOptions?.rotateY !== undefined) args.push('--rotate-y', String(bambuOptions.rotateY));
            }
            if (bambuOptions?.cloneObjects) args.push('--clone-objects', bambuOptions.cloneObjects);
            if (bambuOptions?.skipObjects) args.push('--skip-objects', bambuOptions.skipObjects);
            if (cliBundle.filamentPaths.length > 0) {
              args.push('--load-filaments', absoluteCliPathList(cliBundle.filamentPaths));
              args.push('--load-defaultfila');
            }
            if (bambuOptions?.loadFilamentIds) args.push('--load-filament-ids', bambuOptions.loadFilamentIds);
            if (bambuOptions?.customGcodesFile) args.push('--load-custom-gcodes', path.resolve(bambuOptions.customGcodesFile));

            args.push(path.resolve(inputPath));
            // Override outputFilePath for bambustudio since it produces 3MF, not gcode
            outputFilePath = bambuOutputPath;
          }
          break;

        default:
          throw new Error(`Unsupported slicer type: ${slicerType}`);
      }

      // The Bambu-compatible CLI's slice, kept for reuse: the same model sliced the same way again is restored,
      // and every check below still runs on it (slice-cache.ts).
      const cacheRun = cliResult && slicerType !== 'orca-slicer-api'
        ? { command: slicerPath, args, outputs: [outputFilePath, cliResult.resultPath], locations: [path.dirname(cliResult.resultPath)] } : undefined;
      const cacheKey = cacheRun ? await sliceCacheKey(cacheRun) : undefined;
      const restored = !!cacheKey && await restoreSlice(cacheKey, cacheRun!);
      if (restored) {
        if (progressCallback) progressCallback(90, 'Reusing the same slice of this model');
        console.error(`Reusing slice ${cacheKey} for: ${slicerPath} ${args.join(' ')}`);
      }
      if (slicerType !== 'orca-slicer-api' && !restored) {
        if (progressCallback) progressCallback(20, `Executing slicer: ${slicerPath} ${args.join(' ')}`);
        console.error(`Executing: ${slicerPath} ${args.join(' ')}`);

        // Execute the slicer
        await new Promise<void>((resolve, reject) => {
          const process = execFile(slicerPath, args, (error, stdout, stderr) => {
            if (error) {
              console.error(`Slicer Error: ${error.message}`);
              console.error(`Slicer Stderr: ${stderr}`);
              const slicerResult = cliResult ? readCliResult(cliResult) : undefined;
              reject(new SlicerRunError(describeSlicerFailure(error, stdout, stderr, cliResult), slicerResult));
            } else {
              console.error(`Slicer Stdout: ${stdout}`);
               if (stderr) {
                   console.warn(`Slicer Stderr: ${stderr}`); // Log stderr even on success
               }
              resolve();
            }
          });

          // Optional: Add listeners for stdout/stderr for real-time progress if slicer provides it
          // process.stdout?.on('data', (data) => { console.error(`Slicer stdout: ${data}`); });
          // process.stderr?.on('data', (data) => { console.error(`Slicer stderr: ${data}`); });
        
          // Check for cancellation periodically
          const checkCancel = setInterval(() => {
             if (!this.activeOperations.get(operationId)) {
                 clearInterval(checkCancel);
                 try {
                     process.kill(); // Attempt to kill the slicer process
                     reject(new Error("Slicing operation cancelled"));
                 } catch (killError) {
                     console.error("Error attempting to kill slicer process:", killError);
                     reject(new Error("Slicing operation cancelled, but failed to kill process."));
                 }
             }
         }, 500);

         process.on('exit', () => clearInterval(checkCancel));
         process.on('error', () => clearInterval(checkCancel)); // Ensure interval cleared on process error too

        });
      }

      if (!this.activeOperations.get(operationId)) {
        // This check might be redundant if the promise rejected on kill, but good safety
        throw new Error("Slicing operation cancelled after process finished");
      }
      
      const slicerResult = cliResult ? readCliResult(cliResult) : undefined;
      if (cliResult && !slicerResult) {
        // Older or Linux CLIs may write result.json only for handled errors.
        console.error(`${slicerType} wrote no result.json for this slice, so its own checks are not available.`);
      }
      if (typeof slicerResult?.return_code === "number" && slicerResult.return_code !== 0) {
        throw new SlicerRunError(`Slicer failed: the slicer exited with code 0, but its result.json reports return_code ${slicerResult.return_code}.`, slicerResult);
      }
      if (cacheKey && !restored && fs.existsSync(outputFilePath)) await keepSlice(cacheKey, cacheRun!);

      if (!fs.existsSync(outputFilePath)) {
          throw new SlicerRunError(`Slicer finished but output file not found: ${outputFilePath}`, slicerResult);
      }

      if (progressCallback) progressCallback(100, "Slicing completed successfully");
      
      this.emit('operationComplete', {
        operationId,
        type: 'slice',
        success: true,
        output: outputFilePath
      });

      return slicerResult ? { path: outputFilePath, slicer_result: slicerResult } : { path: outputFilePath };
    } catch (error) {
      console.error(`Slicing failed for ${stlFilePath}:`, error);
      // Nothing in a failed or cancelled slice's folder is handed back (its result.json is already in the error).
      if (sliceDir) await fs.promises.rm(sliceDir, { recursive: true, force: true }).catch(() => undefined);
      this.emit('operationError', {
        operationId,
        type: 'slice',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error; 
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.activeOperations.delete(operationId);
      for (const file of temporaryFiles) {
        await fs.promises.rm(file, { force: true }).catch(error => console.error('Could not remove a temporary mesh:', error));
      }
      for (const directory of orcaTemporaryDirectories.reverse()) {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(error => {
          console.error('Could not remove temporary Orca profiles:', error);
        });
      }
    }
  }

  /**
   * Enhanced version of confirmTemperatures with better error handling
   * @param gcodePath Path to the G-code file
   * @param expected Expected temperature settings
   * @param progressCallback Optional callback for progress updates
   * @returns Object with comparison results
   */
  async confirmTemperatures(
    gcodePath: string,
    expected: { 
      extruder?: number; 
      bed?: number; 
    },
    progressCallback?: ProgressCallback
  ): Promise<{
    match: boolean;
    actual: { extruder?: number; bed?: number };
    expected: { extruder?: number; bed?: number };
    allTemperatures: { extruder: number[]; bed: number[] };
  }> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting temperature verification...");
      
      // Verify the G-code file exists
      if (!fs.existsSync(gcodePath)) {
        throw new Error(`G-code file not found: ${gcodePath}`);
      }
      
      if (progressCallback) progressCallback(20, "Reading G-code file...");
      
      // Read the G-code file
      const gcode = await readFileAsync(gcodePath, 'utf8');
      const lines = gcode.split('\n');
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(50, "Analyzing temperature commands...");
      
      // Extract temperature settings from G-code
      const actual: { extruder?: number; bed?: number } = {};
      const allTemperatures: { extruder: number[]; bed: number[] } = { extruder: [], bed: [] };
      
      for (const line of lines) {
        // Look for extruder temperature (M104 or M109)
        const extruderMatch = line.match(/M10[49] S(\d+)/);
        if (extruderMatch) {
          const temp = parseInt(extruderMatch[1], 10);
          allTemperatures.extruder.push(temp);
          
          // Keep the first temperature for compatibility with original function
          if (!actual.extruder) {
            actual.extruder = temp;
          }
        }
        
        // Look for bed temperature (M140 or M190)
        const bedMatch = line.match(/M1[49]0 S(\d+)/);
        if (bedMatch) {
          const temp = parseInt(bedMatch[1], 10);
          allTemperatures.bed.push(temp);
          
          // Keep the first temperature for compatibility with original function
          if (!actual.bed) {
            actual.bed = temp;
          }
        }
      }
      
      if (progressCallback) progressCallback(80, "Comparing temperatures...");
      
      // Compare actual with expected
      let match = true;
      if (expected.extruder !== undefined && actual.extruder !== expected.extruder) {
        match = false;
      }
      if (expected.bed !== undefined && actual.bed !== expected.bed) {
        match = false;
      }
      
      if (progressCallback) progressCallback(100, "Temperature verification complete");
      
      this.emit('operationComplete', {
        operationId,
        type: 'confirmTemperatures',
        success: true,
        result: { match, actual, expected, allTemperatures }
      });
      
      return { match, actual, expected, allTemperatures };
    } catch (error) {
      console.error("Error confirming temperatures:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'confirmTemperatures',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to confirm temperatures: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Merge vertices within a specified tolerance.
   */
  async mergeVertices(
    stlFilePath: string,
    tolerance: number = 0.01, // Default tolerance in mm
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting vertex merging...");
      
      const { geometry } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(60, "Merging vertices...");

      const originalVertexCount = geometry.attributes.position.count;
      const mergedGeometry = BufferGeometryUtils.mergeVertices(geometry, tolerance);
      const newVertexCount = mergedGeometry.attributes.position.count;

      console.error(`Merged vertices: ${originalVertexCount} -> ${newVertexCount} (Tolerance: ${tolerance}mm)`);
      if (progressCallback) progressCallback(70, `Vertices merged: ${originalVertexCount} -> ${newVertexCount}`);

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_merged.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);

      await this.saveSTL(mergedGeometry, outputFilePath, progressCallback); // 80-100% progress

      this.emit('operationComplete', { operationId, type: 'mergeVertices', success: true, output: outputFilePath, verticesRemoved: originalVertexCount - newVertexCount });
      return outputFilePath;

    } catch (error) {
      this.emit('operationError', { operationId, type: 'mergeVertices', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Center the model at the origin (0,0,0).
   */
  async centerModel(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting centering operation...");
      
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(60, "Calculating center...");

      const center = new THREE.Vector3();
      boundingBox.getCenter(center);

      if (center.lengthSq() < 0.0001) { // Already centered (or very close)
          if (progressCallback) progressCallback(100, "Model is already centered.");
          console.error("Model already centered. No changes made.");
          this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: stlFilePath, message: "Model already centered." });
          return stlFilePath; // Return original path
      }

      if (progressCallback) progressCallback(70, `Applying translation: (${-center.x.toFixed(2)}, ${-center.y.toFixed(2)}, ${-center.z.toFixed(2)})`);

      const translationMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      geometry.applyMatrix4(translationMatrix);
      geometry.computeBoundingBox(); // Recompute bounds after moving

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_centered.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);

      await this.saveSTL(geometry, outputFilePath, progressCallback); // 80-100% progress

      this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: outputFilePath });
      return outputFilePath;

    } catch (error) {
      this.emit('operationError', { operationId, type: 'centerModel', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Rotate the model so a face rests on the bed, in the pose with the least
   * part and support material per mm² of bed contact, then move it down to
   * Z=0. Returns the new file's path, or the input path when no pose qualifies.
   */
  async layFlat(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    return (await this.layFlatWithResult(stlFilePath, progressCallback)).path;
  }

  /**
   * layFlat with its outcome. A pose qualifies only when some face, turned to
   * face down, lies on the rotated mesh's lowest plane; `laid_flat` is false
   * and the model is unchanged when none does.
   */
  async layFlatWithResult(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<LayFlatResult> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting lay flat operation...");

      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50%

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(55, "Analyzing faces...");

      const positionAttribute = geometry.getAttribute('position');
      if (!positionAttribute) throw new Error("Geometry has no position attribute.");

      const faceCount = Math.floor(positionAttribute.count / 3);
      if (faceCount === 0) throw new Error("No faces found in geometry.");
      const mesh: LayFlatMesh = {
        positions: new Float64Array(faceCount * 9),
        normals: new Float64Array(faceCount * 3),
        areas: new Float64Array(faceCount),
        volume: 0,
      };
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const cb = new THREE.Vector3(), ab = new THREE.Vector3();
      const fromA = new THREE.Vector3(), fromB = new THREE.Vector3(), fromC = new THREE.Vector3();

      for (let face = 0; face < faceCount; face++) {
          vA.fromBufferAttribute(positionAttribute, face * 3);
          vB.fromBufferAttribute(positionAttribute, face * 3 + 1);
          vC.fromBufferAttribute(positionAttribute, face * 3 + 2);
          vA.toArray(mesh.positions, face * 9);
          vB.toArray(mesh.positions, face * 9 + 3);
          vC.toArray(mesh.positions, face * 9 + 6);
          // Signed tetrahedron volumes about the center sum to the enclosed volume.
          fromA.subVectors(vA, center);
          fromB.subVectors(vB, center);
          fromC.subVectors(vC, center);
          mesh.volume += fromA.dot(fromB.cross(fromC)) / 6;

          // The cross product's direction is the outward normal; half its length is the area.
          cb.subVectors(vC, vB);
          ab.subVectors(vA, vB);
          cb.cross(ab);
          mesh.areas[face] = cb.length() / 2;
          cb.normalize().toArray(mesh.normals, face * 3);
      }

      mesh.volume = Math.abs(mesh.volume);

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(65, "Grouping faces by normal...");

      // Group faces by similar normal vectors (tolerance for floating point errors)
      const normalGroups: { totalArea: number; representativeNormal: THREE.Vector3 }[] = [];
      const tolerance = 1e-5;
      const faceNormal = new THREE.Vector3();

      for (let face = 0; face < faceCount; face++) {
          if (!(mesh.areas[face] > 0)) continue;
          faceNormal.fromArray(mesh.normals, face * 3);
          const group = normalGroups.find(candidate => faceNormal.distanceToSquared(candidate.representativeNormal) < tolerance);
          if (group) group.totalArea += mesh.areas[face];
          else normalGroups.push({ totalArea: mesh.areas[face], representativeNormal: faceNormal.clone() });
      }

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(75, "Finding the pose that rests on the bed...");

      // Candidate directions to turn down: the largest face groups, plus the
      // model's own axes so a part with a domed side can be flipped exactly.
      const candidates = normalGroups
        .sort((a, b) => b.totalArea - a.totalArea)
        .slice(0, LAY_FLAT_MAX_GROUP_CANDIDATES)
        .map(group => group.representativeNormal);
      for (const axis of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
          const normal = new THREE.Vector3(axis[0], axis[1], axis[2]);
          if (!candidates.some(candidate => candidate.distanceToSquared(normal) < tolerance)) candidates.push(normal);
      }

      let best: LayFlatPose | null = null;
      for (const normal of candidates) {
          const pose = evaluateLayFlatPose(mesh, normal);
          if (pose && (!best || isBetterLayFlatPose(pose, best))) best = pose;
      }

      if (!best) {
          const message = "No face lies on the model's lowest plane in any candidate orientation, so the model is unchanged.";
          console.error(`lay_flat: ${message}`);
          this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: stlFilePath, message });
          return { path: stlFilePath, laid_flat: false, message };
      }

      if (progressCallback) progressCallback(80, "Calculating rotation...");

      // Turn the chosen normal to face straight down. Turning +Z down rotates
      // half a turn about X, which keeps the model's X layout.
      const downVector = new THREE.Vector3(0, 0, -1);
      const rotationMatrix = best.normal.dot(downVector) < -1 + 1e-9
        ? new THREE.Matrix4().makeRotationX(Math.PI)
        : new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(best.normal, downVector));

      // Rotate around the model's center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);

      // Apply rotation
      geometry.applyMatrix4(toOriginMatrix);
      geometry.applyMatrix4(rotationMatrix);
      geometry.applyMatrix4(fromOriginMatrix);

      // Translate so the new bottom is at Z=0
      geometry.computeBoundingBox(); // Recompute bounds after rotation
      const newMinZ = geometry.boundingBox!.min.z;
      const translateToZeroMatrix = new THREE.Matrix4().makeTranslation(0, 0, -newMinZ);
      geometry.applyMatrix4(translateToZeroMatrix);
      geometry.computeBoundingBox(); // Final bounds

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_flat.stl';
      const outputFilePath = path.join(this.tempDir, outputFileName);

      await this.saveSTL(geometry, outputFilePath, progressCallback); // 90-100% progress

      const message = `Rests on ${best.contactArea.toFixed(1)} mm² of bed contact; overhangs more than 45° from vertical need about ${best.supportVolume.toFixed(0)} mm³ of support.`;
      this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: outputFilePath, message });
      return { path: outputFilePath, laid_flat: true, message };

    } catch (error) {
      this.emit('operationError', { operationId, type: 'layFlat', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
}

export type LayFlatResult = {
  /** The laid-flat STL, or the unchanged input when `laid_flat` is false. */
  path: string;
  laid_flat: boolean;
  message: string;
};

/** Face corners (9 per face), outward unit normals (3 per face), areas, and the enclosed volume. */
type LayFlatMesh = { positions: Float64Array; normals: Float64Array; areas: Float64Array; volume: number };

/**
 * A direction to turn down, with the bed contact and support it gives.
 * `stackHeight` is the part and support volume over the contact area: the mean
 * height of material standing on each mm² of bed. Standing a long part on its
 * end, or resting a part on a fin under a wide cap, makes it tall.
 */
type LayFlatPose = { normal: THREE.Vector3; contactArea: number; supportVolume: number; stackHeight: number };

const LAY_FLAT_MAX_GROUP_CANDIDATES = 64;
/** Faces tilted more than 45° from vertical overhang and need support. */
const LAY_FLAT_OVERHANG_COS = Math.SQRT1_2 + 1e-6;

/**
 * Score turning `normal` to face the bed. The bed is the mesh's lowest plane in
 * that pose, its support plane. Faces lying on it, within 0.5% of the model's
 * height there (at most 0.2 mm), are bed contact. Overhanging faces above it
 * need support up from the bed: their projected area times their height.
 * Returns null when no face lies on the bed: turning that normal down would
 * rest the model on an edge or a point, not a face.
 */
function evaluateLayFlatPose(mesh: LayFlatMesh, normal: THREE.Vector3): LayFlatPose | null {
  const { positions, normals, areas } = mesh;
  const nx = normal.x, ny = normal.y, nz = normal.z;
  // Distance along the normal grows toward the bed: the bed is at its maximum.
  let bed = -Infinity, top = Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    const along = positions[index] * nx + positions[index + 1] * ny + positions[index + 2] * nz;
    if (along > bed) bed = along;
    if (along < top) top = along;
  }
  const tolerance = Math.min(0.2, Math.max(0.005 * (bed - top), 1e-4));

  let contactArea = 0;
  let supportVolume = 0;
  for (let face = 0; face < areas.length; face++) {
    const facing = normals[face * 3] * nx + normals[face * 3 + 1] * ny + normals[face * 3 + 2] * nz;
    if (!(facing > 0)) continue;
    const base = face * 9;
    let heightSum = 0, heightMax = 0;
    for (let corner = base; corner < base + 9; corner += 3) {
      const height = bed - (positions[corner] * nx + positions[corner + 1] * ny + positions[corner + 2] * nz);
      heightSum += height;
      if (height > heightMax) heightMax = height;
    }
    if (heightMax <= tolerance) contactArea += areas[face];
    else if (facing > LAY_FLAT_OVERHANG_COS) supportVolume += areas[face] * facing * (heightSum / 3);
  }
  if (!(contactArea > 0)) return null;
  return { normal, contactArea, supportVolume, stackHeight: (mesh.volume + supportVolume) / contactArea };
}

/**
 * Prefer the pose with the lowest stack height, then the larger contact. On a
 * tie, keep the face that already points down so a seated part is not flipped.
 */
function isBetterLayFlatPose(pose: LayFlatPose, best: LayFlatPose): boolean {
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
  if (!same(pose.stackHeight, best.stackHeight)) return pose.stackHeight < best.stackHeight;
  if (!same(pose.contactArea, best.contactArea)) return pose.contactArea > best.contactArea;
  return pose.normal.z < best.normal.z;
}
