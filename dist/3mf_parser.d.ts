import { ThreeMFData, CollarCharmAnalysis, ThreeMFAmsRequirements, ThreeMFPlateObjects } from './types.js';
export { ThreeMFData };
export declare function parse3MF(filePath: string): Promise<ThreeMFData>;
/** Whether a 3MF carries its own Bambu Studio/Orca process (a designer's project, not a bare mesh archive). */
export declare function hasBambuProjectSettings(filePath: string): Promise<boolean>;
export declare function extractBambuTemplateSettings(filePath: string, outputDir: string): Promise<string>;
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
