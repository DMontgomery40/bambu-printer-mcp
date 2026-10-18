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

/** One `ams_mapping2` entry for a flat project-level tray value. Unused positions are
 * the firmware sentinel {255,255}. External spools keep the existing {254,254} form for
 * the (single or left/deputy) external spool; the right/main external spool 255 of a
 * dual-nozzle printer is sent as ams_id 255 with slot_id 0, the virtual-slot form Bambu
 * Studio builds (SelectMachine.cpp sets slot_id "0" for VIRTUAL_TRAY_* results), which
 * keeps it distinct from the unused sentinel. */
export function bridgeAmsMapping2Entry(value: number, dualNozzle = false): { ams_id: number; slot_id: number } {
  if (value < 0) return { ams_id: 255, slot_id: 255 };
  if (value === 255) return dualNozzle ? { ams_id: 255, slot_id: 0 } : { ams_id: 255, slot_id: 255 };
  if (value === 254) return { ams_id: 254, slot_id: 254 };
  if (value >= 128) return { ams_id: 128, slot_id: value - 128 };
  return { ams_id: Math.floor(value / 4), slot_id: value % 4 };
}
