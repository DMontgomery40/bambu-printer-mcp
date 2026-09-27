/**
 * BambuStudio CLI profile flattener.
 *
 * Background: BambuStudio's bundled profile JSONs (Resources/profiles/BBL/...)
 * use an `inherits` chain that the GUI resolves at runtime but the CLI does
 * not. Passing a leaf profile straight to `--load-settings` / `--load-filaments`
 * yields a partial config and the slicer asserts (e.g. `nozzle_volume_type
 * not found` -> SIGSEGV / assertion in MutablePolygon.cpp / Geometry.hpp).
 * See https://github.com/bambulab/BambuStudio/issues/9636 and #9968.
 *
 * This module:
 *   1. Indexes every BBL profile JSON by its `name` field.
 *   2. Recursively walks `inherits`, deep-merging parent into child, and
 *      applies each level's `include` templates (G-code templates for
 *      machines, per-variant defaults for filaments) the way the GUI does.
 *   3. Derives `nozzle_volume_type` from `default_nozzle_volume_type[0]`
 *      (the GUI does this implicitly; the CLI doesn't).
 *   4. Merges CLI-specific machine_limits from `BBL/cli_config.json` so the
 *      printer doesn't run unsafe accelerations / jerks.
 *   5. Writes the flattened JSON to a temp file the caller passes to
 *      BambuStudio CLI.
 *
 * BBL only. Other vendors are out of scope and rejected explicitly so we
 * fail loud rather than producing dangerous gcode for hardware we don't own.
 */

import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ProfileKind = "machine" | "process" | "filament";

export interface FlattenedProfiles {
  machinePath: string;
  processPath: string;
  filamentPaths: string[];
  /** Diagnostics for callers / logs. Not part of the slicer invocation. */
  meta: {
    profilesRoot: string;
    machineLeafName: string;
    processLeafName: string;
    filamentLeafNames: string[];
    cliOverlayApplied: boolean;
  };
}

export interface FlattenOptions {
  /** e.g. "Bambu Lab H2S 0.4 nozzle" */
  machineLeaf: string;
  /** e.g. "0.20mm Standard @BBL H2S" */
  processLeaf: string;
  /** e.g. ["Bambu PLA Basic @BBL H2S"] */
  filamentLeaves: string[];
  /** Absolute path to `.../Resources/profiles`. */
  profilesRoot: string;
  /** Where to write flattened temp files. */
  tempDir: string;
  /** Vendor subdir under profilesRoot. Currently only "BBL" supported. */
  vendor?: string;
  /**
   * Override for installed nozzle flow type. The printer reports this on
   * boot from its physical nozzle scan; both nozzles always match (you
   * can't mix Standard + High Flow, just like you can't mix 0.2 + 0.4).
   * If omitted we use `default_nozzle_volume_type` from the profile tree
   * (= "Standard" on stock BBL machines). Pass "High Flow" when HF
   * nozzles are installed.
   */
  nozzleVolumeType?: "Standard" | "High Flow";
  /** BambuStudio display name, e.g. "Textured PEI Plate" or "Cool Plate". */
  bedType?: string;
  /** Actual input configs, including user overrides on top of BBL parents. */
  sourceProfiles?: {
    machine?: Record<string, unknown>;
    process?: Record<string, unknown>;
    filaments?: (Record<string, unknown> | undefined)[];
  };
}

interface IndexedProfile {
  filePath: string;
  data: Record<string, unknown>;
}

type NameIndex = Map<string, IndexedProfile>;

/* -------------------------------------------------------------------------- */
/* Indexing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a name -> {filePath, data} map for every JSON in
 * <profilesRoot>/<vendor>/{machine,process,filament}/.
 *
 * The `name` field inside each JSON is the lookup key (this is what
 * `inherits` references). We index every file, including non-instantiable
 * abstract bases like `fdm_machine_common` and `fdm_bbl_3dp_001_common`,
 * because those are the parents we'll walk to.
 */
