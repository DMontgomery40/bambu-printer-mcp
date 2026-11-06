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
export declare function analyze3MFPlateObjects(filePath: string, plateIndex?: number): Promise<ThreeMFPlateObjects>;
