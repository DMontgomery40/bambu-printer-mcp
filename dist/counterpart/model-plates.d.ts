import { type PaintLimits, type PlateFilament } from "./plate-filaments.js";
export interface ModelPlate {
    /** Zero-based, as inspect_print_file's plate_index; slice_stl's slice_plate is index + 1. */
    index: number;
    name: string;
    objects: string[];
    /**
     * Each object copy on the plate with its identify_id, from model_settings.config's <model_instance> entries
     * (Bambu Studio 02.08.02.61 bbs_3mf.cpp:8448-8482). These are the ids slice_stl's skip_objects takes: the
     * CLI matches them against each instance's loaded id (BambuStudio.cpp:1785-1789, 6530-6545).
     */
    instances: {
        identify_id: number;
        name: string;
    }[];
    /** The file already holds this plate's G-code. */
    sliced: boolean;
    /**
     * The project filaments this plate prints with, and only those (counterpart/1): what a client asks the person to
     * choose spools for. From the slice when the file holds one (plate_N.json filament_ids), otherwise worked out as
     * Bambu Studio does for the objects on this plate (see plate-filaments.ts). Filaments of other plates never appear.
     */
    filaments: PlateFilament[];
    /**
     * false when the plate's list may hold filaments it doesn't print: a part's mesh was too large to read its painting,
     * so every declared filament is listed rather than risk leaving out one that prints. A client offers them all.
     */
    filaments_complete: boolean;
    /** The plate's own preview from the file (Metadata/plate_N.png), when asked for and present. */
    thumbnail_png_base64?: string;
}
export interface ModelPlates {
    plate_count: number;
    plates: ModelPlate[];
    title?: string;
    designer?: string;
    licence?: string;
    /**
     * Every filament the project declares (project_settings.config), used on a plate or not, from 1: slice_stl takes one
     * load_filaments profile per declared filament. Empty for a 3MF that declares none.
     */
    project_filaments: PlateFilament[];
}
export declare function listModelPlates(filePath: string, options?: {
    thumbnails?: boolean;
    paintLimits?: PaintLimits;
}): Promise<ModelPlates>;
