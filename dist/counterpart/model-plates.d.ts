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
    /** The plate's own preview from the file (Metadata/plate_N.png), when asked for and present. */
    thumbnail_png_base64?: string;
}
export interface ModelPlates {
    plate_count: number;
    plates: ModelPlate[];
    title?: string;
    designer?: string;
    licence?: string;
}
export declare function listModelPlates(filePath: string, options?: {
    thumbnails?: boolean;
}): Promise<ModelPlates>;
