import * as THREE from 'three';
import { EventEmitter } from 'events';
export type ProgressCallback = (progress: number, message?: string) => void;
export type OperationResult = {
    success: boolean;
    filePath?: string;
    error?: string;
    operationId: string;
};
export type TransformationType = 'scale' | 'rotate' | 'translate' | 'extendBase' | 'customModify';
export type TransformationAxis = 'x' | 'y' | 'z' | 'all';
export type BoundingBox = {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    dimensions: THREE.Vector3;
};
export type TransformationParams = {
    type: TransformationType;
    axis?: TransformationAxis;
    value: number | number[];
    relative?: boolean;
    selectionBounds?: THREE.Box3;
};
export interface BambuSliceOptions {
    uptodate?: boolean;
    repetitions?: number;
    orient?: boolean;
    arrange?: boolean;
    ensureOnBed?: boolean;
    cloneObjects?: string;
    skipObjects?: string;
    loadFilaments?: string;
    loadFilamentIds?: string;
    bedType?: string;
    enableTimelapse?: boolean;
    allowMixTemp?: boolean;
    scale?: number;
    rotate?: number;
    rotateX?: number;
    rotateY?: number;
    minSave?: boolean;
    skipModifiedGcodes?: boolean;
    slicePlate?: number;
}
export declare class STLManipulator extends EventEmitter {
    private tempDir;
    private activeOperations;
    constructor(tempDir?: string);
    /**
     * Generate a unique operation ID
     */
    private generateOperationId;
    private getAvailableProfileRoots;
    private findProfileFile;
    private buildFilamentIdIndex;
    private readJsonFile;
    private stripAbsoluteExtruderResets;
    private sanitizeProcessForOrca;
    private writeTempJson;
    private resolveBambuLikeSettingsBundle;
    /**
     * Optionally rewrite a Bambu-like settings bundle so the paths point at
     * fully-flattened temp configs instead of the BBL-shipped leaf JSONs.
     *
     * BambuStudio's CLI does not resolve the `inherits` chain when loading
     * profiles via --load-settings / --load-filaments, which causes a
     * cluster of upstream bugs (see https://github.com/bambulab/BambuStudio/issues/9636
     * and #9968). Our flattener (src/slicer/profile-flatten.ts) reproduces
     * what the GUI does at slice time so the CLI accepts the configs.
     *
     * Opt-in via `BAMBU_CLI_FLATTEN=true`. When the env var is unset or
     * not "true"/"1", returns the bundle unchanged so behavior is
     * backward-compatible. When enabled, only BBL-shipped leaves get
     * flattened; user-provided custom configs pass through untouched.
     */
    private maybeFlattenBundle;
    private resolveBambuStudioBedType;
    /** Read a profile JSON's top-level `name` field, or null if unreadable. */
    private readLeafName;
    /**
     * Load STL file and return geometry and bounding box
     */
    private loadSTL;
    /**
     * Save a geometry to STL file
     */
    private saveSTL;
    /**
     * Get comprehensive information about an STL file
     */
    getSTLInfo(stlFilePath: string): Promise<{
        filePath: string;
        fileName: string;
        fileSize: number;
        boundingBox: BoundingBox;
        vertexCount: number;
        faceCount: number;
        objects?: Array<{
            name: string;
            vertexCount: number;
            faceCount: number;
            boundingBox: BoundingBox;
        }>;
    }>;
    /**
     * Extract mesh info from a 3MF file by parsing the XML object models.
     */
    private get3MFInfo;
    /**
     * Scale an STL model uniformly or along specific axes
     */
    scaleSTL(stlFilePath: string, scaleFactors: number | [number, number, number], progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate an STL model around specific axes
     */
    rotateSTL(stlFilePath: string, rotationAngles: [number, number, number], // [x, y, z] in degrees
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Translate (move) an STL model along specific axes
     */
    translateSTL(stlFilePath: string, translationValues: [number, number, number], // [x, y, z] in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Cancel an ongoing operation
     */
    cancelOperation(operationId: string): boolean;
    /**
     * Generate an SVG visualization of an STL file from multiple angles
     * @param stlFilePath Path to the STL file
     * @param width Width of each view in pixels
     * @param height Height of each view in pixels
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated SVG file
     */
    generateVisualization(stlFilePath: string, width?: number, height?: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    modifySection(stlFilePath: string, selection: THREE.Box3 | 'top' | 'bottom' | 'center', transformation: TransformationParams, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Enhanced version of extendBase with progress reporting
     * @param stlFilePath Path to the input STL file
     * @param extensionInches Amount to extend base in inches
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the modified STL file
     */
    extendBase(stlFilePath: string, extensionInches: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Slice an STL or 3MF file using the specified slicer
     * @param stlFilePath Path to the input STL or 3MF file
     * @param slicerType Type of slicer (prusaslicer, cura, slic3r, orcaslicer, bambustudio)
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Optional path to the slicer profile/config file
     * @param progressCallback Optional callback for progress updates
     * @param printerPreset Optional BambuStudio printer preset name (e.g., "Bambu Lab P1S 0.4 nozzle")
     * @param bambuOptions Optional BambuStudio-specific CLI flags
     * @returns Path to the generated G-code or sliced 3MF file
     */
    sliceSTL(stlFilePath: string, slicerType: 'prusaslicer' | 'cura' | 'slic3r' | 'orcaslicer' | 'bambustudio', slicerPath: string, slicerProfile?: string, progressCallback?: ProgressCallback, printerPreset?: string, bambuOptions?: BambuSliceOptions): Promise<string>;
    /**
     * Enhanced version of confirmTemperatures with better error handling
     * @param gcodePath Path to the G-code file
     * @param expected Expected temperature settings
     * @param progressCallback Optional callback for progress updates
     * @returns Object with comparison results
     */
    confirmTemperatures(gcodePath: string, expected: {
        extruder?: number;
        bed?: number;
    }, progressCallback?: ProgressCallback): Promise<{
        match: boolean;
        actual: {
            extruder?: number;
            bed?: number;
        };
        expected: {
            extruder?: number;
            bed?: number;
        };
        allTemperatures: {
            extruder: number[];
            bed: number[];
        };
    }>;
    /**
     * Merge vertices within a specified tolerance.
     */
    mergeVertices(stlFilePath: string, tolerance?: number, // Default tolerance in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Center the model at the origin (0,0,0).
     */
    centerModel(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate the model so its largest flat face lies on the XY plane (Z=0).
     */
    layFlat(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
}
