/** Tray-value options. `dualNozzle` admits 255, the right/main nozzle external spool that
 * dual-nozzle printers report beside the left/deputy external spool 254 (Bambu Studio
 * VIRTUAL_TRAY_MAIN_ID / VIRTUAL_TRAY_DEPUTY_ID). Single-nozzle printers keep 254 only. */
export interface AmsTrayValueOptions {
    dualNozzle?: boolean;
}
export declare function describeAmsTrayRange(options?: AmsTrayValueOptions): string;
export declare function normalizeBridgeAmsTrayValue(value: unknown, label: string, options?: AmsTrayValueOptions): number;
export declare function normalizeAmsMappingObject(mapping: Record<string, unknown>, label?: string, options?: AmsTrayValueOptions): number[];
export declare function hasAmsMappingInput(value: unknown): boolean;
/** Flat wire entries use -1 for dual-nozzle virtual trays; ams_mapping2 identifies their spool. */
export declare function bridgeAmsMappingValue(value: number, dualNozzle?: boolean): number;
/** Select an external spool only from a verified physical nozzle on dual-nozzle printers. */
export declare function externalTrayForNozzle(nozzle: number | undefined, dualNozzle?: boolean): number;
/** Virtual trays use slot zero on dual-nozzle printers; retain the historical single-nozzle form. */
export declare function bridgeAmsMapping2Entry(value: number, dualNozzle?: boolean): {
    ams_id: number;
    slot_id: number;
};
/** A project filament as the sliced 3MF's Metadata/project_settings.config declares it. */
export interface ProjectFilament {
    type: string;
    filamentId: string;
    colour: string;
    nozzle?: number;
}
/** Read every project filament (not just the plate's used ones) from project_settings.config. */
export declare function projectFilaments(projectSettings: Record<string, unknown>): ProjectFilament[];
/** The colour the printer reports for an absolute tray value (AMS, AMS-HT or external spool). */
export declare function trayColour(rawStatus: any, tray: number): string | undefined;
/**
 * PrintParams.ams_mapping_info exactly as Bambu Studio and FULU's slicer build it
 * (SelectMachineDialog::get_ams_mapping_result) and send it with every print: one entry per
 * project filament. A mapped filament names its tray, its filament id and type, its colour as
 * #RRGGBBAA and the tray's colour as the printer reports it; an unmapped one carries ams -1.
 * Filament-map nozzle 1 (left) is cloud nozzle 1 and 2 (right) is 0 (CloudTaskNozzleId).
 */
export declare function studioAmsMappingInfo(filaments: ProjectFilament[], mapping: number[], colourOfTray: (tray: number) => string | undefined): Array<Record<string, unknown>>;
