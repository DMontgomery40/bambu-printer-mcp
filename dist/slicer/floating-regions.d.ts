/**
 * Where a slice's "floating regions" warning comes from. Bambu Studio and OrcaSlicer say only that an object "has
 * floating regions" (a layer island with nothing under it); a design worker then rebuilt and re-sliced six times
 * chasing specks it could not see (scan-to-make #859, pass B). This finds them in the STL itself: each downward-facing
 * low point of the surface that starts above the plate, with how far its surface hangs below the point where it joins
 * something lower (its depth). The same mesh, the same places, so one fix can be aimed.
 *
 * Coordinates are the STL's own, in millimetres, with z measured from the model's lowest point (where the slicer
 * puts the plate). Shared by bambu-printer-mcp and mcp-3D-printer-server.
 */
/** One floating region: z where it starts (its lowest point), how far it hangs, and the box of what hangs (STL x, y; z from the model's lowest point). */
export interface FloatingRegion {
    z: number;
    depth_mm: number;
    box_mm: {
        min: [number, number, number];
        max: [number, number, number];
    };
}
export interface FloatingRegions {
    /** The deepest regions first, at most `limit`; z from the model's lowest point. */
    regions: FloatingRegion[];
    /** All the low points found, before the limit. */
    count: number;
    /** The STL's lowest z, which the slicer moves to the plate. */
    model_min_z: number;
}
/** Triangles of a binary or ASCII STL, as a flat array of 9 numbers each. */
export declare function stlTriangles(bytes: Buffer): Float64Array;
/**
 * The floating low points of a triangle mesh. A sweep from the bottom up joins vertices into connected pieces of the
 * surface below each height; a piece that starts above `plate_mm` is a low point, and its depth is how far up it
 * reaches before it joins a piece that started lower (or the whole of it, if it never does: a body in mid-air).
 * Only low points whose surface faces down count (the floor of a bowl or of a closed void faces up), and only
 * those deeper than `min_depth_mm` (about one layer: shallower bumps fall inside the layer that already has material).
 */
export declare function floatingRegions(triangles: Float64Array, options?: {
    plate_mm?: number;
    min_depth_mm?: number;
    merge_mm?: number;
    limit?: number;
}): FloatingRegions;
/** The slicer said a model has floating regions or small islands: a cosmetic warning this rule bounds. */
export declare function isFloatingWarning(message: string | undefined): boolean;
export declare const SLICE_WARNING_RULE = "A cosmetic warning (floating regions, small islands) gets one targeted fix and one re-slice, then stops: if it remains, report it in the result or slice with supports on. Do not rebuild and re-slice to chase it.";
/**
 * What slice_stl adds to a slice that worked but warned about floating regions: the rule above, and where the
 * regions are when the input is an STL the slicer did not turn (orient, rotate). Never throws: a location it
 * cannot find is left out, with why.
 */
export declare function floatingWarningFacts(report: {
    failed: boolean;
    message?: string;
} | undefined, modelPath: string, turned: boolean): Promise<Record<string, unknown>>;
