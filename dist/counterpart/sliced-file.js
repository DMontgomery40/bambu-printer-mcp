import fs from "node:fs";
import { loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";
import { plainSlicerError, UNKNOWN_SLICER_ERROR } from "../slicer/slicer-messages.js";
const number = (value) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const first = (value) => Array.isArray(value) ? value[0] : value;
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
function headerSettings(text) {
    const read = (pattern) => number(text.match(pattern)?.[1]);
    const layers = read(/^;\s*(?:total layer number|total layers count|LAYER_COUNT)\s*[:=]\s*(\d+)/im);
    const walls = read(/^;\s*(?:wall_loops|perimeters)\s*=\s*(\d+)/im);
    return defined({
        layer_height_mm: read(/^;\s*layer_height\s*=\s*([\d.]+)/im),
        sparse_infill_percent: read(/^;\s*(?:sparse_infill_density|fill_density)\s*=\s*([\d.]+)%/im),
        wall_loops: walls === undefined ? undefined : Math.trunc(walls),
        layer_count: layers ? Math.trunc(layers) : undefined,
    });
}
/** The facts of a sliced 3MF or G-code file for one zero-based plate; what can't be read is left out, never an error. */
export async function slicedFileFacts(filePath, plateIndex = 0) {
    try {
        return await readFacts(filePath, plateIndex);
    }
    catch {
        return { settings: {} };
    }
}
async function readFacts(filePath, plateIndex) {
    const head = Buffer.alloc(4);
    const handle = await fs.promises.open(filePath, "r");
    try {
        await handle.read(head, 0, 4, 0);
    }
    finally {
        await handle.close();
    }
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
        // G-code: PrusaSlicer and Orca write their settings in a footer, others in a header; read both ends.
        const stat = await fs.promises.stat(filePath);
        const size = 256 * 1024;
        const read = async (start) => {
            const buffer = Buffer.alloc(Math.min(size, stat.size));
            const file = await fs.promises.open(filePath, "r");
            try {
                await file.read(buffer, 0, buffer.length, start);
            }
            finally {
                await file.close();
            }
            return buffer.toString("latin1");
        };
        return { plate_count: 1, settings: headerSettings(`${await read(0)}\n${await read(Math.max(0, stat.size - size))}`) };
    }
    const zip = await loadSafe3mfArchive(await readBoundedPrintFile(filePath));
    const plates = new Set(Object.keys(zip.files).flatMap(name => /^Metadata\/plate_([1-9]\d*)\.gcode$/.exec(name)?.[1] ?? []));
    const text = async (name) => zip.file(name)?.async("string");
    let settings = {};
    const project = await text("Metadata/project_settings.config");
    if (project) {
        try {
            const values = JSON.parse(project);
            const infill = String(first(values.sparse_infill_density) ?? "");
            const walls = number(first(values.wall_loops));
            settings = defined({
                layer_height_mm: number(first(values.layer_height)),
                sparse_infill_percent: infill === "" ? undefined : number(infill.replace("%", "")),
                wall_loops: walls === undefined ? undefined : Math.trunc(walls),
            });
        }
        catch { /* the settings stay unknown */ }
    }
    // Only the plate G-code's header, never the whole (often hundreds of MB) as a string.
    const gcode = await zip.file(`Metadata/plate_${plateIndex + 1}.gcode`)?.async("nodebuffer");
    // The project settings are authoritative; the plate's G-code header adds the layer count.
    if (gcode)
        settings = { ...headerSettings(gcode.subarray(0, 64 * 1024).toString("latin1")), ...settings };
    let estimate;
    const info = await text("Metadata/slice_info.config");
    const plate = info?.match(/<plate(?:\s[^>]*)?>[\s\S]*?<\/plate>/g)
        ?.find(block => new RegExp(`<metadata\\s+key=["']index["']\\s+value=["']${plateIndex + 1}["']`).test(block));
    if (plate) {
        const value = (key) => {
            const found = plate.match(new RegExp(`<metadata\\s+key=["']${key}["']\\s+value=["']([^"']+)["']`))?.[1];
            const parsed = found && /^\d+(?:\.\d+)?$/.test(found) ? Number(found) : undefined;
            return parsed !== undefined && parsed > 0 ? parsed : undefined;
        };
        const seconds = value("prediction"), grams = value("weight");
        if (seconds !== undefined || grams !== undefined)
            estimate = defined({ seconds, grams });
    }
    return { ...(plates.size ? { plate_count: plates.size } : {}), ...(estimate ? { estimate } : {}), settings };
}
const clean = (text) => text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim();
/** A refusal's report: the plain sentence, and the slicer's words kept beside it. */
export function refusalReport(words) {
    const raw = clean(words).slice(0, 2000);
    return { failed: true, message: plainSlicerError(raw) ?? UNKNOWN_SLICER_ERROR, ...(raw ? { slicer_message: raw } : {}) };
}
export function slicerReport(result) {
    if (!result || typeof result !== "object" || Array.isArray(result))
        return undefined;
    const value = result;
    const plates = Array.isArray(value.sliced_plates) ? value.sliced_plates : [];
    const ids = plates.map(plate => plate && typeof plate === "object" ? plate.id : undefined);
    const plateCount = ids.length && ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ? new Set(ids).size : undefined;
    const warnings = plates.map(plate => plate && typeof plate.warning_message === "string" ? clean(plate.warning_message) : "").filter(Boolean);
    // Anything but the slicer's success code fails closed, a missing one included.
    const failed = value.return_code !== 0;
    const error = typeof value.error_string === "string" ? clean(value.error_string) : "";
    const words = [...new Set([...(failed && error ? [error] : []), ...warnings])].join("\n").slice(0, 2000);
    if (failed)
        return refusalReport(words || `return code ${String(value.return_code)}`);
    return { failed, ...(words ? { message: words, slicer_message: words } : {}), ...(plateCount ? { plate_count: plateCount } : {}) };
}
