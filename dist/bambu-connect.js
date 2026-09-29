import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const BAMBU_CONNECT_APP_PATH = "/Applications/Bambu Connect.app";
const BAMBU_CONNECT_SCHEME = "bambu-connect://import-file";
function resolveImportFilePath(rawPath) {
    const trimmed = rawPath.trim();
    if (!trimmed) {
        throw new Error("file_path is required.");
    }
    const filePath = path.resolve(trimmed);
    if (!/\.(?:gcode|3mf)$/i.test(filePath)) {
        throw new Error("Bambu Connect import accepts a .gcode or .3mf file.");
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
        fs.accessSync(filePath, fs.constants.R_OK);
    }
    catch {
        throw new Error(`Bambu Connect import file is not readable: ${filePath}`);
    }
    if (!stat.isFile()) {
        throw new Error(`Bambu Connect import path is not a regular file: ${filePath}`);
    }
    return filePath;
}
function defaultImportName(filePath) {
    const name = path.basename(filePath)
        .replace(/\.gcode\.3mf$/i, "")
        .replace(/\.3mf$/i, "")
        .replace(/\.gcode$/i, "")
        .trim();
    return name || "Bambu print";
}
export function buildBambuConnectImportUrl(options) {
    const filePath = resolveImportFilePath(options.filePath);
    const name = options.name?.trim() || defaultImportName(filePath);
    const version = options.version?.trim() || "1.0.0";
    if (!version) {
        throw new Error("version must not be empty.");
    }
    const url = new URL(BAMBU_CONNECT_SCHEME);
    url.searchParams.set("path", filePath);
    url.searchParams.set("name", name);
    url.searchParams.set("version", version);
    return url.toString();
}
export async function importFileViaBambuConnect(options) {
    if (process.platform !== "darwin") {
        throw new Error("Bambu Connect URL handoff is currently supported only on macOS.");
    }
    if (!fs.existsSync(BAMBU_CONNECT_APP_PATH)) {
        throw new Error(`Bambu Connect is not installed at ${BAMBU_CONNECT_APP_PATH}.`);
    }
    const filePath = resolveImportFilePath(options.filePath);
    const name = options.name?.trim() || defaultImportName(filePath);
    const version = options.version?.trim() || "1.0.0";
    const url = buildBambuConnectImportUrl({ filePath, name, version });
    const { stdout, stderr } = await execFileAsync("/usr/bin/open", ["-a", BAMBU_CONNECT_APP_PATH, url], { encoding: "utf8", timeout: 30000 });
    return {
        status: "handoff_ready",
        app: "Bambu Connect",
        app_path: BAMBU_CONNECT_APP_PATH,
        route: BAMBU_CONNECT_SCHEME,
        file_path: filePath,
        project_name: name,
        version,
        opened: true,
        url,
        stdout: String(stdout || "").trim() || undefined,
        stderr: String(stderr || "").trim() || undefined,
        note: "The file was handed to Bambu Connect. Review the selected printer and plate there, then start printing from Bambu Connect when ready; this handoff does not start a print by itself.",
    };
}
