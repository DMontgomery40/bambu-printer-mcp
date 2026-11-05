/**
 * slice_stl's `quality` and `strength` (PRD §8.4): a client's print-sheet choice, mapped here to the
 * slicer's own numbers so no client carries layer heights, wall counts or infill. Draft and Fine set
 * the layer height for the nozzle in use (0.28 and 0.12 mm on a 0.4 mm nozzle, scaled with it); Strong
 * and Max raise walls and infill to at least their values: a process that already has more (a
 * designer's 3MF at 100% infill) keeps it, so a stronger choice never prints weaker. Standard sends
 * nothing: the resolved process decides. An explicit layer_height, wall_loops or
 * sparse_infill_density in the same call wins over these and is written as given.
 */
export const PRINT_QUALITIES = ["draft", "standard", "fine"];
export const PRINT_STRENGTHS = ["standard", "strong", "max"];
/** Layer heights on the reference 0.4 mm nozzle; other nozzles scale from it. */
const REFERENCE_NOZZLE_MM = 0.4;
const LAYER_MM_ON_REFERENCE = { draft: 0.28, fine: 0.12 };
const STRENGTH = {
    strong: { wall_loops: 4, sparse_infill_density: "25%" },
    max: { wall_loops: 6, sparse_infill_density: "40%" },
};
/** The call's arguments with `quality` and `strength` written out as slicer settings. */
export function withPrintQuality(args, nozzleDiameter) {
    if (args.quality === undefined && args.strength === undefined)
        return args;
    const quality = args.quality === undefined ? "standard" : args.quality;
    const strength = args.strength === undefined ? "standard" : args.strength;
    if (typeof quality !== "string" || !PRINT_QUALITIES.includes(quality)) {
        throw new Error(`quality must be one of ${PRINT_QUALITIES.join(", ")}.`);
    }
    if (typeof strength !== "string" || !PRINT_STRENGTHS.includes(strength)) {
        throw new Error(`strength must be one of ${PRINT_STRENGTHS.join(", ")}.`);
    }
    const out = { ...args };
    const scale = typeof nozzleDiameter === "number" && Number.isFinite(nozzleDiameter) && nozzleDiameter > 0 ? nozzleDiameter / REFERENCE_NOZZLE_MM : 1;
    const layer = LAYER_MM_ON_REFERENCE[quality];
    if (layer !== undefined && out.layer_height === undefined)
        out.layer_height = Math.round(layer * scale * 100) / 100;
    const walls = STRENGTH[strength];
    if (walls) {
        if (out.wall_loops === undefined)
            out.wall_loops_floor = walls.wall_loops;
        if (out.sparse_infill_density === undefined)
            out.sparse_infill_density_floor = walls.sparse_infill_density;
    }
    return out;
}
/** slice_stl input-schema properties for both arguments. */
export const PRINT_QUALITY_PROPERTIES = {
    quality: {
        type: "string", enum: [...PRINT_QUALITIES],
        description: "Print quality: draft (thicker layers, faster), standard (the preset's own layer height) or fine (thinner layers). The server picks the layer height for the nozzle in use; an explicit layer_height wins.",
    },
    strength: {
        type: "string", enum: [...PRINT_STRENGTHS],
        description: "Part strength: standard (the process's own walls and infill), strong or max (at least more walls and denser infill; a process that already has more keeps it). The server picks the values; explicit wall_loops or sparse_infill_density win.",
    },
};
