export interface Rect {
    x: number;
    y: number;
    w: number;
    d: number;
}
/** The printable bed in its own coordinates: its rectangle, height, and the areas nothing may be placed on. */
export interface Bed {
    x: number;
    y: number;
    width: number;
    depth: number;
    height: number;
    excluded: Rect[];
}
/** A plate of the split file, in the shape clients use for a designer's plates: zero-based index, name, objects. */
export interface SplitPlate {
    index: number;
    name: string;
    objects: string[];
}
export type BedSplit = {
    fits: true;
} | {
    fits: false;
    too_large: {
        name: string;
        size_mm: number[];
    }[];
    bed_mm: number[];
    message: string;
} | {
    fits: false;
    three_mf_path: string;
    plates: SplitPlate[];
    bed_mm: number[];
    message: string;
};
export declare class BedSplitError extends Error {
}
/**
 * The bed of a resolved (flattened) machine preset: printable_area, bed_exclude_area and printable_height, as
 * Bambu Studio and OrcaSlicer define them. Without a printable_area, `fallback` ([width, depth, height]) is used.
 */
export declare function bedFromMachine(machine: Record<string, unknown> | undefined, fallback?: readonly number[]): Bed;
/**
 * The bed of the exact machine preset a slice uses (`Bambu Lab P1S 0.4 nozzle`), from the selected profile tree.
 * When that preset can't be read, the model's build volume stands in, without excluded areas, and says so on stderr.
 */
export declare function machineBed(profilesRoot: string | undefined, preset: string | undefined, volume?: readonly number[]): Promise<Bed>;
/** OBJ vertices and faces (polygons as triangle fans; negative indices count back). Other statements are ignored. */
export declare function objTriangles(text: string): Float32Array;
/** Columns of the slicer's plate grid: the rounded-up square root of the plate count. */
export declare function plateColumns(count: number): number;
/**
 * Split `modelPath` across plates of `bed` when it doesn't fit as it is. `printer` names the printer in the
 * sentences ("the P1S bed"); `outPath` is where the multi-plate 3MF is written (replaced if present).
 */
export declare function splitToPlates(options: {
    modelPath: string;
    outPath: string;
    bed: Bed;
    printer?: string;
}): Promise<BedSplit>;