async function buildNameIndex(
  profilesRoot: string,
  vendor: string
): Promise<NameIndex> {
  const index: NameIndex = new Map();
  const subdirs: ProfileKind[] = ["machine", "process", "filament"];

  for (const sub of subdirs) {
    const dir = path.join(profilesRoot, vendor, sub);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Vendor or subdir missing -- skip silently; flatten will fail later
      // with a precise "name not found" error.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Malformed profile -- skip, don't poison the index.
        continue;
      }
      const name = data["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      // First-write wins. BBL doesn't have name collisions in practice;
      // log if it ever does so we notice.
      if (!index.has(name)) {
        index.set(name, { filePath, data });
      }
    }
  }

  return index;
}

/* -------------------------------------------------------------------------- */
/* Inheritance walk + merge                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the full inheritance chain for `leafName` and return a single
 * deep-merged object. Child wins on key collision.
 *
 * Throws on:
 *   - Unknown name (broken `inherits` reference).
 *   - Cycles (A -> B -> A).
 */
function flattenByName(
  leafName: string,
  index: NameIndex,
  visiting = new Set<string>()
): Record<string, unknown> {
  if (visiting.has(leafName)) {
    throw new Error(`Profile inheritance cycle detected (inherits/include): ${[...visiting, leafName].join(" -> ")}`);
  }
  const entry = index.get(leafName);
  if (!entry) {
    throw new Error(`Profile "${leafName}" not found in index. The profile tree is incomplete or the name is misspelled.`);
  }
  visiting.add(leafName);
  try {
    return flattenData(entry.data, index, visiting);
  } finally {
    visiting.delete(leafName);
  }
}

function flattenData(
  data: Record<string, unknown>,
  index: NameIndex,
  visiting = new Set<string>()
): Record<string, unknown> {
  const parent = data["inherits"];
  const merged = typeof parent === "string" && parent.length > 0
    ? flattenByName(parent, index, visiting)
    : {};
  // Includes may themselves inherit or include templates. Each level wins
  // over its parent, then the including profile's own settings win last.
  applyIncludes(merged, data, index, visiting);
  Object.assign(merged, data);
  delete merged["include"];
  return merged;
}

/** Keys of an include template that describe the template, not the config. */
const INCLUDE_METADATA_KEYS = new Set(["name", "type", "from", "instantiation", "inherits", "include", "setting_id"]);

/**
 * Recent BBL profiles (e.g. "Bambu Lab P2S 0.4 nozzle") no longer carry
 * their G-code inline: `machine_start_gcode`, `machine_end_gcode`,
 * `change_filament_gcode`, ... live in separate "... template <key>"
 * profiles listed under `include`. Skipping them silently falls back to
 * the generic G-code inherited from `fdm_machine_common` & co, which is
 * wrong for the printer (no AMS filament load, other printer's moves).
 */
