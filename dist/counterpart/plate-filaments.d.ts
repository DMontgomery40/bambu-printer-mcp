/**
 * The project filaments each plate of a Bambu Studio / OrcaSlicer 3MF prints with, worked out the way Bambu Studio
 * does it (v02.08.02.61), so a client asks the person to choose spools only for the filaments that plate uses.
 *
 * - A sliced plate: Studio's own record, Metadata/plate_N.json `filament_ids` (0-based), written from the slice.
 * - An unsliced plate: PartPlate::get_extruders_under_cli (src/slic3r/GUI/PartPlate.cpp:1298-1420) over the objects
 *   with an instance on the plate (model_settings.config <model_instance>; an instance with printable="0" in the
 *   3dmodel.model build is skipped, PartPlate.cpp:1321):
 *   - each volume's ModelVolume::get_extruders (src/libslic3r/Model.cpp:3357-3412): negative parts, support blockers
 *     and enforcers print nothing; the volume's painted states (mmu_segmentation, `paint_color`); the volume's own
 *     extruder (ModelVolume::extruder_id, Model.cpp:3295-3306: the part's, else the object's, else 1) unless paint
 *     covers every facet of a model part; and the volume's wall/solid/sparse infill filaments, else the object's;
 *   - the object's layer-range extruders (Metadata/layer_config_ranges.xml, by 1-based model object index);
 *   - the object's feature filaments when separate_filaments_for_features is on;
 *   - the support and support-interface filaments when the object (or the project) prints support or a raft;
 *   - the plate's tool changes (Metadata/custom_gcode_per_layer.xml, CustomGCode::ToolChange = 2,
 *     PartPlate.cpp:1263-1274).
 * Painting is decoded as FacetsAnnotation::set_triangle_from_string (Model.cpp:4631-4650) and
 * TriangleSelector::deserialize (src/libslic3r/TriangleSelector.cpp:2111-2139) read it; this is a reimplementation
 * from that documented behaviour, not Studio's code.
 *
 * Only bounded metadata and mesh text are read; nothing is extracted or run.
 */
import type JSZip from "jszip";
export interface PlateFilament {
    /** 1-based project filament number: slice_stl's load_filaments/filament_colours position, print_3mf's ams_mapping index + 1. */
    index: number;
    /** As the project declares it (project_settings.config filament_colour), #RRGGBB. */
    colour?: string;
    /** project_settings.config filament_type. */
    material?: string;
    /** project_settings.config filament_ids (Bambu's filament id, e.g. GFA00). */
    filament_id?: string;
    /** The first part (else object) on this plate that prints with it; absent for support, painting or tool changes only. */
    name?: string;
}
/**
 * One part on a plate, as the open 3MF standard places it, so a client draws it in its filament's colour without
 * reading slicer files: the mesh object `object_id`, in the model part `path` when that is not the root
 * 3D/3dmodel.model (production extension p:path, as the file names it), and the 1-based project filament it prints
 * with. `painted` is true when the slicer's painting (paint_color) recolours some of its facets.
 */
export interface PlatePart {
    object_id: number;
    /** The root object (a build item's objectid) this part belongs to: copies of one mesh may print in other filaments. */
    build_object_id: number;
    path?: string;
    name: string;
    filament: number;
    painted?: true;
}
type Settings = Map<string, string>;
interface Part {
    id: string;
    subtype: string;
    name: string;
    settings: Settings;
}
interface ObjectEntry {
    id: string;
    name: string;
    settings: Settings;
    parts: Part[];
}
/** model_settings.config objects with their own settings and parts (parts never nest). */
export declare function readModelObjects(settings: string): ObjectEntry[];
/**
 * The filament states a painted facet string holds (0 is "the volume's own filament"). Studio's string is hex,
 * read last character first, each digit four bits low bit first, so the nibbles are the digits in reverse order.
 * Each node is one nibble: two low bits are the split-side count (children = sides + 1); a leaf's state is the high
 * two bits, or, when both are set, 3 + the next nibble + 15 for every preceding 0b1111 nibble.
 */
export declare function paintedStates(paint: string): number[];
/** How much mesh text is read for painting: one file, and all of them together. */
export interface PaintLimits {
    meshBytes: number;
    totalBytes: number;
}
export declare const PAINT_LIMITS: PaintLimits;
export interface PlateLayout {
    /** 1-based plate number. */
    number: number;
    /** model_settings.config object ids with an instance on this plate, in plate order. */
    objectIds: string[];
    /** Each copy on the plate: its object and that object's instance_id (model_settings.config <model_instance>). */
    instances?: {
        objectId: string;
        instanceId: number;
    }[];
    /** Metadata/plate_N.json filament_ids (0-based) when the file holds this plate's slice. */
    slicedFilamentIds?: number[];
    /** The file has no plate metadata: this one plate holds every build item. */
    allItems?: boolean;
}
/**
 * The filaments each plate prints with, keyed by plate number. `settings` is model_settings.config, `model` the root
 * 3D/3dmodel.model text.
 */
export declare function plateFilaments(zip: JSZip, settings: string, model: string, plates: PlateLayout[], limits?: PaintLimits): Promise<{
    plates: Map<number, PlateFilament[]>;
    incomplete: Set<number>;
    project: PlateFilament[];
    buildItems: Map<number, number[]>;
    parts: Map<number, PlatePart[]>;
}>;
export {};
