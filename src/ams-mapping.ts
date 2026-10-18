/** Tray-value options. `dualNozzle` admits 255, the right/main nozzle external spool that
 * dual-nozzle printers report beside the left/deputy external spool 254 (Bambu Studio
 * VIRTUAL_TRAY_MAIN_ID / VIRTUAL_TRAY_DEPUTY_ID). Single-nozzle printers keep 254 only. */
export interface AmsTrayValueOptions { dualNozzle?: boolean }

export function describeAmsTrayRange(options: AmsTrayValueOptions = {}): string {
  return options.dualNozzle
    ? "[-1, 15] (absolute tray), 128-253 (AMS-HT), 254 (left/deputy external) or 255 (right/main external)"
    : "[-1, 15] (absolute tray) or 128-254 (HT/external)";
}

export function normalizeBridgeAmsTrayValue(value: unknown, label: string, options: AmsTrayValueOptions = {}): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else {
    throw new Error(`${label} must be an integer tray index; got ${JSON.stringify(value)}`);
  }

  if (
    !Number.isInteger(numeric) ||
    numeric < -1 ||
    (numeric > 15 && numeric < 128) ||
    numeric > (options.dualNozzle ? 255 : 254)
  ) {
    throw new Error(
      `${label} must be an integer in ${describeAmsTrayRange(options)}; got ${JSON.stringify(value)}`
    );
  }

  return numeric;
}

function isNumericMappingKey(key: string): boolean {
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric >= 0;
}

export function normalizeAmsMappingObject(mapping: Record<string, unknown>, label = "ams_mapping", options: AmsTrayValueOptions = {}): number[] {
  return Object.entries(mapping)
    .sort(([leftKey], [rightKey]) => {
      const leftNumeric = isNumericMappingKey(leftKey);
      const rightNumeric = isNumericMappingKey(rightKey);
      if (leftNumeric && rightNumeric) return Number(leftKey) - Number(rightKey);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return 0;
    })
    .map(([key, value]) => normalizeBridgeAmsTrayValue(value, `${label}[${key}]`, options));
}

export function hasAmsMappingInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return value !== undefined && value !== null;
}

/** Flat wire entries use -1 for dual-nozzle virtual trays; ams_mapping2 identifies their spool. */
export function bridgeAmsMappingValue(value: number, dualNozzle = false): number {
  return dualNozzle && (value === 254 || value === 255) ? -1 : value;
}

/** Select an external spool only from a verified physical nozzle on dual-nozzle printers. */
export function externalTrayForNozzle(nozzle: number | undefined, dualNozzle = false): number {
  if (!dualNozzle) return 254;
  if (nozzle === 0) return 255;
  if (nozzle === 1) return 254;
  throw new Error("External-spool printing requires inspected filament_map and physical_extruder_map nozzle bindings.");
}

/** Virtual trays use slot zero on dual-nozzle printers; retain the historical single-nozzle form. */
export function bridgeAmsMapping2Entry(value: number, dualNozzle = false): { ams_id: number; slot_id: number } {
  if (value < 0) return { ams_id: 255, slot_id: 255 };
  if (value === 255) return dualNozzle ? { ams_id: 255, slot_id: 0 } : { ams_id: 255, slot_id: 255 };
  if (value === 254) return { ams_id: 254, slot_id: dualNozzle ? 0 : 254 };
  if (value >= 128) return { ams_id: 128, slot_id: value - 128 };
  return { ams_id: Math.floor(value / 4), slot_id: value % 4 };
}