function applyIncludes(
  target: Record<string, unknown>,
  profile: Record<string, unknown>,
  index: NameIndex,
  visiting: Set<string>
): void {
  const raw = profile["include"];
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string" && !Array.isArray(raw)) {
    throw new Error(`Profile "${String(profile["name"])}" has an invalid include; expected a name or array of names.`);
  }
  const names = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  for (const name of names) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`Profile "${String(profile["name"])}" has an invalid include reference; every entry must be a nonempty name.`);
    }
    const entry = index.get(name);
    if (!entry) {
      throw new Error(
        `Profile "${String(profile["name"])}" includes "${name}", which is not in the index. ` +
          `Refusing to fall back to inherited defaults (wrong G-code for this printer).`
      );
    }
    for (const [key, value] of Object.entries(flattenByName(name, index, visiting))) {
      if (!INCLUDE_METADATA_KEYS.has(key)) target[key] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CLI post-processing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Bambu's CLI looks up `nozzle_volume_type`, but the profile tree only
 * defines `default_nozzle_volume_type`. The GUI propagates the latter
 * (or the value reported by the printer's nozzle scan on boot) into the
 * former at runtime. We do the same.
 *
 * Shape: array of strings, one entry per physical nozzle. Hardware
 * invariant from Bambu: BOTH nozzles must match (same diameter, same
 * flow type) -- you cannot install 0.2 + 0.4, and you cannot install
 * Standard + High Flow. So the array always contains identical entries.
 *
 * Verified against a GUI-sliced H2D project_settings.config:
 *   ["High Flow", "High Flow"]   (dual-nozzle, HF installed)
 *   ["Standard", "Standard"]     (dual-nozzle, stock)
 *   ["Standard"]                 (single-extruder default)
 *
 * Override priority:
 *   1. Caller-supplied `nozzleVolumeType` (e.g. printer reported HF).
 *   2. Existing `nozzle_volume_type` already in the flattened profile.
 *   3. `default_nozzle_volume_type` from the profile tree.
 *   4. ["Standard"] x extruder count.
 */
function deriveNozzleVolumeType(
  flat: Record<string, unknown>,
  override?: "Standard" | "High Flow"
): void {
  if (override) {
    const count = inferExtruderCount(flat);
    flat["nozzle_volume_type"] = Array(count).fill(override);
    return;
  }

  if (Array.isArray(flat["nozzle_volume_type"])) {
    enforceMatchingNozzles(flat["nozzle_volume_type"] as unknown[]);
    return;
  }

  const def = flat["default_nozzle_volume_type"];
  if (Array.isArray(def) && def.every((v) => typeof v === "string")) {
    enforceMatchingNozzles(def);
    flat["nozzle_volume_type"] = [...def];
    return;
  }

  const extruderCount = inferExtruderCount(flat);
  flat["nozzle_volume_type"] = Array(extruderCount).fill("Standard");
}

/**
 * Hardware invariant: all nozzles on a Bambu printer have identical flow
 * type (and diameter). If a profile somehow declares mixed types it's
 * either bad input or a future mistake -- fail loud so we don't ship
 * gcode that could damage the printer.
 */
function enforceMatchingNozzles(arr: unknown[]): void {
  if (arr.length <= 1) return;
  const first = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== first) {
      throw new Error(
        `nozzle_volume_type entries must all match (Bambu hardware invariant). ` +
          `Got: ${JSON.stringify(arr)}. ` +
          `Both nozzles on H2-series printers always have identical flow type.`
      );
    }
  }
}

