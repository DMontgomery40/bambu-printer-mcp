/**
 * Printers this server recognises in printer status but cannot print, heat, resume or clear errors on yet.
 *
 * They are deliberately absent from MACHINE_LIMITS (limits.ts, so normalizeModel never returns them and no
 * temperature or file check can pass), from the bambu_model choices (VALID_BAMBU_MODELS), from the setup and
 * discovery tables (SERIAL_MODELS, MODEL_IDS in printer-state.ts) and from every route set (dual-nozzle, H2 FTPS
 * root, cancelled-job, camera). Recognising one only names it: a fresh report that identifies one resolves to its
 * value here, and validatePrinterState and hardware-error clearing refuse it before anything is sent. Stop and
 * heater-off need no identity and stay available.
 *
 * H3C: Bambu Studio v02.09.01.70 (commit 56a57d00a591360cf41bf21383915ee5bf357be5), resources/printers/N10.json:
 * display_name "Bambu Lab H3C", model_id "N10", sn_prefix "32X". This is source-derived: no H3C report has been
 * captured here. Its tool rack, AMS-3H bindings, filament-to-nozzle mapping, G-code forms, upload storage and job
 * command are not implemented, and it is not an H2C or H2D: never alias it to either.
 */
import { modelSpelling } from "./limits.js";

type StatusOnlyPrinter = { model: string; display: string; modelIds: readonly string[]; serialPrefixes: readonly string[] };

const STATUS_ONLY_PRINTERS: readonly StatusOnlyPrinter[] = [
  { model: "h3c", display: "H3C", modelIds: ["N10"], serialPrefixes: ["32X"] },
];

function byIdentity(value: unknown): StatusOnlyPrinter | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const id = value.trim().toUpperCase();
  const name = modelSpelling(value);
  return STATUS_ONLY_PRINTERS.find(printer =>
    printer.modelIds.includes(id) || printer.model === name || modelSpelling(printer.display) === name);
}

function bySerial(serial: unknown): StatusOnlyPrinter | undefined {
  if (typeof serial !== "string") return undefined;
  const prefix = serial.trim().toUpperCase().slice(0, 3);
  return STATUS_ONLY_PRINTERS.find(printer => printer.serialPrefixes.includes(prefix));
}

/** The status-only model value ("h3c") a reported model id, model name or value names, if any. */
export function statusOnlyModel(value: unknown): string | undefined {
  return byIdentity(value)?.model;
}

/** The status-only model value a returned serial number's prefix names, if any. */
export function statusOnlyModelFromSerial(serial: unknown): string | undefined {
  return bySerial(serial)?.model;
}

/** Bambu's display name ("H3C") for a status-only model id, model name or value. */
export function statusOnlyDisplayName(value: unknown): string | undefined {
  return byIdentity(value)?.display;
}

/** Bambu's display name for a status-only printer's serial number. */
export function statusOnlyDisplayNameFromSerial(serial: unknown): string | undefined {
  return bySerial(serial)?.display;
}

/** Whether a model id ("N10"), model name ("Bambu Lab H3C") or model value ("h3c") names a status-only printer. */
export function isStatusOnlyModel(value: unknown): boolean {
  return byIdentity(value) !== undefined;
}

const UNSUPPORTED = "printing, uploading a printable file, heating, resuming and clearing errors are not supported on it yet";

/** Why an operation on a printer that reported itself as status-only was refused before anything was sent to it. */
export function statusOnlyMessage(value: unknown): string {
  const display = statusOnlyDisplayName(value) ?? String(value);
  return `This printer identifies itself as a Bambu Lab ${display}. This server shows its status only: ` +
    `${UNSUPPORTED}, so nothing was sent. Stop and heater-off still work.`;
}

/** Refuses an operation on a printer whose fresh report identified it as status-only, before anything is sent. */
export function assertNotStatusOnly(observedModel: unknown): void {
  if (isStatusOnlyModel(observedModel)) throw new Error(statusOnlyMessage(observedModel));
}

/** Why a status-only model was refused as a bambu_model value. */
export function statusOnlyModelValueMessage(value: unknown): string {
  const display = statusOnlyDisplayName(value) ?? String(value);
  return `bambu_model "${String(value).trim()}": this server recognises the Bambu Lab ${display} in printer status only; ` +
    `${UNSUPPORTED}, so it is not a bambu_model value.`;
}
