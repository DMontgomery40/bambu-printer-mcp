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
 *   2. Recursively walks `inherits`, deep-merging parent into child.
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
}
/**
 * Flatten the leaf profiles, post-process for CLI, and write to temp files.
 *
 * Throws on unknown leaf names, missing profilesRoot, or cycles.
 */
export declare function flattenForCli(opts: FlattenOptions): Promise<FlattenedProfiles>;
/**
 * Given the SLICER_PATH (path to BambuStudio executable), walk up to the
 * Resources/profiles directory. Falls back to common platform paths.
 *
 * Override via BAMBU_PROFILES_ROOT env.
 */
export declare function detectProfilesRoot(slicerPath?: string): string;
