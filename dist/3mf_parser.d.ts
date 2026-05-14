import { ThreeMFData, CollarCharmAnalysis, ThreeMFAmsRequirements, ThreeMFPlateObjects } from './types.js';
export { ThreeMFData };
export declare function parse3MF(filePath: string): Promise<ThreeMFData>;
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