/** Best-effort extruder count for fallback nozzle_volume_type sizing. */
function inferExtruderCount(flat: Record<string, unknown>): number {
  for (const key of ["nozzle_diameter", "extruder_type", "extruder_variant_list"]) {
    const v = flat[key];
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 1;
}

/**
 * Bambu ships `BBL/cli_config.json` with per-printer overlays containing
 * machine_limits keys (cli_safe_acceleration_*, cli_safe_jerk_*,
 * cli_safe_speed_*). Without these the slicer can emit movements faster
 * than the printer's safe envelope -- dangerous on real hardware.
 *
 * The overlay keys are scoped under printer.<printer_name>.machine_limits.
 * We look up by the leaf machine's `printer_model` or `name` and merge
 * those keys into the flattened machine profile.
 *
 * Returns true if an overlay was found and applied, false otherwise.
 */
async function applyCliOverlay(
  flat: Record<string, unknown>,
  profilesRoot: string,
  vendor: string
): Promise<boolean> {
  const cliConfigPath = path.join(profilesRoot, vendor, "cli_config.json");
  let raw: string;
  try {
    raw = await fs.readFile(cliConfigPath, "utf8");
  } catch {
    return false;
  }
  let cliConfig: Record<string, unknown>;
  try {
    cliConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const printerSection = cliConfig["printer"];
  if (!printerSection || typeof printerSection !== "object") return false;

  // Match key: cli_config.json keys are bare printer names like
  // "Bambu Lab H2D" / "Bambu Lab A1". Try, in order: explicit printer_model,
  // printer_settings_id with the " 0.4 nozzle" suffix stripped, raw name
  // with that suffix stripped, raw name as-is.
  const candidates = [
    flat["printer_model"],
    typeof flat["printer_settings_id"] === "string"
      ? stripNozzleSuffix(flat["printer_settings_id"])
      : undefined,
    typeof flat["name"] === "string" ? stripNozzleSuffix(flat["name"]) : undefined,
    flat["name"],
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const key of candidates) {
    const block = (printerSection as Record<string, unknown>)[key];
    if (!block || typeof block !== "object") continue;
    const mlimits = (block as Record<string, unknown>)["machine_limits"];
    if (!mlimits || typeof mlimits !== "object") continue;
    // Merge machine_limits into the flat profile. These are CLI-only safety
    // values; they should never be overridden by the leaf.
    Object.assign(flat, mlimits as Record<string, unknown>);
    return true;
  }

  return false;
}

/**
 * Ensure the chosen machine is in the process/filament's
 * `compatible_printers` list. This mirrors what the GUI does when you
 * save a project with a printer/process combo that wasn't in the
 * shipped compat list.
 */
function ensureMachineInCompatList(
  flat: Record<string, unknown>,
  machineLeaf: string
): void {
  const list = flat["compatible_printers"];
  if (!Array.isArray(list)) {
    flat["compatible_printers"] = [machineLeaf];
    return;
  }
  if (!list.includes(machineLeaf)) {
    list.push(machineLeaf);
  }
}

function stripNozzleSuffix(name: string): string {
  return name.replace(/\s+\d+\.\d+\s+nozzle.*$/, "");
}

/**
 * Adjust fields for CLI consumption.
 *
 * - Strip `inherits` and `instantiation` (chain marker, abstract-base flag).
 *   The GUI consumes them; the CLI treats anything still present as part of
 *   the merged config.
 * - Rewrite `from`. Leaf BBL profiles ship with `"from": "system"`, which
 *   the CLI rejects when loaded via `--load-settings` (system presets
 *   aren't supposed to be loaded that way). The GUI rewrites this to
 *   `"from": "project"` when it embeds the merged config in a 3MF. We do
 *   the same so the CLI accepts our flattened temp file.
 * - Strip `setting_id` / `is_custom_defined` (user-registry markers that
 *   make no sense on a transient flattened file).
 */
function normalizeForCli(
  flat: Record<string, unknown>,
  kind: ProfileKind,
  leafName: string
): void {
  // Set inherits to the leaf name BEFORE we delete it below, so the
  // CLI's system_name resolution lands on the right value.
  // (See note further down for why this matters.)
  flat["inherits"] = leafName;
  // Identity field. The CLI sets this internally, but we mirror it for
  // consistency with what the GUI's project_settings.config emits.
  switch (kind) {
    case "machine":
      flat["printer_settings_id"] = leafName;
      break;
    case "process":
      flat["print_settings_id"] = leafName;
      break;
    case "filament":
      flat["filament_settings_id"] = [leafName];
      break;
  }

  // CRITICAL: when from=="User", the CLI computes `system_name = inherits`
  // and the compatibility check compares the *other* configs'
  // `compatible_printers` list against that system_name. The leaf
  // profiles' compat lists contain the leaf machine name (e.g.
  // "Bambu Lab H2S 0.4 nozzle"), so we must set `inherits` on the
  // flattened machine to that same leaf name. For process/filament,
  // `inherits` doesn't drive the compat check we hit, but we set it for
  // symmetry so any future check succeeds the same way.
  // Source: BambuStudio.cpp ~line 2222 (from!="system" -> system_name = inherits).
  // NOTE: do NOT delete inherits -- we just set it above. The CLI uses
  // its value (when from=="User") for the system_name compat check.
  delete flat["instantiation"];
  delete flat["setting_id"];
  delete flat["is_custom_defined"];
  // Always rewrite `from` to "User". "Project" is what the GUI uses when
  // embedding in a 3MF, but the CLI accepts "User" for --load-settings
  // paths and that's semantically what we are.
  flat["from"] = "User";
  // Mirror the GUI's behavior of clearing compatibility constraints in the
  // merged project config. The leaf process/filament profiles ship with
  // `compatible_printers: ["Bambu Lab H2S 0.4 nozzle"]` etc., and the CLI
  // re-validates that list against our flattened machine config -- which
  // has had `from` rewritten and inheritance collapsed, so the equality
  // check fails. The GUI's project_settings.config has these set to null
  // because at that point compatibility is already established by the
  // user. We do the same.
  // Leave compatible_printers / compatible_prints as the leaf declared
  // them. The GUI nulls these in embedded project configs, but the CLI's
  // --load-settings path requires a non-empty list and matches against
  // the machine's `name` / `printer_settings_id`. The leaves ship with
  // the correct list ([machine_leaf_name]) so just preserve.
  // _condition fields can stay null (string-typed, tolerated as null).
}

function applyBedType(processFlat: Record<string, unknown>, bedType?: string): void {
  if (!bedType) return;
  processFlat.curr_bed_type = bedType;
}

function applyMachineModelBedMetadata(
  machineFlat: Record<string, unknown>,
  index: NameIndex
): void {
  const modelName = machineFlat.printer_model;
  if (typeof modelName !== "string") return;

  const model = index.get(modelName)?.data;
  if (!model) return;

  for (const key of ["default_bed_type", "image_bed_type", "not_support_bed_type"]) {
    if (!(key in machineFlat) && key in model) {
      machineFlat[key] = model[key];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flatten the leaf profiles, post-process for CLI, and write to temp files.
 *
 * Throws on unknown leaf names, missing profilesRoot, or cycles.
 */
export async function flattenForCli(opts: FlattenOptions): Promise<FlattenedProfiles> {
  const vendor = opts.vendor ?? "BBL";
  if (vendor !== "BBL") {
    throw new Error(
      `profile-flatten: only BBL vendor is supported (got "${vendor}"). ` +
        `Other vendors are out of scope -- contributions welcome but untested.`
    );
  }

  // Confirm the profiles root looks plausible before doing real work.
  const probe = path.join(opts.profilesRoot, vendor, "machine");
  try {
    await fs.access(probe);
  } catch {
    throw new Error(
      `profile-flatten: profilesRoot "${opts.profilesRoot}" does not contain "${vendor}/machine". ` +
        `Set BAMBU_PROFILES_ROOT or check your BambuStudio install.`
    );
  }

  const index = await buildNameIndex(opts.profilesRoot, vendor);

  // Flatten each leaf.
  if (opts.sourceProfiles?.filaments && opts.sourceProfiles.filaments.length !== opts.filamentLeaves.length) {
    throw new Error("Every filament slot must have a source profile.");
  }
  const machineFlat = opts.sourceProfiles?.machine
    ? flattenData(opts.sourceProfiles.machine, index)
    : flattenByName(opts.machineLeaf, index);
  const processFlat = opts.sourceProfiles?.process
    ? flattenData(opts.sourceProfiles.process, index)
    : flattenByName(opts.processLeaf, index);
  const filamentFlats = opts.filamentLeaves.map((n, i) => {
    const source = opts.sourceProfiles?.filaments?.[i];
    return source ? flattenData(source, index) : flattenByName(n, index);
  });

  // CLI-specific post-processing on machine profile only.
  deriveNozzleVolumeType(machineFlat, opts.nozzleVolumeType);
  applyMachineModelBedMetadata(machineFlat, index);
  const cliOverlayApplied = await applyCliOverlay(machineFlat, opts.profilesRoot, vendor);

  // Normalize each flattened profile for CLI consumption.
  normalizeForCli(machineFlat, "machine", opts.machineLeaf);
  normalizeForCli(processFlat, "process", opts.processLeaf);
  filamentFlats.forEach((f, i) => normalizeForCli(f, "filament", opts.filamentLeaves[i]));
  applyBedType(processFlat, opts.bedType);

  // Mirror the GUI's auto-extend behavior: when the caller explicitly
  // chose a process or filament that wasn't pre-declared compatible with
  // the chosen machine (e.g. "0.20mm Standard @BBL P1P" used on a P1S),
  // add the machine name to the process/filament compat list. The GUI
  // does this implicitly when saving a project.
  ensureMachineInCompatList(processFlat, opts.machineLeaf);
  filamentFlats.forEach((f) => ensureMachineInCompatList(f, opts.machineLeaf));

  // Hash the resolved content so concurrent jobs using the same preset with
  // different overrides never overwrite each other's input files.
  await fs.mkdir(opts.tempDir, { recursive: true });
  const machinePath = await writeTemp(opts.tempDir, "machine", opts.machineLeaf, machineFlat);
  const processPath = await writeTemp(opts.tempDir, "process", opts.processLeaf, processFlat);
  const filamentPaths: string[] = [];
  for (let i = 0; i < filamentFlats.length; i++) {
    filamentPaths.push(
      await writeTemp(opts.tempDir, `filament-${i}`, opts.filamentLeaves[i], filamentFlats[i])
    );
  }

  return {
    machinePath,
    processPath,
    filamentPaths,
    meta: {
      profilesRoot: opts.profilesRoot,
      machineLeafName: opts.machineLeaf,
      processLeafName: opts.processLeaf,
      filamentLeafNames: opts.filamentLeaves,
      cliOverlayApplied,
    },
  };
}

async function writeTemp(
  tempDir: string,
  kind: string,
  leafName: string,
  data: Record<string, unknown>
): Promise<string> {
  const serialized = JSON.stringify(data, null, 2);
  const hash = crypto.createHash("sha256").update(leafName).update("\0").update(serialized).digest("hex").slice(0, 16);
  const safe = leafName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  const filename = `flat-${kind}-${safe}-${hash}.json`;
  const out = path.join(tempDir, filename);
  await fs.writeFile(out, serialized, "utf8");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Profile root detection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Given the SLICER_PATH (path to BambuStudio executable), walk up to the
 * profile directory for that installation (macOS, Windows, or Linux prefix).
 *
 * Override via BAMBU_PROFILES_ROOT env.
 */
export function detectProfilesRoot(slicerPath?: string): string {
  if (process.env["BAMBU_PROFILES_ROOT"]) {
    return process.env["BAMBU_PROFILES_ROOT"];
  }

  if (slicerPath) {
    let executable = slicerPath;
    if (!slicerPath.includes('/') && !slicerPath.includes('\\')) {
      const located = (process.env.PATH ?? '').split(path.delimiter)
        .map(dir => path.join(dir, slicerPath))
        .find(candidate => existsSync(candidate));
      if (located) executable = located;
    }
    // Package-manager launchers may be symlinks into the installation prefix.
    try { executable = realpathSync(executable); } catch { /* Probe the supplied path below. */ }
    const bin = path.dirname(executable);
    const candidates = path.basename(bin) === 'MacOS'
      ? [path.resolve(bin, '..', 'Resources', 'profiles')]
      : [
          path.join(bin, 'resources', 'profiles'),
          path.join(bin, 'Resources', 'profiles'),
          path.resolve(bin, '..', 'share', 'BambuStudio', 'profiles'),
          path.resolve(bin, '..', 'share', 'bambu-studio', 'profiles'),
          path.resolve(bin, '..', 'share', 'BambuStudio', 'resources', 'profiles'),
        ];
    const found = candidates.find(root => existsSync(path.join(root, 'BBL', 'machine')));
    // Do not select another installation if this executable has no profile tree.
    // flattenForCli reports the missing tree and asks for BAMBU_PROFILES_ROOT.
    return found ?? candidates[0];
  }

  // Default macOS install.
  return "/Applications/BambuStudio.app/Contents/Resources/profiles";
}
