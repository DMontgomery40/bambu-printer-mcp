/**
 * HMS and print-error text from the user's own Bambu Studio download, for
 * codes the tables bundled at the pinned Studio tag lack (it bundles no P1,
 * X1 or A1 table). Bambu Studio downloads hms_en_<serial prefix>.json and
 * hms_en.json into an hms folder next to BambuStudio.conf; this reads them
 * read-only and returns Bambu's text unchanged, with no advice added. The
 * files are Bambu's and are never copied or redistributed.
 */
import fs from "node:fs";
import path from "node:path";
import { studioConfigPath } from "./studio-print-options.js";

type Table = { hms: Map<string, string>; error: Map<string, string> };
const cache = new Map<string, { mtimeMs: number; size: number; table: Table | undefined }>();

function entries(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(value)) return map;
  for (const entry of value) {
    const code = typeof entry?.ecode === "string" ? entry.ecode.trim().toUpperCase() : "";
    const text = typeof entry?.intro === "string" ? entry.intro.trim() : "";
    if (/^[0-9A-F]{8}([0-9A-F]{8})?$/.test(code) && text) map.set(code, text);
  }
  return map;
}

function load(file: string): Table | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return undefined; }
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return undefined;
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.table;
  let table: Table | undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))?.data;
    table = { hms: entries(data?.device_hms?.en), error: entries(data?.device_error?.en) };
  } catch { table = undefined; }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, table });
  return table;
}

/** Bambu Studio's downloaded text for a 16-hex HMS code or an 8-hex print_error code, by serial prefix, else from hms_en.json. */
export function studioDownloadedText(kind: "hms" | "error", code: string, serial: string): string | undefined {
  const config = studioConfigPath();
  if (!config) return undefined;
  const directory = path.join(path.dirname(config), "hms");
  const prefix = serial.trim().toUpperCase().slice(0, 3);
  const files = [...(/^[0-9A-Z]{3}$/.test(prefix) ? [`hms_en_${prefix}.json`] : []), "hms_en.json"];
  for (const name of files) {
    const text = load(path.join(directory, name))?.[kind].get(code.toUpperCase());
    if (text) return text;
  }
  return undefined;
}
