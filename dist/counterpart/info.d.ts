import { type PrinterInfo } from "./schemas.js";
export declare function bambuPrinterInfo(options: {
    server: {
        name: string;
        version: string;
    };
    host: string;
    serial?: string;
    model?: string;
}): PrinterInfo;
