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
