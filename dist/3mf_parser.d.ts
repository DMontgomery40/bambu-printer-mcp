import { ThreeMFData, CollarCharmAnalysis, ThreeMFAmsRequirements, ThreeMFPlateObjects } from './types.js';
/** Whether a 3MF carries a slicer settings file at all (readable or not). */
export declare function hasSlicerSettingsFile(filePath: string): Promise<boolean>;
export { ThreeMFData };
export declare function parse3MF(filePath: string): Promise<ThreeMFData>;
/** Whether a 3MF carries its own Bambu Studio/Orca process (a designer's project, not a bare mesh archive). */
export declare function hasBambuProjectSettings(filePath: string): Promise<boolean>;
/** Runs one operation; the directory of every settings file extracted during it is removed when it settles. */
export declare function withExtractedSettingsCleanup<T>(operation: () => Promise<T>): Promise<T>;
/**
 * Writes a 3MF's slicer settings to a file of their own and returns its path. Each extraction gets its own directory,
 * removed when the surrounding withExtractedSettingsCleanup operation settles. `keep` is for a path handed back to the
 * caller: it is named by content, so repeat calls reuse one file, and written whole before it is renamed into place.
 */
export declare function extractBambuTemplateSettings(filePath: string, outputDir: string, options?: {
    keep?: boolean;
}): Promise<string>;
export declare function analyzeCollarCharm3MF(filePath: string, plateIndex?: number): Promise<CollarCharmAnalysis>;
export declare function getCollarCharmRolePolicy(): {
    colors: {
        readonly inner: "black";
        readonly outer: "white";
    };
    amsSlots: {
        readonly inner: 0;
        readonly outer: 4;
    };
};
export declare function analyze3MFAmsRequirements(filePath: string, plateIndex?: number): Promise<ThreeMFAmsRequirements>;
/**
 * The objects of one sliced plate that the printer can skip, as Bambu Studio lists them in its skip dialog
 * (02.08.02.61 slic3r/GUI/PartSkipDialog.cpp:734-741, SkipPartCanvas.cpp:690-730): one entry per instance
 * from Metadata/slice_info.config's plate whose `index` matches (written per instance at bbs_3mf.cpp:8718-8750),
 * with its identify_id. plate_N.json's bbox_objects are not paired by position: their `id` is an internal
 * object id the printer doesn't know (BambuStudio.cpp:7374-7382), and copies share a name. The wipe tower
 * is never a slice_info object.
 */
export declare function analyze3MFPlateObjects(filePath: string, plateIndex?: number): Promise<ThreeMFPlateObjects>;
