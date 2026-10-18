import type { BambuSliceOptions } from '../stl/stl-manipulator.js';
export declare function validateRemoteSliceOptions(options?: BambuSliceOptions): number;
/** Upload only locally prepared profiles, then inspect the exact downloaded 3MF. */
export declare function sliceWithOrcaApi(input: {
    inputPath: string;
    machinePath: string;
    processPath: string;
    filamentPaths: string[];
    outputPath: string;
    options?: BambuSliceOptions;
    isCancelled: () => boolean;
}): Promise<string>;
