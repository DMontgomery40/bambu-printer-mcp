export function normalizeModelName(model: unknown): string {
  return String(model ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export const P1_MODELS = new Set(["p1s", "p1p"]);
export const P2_MODELS = new Set(["p2s"]);
export const H2_MODELS = new Set(["h2", "h2c", "h2d", "h2dpro", "h2d pro", "h2s"]);
export const X1_MODELS = new Set(["x1", "x1c", "x1carbon", "x1e"]);
export const X2_MODELS = new Set(["x2d"]);
export const A1_MODELS = new Set(["a1", "a1mini"]);

export const LEGACY_SDCARD_PRINT_MODELS = new Set([
  ...P1_MODELS,
  ...X1_MODELS,
  ...A1_MODELS,
]);

const LEGACY_SERIAL_PREFIXES = ["01P", "01S", "00M", "00W", "03W", "030", "039"];
const ROOT_FTP_SERIAL_PREFIXES = ["22E", "093", "094", "239", "31B", "20P"];

export function isLegacySdcardPrintModel(model: unknown): boolean {
  return LEGACY_SDCARD_PRINT_MODELS.has(normalizeModelName(model));
}

/** x1/p1/a1 -> /cache. p2/h2/x2 -> ftp root + ams_mapping2. model wins over serial. */
export function usesRootFtpPrintPath(model?: unknown, serial?: string): boolean {
  const m = normalizeModelName(model);
  const sn = String(serial ?? "");

  if (P2_MODELS.has(m) || H2_MODELS.has(m) || X2_MODELS.has(m)) return true;
  if (m && isLegacySdcardPrintModel(m)) return false;
  if (ROOT_FTP_SERIAL_PREFIXES.some((p) => sn.startsWith(p))) return true;
  if (LEGACY_SERIAL_PREFIXES.some((p) => sn.startsWith(p))) return false;
  if (m) return true;
  return false;
}
