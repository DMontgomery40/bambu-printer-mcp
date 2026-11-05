/**
 * slice_stl's layer_height, wall_loops, sparse_infill_density and support arguments
 * (PRD §8.4). They are written over the process preset the slicer already
 * resolved, using Bambu Studio/Orca keys and their string forms ("0.2", "2",
 * "15%"), so the machine preset and every other process value stay as resolved.
 */
export declare const PROCESS_OVERRIDE_KEYS: readonly ["layer_height", "wall_loops", "sparse_infill_density", "enable_support", "support_type", "support_threshold_angle"];
/** Minimums from a strength choice: the resolved process keeps its own value when it is already higher. */
export declare const PROCESS_FLOOR_KEYS: readonly ["wall_loops_floor", "sparse_infill_density_floor"];
export type ProcessOverrides = Partial<Record<(typeof PROCESS_OVERRIDE_KEYS)[number] | (typeof PROCESS_FLOOR_KEYS)[number], string>>;
/** Bambu Studio's and OrcaSlicer's support_type values. */
export declare const SUPPORT_TYPES: readonly ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"];
/** Validate the tool arguments; undefined when none are given. */
export declare function parseProcessOverrides(args: Record<string, unknown> | undefined, nozzleDiameter: number): ProcessOverrides | undefined;
/** The process profile with the overrides written over its values. */
export declare function applyProcessOverrides(profile: Record<string, unknown>, overrides: ProcessOverrides): Record<string, unknown>;
