const STATUS_ONLY_PRINTERS = [
    { model: "h3c", display: "H3C", modelIds: ["N10"], serialPrefixes: ["32X"] },
];
/** The same spelling rules as normalizeModel: case, a "Bambu Lab" prefix, spaces, underscores and hyphens don't count. */
function key(value) {
    return value.trim().toLowerCase().replace(/^bambu\s*(?:lab\s*)?/, "").replace(/[\s_-]/g, "");
}
function byIdentity(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const id = value.trim().toUpperCase();
    const name = key(value);
    return STATUS_ONLY_PRINTERS.find(printer => printer.modelIds.includes(id) || printer.model === name || key(printer.display) === name);
}
function bySerial(serial) {
    if (typeof serial !== "string")
        return undefined;
    const prefix = serial.trim().toUpperCase().slice(0, 3);
    return STATUS_ONLY_PRINTERS.find(printer => printer.serialPrefixes.includes(prefix));
}
/** The status-only model value ("h3c") a reported model id, model name or value names, if any. */
export function statusOnlyModel(value) {
    return byIdentity(value)?.model;
}
/** The status-only model value a returned serial number's prefix names, if any. */
export function statusOnlyModelFromSerial(serial) {
    return bySerial(serial)?.model;
}
/** Bambu's display name ("H3C") for a status-only model id, model name or value. */
export function statusOnlyDisplayName(value) {
    return byIdentity(value)?.display;
}
/** Bambu's display name for a status-only printer's serial number. */
export function statusOnlyDisplayNameFromSerial(serial) {
    return bySerial(serial)?.display;
}
export function isStatusOnlyModel(value) {
    return byIdentity(value) !== undefined;
}
const UNSUPPORTED = "printing, uploading a printable file, heating, resuming and clearing errors are not supported on it yet";
/** Why an operation on a printer that reported itself as status-only was refused before anything was sent to it. */
export function statusOnlyMessage(value) {
    const display = statusOnlyDisplayName(value) ?? String(value);
    return `This printer identifies itself as a Bambu Lab ${display}. This server shows its status only: ` +
        `${UNSUPPORTED}, so nothing was sent. Stop and heater-off still work.`;
}
/** Why a status-only model was refused as a bambu_model value. */
export function statusOnlyModelValueMessage(value) {
    const display = statusOnlyDisplayName(value) ?? String(value);
    return `bambu_model "${String(value).trim()}": this server recognises the Bambu Lab ${display} in printer status only; ` +
        `${UNSUPPORTED}, so it is not a bambu_model value.`;
}
