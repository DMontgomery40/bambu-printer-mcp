import { BambuClient } from "bambu-node";
export declare const SERIAL_MODELS: Record<string, string>;
/** Only raw reports received after this request are evidence. Never read printer.data here. */
export declare function readFreshPrinterStatus(printer: BambuClient, serial: string, timeoutMs?: number): Promise<any>;
export interface PrinterStateRequirements {
    model: string;
    nozzleDiameters: number[];
    materials?: string[];
    usedFilamentPositions?: number[];
    /** Verified physical nozzle index for each project filament, composed from the inspected plate mappings. */
    filamentNozzleIndices?: number[];
    amsMapping?: number[];
    useAMS?: boolean;
    requireIdle?: boolean;
    /** Raw gcode_file transport cannot load a mapped spool before printing. */
    requireLoadedFilament?: boolean;
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
/** Nozzles whose reported diameter and type are configured settings rather than chip readings. */
export declare function unchippedNozzles(raw: unknown): number[];
/** The one key format for a reported entry, shared by the gate and clear_hms_errors. */
export declare function reportedHmsKey(entry: unknown): string;
/** Bambu's display form of a cleared-code key such as "hms:83887616:131184"; other keys unchanged. */
export declare function describeHmsKey(key: string): string;
/** Labels of reported entries that pass only because Bambu hides them for this printer. */
export declare function hiddenHmsNotices(raw: unknown, serial: string, model: string): string[];
/** Cleared-code keys of reported hidden entries; clearing never removes them, so they are not re-acknowledged. */
export declare function hiddenHmsKeys(raw: unknown, serial: string, model: string): string[];
/** Verifies reported configuration, not a physical nozzle/spool inspection. */
export declare function validatePrinterState(status: any, requirements: PrinterStateRequirements): ValidatedPrinterState;
/** Manual M104 cannot remap filament slots. Validate the material already at the nozzle. */
export declare function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string): PrinterStateRequirements;
export type ExternalStorageState = "none" | "normal" | "abnormal" | "readonly";
/**
 * The SD card or USB stick state, read as Bambu Studio does: the `sdcard`
 * flag, then `home_flag` bits 8-9, then on firmware that reports cfg/fun/aux/stat
 * the `aux` bits 12-13, each later source overriding the earlier one
 * (DevStorage.cpp, DeviceManager.cpp parse_home_flag and parse_new_info).
 */
export declare function externalStorageState(raw: unknown): ExternalStorageState;
export {};
