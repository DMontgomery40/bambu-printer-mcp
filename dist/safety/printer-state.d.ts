import { BambuClient } from "bambu-node";
/** Only raw reports received after this request are evidence. Never read printer.data here. */
export declare function readFreshPrinterStatus(printer: BambuClient, serial: string, timeoutMs?: number): Promise<any>;
export interface PrinterStateRequirements {
    model: string;
    nozzleDiameters: number[];
    materials?: string[];
    usedFilamentPositions?: number[];
    amsMapping?: number[];
    useAMS?: boolean;
    requireIdle?: boolean;
    /** Upload-only identity checks do not select or consume a physical filament slot. */
    verifyMaterials?: boolean;
    /** Zero-based firmware nozzle indices corresponding positionally to nozzleDiameters. */
    usedNozzleIndices?: number[];
    nozzleTypes?: string[];
    nozzleFlows?: string[];
}
interface ReportedNozzle {
    index: number;
    diameter: number;
    type?: string;
    flow?: string;
}
interface ReportedFilament {
    position: number;
    material: string;
    trayIndex: number;
    nozzleMin?: number;
    nozzleMax?: number;
}
export interface ValidatedPrinterState {
    model: string;
    reportedNozzles: ReportedNozzle[];
    filaments: ReportedFilament[];
}
/** Verifies reported configuration, not a physical nozzle/spool inspection. */
export declare function validatePrinterState(status: any, requirements: PrinterStateRequirements): ValidatedPrinterState;
/** Manual M104 cannot remap filament slots. Validate the material already at the nozzle. */
export declare function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string): PrinterStateRequirements;
export {};
