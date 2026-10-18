export function describeAmsTrayRange(options = {}) {
    return options.dualNozzle
        ? "[-1, 15] (absolute tray), 128-253 (AMS-HT), 254 (left/deputy external) or 255 (right/main external)"
        : "[-1, 15] (absolute tray) or 128-254 (HT/external)";
}
export function normalizeBridgeAmsTrayValue(value, label, options = {}) {
    let numeric;
    if (typeof value === "number") {
        numeric = value;
    }
    else if (typeof value === "string" && value.trim() !== "") {
        numeric = Number(value);
    }
    else {
        throw new Error(`${label} must be an integer tray index; got ${JSON.stringify(value)}`);
    }
    if (!Number.isInteger(numeric) ||
        numeric < -1 ||
        (numeric > 15 && numeric < 128) ||
        numeric > (options.dualNozzle ? 255 : 254)) {
        throw new Error(`${label} must be an integer in ${describeAmsTrayRange(options)}; got ${JSON.stringify(value)}`);
    }
    return numeric;
}
function isNumericMappingKey(key) {
    const numeric = Number(key);
    return Number.isInteger(numeric) && numeric >= 0;
}
export function normalizeAmsMappingObject(mapping, label = "ams_mapping", options = {}) {
    return Object.entries(mapping)
        .sort(([leftKey], [rightKey]) => {
        const leftNumeric = isNumericMappingKey(leftKey);
        const rightNumeric = isNumericMappingKey(rightKey);
        if (leftNumeric && rightNumeric)
            return Number(leftKey) - Number(rightKey);
        if (leftNumeric)
            return -1;
        if (rightNumeric)
            return 1;
        return 0;
    })
        .map(([key, value]) => normalizeBridgeAmsTrayValue(value, `${label}[${key}]`, options));
}
export function hasAmsMappingInput(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (value && typeof value === "object")
        return Object.keys(value).length > 0;
    return value !== undefined && value !== null;
}
/** Flat wire entries use -1 for dual-nozzle virtual trays; ams_mapping2 identifies their spool. */
export function bridgeAmsMappingValue(value, dualNozzle = false) {
    return dualNozzle && (value === 254 || value === 255) ? -1 : value;
}
/** Select an external spool only from a verified physical nozzle on dual-nozzle printers. */
export function externalTrayForNozzle(nozzle, dualNozzle = false) {
    if (!dualNozzle)
        return 254;
    if (nozzle === 0)
        return 255;
    if (nozzle === 1)
        return 254;
    throw new Error("External-spool printing requires inspected filament_map and physical_extruder_map nozzle bindings.");
}
/** Virtual trays use slot zero on dual-nozzle printers; retain the historical single-nozzle form. */
export function bridgeAmsMapping2Entry(value, dualNozzle = false) {
    if (value < 0)
        return { ams_id: 255, slot_id: 255 };
    if (value === 255)
        return dualNozzle ? { ams_id: 255, slot_id: 0 } : { ams_id: 255, slot_id: 255 };
    if (value === 254)
        return { ams_id: 254, slot_id: dualNozzle ? 0 : 254 };
    if (value >= 128)
        return { ams_id: 128, slot_id: value - 128 };
    return { ams_id: Math.floor(value / 4), slot_id: value % 4 };
}
