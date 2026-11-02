export type StudioOptionValue = "off" | "on" | "auto";
export type StudioOptionSource = "caller" | "studio-config" | "studio-default";
/** Explicit caller choices; each one wins over Studio's resolution. */
export type CallerPrintOptions = {
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    /** 0 off, 1 on, 2 auto, as Studio's getValueInt. */
    autoBedLeveling?: number;
    autoFlowCali?: number;
    autoOffsetCali?: number;
    extruderCaliManualMode?: number;
};
export type StudioPrintOptions = {
    printerType?: string;
    values: {
        bed_leveling: StudioOptionValue;
        flow_cali: StudioOptionValue;
        nozzle_offset_cali: StudioOptionValue;
    };
    sources: {
        bed_leveling: StudioOptionSource;
        flow_cali: StudioOptionSource;
        nozzle_offset_cali: StudioOptionSource;
    };
    task_bed_leveling: boolean;
    task_flow_cali: boolean;
    task_vibration_cali: boolean;
    task_layer_inspect: boolean;
    auto_bed_leveling: number;
    auto_flow_cali: number;
    auto_offset_cali: number;
    extruder_cali_manual_mode: number;
};
/** Where Studio keeps BambuStudio.conf; BAMBU_STUDIO_CONFIG overrides it (empty: none). */
export declare function studioConfigPath(): string | undefined;
/**
 * The Send dialog options Studio saved for a printer type, and nothing else:
 * BambuStudio.conf also holds access codes, so only that one section is kept,
 * and a parse failure is reported without any of the file's text.
 */
export declare function readStudioSavedOptions(printerTypes: string[], configPath: string | undefined): Record<string, string> | undefined;
/**
 * What Studio's Send dialog would send for this model, with the caller's
 * explicit choices taking precedence. usedNozzles is the number of nozzles the
 * job uses, for dual-nozzle printers.
 */
export declare function resolveStudioPrintOptions(model: string, caller?: CallerPrintOptions, options?: {
    usedNozzles?: number;
    configPath?: string;
}): StudioPrintOptions;
/** The number of nozzles a job's used filaments print from, when the inspection knows. */
export declare function usedNozzleCount(inspection: {
    usedFilamentPositions: number[];
    filamentNozzleIndices?: Array<number | undefined>;
}): number | undefined;
