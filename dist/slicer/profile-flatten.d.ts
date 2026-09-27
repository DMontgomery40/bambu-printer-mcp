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
 *   4. Validates the model in `BBL/cli_config.json` and merges its CLI-specific
 *      machine_limits where supplied for safe accelerations / jerks.
 *   5. Writes the flattened JSON to a temp file the caller passes to
 *      BambuStudio CLI.
 *
 * BBL only. Other vendors are out of scope and rejected explicitly so we
 * fail loud rather than producing dangerous gcode for hardware we don't own.
 */
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
        /** False only for an explicit standalone custom machine. */
        cliConfigValidated: boolean;
        /** Some validated official model configs intentionally have no limits. */
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
    /**
     * Positional `#RRGGBB` colour per filament slot (e.g. from the input 3MF
     * project or the caller). Missing entries keep the profile's own colour or
     * fall back to DEFAULT_FILAMENT_COLOUR.
     */
    filamentColours?: (string | undefined)[];
}
/** Best-effort extruder count for fallback nozzle_volume_type sizing. */
/** BambuStudio's built-in filament_colour default. */
export declare const DEFAULT_FILAMENT_COLOUR = "#00AE42";
/**
 * Flatten the leaf profiles, post-process for CLI, and write to temp files.
 *
 * Throws on unknown leaf names, missing profilesRoot, or cycles.
 */
export declare function flattenForCli(opts: FlattenOptions): Promise<FlattenedProfiles>;
/**
 * Given the SLICER_PATH (path to BambuStudio executable), walk up to the
 * profile directory for that installation (macOS, Windows, or Linux prefix).
 *
 * Override via BAMBU_PROFILES_ROOT env.
 */
export declare function detectProfilesRoot(slicerPath?: string): string;
