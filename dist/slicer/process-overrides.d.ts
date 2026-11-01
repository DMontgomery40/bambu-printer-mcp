/**
 * slice_stl's layer_height, wall_loops and sparse_infill_density arguments
 * (PRD §8.4). They are written over the process preset the slicer already
 * resolved, using Bambu Studio/Orca keys and their string forms ("0.2", "2",
 * "15%"), so the machine preset and every other process value stay as resolved.
 */
export type ProcessOverrides = Partial<Record<"layer_height" | "wall_loops" | "sparse_infill_density", string>>;
export declare const PROCESS_OVERRIDE_KEYS: readonly ["layer_height", "wall_loops", "sparse_infill_density"];
/** Validate the tool arguments; undefined when none are given. */
export declare function parseProcessOverrides(args: Record<string, unknown> | undefined, nozzleDiameter: number): ProcessOverrides | undefined;
/** The process profile with the overrides written over its values. */
export declare function applyProcessOverrides(profile: Record<string, unknown>, overrides: ProcessOverrides): Record<string, unknown>;
