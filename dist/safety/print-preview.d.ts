export interface PreviewView {
    name: "top" | "bed_side";
    label: string;
    png_base64: string;
    width: number;
    height: number;
}
export interface PrintPreview {
    views: PreviewView[];
    /** Millimetres per pixel in both views. */
    mm_per_pixel: number;
    /** The drawn area on the bed, in millimetres: [minX, minY, maxX, maxY]. */
    extent_mm: [number, number, number, number];
    layers: number;
    /** Filament slots (0-based, as the G-code's T numbers) that extrude on this plate. */
    filaments_used: number[];
}
/** RGB pixels (row-major) as a PNG. */
export declare function encodePng(width: number, height: number, rgb: Uint8Array): Buffer;
interface Segment {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    z: number;
    tool: number;
    width: number;
}
/** Extruding moves of one plate's G-code, start-up purge and filament-change flushing excluded. */
export declare function extrusionSegments(gcode: string): {
    segments: Segment[];
    layers: number;
};
/** An arc's centre from I/J (offsets from the start) or R (radius; negative takes the longer way round). */
export declare function arcCentre(x: number, y: number, tx: number, ty: number, clockwise: boolean, i?: number, j?: number, r?: number): [number, number] | undefined;
/** The top and bed-side pictures of one plate's G-code. `colours` are the project's filament colours by slot. */
export declare function renderPrintPreview(gcode: string, colours?: unknown[]): PrintPreview | undefined;
/** The preview of one plate of a sliced .3mf or a .gcode file, or undefined when it has no extruding moves. */
export declare function previewPrintFile(source: {
    gcode: string;
    projectColours?: unknown[];
}): Promise<PrintPreview | undefined>;
export {};
