import { type PrinterInfo } from "./schemas.js";
/** Backends that slice through the Bambu Studio / OrcaSlicer CLI, where supports, copies and auto-orient all apply. */
export declare const BAMBU_CLI_SLICERS: readonly ["bambustudio", "orcaslicer", "orcaslicer-bambulab"];
/**
 * What slice_stl applies on each backend: the Bambu Studio / OrcaSlicer CLIs take all three; remote orca-slicer-api
 * takes supports and orient but refuses repetitions; PrusaSlicer, Slic3r and Cura take none of them here.
 */
export declare function bambuSliceCapabilities(slicerType: string | undefined): {
    supports: boolean;
    copies: boolean;
    orient: boolean;
};
/** The maker's own name for this model ("Bambu Lab P1S"), so a client shows it as given and composes nothing. */
export declare const BAMBU_MAKER = "Bambu Lab";
export declare function bambuPrinterInfo(options: {
    server: {
        name: string;
        version: string;
    };
    host: string;
    serial?: string;
    model?: string;
    slicerType?: string;
}): PrinterInfo;
