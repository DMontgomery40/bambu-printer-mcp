export interface ModelPlate {
    /** Zero-based, as inspect_print_file's plate_index; slice_stl's slice_plate is index + 1. */
    index: number;
    name: string;
    objects: string[];
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
