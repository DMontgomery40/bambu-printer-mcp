/**
 * Pause-at-layer for Bambu-compatible slicer CLIs ("Add pause" in Bambu Studio
 * and OrcaSlicer). The slicer writes the machine's own machine_pause_gcode
 * (M400 U1 on Bambu printers) before the chosen layer, so the printer pauses
 * by itself there and waits for Resume; no remote command is involved.
 *
 * The CLI takes these as --load-custom-gcodes <json> (CustomGCode::Info). It
 * does not apply the pauses a project 3MF already carries in
 * Metadata/custom_gcode_per_print_z.xml, so those are read here and passed the
 * same way. A pause's print_z must be the exact top of its layer: a height
 * between layers lands on the layer below.
 */
/** CustomGCode::Type, in the order bbs_3mf.cpp writes it as an integer. */
declare const CUSTOM_GCODE_TYPES: readonly ["ColorChange", "PausePrint", "ToolChange", "Template", "Custom", "Unknown"];
export type CustomGcodeType = (typeof CUSTOM_GCODE_TYPES)[number];
export interface CustomGcodeItem {
    type: CustomGcodeType;
    print_z: number;
    color: string;
    extruder: number;
    extra: string;
}
export interface CustomGcodeInfo {
    mode: string;
    gcodes: CustomGcodeItem[];
}
/** 1-based layer numbers, as Bambu Studio's and OrcaSlicer's preview slider count them. */
export declare function parsePauseLayers(value: unknown): number[] | undefined;
/**
 * The custom G-codes (pauses, colour changes, ...) a project 3MF stores for
 * one plate (1-based), as Bambu Studio and OrcaSlicer save them.
 */
export declare function readProjectCustomGcodes(threeMfPath: string, plate?: number): Promise<CustomGcodeInfo | undefined>;
/** The plate's G-code text inside a sliced 3MF. */
export declare function readPlateGcode(threeMfPath: string, plate?: number): Promise<string | undefined>;
/** Each layer's top Z in order, from the slicer's "; Z_HEIGHT:" markers. */
export declare function layerTops(gcode: string): number[];
/**
 * The 1-based layers whose block holds a pause: the slicer's "; PAUSE_PRINTING"
 * marker or the machine's pause G-code on its own line.
 */
export declare function pausedLayers(gcode: string, pauseGcode?: string): number[];
/** The machine_pause_gcode a sliced file was made with (its config block), else Bambu's M400 U1. */
export declare function machinePauseGcode(gcode: string): string;
/** Project custom G-codes plus a pause before each requested layer, at that layer's exact top. */
export declare function customGcodesWithPauses(tops: number[], layers: number[], project?: CustomGcodeInfo): CustomGcodeInfo;
export {};
