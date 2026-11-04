import { type PrinterInfo } from "./schemas.js";
/** What slice_stl applies on each backend: the local slicer CLIs take all three; orca-slicer-api refuses repetitions. */
export declare function bambuSliceCapabilities(slicerType: string | undefined): {
    supports: boolean;
    copies: boolean;
    orient: boolean;
};
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
