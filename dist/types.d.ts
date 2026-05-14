export type BambuFTP = {
    readDir: (path: string) => Promise<string[]>;
    sendFile: (sourcePath: string, destinationPath: string, progressCallback?: (progress: number) => void) => Promise<void>;
    removeFile: (path: string) => Promise<void>;
};
export interface SectionBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}
export interface ThreeMFMetadata {
    [key: string]: string;
}
export interface ThreeMFObject {
    id: string;
    name?: string;
    type?: string;
    mesh?: any;
}
export interface ThreeMFBuildItem {
    objectId: string;
    transform?: string;
}
export interface AMSFilamentMapping {
    [filamentId: string]: number;
}
export interface BambuSlicerConfig {
    layer_height?: number;
    first_layer_height?: number;
    sparse_infill_density?: number;
    sparse_infill_pattern?: string;
    support_enabled?: boolean;
    support_type?: string;
    support_threshold_angle?: number;
    raft_layers?: number;
    brim_width?: number;
    wall_loops?: number;
    top_shell_layers?: number;
    bottom_shell_layers?: number;
    nozzle_temperature?: number[];
    bed_temperature?: number;
    filament_type?: string[];
    flow_ratio?: number[];
    ams_mapping?: AMSFilamentMapping;
    [key: string]: any;
}
export interface ThreeMFData {
    metadata: ThreeMFMetadata;
    objects: ThreeMFObject[];
    build: {
        items: ThreeMFBuildItem[];
    };
    slicerConfig?: Partial<BambuSlicerConfig>;
}
export interface CollarCharmRole {
    role: 'inner' | 'outer';
    objectIndex: number;
    name: string;
    area: number;
    filamentPosition: number;
}
export interface CollarCharmAnalysis {
    plateIndex: number;
    usedFilamentPositions: number[];
    amsSlots: number[];
    roles: CollarCharmRole[];
}
export interface ThreeMFFilamentRequirement {
    filamentPosition: number;
    filamentId: number;
    tray_info_idx: string | null;
    type: string | null;
    color: string | null;
}
export interface ThreeMFAmsRequirements {
    plateIndex: number;
    usedFilamentPositions: number[];
    filaments: ThreeMFFilamentRequirement[];
}
export interface ThreeMFPlateObject {
    id: number;
    name: string;
    area: number | null;
    bbox: unknown;
}
export interface ThreeMFPlateObjects {
    plateIndex: number;
    objects: ThreeMFPlateObject[];
}
