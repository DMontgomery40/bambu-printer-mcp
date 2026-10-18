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
/** One `ams_mapping2` entry for a flat project-level tray value. Unused positions are
 * the firmware sentinel {255,255}. External spools keep the existing {254,254} form for
 * the (single or left/deputy) external spool; the right/main external spool 255 of a
 * dual-nozzle printer is sent as ams_id 255 with slot_id 0, the virtual-slot form Bambu
 * Studio builds (SelectMachine.cpp sets slot_id "0" for VIRTUAL_TRAY_* results), which
 * keeps it distinct from the unused sentinel. */
export declare function bridgeAmsMapping2Entry(value: number, dualNozzle?: boolean): {
    ams_id: number;
    slot_id: number;
};
