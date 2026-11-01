export const PROCESS_OVERRIDE_KEYS = ["layer_height", "wall_loops", "sparse_infill_density"];
/** Validate the tool arguments; undefined when none are given. */
export function parseProcessOverrides(args, nozzleDiameter) {
    const overrides = {};
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
        if (!match || Number(match[1]) > 100)
            throw new Error('sparse_infill_density must be a percentage from 0% to 100%, such as "15%".');
        overrides.sparse_infill_density = `${Number(match[1])}%`;
    }
    return Object.keys(overrides).length ? overrides : undefined;
}
/** The process profile with the overrides written over its values. */
export function applyProcessOverrides(profile, overrides) {
    return { ...profile, ...overrides };
}
