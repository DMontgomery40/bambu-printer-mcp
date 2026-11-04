/**
 * slice_stl's `quality` and `strength` (PRD §8.4): a client's print-sheet choice, mapped here to the
 * slicer's own numbers so no client carries layer heights, wall counts or infill. Draft and Fine set
 * the layer height for the nozzle in use (0.28 and 0.12 mm on a 0.4 mm nozzle, scaled with it); Strong
 * and Max set walls and infill. Standard sends nothing: the resolved preset decides. An explicit
 * layer_height, wall_loops or sparse_infill_density in the same call wins over these.
 */
export declare const PRINT_QUALITIES: readonly ["draft", "standard", "fine"];
export declare const PRINT_STRENGTHS: readonly ["standard", "strong", "max"];
/** The call's arguments with `quality` and `strength` written out as slicer settings. */
export declare function withPrintQuality<T extends Record<string, unknown> | undefined>(args: T, nozzleDiameter?: number): T;
/** slice_stl input-schema properties for both arguments. */
export declare const PRINT_QUALITY_PROPERTIES: {
    readonly quality: {
        readonly type: "string";
        readonly enum: readonly ["draft", "standard", "fine"];
        readonly description: "Print quality: draft (thicker layers, faster), standard (the preset's own layer height) or fine (thinner layers). The server picks the layer height for the nozzle in use; an explicit layer_height wins.";
    };
    readonly strength: {
        readonly type: "string";
        readonly enum: readonly ["standard", "strong", "max"];
        readonly description: "Part strength: standard (the preset's walls and infill), strong or max (more walls and denser infill). The server picks the values; explicit wall_loops or sparse_infill_density win.";
    };
};
