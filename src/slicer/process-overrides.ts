/**
 * slice_stl's layer_height, wall_loops, sparse_infill_density and support arguments
 * (PRD §8.4). They are written over the process preset the slicer already
 * resolved, using Bambu Studio/Orca keys and their string forms ("0.2", "2",
 * "15%"), so the machine preset and every other process value stay as resolved.
 */
export const PROCESS_OVERRIDE_KEYS = ["layer_height", "wall_loops", "sparse_infill_density", "enable_support", "support_type", "support_threshold_angle"] as const;

/** Minimums from a strength choice: the resolved process keeps its own value when it is already higher. */
export const PROCESS_FLOOR_KEYS = ["wall_loops_floor", "sparse_infill_density_floor"] as const;

export type ProcessOverrides = Partial<Record<(typeof PROCESS_OVERRIDE_KEYS)[number] | (typeof PROCESS_FLOOR_KEYS)[number], string>>;

/** Bambu Studio's and OrcaSlicer's support_type values. */
export const SUPPORT_TYPES = ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"] as const;

/** Validate the tool arguments; undefined when none are given. */
export function parseProcessOverrides(args: Record<string, unknown> | undefined, nozzleDiameter: number): ProcessOverrides | undefined {
  const overrides: ProcessOverrides = {};
  const layerHeight = args?.layer_height;
  if (layerHeight !== undefined) {
    if (typeof layerHeight !== "number" || !Number.isFinite(layerHeight) || layerHeight <= 0 ||
        (Number.isFinite(nozzleDiameter) && nozzleDiameter > 0 && layerHeight > nozzleDiameter)) {
      throw new Error("layer_height must be a positive number of millimetres, no larger than the nozzle diameter.");
    }
    overrides.layer_height = String(Number(layerHeight.toFixed(4)));
  }
  const wallLoops = args?.wall_loops;
  if (wallLoops !== undefined) {
    // Bambu Studio's wall_loops option ranges from 0 to 1000.
    if (typeof wallLoops !== "number" || !Number.isInteger(wallLoops) || wallLoops < 0 || wallLoops > 1000) {
      throw new Error("wall_loops must be an integer from 0 to 1000.");
    }
    overrides.wall_loops = String(wallLoops);
  }
  const density = args?.sparse_infill_density;
  if (density !== undefined) {
    const match = typeof density === "string" ? /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(density) : null;
    if (!match || Number(match[1]) > 100) throw new Error('sparse_infill_density must be a percentage from 0% to 100%, such as "15%".');
    overrides.sparse_infill_density = `${Number(match[1])}%`;
  }
  // Written by withPrintQuality for strong/max, never by a caller.
  if (typeof args?.wall_loops_floor === "number") overrides.wall_loops_floor = String(args.wall_loops_floor);
  if (typeof args?.sparse_infill_density_floor === "string") overrides.sparse_infill_density_floor = args.sparse_infill_density_floor;
  const enableSupport = args?.enable_support;
  if (enableSupport !== undefined) {
    if (typeof enableSupport !== "boolean") throw new Error("enable_support must be true or false.");
    overrides.enable_support = enableSupport ? "1" : "0";
  }
  const supportType = args?.support_type;
  if (supportType !== undefined) {
    if (typeof supportType !== "string" || !(SUPPORT_TYPES as readonly string[]).includes(supportType)) {
      throw new Error(`support_type must be one of ${SUPPORT_TYPES.join(", ")}.`);
    }
    overrides.support_type = supportType;
  }
  const threshold = args?.support_threshold_angle;
  if (threshold !== undefined) {
    // Studio's threshold angle runs 0-90 degrees; 0 lets the slicer pick by its own rule.
    if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0 || threshold > 90) {
      throw new Error("support_threshold_angle must be an integer number of degrees from 0 to 90.");
    }
    overrides.support_threshold_angle = String(threshold);
  }
  return Object.keys(overrides).length ? overrides : undefined;
}

/** The process profile with the overrides written over its values. */
export function applyProcessOverrides(profile: Record<string, unknown>, overrides: ProcessOverrides): Record<string, unknown> {
  const { wall_loops_floor: wallFloor, sparse_infill_density_floor: densityFloor, ...exact } = overrides;
  const out: Record<string, unknown> = { ...profile };
  const number = (value: unknown) => {
    const parsed = Number.parseFloat(String(Array.isArray(value) ? value[0] : value ?? ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  if (wallFloor !== undefined && (number(out.wall_loops) ?? -1) < Number(wallFloor)) out.wall_loops = wallFloor;
  if (densityFloor !== undefined && (number(out.sparse_infill_density) ?? -1) < Number.parseFloat(densityFloor)) out.sparse_infill_density = densityFloor;
  return { ...out, ...exact };
}
