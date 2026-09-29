import { createHash } from "node:crypto";
import { readFreshPrinterStatus } from "../safety/printer-state.js";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { readSafe3mfArchive } from "../safety/archive.js";
import { inspectPrintFile } from "../safety/print-file.js";
import { normalizeModel, validateTemperature } from "../safety/limits.js";
import { validatePrinterState, manualHeatingRequirements } from "../safety/printer-state.js";
import { withPrinterOperation, withPrintSnapshot, uniquePrintName, normalizedRemotePath, cancelPendingPrinterOperations } from "../safety/artifact.js";
import { Client as FTPClient } from "basic-ftp";
import { BambuPrinter } from "bambu-js";
import * as mqtt from "mqtt";
import { BambuClient, GCodeFileCommand, GCodeLineCommand, PushAllCommand, UpdateFanCommand, UpdateLightCommand, UpdateStateCommand, } from "bambu-node";
/**
 * Post-Jan-2025 H2D firmware requires mTLS with a Bambu-issued client cert.
 * Loads cert+key once from:
 *   - BAMBU_CLIENT_CERT / BAMBU_CLIENT_KEY env vars (paths), or
 *   - ~/Desktop/bambu certs/embedded-cert.pem + embedded-key.pem (default)
 * Returns null if files missing — caller falls back to no-cert TLS.
 */
function loadClientCreds() {
    const defaultDir = path.join(os.homedir(), "Desktop", "bambu certs");
    const certPath = process.env.BAMBU_CLIENT_CERT || path.join(defaultDir, "embedded-cert.pem");
    const keyPath = process.env.BAMBU_CLIENT_KEY || path.join(defaultDir, "embedded-key.pem");
    try {
        if (!existsSync(certPath) || !existsSync(keyPath))
            return null;
        return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    }
    catch {
        return null;
    }
}
const CLIENT_CREDS = loadClientCreds();
const COMMAND_SETTLE_MS = 300;
/** HMS 0500-0500-0001-0007: firmware 01.08.05+ rejected an unsigned MQTT command. */
const COMMAND_VERIFICATION_HMS = { attr: 0x05000500, code: 0x00010007 };
const COMMAND_REJECTED_MESSAGE = "The printer rejected the print command (HMS 0500-0500-0001-0007, \"MQTT command verification failed\"). " +
    "Bambu firmware 01.08.05 and later only accept third-party LAN control with LAN Only Mode and Developer Mode " +
    "enabled (Settings > WLAN on the printer). The checked file is on the printer's storage, but nothing is printing. " +
    "The rejection stays on the printer as a fatal HMS entry that blocks later prints: after enabling those modes, " +
    "clear it with clear_hms_errors or dismiss it on the printer's screen, then print again.";
const DISPATCH_CANCELLED_MESSAGE = "A stop or heater-off request arrived after the print command was sent, so this call does not report the print as started. " +
    "Check get_printer_status.";
/** How long to watch fresh reports after a print command (BAMBU_DISPATCH_CHECK_MS, 0 disables). */
function dispatchCheckMs() {
    const raw = process.env.BAMBU_DISPATCH_CHECK_MS?.trim();
    const value = raw ? Number(raw) : 15000;
    return Number.isInteger(value) && value >= 0 && value <= 60000 ? value : 15000;
}
const MODEL_ID_TO_NAME = {
    O1C: "H2C",
    O1C2: "H2C",
    O1D: "H2D",
    O1E: "H2D Pro",
    O1S: "H2S",
    N6: "X2D",
    N2S: "A1",
    A1M: "A1 Mini",
    C11: "P1P",
    C12: "P1S",
    "BL-P001": "X1C",
    "BL-P002": "X1",
    C13: "X1E",
};
const H2_MODEL_NAMES = new Set(["h2", "h2c", "h2d", "h2dpro", "h2d pro", "h2s", "x2d"]);
export function assertDirectPrintSupported(model, serial) {
    if (model?.trim().toLowerCase() === "x2d" || serial?.trim().toUpperCase().startsWith("20P")) {
        throw new Error("X2D direct printing is not supported through legacy MQTT/FTPS. Use the macOS native eMMC route via print_3mf. " +
            "X2D status and slicing remain available on all supported platforms.");
    }
}
function isH2ModelName(model) {
    return H2_MODEL_NAMES.has(String(model ?? "").trim().toLowerCase().replace(/\s+/g, " "));
}
function isP2SModelName(model) {
    return String(model ?? "").trim().toLowerCase() === "p2s";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveModelName(data) {
    const modelId = `${data?.model_id ?? ""}`.toUpperCase();
    return (MODEL_ID_TO_NAME[modelId] ||
        data?.model ||
        data?.device?.devModel ||
        data?.device?.dev_model ||
        "Unknown");
}
async function invokeWithoutAck(printer, command) {
    await command.invoke(printer);
    await sleep(COMMAND_SETTLE_MS);
}
function getPrinterKey(host, serial, token) {
    return `${host}-${serial}-${token}`;
}
class TolerantBambuClient extends BambuClient {
    /**
     * H2D-class firmware streams push status immediately after subscribe, but
     * never answers bambu-node's initial get_version round-trip. Avoid treating
     * that missing ACK as a failed connection.
     */
    async onConnect() {
        const subscribe = this.subscribe.bind(this);
        await subscribe(`device/${this.config.serialNumber}/report`);
    }
    /**
     * H2-series printers don't respond to get_version with module info.
     * Infer model from serial number prefix so downstream code (Job, status
     * parsing, etc.) has a valid printerModel instead of undefined.
     */
    inferModelFromSerial() {
        const sn = this.config.serialNumber;
        if (sn.startsWith("093"))
            return "H2S";
        if (sn.startsWith("094"))
            return "H2D";
        if (sn.startsWith("239"))
            return "H2C";
        if (sn.startsWith("31B"))
            return "H2DPRO";
        if (sn.startsWith("20P"))
            return "X2D";
        if (sn.startsWith("00M"))
            return "X1C";
        if (sn.startsWith("00W"))
            return "X1";
        if (sn.startsWith("03W"))
            return "X1E";
        if (sn.startsWith("01S"))
            return "P1P";
        if (sn.startsWith("01P"))
            return "P1S";
        if (sn.startsWith("22E"))
            return "P2S";
        if (sn.startsWith("030"))
            return "A1";
        if (sn.startsWith("039"))
            return "A1M";
        return undefined;
    }
    /**
     * Override bambu-node's MQTT connect to pass a client cert+key for mTLS.
     * Post-Jan-2025 H2D firmware rejects TLS handshakes without a valid Bambu-
     * issued client certificate. Options mirror the upstream implementation
     * plus `cert`/`key` when creds are available.
     */
    async connect() {
        await new Promise((resolve, reject) => {
            const self = this;
            if (self.mqttClient) {
                throw new Error("Can't establish a new connection while running another one!");
            }
            const tlsOpts = {
                username: "bblp",
                password: self.config.accessToken,
                reconnectPeriod: self.clientOptions.reconnectInterval,
                connectTimeout: self.clientOptions.connectTimeout,
                keepalive: self.clientOptions.keepAlive,
                resubscribe: true,
                rejectUnauthorized: false,
            };
            if (CLIENT_CREDS) {
                tlsOpts.cert = CLIENT_CREDS.cert;
                tlsOpts.key = CLIENT_CREDS.key;
            }
            const client = mqtt.connect(`mqtts://${self.config.host}:${self.config.port}`, tlsOpts);
            self.mqttClient = client;
            client.on("connect", async (...args) => {
                try {
                    await self.onConnect(...args);
                    self.emit("client:connect");
                    resolve();
                }
                catch (e) {
                    reject(e);
                }
            });
            client.on("disconnect", () => {
                self.emit("client:disconnect", false);
                self.emit("printer:statusUpdate", self._printerStatus, "OFFLINE");
                self._printerStatus = "OFFLINE";
                if (self.currentJob)
                    self.emit("job:pause", self.currentJob, true);
            });
            client.on("offline", () => {
                self.emit("client:disconnect", true);
                self.emit("printer:statusUpdate", self._printerStatus, "OFFLINE");
                self._printerStatus = "OFFLINE";
                if (self.currentJob)
                    self.emit("job:pause", self.currentJob, true);
            });
            client.on("message", (topic, payload) => self.emit("rawMessage", topic, payload));
            client.on("error", (err) => {
                self.emit("client:error", err);
                reject(err);
            });
        });
        // H2-series printers don't respond to get_version with module info.
        // Infer model from serial number prefix so downstream code works.
        if (!this.data.model) {
            const inferred = this.inferModelFromSerial();
            if (inferred) {
                this.data.model = inferred;
                this.emit("printer:dataUpdate", this.data, { model: inferred });
            }
        }
        return [undefined];
    }
}
/**
 * Build FTPS secureOptions that include the client cert+key when available.
 *
 * `host` must be included: basic-ftp opens each data connection by wrapping
 * a plain socket with tls.connect(tlsOptions), and without a host Node can bind
 * the resumable session to "localhost" instead of the printer host. Printers
 * that require TLS session reuse (vsftpd require_ssl_reuse, e.g. X2D) refuse
 * to resume the session and reply "522 SSL connection failed: session reuse
 * required", failing every LIST, STOR and RETR.
 */
function ftpsSecureOptions(host) {
    const opts = { rejectUnauthorized: false, host };
    if (CLIENT_CREDS) {
        opts.cert = CLIENT_CREDS.cert;
        opts.key = CLIENT_CREDS.key;
    }
    return opts;
}
class BambuClientStore {
    constructor() {
        this.printers = new Map();
        this.initialConnectionPromises = new Map();
        this.reportSnapshots = new Map();
        this.initialReportPromises = new Map();
        this.initialReportResolvers = new Map();
    }
    ensureInitialReportPromise(key) {
        const existing = this.initialReportPromises.get(key);
        if (existing) {
            return existing;
        }
        const promise = new Promise((resolve) => {
            this.initialReportResolvers.set(key, resolve);
        });
        this.initialReportPromises.set(key, promise);
        return promise;
    }
    resolveInitialReport(key) {
        const resolve = this.initialReportResolvers.get(key);
        if (!resolve) {
            return;
        }
        this.initialReportResolvers.delete(key);
        resolve();
    }
    updateReportSnapshot(key, update) {
        if (!update || Object.keys(update).length === 0) {
            return;
        }
        const previous = this.reportSnapshots.get(key) || {};
        this.reportSnapshots.set(key, { ...previous, ...update });
        this.resolveInitialReport(key);
    }
    clearPrinterState(key) {
        this.printers.delete(key);
        this.initialConnectionPromises.delete(key);
        this.reportSnapshots.delete(key);
        this.initialReportPromises.delete(key);
        this.initialReportResolvers.delete(key);
    }
    getCachedReport(host, serial, token) {
        return this.reportSnapshots.get(getPrinterKey(host, serial, token)) || null;
    }
    async waitForInitialReport(host, serial, token, timeoutMs = 4000) {
        const key = getPrinterKey(host, serial, token);
        const existing = this.reportSnapshots.get(key);
        if (!existing || Object.keys(existing).length === 0) {
            // No MQTT data yet — wait for the first push.
            const reportPromise = this.ensureInitialReportPromise(key);
            try {
                await Promise.race([
                    reportPromise,
                    sleep(timeoutMs).then(() => {
                        throw new Error(`Timed out waiting for initial printer report after ${timeoutMs}ms.`);
                    }),
                ]);
            }
            catch (error) {
                console.warn(`No initial printer report received for ${serial}:`, error);
            }
        }
        // Short settle: the first MQTT push from the printer is a sparse "hello"
        // with only model/modules. A second push carrying the full status
        // (gcode_state, ams, hms, temperatures, fans, etc.) arrives afterward
        // and gets merged into reportSnapshots via incremental update.
        // This settle runs regardless of whether data arrived before or during
        // the promise race above, so the merge has time to complete.
        await sleep(500);
        return this.reportSnapshots.get(key) || null;
    }
    async getPrinter(host, serial, token) {
        const key = getPrinterKey(host, serial, token);
        if (this.printers.has(key)) {
            return this.printers.get(key);
        }
        if (this.initialConnectionPromises.has(key)) {
            await this.initialConnectionPromises.get(key);
            if (this.printers.has(key)) {
                return this.printers.get(key);
            }
            throw new Error(`Existing Bambu client connection for ${key} failed.`);
        }
        const printer = new TolerantBambuClient({
            host,
            serialNumber: serial,
            accessToken: token,
        });
        this.ensureInitialReportPromise(key);
        printer.on("rawMessage", (_topic, payload) => {
            try {
                const parsed = JSON.parse(payload.toString());
                const printMessage = parsed?.print;
                if (printMessage && typeof printMessage === "object") {
                    this.updateReportSnapshot(key, printMessage);
                }
            }
            catch {
                // Ignore unrelated payloads.
            }
        });
        printer.on("printer:dataUpdate", (data) => {
            this.updateReportSnapshot(key, data);
        });
        printer.on("client:connect", () => {
            this.printers.set(key, printer);
            this.initialConnectionPromises.delete(key);
        });
        printer.on("client:error", () => {
            this.clearPrinterState(key);
        });
        printer.on("client:disconnect", () => {
            this.clearPrinterState(key);
        });
        const connectPromise = printer.connect().then(() => { });
        this.initialConnectionPromises.set(key, connectPromise);
        try {
            await connectPromise;
            return printer;
        }
        catch (error) {
            this.clearPrinterState(key);
            throw error;
        }
    }
    async disconnectAll() {
        const disconnectPromises = [];
        for (const printer of this.printers.values()) {
            disconnectPromises.push((async () => {
                try {
                    await printer.disconnect();
                }
                catch (error) {
                    console.error("Failed to disconnect Bambu client", error);
                }
            })());
        }
        await Promise.allSettled(disconnectPromises);
        this.printers.clear();
        this.initialConnectionPromises.clear();
        this.reportSnapshots.clear();
        this.initialReportPromises.clear();
        this.initialReportResolvers.clear();
    }
}
export class BambuImplementation {
    constructor(confirm) {
        this.confirm = confirm;
        this.checkedJobs = new Map();
        this.clearedErrors = new Map();
        this.printerStore = new BambuClientStore();
    }
    async confirmHardwareAction(message, physicalCheck = false) {
        if (!physicalCheck && process.env.BAMBU_REQUIRE_CONFIRMATION === "0")
            return;
        if (!this.confirm || !(await this.confirm(message))) {
            throw new Error("Hardware safety confirmation was declined or unavailable. Use an MCP client with elicitation support. No command was sent.");
        }
    }
    finishedJobIdentity(status) {
        return status.raw.gcode_state === "FINISH" ? JSON.stringify([status.raw.gcode_file, status.raw.subtask_name, status.raw.task_id, status.raw.subtask_id]) : undefined;
    }
    async confirmPrintPreflight(serial, status, inspection) {
        const finishedJob = this.finishedJobIdentity(status);
        const cleared = this.clearedErrors.get(serial);
        await this.confirmHardwareAction(`Start a checked print on ${inspection.model.toUpperCase()} (${serial})? Nozzles: ${inspection.nozzleDiameters.join(", ")} mm. ` +
            `Materials: ${inspection.materials.join(", ")}. Peak targets: nozzle ${inspection.maxNozzleTemperature}°C, bed ${inspection.maxBedTemperature}°C, chamber ${inspection.maxChamberTemperature}°C. ` +
            `File SHA-256: ${inspection.sha256}. Confirm the physical spool labels and that the build plate is clear.` +
            (finishedJob !== undefined ? " The printer reports FINISH: remove the previous part and debris before confirming." : "") +
            (cleared ? ` Previously cleared hardware codes: ${cleared.join(", ")}. Confirm their physical causes have been resolved.` : ""), finishedJob !== undefined || !!cleared);
        return finishedJob;
    }
    assertBedClearance(status, confirmedFinishedJob) {
        const current = this.finishedJobIdentity(status);
        if (current !== undefined && current !== confirmedFinishedJob) {
            throw new Error("Printer reports a newly finished job. Confirm that its part and debris have been removed before retrying the print.");
        }
    }
    async getPrinter(host, serial, token) {
        return this.printerStore.getPrinter(host, serial, token);
    }
    /** Internal handoff from a successful inspected transport; never exposed as an MCP tool. */
    recordCheckedJob(host, serial, remotePath, requirements) {
        this.checkedJobs.set(`${host}\n${serial}`, { remotePath, requirements: structuredClone(requirements) });
        this.clearedErrors.delete(serial);
    }
    validateLoadedGcodeState(status, inspection) {
        const usedMaterials = inspection.usedFilamentPositions.map(position => inspection.materials[position]);
        if (new Set(usedMaterials).size !== 1)
            throw new Error("gcode_file printing cannot verify physical changes between different materials. Use a mapped .3mf project.");
        const loaded = manualHeatingRequirements(status, inspection.model, inspection.nozzleDiameters[0], usedMaterials[0]);
        const mapping = Array(inspection.materials.length).fill(-1);
        inspection.usedFilamentPositions.forEach(position => { mapping[position] = loaded.amsMapping?.[0] ?? 254; });
        const requirements = { ...inspection, useAMS: loaded.useAMS, amsMapping: mapping, usedNozzleIndices: loaded.usedNozzleIndices, requireLoadedFilament: true };
        validatePrinterState(status, requirements);
        return requirements;
    }
    async resolveProjectFileMetadata(localThreeMfPath, plateIndex, inspectedPlatePath) {
        const { zip } = await readSafe3mfArchive(localThreeMfPath);
        const expectedEntryName = `Metadata/plate_${(plateIndex ?? 0) + 1}.gcode`;
        if (inspectedPlatePath !== undefined && inspectedPlatePath !== expectedEntryName) {
            throw new Error("Inspected plate path does not match the requested print plate.");
        }
        const selectedEntry = zip.file(inspectedPlatePath ?? expectedEntryName);
        if (!selectedEntry) {
            throw new Error(`Selected inspected plate ${expectedEntryName} is not present in 3MF. Re-slice that plate.`);
        }
        const gcodeBuffer = await selectedEntry.async("nodebuffer");
        const md5 = createHash("md5").update(gcodeBuffer).digest("hex");
        // Project filament count: parse the gcode header line
        // `; filament_colour = #FFFFFF;#FF911A80;#DCF478;#DCF478`
        // This is the authoritative source -- it always reflects the slicer's
        // project filament list length. We only scan the first ~32KB of the
        // gcode to keep this cheap even on large plates.
        let projectFilamentCount = 1;
        const head = gcodeBuffer.slice(0, 32 * 1024).toString("utf8");
        const colourLine = head.match(/;\s*filament_colour\s*=\s*([^\n\r]+)/i);
        if (colourLine) {
            projectFilamentCount = colourLine[1].split(";").filter((s) => s.trim()).length;
        }
        else {
            // Fallback: count filament_ids header entries.
            const idsLine = head.match(/;\s*filament_ids\s*=\s*([^\n\r]+)/i);
            if (idsLine) {
                projectFilamentCount = idsLine[1].split(";").filter((s) => s.trim()).length;
            }
        }
        // Used filament positions: from Metadata/plate_<n>.json.filament_ids.
        // These are 0-based positions into the project filament list that the
        // selected plate actually consumes.
        let usedFilamentPositions = [];
        const plateJsonName = selectedEntry.name.replace(/\.gcode$/i, ".json");
        const plateJsonEntry = zip.file(plateJsonName);
        if (plateJsonEntry) {
            try {
                const raw = await plateJsonEntry.async("string");
                const json = JSON.parse(raw);
                if (Array.isArray(json.filament_ids)) {
                    usedFilamentPositions = json.filament_ids
                        .filter((n) => Number.isInteger(n))
                        .map((n) => n);
                }
            }
            catch {
                // tolerate malformed plate_N.json -- caller can pass amsMapping directly
            }
        }
        if (usedFilamentPositions.length === 0)
            usedFilamentPositions = [0];
        return {
            plateFileName: path.posix.basename(selectedEntry.name),
            plateInternalPath: selectedEntry.name,
            md5,
            projectFilamentCount,
            usedFilamentPositions,
        };
    }
    /** Safety reads never use the display cache or configured-serial model inference. */
    async getSafetyStatus(host, serial, token) {
        return readFreshPrinterStatus(await this.getPrinter(host, serial, token), serial);
    }
    async getStatus(host, serial, token) {
        try {
            const printer = await this.getPrinter(host, serial, token);
            try {
                await invokeWithoutAck(printer, new PushAllCommand());
            }
            catch (error) {
                console.warn("PushAllCommand failed, continuing with cached status", error);
            }
            const cachedData = await this.printerStore.waitForInitialReport(host, serial, token);
            const data = cachedData && Object.keys(cachedData).length > 0
                ? cachedData
                : printer.data;
            return {
                status: data.gcode_state || "UNKNOWN",
                connected: true,
                temperatures: {
                    nozzle: {
                        actual: data.nozzle_temper || 0,
                        target: data.nozzle_target_temper || 0,
                    },
                    bed: {
                        actual: data.bed_temper || 0,
                        target: data.bed_target_temper || 0,
                    },
                    chamber: data.chamber_temper || data.frame_temper || 0,
                },
                print: {
                    filename: data.subtask_name || data.gcode_file || "None",
                    progress: data.mc_percent || 0,
                    timeRemaining: data.mc_remaining_time || 0,
                    currentLayer: data.layer_num || 0,
                    totalLayers: data.total_layer_num || 0,
                },
                ams: data.ams || null,
                model: resolveModelName(data),
                serial,
                raw: data,
            };
        }
        catch (error) {
            console.error(`Failed to get Bambu status for ${serial}:`, error);
            return { status: "error", connected: false, error: error.message };
        }
    }
    async print3mf(host, serial, token, options) {
        assertDirectPrintSupported(options.bambuModel, serial);
        return withPrinterOperation(host, serial, assertActive => withPrintSnapshot(options.filePath, filePath => this.print3mfPrepared(host, serial, token, { ...options, filePath }, assertActive)));
    }
    async print3mfPrepared(host, serial, token, options, assertActive) {
        const model = normalizeModel(options.bambuModel);
        if (!model)
            throw new Error("A supported bambuModel is required before printing.");
        if (!options.filePath.toLowerCase().endsWith(".3mf")) {
            throw new Error("print3mf requires a .3mf input file.");
        }
        // Normalise remote filename: collapse double-extension artifacts like
        // "Cube.gcode.3mf.gcode.3mf" -> "Cube.gcode.3mf" so firmware can identify
        // the container format from the extension.
        let remoteFileName = uniquePrintName(options.filePath);
        remoteFileName = remoteFileName.replace(/\.gcode\.3mf\.gcode\.3mf$/i, ".gcode.3mf");
        // H2-series printers land files at the FTP root and reference them via ftp:///<name>.
        // Full-size A1 uses SD root/project_file (reported on firmware 01.08.01.00).
        // P1/X1/A1 mini retain their legacy cache/gcode_file route.
        // P2S keeps the /cache/<name> upload but only accepts the H2-style
        // project_file command, referenced via ftp:///cache/<name> (verified on
        // P2S firmware 01.02.00.00; file:///sdcard/... fails with ERROR STATE).
        const isH2 = serial.startsWith("093") ||
            serial.startsWith("094") ||
            isH2ModelName(options.bambuModel);
        const isP2S = serial.startsWith("22E") || isP2SModelName(options.bambuModel);
        const isA1 = String(options.bambuModel ?? "").trim().toLowerCase() === "a1" ||
            (!options.bambuModel && serial.startsWith("030"));
        const usesH2ProjectFile = isH2 || isP2S;
        const remoteProjectPath = isH2 || isA1 ? remoteFileName : `cache/${remoteFileName}`;
        const remoteUploadPath = `/${remoteProjectPath}`;
        const projectUrl = usesH2ProjectFile
            ? `ftp:///${remoteProjectPath}`
            : `file:///sdcard/${remoteProjectPath}`;
        const inspection = await inspectPrintFile(options.filePath, {
            model, nozzleDiameters: options.nozzleDiameters, plateIndex: options.plateIndex ?? 0, bedType: options.bedType,
        });
        const projectMetadata = await this.resolveProjectFileMetadata(options.filePath, options.plateIndex, inspection.plateInternalPath);
        // Send project_file command via bambu-node MQTT (bypasses bambu-js
        // hardcoded use_ams=true and missing ams_mapping support)
        const md5 = projectMetadata.md5;
        if (options.md5 !== undefined && options.md5 !== md5)
            throw new Error("Provided checksum does not match the inspected plate G-code.");
        // Build AMS mapping.
        //
        // Convention: position = project-level filament index, value = absolute
        // tray index (0-3 = AMS 0 trays, 4-7 = AMS 1, 8-11 = AMS 2, 128+ = AMS-HT,
        // 254 = external spool, -1 = unused). Required on AMS-equipped printers
        // even when you think "no AMS" -- firmware looks up the mapping table
        // whenever the 3MF declares filaments, and a missing/invalid mapping
        // fails with 0700-8012-032015 "Failed to get AMS mapping table".
        //
        // For H2-series the array length MUST equal the project-level filament
        // count declared by the slicer (parsed from the gcode header's
        // `filament_colour` list). For P1/A1/X1 we pad to length 5 per the
        // historical bambu-js behavior.
        //
        // Caller ergonomics: callers typically know only "I want to pull this
        // print's filaments from these AMS slots" in the order the plate uses
        // them. We expose `amsSlots` for that -- one entry per position in
        // `plate_N.json.filament_ids` -- and expand to a full project-level
        // array here. `amsMapping` is the raw escape hatch (takes precedence
        // when both are supplied).
        const validateTrayValue = (v, label) => {
            if (!Number.isInteger(v) ||
                v < -1 ||
                (v > 15 && v < 128) ||
                v > 254) {
                throw new Error(`${label} values must be integers in [-1, 15] (absolute tray) or 128-254 (HT/external); got ${v}`);
            }
        };
        let baseMapping;
        if (options.amsMapping && options.amsMapping.length > 0) {
            for (const v of options.amsMapping)
                validateTrayValue(v, "ams_mapping");
            baseMapping = options.amsMapping.slice();
        }
        else if (options.amsSlots && options.amsSlots.length > 0) {
            for (const v of options.amsSlots)
                validateTrayValue(v, "amsSlots");
            const positions = projectMetadata.usedFilamentPositions;
            if (options.amsSlots.length !== positions.length) {
                throw new Error(`amsSlots length ${options.amsSlots.length} does not match used filament count ${positions.length} (plate uses positions ${JSON.stringify(positions)}). Provide one tray per used filament, or use amsMapping for a raw project-level array.`);
            }
            const projectLen = Math.max(projectMetadata.projectFilamentCount, ...positions.map((p) => p + 1));
            baseMapping = Array(projectLen).fill(-1);
            positions.forEach((pos, i) => {
                baseMapping[pos] = options.amsSlots[i];
            });
        }
        else {
            if (options.useAMS !== false && projectMetadata.usedFilamentPositions.length > 0) {
                throw new Error(`H2 project_file requires amsSlots or amsMapping for sliced files with declared filaments. Plate uses project filament positions ${JSON.stringify(projectMetadata.usedFilamentPositions)}.`);
            }
            const positions = projectMetadata.usedFilamentPositions;
            const projectLen = Math.max(projectMetadata.projectFilamentCount, ...positions.map((p) => p + 1), 1);
            baseMapping = Array(projectLen).fill(-1);
            positions.forEach((pos, i) => {
                baseMapping[pos] = options.useAMS === false ? 254 : i;
            });
        }
        let amsMapping;
        let amsMapping2;
        if (usesH2ProjectFile) {
            const projLen = Math.max(projectMetadata.projectFilamentCount, baseMapping.length, 1);
            amsMapping = Array.from({ length: projLen }, (_, i) => i < baseMapping.length ? baseMapping[i] : -1);
            amsMapping2 = amsMapping.map((v) => {
                if (v < 0 || v === 255)
                    return { ams_id: 255, slot_id: 255 };
                if (v === 254)
                    return { ams_id: 254, slot_id: 254 };
                if (v >= 128)
                    return { ams_id: 128, slot_id: v - 128 };
                return { ams_id: Math.floor(v / 4), slot_id: v % 4 };
            });
        }
        else {
            amsMapping = Array.from({ length: Math.max(5, baseMapping.length, projectMetadata.projectFilamentCount) }, (_, i) => i < baseMapping.length ? baseMapping[i] : -1);
            amsMapping2 = [];
        }
        for (const position of inspection.usedFilamentPositions) {
            if (baseMapping[position] === undefined || baseMapping[position] < 0) {
                throw new Error(`Missing physical filament mapping for project filament ${position}.`);
            }
            if (options.useAMS === false && baseMapping[position] !== 254) {
                throw new Error("External-spool printing requires external spool mapping (254).");
            }
        }
        const legacyContainer = options.filePath.toLowerCase().endsWith(".gcode.3mf") && !usesH2ProjectFile && !isA1;
        if (legacyContainer) {
            if (options.useAMS !== false || inspection.selectsAms) {
                throw new Error("Legacy .gcode.3mf transport cannot apply verified AMS mappings. Export a .3mf project for AMS printing, or use an external-spool-only job with use_ams:false.");
            }
            const { zip: archive } = await readSafe3mfArchive(options.filePath);
            const plates = Object.values(archive.files).filter(entry => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name));
            if (plates.length !== 1 || inspection.plateInternalPath?.toLowerCase() !== "metadata/plate_1.gcode") {
                throw new Error("Legacy gcode_file printing requires a single plate_1.gcode. Export only the selected plate or use a .3mf project_file export.");
            }
        }
        let requirements = { ...inspection, amsMapping: baseMapping, useAMS: options.useAMS !== false };
        const initialStatus = await this.getSafetyStatus(host, serial, token);
        if (legacyContainer)
            requirements = this.validateLoadedGcodeState(initialStatus, inspection);
        else
            validatePrinterState(initialStatus, requirements);
        const bedClearance = await this.confirmPrintPreflight(serial, initialStatus, inspection);
        const confirmedStatus = await this.getSafetyStatus(host, serial, token);
        if (legacyContainer)
            requirements = this.validateLoadedGcodeState(confirmedStatus, inspection);
        else
            validatePrinterState(confirmedStatus, requirements);
        this.assertBedClearance(confirmedStatus, bedClearance);
        assertActive();
        await this.ftpUpload(host, token, options.filePath, remoteUploadPath);
        // Uploads can be long. Recheck current state before the command is dispatched.
        const dispatchStatus = await this.getSafetyStatus(host, serial, token);
        if (legacyContainer)
            requirements = this.validateLoadedGcodeState(dispatchStatus, inspection);
        else
            validatePrinterState(dispatchStatus, requirements);
        this.assertBedClearance(dispatchStatus, bedClearance);
        const printer = await this.getPrinter(host, serial, token);
        assertActive();
        if (legacyContainer) {
            const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
            try {
                await invokeWithoutAck(printer, new GCodeFileCommand({ fileName: remoteProjectPath }));
            }
            catch (error) {
                watcher.dispose();
                throw error;
            }
            this.recordCheckedJob(host, serial, remoteProjectPath, requirements);
            const dispatch = await watcher.settled();
            return {
                status: "success", dispatch, remoteProjectPath,
                message: dispatch === "started"
                    ? `The printer accepted and started the checked gcode.3mf print: ${options.projectName}`
                    : `Uploaded the checked gcode.3mf and sent the print command for ${options.projectName}; the printer has not reported starting yet. ` +
                        "Check get_printer_status before assuming it is printing.",
            };
        }
        const b = (v) => (v ? 1 : 0);
        let projectFileCmd;
        if (usesH2ProjectFile) {
            const submissionId = String(Date.now() & 0x7fffffff);
            projectFileCmd = {
                print: {
                    sequence_id: "0",
                    command: "project_file",
                    param: projectMetadata.plateInternalPath,
                    url: projectUrl,
                    file: remoteFileName,
                    md5,
                    bed_type: options.bedType || "auto",
                    timelapse: b(options.timelapse),
                    bed_leveling: b(options.bedLeveling ?? true),
                    auto_bed_leveling: 1,
                    flow_cali: b(options.flowCalibration ?? false),
                    vibration_cali: b(options.vibrationCalibration ?? true),
                    layer_inspect: b(options.layerInspect ?? false),
                    use_ams: options.useAMS !== false,
                    cfg: "0",
                    extrude_cali_flag: 0,
                    extrude_cali_manual_mode: 0,
                    nozzle_offset_cali: 2,
                    subtask_name: remoteFileName.replace(/\.3mf$/i, ""),
                    profile_id: "0",
                    project_id: submissionId,
                    subtask_id: submissionId,
                    task_id: submissionId,
                    ams_mapping: amsMapping,
                    ams_mapping2: amsMapping2,
                },
            };
        }
        else {
            projectFileCmd = {
                print: {
                    command: "project_file",
                    param: projectMetadata.plateInternalPath,
                    url: projectUrl,
                    subtask_name: remoteFileName.replace(/\.3mf$/i, ""),
                    md5,
                    flow_cali: options.flowCalibration ?? true,
                    layer_inspect: options.layerInspect ?? true,
                    vibration_cali: options.vibrationCalibration ?? true,
                    bed_leveling: options.bedLeveling ?? true,
                    bed_type: options.bedType || "textured_plate",
                    timelapse: options.timelapse ?? false,
                    use_ams: options.useAMS !== false,
                    ams_mapping: amsMapping,
                    profile_id: "0",
                    project_id: "0",
                    sequence_id: "0",
                    subtask_id: "0",
                    task_id: "0",
                },
            };
        }
        const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
        try {
            await printer.publish(projectFileCmd);
        }
        catch (error) {
            watcher.dispose();
            throw error;
        }
        this.recordCheckedJob(host, serial, remoteProjectPath, requirements);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const dispatch = await watcher.settled();
        return {
            status: "success",
            dispatch,
            message: dispatch === "started"
                ? `The printer accepted and started the checked 3MF print: ${options.projectName}`
                : `Uploaded the checked 3MF and sent the print command for ${options.projectName}; the printer has not reported starting yet. ` +
                    "Check get_printer_status before assuming it is printing.",
            remoteProjectPath,
            plateFile: projectMetadata.plateFileName,
            platePath: projectMetadata.plateInternalPath,
            md5,
            amsMapping,
        };
    }
    async cancelJob(host, serial, token, dispatch) {
        cancelPendingPrinterOperations(host, serial);
        this.checkedJobs.delete(`${host}\n${serial}`);
        const printer = dispatch ? undefined : await this.getPrinter(host, serial, token);
        try {
            if (dispatch)
                return await dispatch();
            else
                await invokeWithoutAck(printer, new UpdateStateCommand({ state: "stop" }));
            this.checkedJobs.delete(`${host}\n${serial}`);
            return { status: "success", message: "Cancel command sent successfully." };
        }
        catch (error) {
            throw new Error(`Failed to cancel print: ${error.message}`);
        }
    }
    async pauseJob(host, serial, token, dispatch) {
        const printer = dispatch ? undefined : await this.getPrinter(host, serial, token);
        try {
            if (dispatch)
                return await dispatch();
            else
                await invokeWithoutAck(printer, new UpdateStateCommand({ state: "pause" }));
            return { status: "success", message: "Pause command sent successfully." };
        }
        catch (error) {
            throw new Error(`Failed to pause print: ${error.message}`);
        }
    }
    async resumeJob(host, serial, token, dispatch) {
        return withPrinterOperation(host, serial, async (assertActive) => {
            const checked = this.checkedJobs.get(`${host}\n${serial}`);
            if (!checked)
                throw new Error("Resume requires a job inspected and started by this server instance. Verify other jobs on the printer before resuming them there.");
            const beforeDispatch = async () => {
                assertActive();
                const status = await this.getSafetyStatus(host, serial, token);
                validatePrinterState(status, { ...checked.requirements, requireIdle: false });
                if (status.raw.gcode_state !== "PAUSE")
                    throw new Error("Resume requires a freshly reported paused job.");
                const stem = (value) => path.posix.basename(value).replace(/(?:\.gcode)?\.3mf$|\.gcode$/i, "");
                const names = [status.raw.gcode_file, status.raw.subtask_name].filter(value => typeof value === "string");
                if (!names.some(value => stem(value) === stem(checked.remotePath)))
                    throw new Error("Paused job identity does not match this server's inspected artifact.");
                assertActive();
            };
            await beforeDispatch();
            const printer = dispatch ? undefined : await this.getPrinter(host, serial, token);
            assertActive();
            if (dispatch)
                await dispatch(assertActive, beforeDispatch);
            else
                await invokeWithoutAck(printer, new UpdateStateCommand({ state: "resume" }));
            return { status: "success", message: "Resume command sent successfully." };
        });
    }
    async clearHmsErrors(host, serial, token, dispatch) {
        return withPrinterOperation(host, serial, async (assertActive) => {
            const codesFor = (status) => {
                if (!Array.isArray(status.raw?.hms) || status.raw?.print_error === undefined)
                    throw new Error("Fresh error codes are required before clearing hardware errors.");
                return [`print_error:${status.raw.print_error}`, ...status.raw.hms.map((entry) => `hms:${entry.attr}:${entry.code}`)].sort();
            };
            const codes = codesFor(await this.getSafetyStatus(host, serial, token));
            await this.confirmHardwareAction(`Clear reported hardware errors on ${serial}: ${codes.join(", ")}? Inspect the printer and resolve the physical cause first. Confirm only after removing obstructions and correcting the fault.`, true);
            const beforeDispatch = async () => {
                assertActive();
                const current = codesFor(await this.getSafetyStatus(host, serial, token));
                if (JSON.stringify(current) !== JSON.stringify(codes))
                    throw new Error("Hardware errors changed before clearing. Inspect the new report before retrying.");
                assertActive();
            };
            await beforeDispatch();
            const printer = dispatch ? undefined : await this.getPrinter(host, serial, token);
            assertActive();
            if (dispatch)
                await dispatch(assertActive, beforeDispatch);
            else
                await printer.publish({ print: { command: "clean_print_error", sequence_id: "0" } });
            this.clearedErrors.set(serial, codes);
            await sleep(COMMAND_SETTLE_MS);
            return { status: "success", message: "Confirmed HMS clear command sent. The next print requires acknowledgment of these cleared codes.", cleared_codes: codes };
        });
    }
    async setPrintSpeed(host, serial, token, speedMode) {
        const printer = await this.getPrinter(host, serial, token);
        const normalized = typeof speedMode === "number" ? String(Math.trunc(speedMode)) : speedMode.trim().toLowerCase();
        const mode = normalized === "silent" ? 1 :
            normalized === "standard" ? 2 :
                normalized === "sport" ? 3 :
                    normalized === "ludicrous" ? 4 :
                        Number(normalized);
        if (!Number.isInteger(mode) || mode < 1 || mode > 4) {
            throw new Error("Print speed mode must be one of: silent, standard, sport, ludicrous, 1, 2, 3, 4.");
        }
        await printer.publish({
            print: {
                command: "print_speed",
                param: String(mode),
                sequence_id: "0",
            },
        });
        await sleep(COMMAND_SETTLE_MS);
        const names = ["", "silent", "standard", "sport", "ludicrous"];
        return {
            status: "success",
            message: `Print speed command sent for ${names[mode]}.`,
            mode,
            label: names[mode],
        };
    }
    async setAirductMode(host, serial, token, mode) {
        const printer = await this.getPrinter(host, serial, token);
        const normalizedMode = mode.trim().toLowerCase();
        if (normalizedMode !== "cooling" && normalizedMode !== "heating") {
            throw new Error("Airduct mode must be one of: cooling, heating.");
        }
        await printer.publish({
            print: {
                command: "set_airduct",
                modeId: normalizedMode === "cooling" ? 0 : 1,
                submode: -1,
                sequence_id: "0",
            },
        });
        await sleep(COMMAND_SETTLE_MS);
        return {
            status: "success",
            message: `Airduct mode command sent for ${normalizedMode}.`,
            mode: normalizedMode,
        };
    }
    async rereadAmsRfid(host, serial, token, amsId, slotId) {
        const normalizedAmsId = amsId;
        const normalizedSlotId = slotId;
        if (!Number.isInteger(normalizedAmsId) || normalizedAmsId < 0 || normalizedAmsId > 3) {
            throw new Error("ams_id must be an integer from 0 to 3.");
        }
        if (!Number.isInteger(normalizedSlotId) || normalizedSlotId < 0 || normalizedSlotId > 3) {
            throw new Error("slot_id must be an integer from 0 to 3.");
        }
        const printer = await this.getPrinter(host, serial, token);
        await printer.publish({
            print: {
                command: "ams_get_rfid",
                ams_id: normalizedAmsId,
                slot_id: normalizedSlotId,
                sequence_id: "0",
            },
        });
        await sleep(COMMAND_SETTLE_MS);
        return {
            status: "success",
            message: `AMS RFID re-read command sent for AMS ${normalizedAmsId} slot ${normalizedSlotId}.`,
            ams_id: normalizedAmsId,
            slot_id: normalizedSlotId,
        };
    }
    async setTemperature(host, serial, token, component, temperature, bambuModel, material, nozzleDiameter = 0.4, dispatch) {
        const normalizedComponent = component.toLowerCase();
        const heater = normalizedComponent === "bed" ? "bed" :
            ["extruder", "nozzle", "tool", "tool0"].includes(normalizedComponent) ? "nozzle" : undefined;
        if (!heater) {
            throw new Error(`Unsupported temperature component: ${component}. Use one of: bed, nozzle, extruder.`);
        }
        if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0) {
            throw new Error("Temperature must be a finite, non-negative number in °C.");
        }
        const model = normalizeModel(bambuModel);
        if (temperature > 0 && !model)
            throw new Error("bambu_model is required before heating.");
        if (temperature > 0 && heater === "nozzle" && !material?.trim()) {
            throw new Error("Declare material before nozzle heating, including non-RFID external spools.");
        }
        const targetTemperature = temperature === 0 ? 0 : validateTemperature(heater, temperature, model, material ? [material] : undefined);
        const gcode = `${heater === "bed" ? "M140" : "M104"}${heater === "nozzle" && targetTemperature > 0 ? " T0" : ""} S${targetTemperature}`;
        const send = async (assertActive) => {
            let beforeDispatch;
            if (targetTemperature > 0) {
                const status = await this.getSafetyStatus(host, serial, token);
                const validateHeatingStatus = (current) => validatePrinterState(current, heater === "nozzle"
                    ? manualHeatingRequirements(current, model, nozzleDiameter, material)
                    : { model: model, nozzleDiameters: [] });
                validateHeatingStatus(status);
                await this.confirmHardwareAction(`Heat ${heater} on ${model.toUpperCase()} (${serial}) to ${targetTemperature}°C?${material ? ` Declared material: ${material}. Confirm the physical spool label.` : ""}`);
                beforeDispatch = async () => {
                    assertActive();
                    const confirmedStatus = await this.getSafetyStatus(host, serial, token);
                    validateHeatingStatus(confirmedStatus);
                    assertActive();
                };
                await beforeDispatch();
            }
            const printer = dispatch ? undefined : await this.getPrinter(host, serial, token);
            assertActive();
            if (dispatch)
                await dispatch(heater, targetTemperature, assertActive, beforeDispatch);
            else
                await invokeWithoutAck(printer, new GCodeLineCommand({ gcodes: [gcode] }));
            return { status: "success", message: `Temperature command sent for ${normalizedComponent}.`, command: gcode };
        };
        if (targetTemperature === 0) {
            cancelPendingPrinterOperations(host, serial);
            return send(() => undefined);
        }
        return withPrinterOperation(host, serial, send);
    }
    async setFanSpeed(host, serial, token, fan, speed) {
        const printer = await this.getPrinter(host, serial, token);
        const normalizedFan = typeof fan === "number" ? fan : fan.trim().toLowerCase();
        const fanId = normalizedFan === 1 || normalizedFan === "1" || normalizedFan === "part" || normalizedFan === "part_cooling"
            ? 1
            : normalizedFan === 2 || normalizedFan === "2" || normalizedFan === "aux" || normalizedFan === "auxiliary"
                ? 2
                : normalizedFan === 3 || normalizedFan === "3" || normalizedFan === "chamber"
                    ? 3
                    : null;
        if (fanId === null) {
            throw new Error("Unsupported fan. Use one of: part, auxiliary, chamber, 1, 2, 3.");
        }
        const targetSpeed = Math.round(speed);
        if (targetSpeed < 0 || targetSpeed > 100) {
            throw new Error("Fan speed must be between 0 and 100 percent.");
        }
        await invokeWithoutAck(printer, new UpdateFanCommand({ fan: fanId, speed: targetSpeed }));
        return {
            status: "success",
            message: `Fan speed command sent for fan ${fanId}.`,
            fan: fanId,
            speed: targetSpeed,
        };
    }
    async setLight(host, serial, token, light, mode) {
        const printer = await this.getPrinter(host, serial, token);
        const normalizedLight = light.trim();
        const normalizedMode = mode.trim().toLowerCase();
        const validModes = new Set(["on", "off", "flashing"]);
        if (!normalizedLight) {
            throw new Error("Light node is required, for example: chamber_light.");
        }
        if (!validModes.has(normalizedMode)) {
            throw new Error("Light mode must be one of: on, off, flashing.");
        }
        await invokeWithoutAck(printer, new UpdateLightCommand({
            light: normalizedLight,
            mode: normalizedMode,
        }));
        return {
            status: "success",
            message: `Light command sent for ${normalizedLight}.`,
            light: normalizedLight,
            mode: normalizedMode,
        };
    }
    async setAmsDrying(host, serial, token, action, amsId) {
        const normalizedAction = action.trim().toLowerCase();
        if (normalizedAction !== "start" && normalizedAction !== "stop") {
            throw new Error("AMS drying action must be one of: start, stop.");
        }
        const normalizedAmsId = amsId;
        if (!Number.isInteger(normalizedAmsId) || normalizedAmsId < 0 || normalizedAmsId > 3) {
            throw new Error("ams_id must be an integer from 0 to 3.");
        }
        const param = normalizedAction === "start" ? "start_drying" : "stop_drying";
        const printer = await this.getPrinter(host, serial, token);
        await printer.publish({
            print: {
                command: "ams_control",
                ams_id: normalizedAmsId,
                param,
                sequence_id: "0",
            },
        });
        await sleep(COMMAND_SETTLE_MS);
        const label = normalizedAction === "start" ? "started" : "stopped";
        return {
            status: "success",
            message: `AMS drying ${label} for AMS ${normalizedAmsId}.`,
            action: normalizedAction,
            ams_id: normalizedAmsId,
        };
    }
    async skipObjects(host, serial, token, objectIds) {
        const printer = await this.getPrinter(host, serial, token);
        const normalizedObjectIds = objectIds
            .map((id) => Math.trunc(id))
            .filter((id) => Number.isInteger(id) && id >= 0);
        if (normalizedObjectIds.length === 0) {
            throw new Error("At least one non-negative object id is required.");
        }
        await printer.publish({
            print: {
                sequence_id: "0",
                command: "skip_objects",
                obj_list: normalizedObjectIds,
            },
        });
        await sleep(COMMAND_SETTLE_MS);
        return {
            status: "success",
            message: "Skip objects command sent.",
            object_ids: normalizedObjectIds,
        };
    }
    async getFiles(host, serial, token) {
        const client = new FTPClient(15000);
        const directories = ["cache", "timelapse", "logs"];
        const filesByDirectory = {};
        try {
            await client.access({
                host,
                port: 990,
                user: "bblp",
                password: token,
                secure: "implicit",
                secureOptions: ftpsSecureOptions(host),
            });
            await this.waitForTlsSession(client);
            // Discover absent optional directories without creating them or treating
            // ambiguous FTP 550 responses (including permission errors) as emptiness.
            const root = await client.list("/");
            for (const directory of directories) {
                const present = root.some(entry => entry.name === directory && (entry.isDirectory || entry.isSymbolicLink));
                filesByDirectory[directory] = present
                    ? (await client.list(`/${directory}`)).map(entry => entry.name)
                    : [];
            }
        }
        finally {
            client.close();
        }
        const files = Object.entries(filesByDirectory).flatMap(([directory, names]) => names.map((name) => `${directory}/${name}`));
        return {
            files,
            directories: filesByDirectory,
        };
    }
    async getFile(host, serial, token, filename) {
        const printer = new BambuPrinter(host, serial, token);
        const normalized = filename.replace(/^\/+/, "");
        const directory = path.posix.dirname(normalized) === "." ? "cache" : path.posix.dirname(normalized);
        const baseName = path.posix.basename(normalized);
        let exists = false;
        await printer.manipulateFiles(async (context) => {
            const entries = await context.readDir(directory);
            exists = entries.includes(baseName);
        });
        return {
            name: `${directory}/${baseName}`,
            exists,
        };
    }
    async uploadFile(host, serial, token, filePath, filename, print, bambuModel, upload) {
        const remotePath = normalizedRemotePath(filename);
        if (!print) {
            const sourceExtension = path.extname(filePath).toLowerCase();
            const destinationExtension = path.posix.extname(remotePath).toLowerCase();
            const printable = [sourceExtension, destinationExtension].some(extension => extension === ".gcode" || extension === ".3mf");
            const model = normalizeModel(bambuModel);
            if (printable && !model)
                throw new Error("A supported bambuModel is required to inspect printable uploads, even when print is false.");
            if (printable && sourceExtension !== destinationExtension) {
                throw new Error("Printable uploads require matching .gcode or .3mf source and destination extensions.");
            }
            return withPrinterOperation(host, serial, assertActive => withPrintSnapshot(filePath, async (snapshot) => {
                const inspections = [];
                if (printable) {
                    if (sourceExtension === ".3mf") {
                        const { zip } = await readSafe3mfArchive(snapshot);
                        const plates = Object.values(zip.files).filter(entry => !entry.dir && /\.gcode$/i.test(entry.name));
                        if (!plates.length)
                            throw new Error("Printable 3MF uploads require a sliced archive containing Metadata/plate_<n>.gcode.");
                        // A later touchscreen start may select any plate in this archive.
                        for (const plate of plates) {
                            const match = plate.name.match(/^Metadata\/plate_([1-9]\d*)\.gcode$/);
                            const plateNumber = match ? Number(match[1]) : NaN;
                            if (!Number.isSafeInteger(plateNumber)) {
                                throw new Error(`Noncanonical printable G-code entry '${plate.name}'. Re-export using exact Metadata/plate_<positive integer>.gcode paths without aliases.`);
                            }
                            const inspection = await inspectPrintFile(snapshot, { model: model, plateIndex: plateNumber - 1 });
                            if (inspection.plateInternalPath !== plate.name) {
                                throw new Error(`Printable G-code entry '${plate.name}' does not match the inspected plate path.`);
                            }
                            inspections.push(inspection);
                        }
                    }
                    else {
                        inspections.push(await inspectPrintFile(snapshot, { model: model }));
                    }
                    const status = await this.getSafetyStatus(host, serial, token);
                    for (const inspection of inspections) {
                        validatePrinterState(status, { ...inspection, verifyMaterials: false, requireIdle: false });
                    }
                }
                assertActive();
                const destination = path.posix.join(path.posix.dirname(remotePath), uniquePrintName(remotePath));
                if (upload)
                    await upload(snapshot, destination, assertActive);
                else
                    await this.ftpUpload(host, token, snapshot, `/${destination}`);
                return { status: "success", uploaded: true, remotePath: destination, printRequested: false, inspected: printable };
            }));
        }
        assertDirectPrintSupported(bambuModel, serial);
        if (!remotePath.toLowerCase().endsWith(".gcode") || !filePath.toLowerCase().endsWith(".gcode")) {
            throw new Error("Automatic print after upload requires .gcode. Use print_3mf for inspected .3mf project prints.");
        }
        return withPrinterOperation(host, serial, assertActive => withPrintSnapshot(filePath, snapshot => this.printRawPrepared(host, serial, token, snapshot, remotePath, bambuModel, assertActive)));
    }
    async printRawPrepared(host, serial, token, filePath, filename, bambuModel, assertActive) {
        const model = normalizeModel(bambuModel);
        if (!model)
            throw new Error("A supported bambuModel is required before printing.");
        const inspection = await inspectPrintFile(filePath, { model });
        if (inspection.selectsAms)
            throw new Error("Raw G-code with AMS selection requires a .3mf project export with verified physical slot mappings.");
        const initialStatus = await this.getSafetyStatus(host, serial, token);
        let requirements = this.validateLoadedGcodeState(initialStatus, inspection);
        const bedClearance = await this.confirmPrintPreflight(serial, initialStatus, inspection);
        const confirmedStatus = await this.getSafetyStatus(host, serial, token);
        requirements = this.validateLoadedGcodeState(confirmedStatus, inspection);
        this.assertBedClearance(confirmedStatus, bedClearance);
        assertActive();
        const remotePath = path.posix.join(path.posix.dirname(filename), uniquePrintName(filename));
        await this.ftpUpload(host, token, filePath, `/${remotePath}`);
        const dispatchStatus = await this.getSafetyStatus(host, serial, token);
        requirements = this.validateLoadedGcodeState(dispatchStatus, inspection);
        this.assertBedClearance(dispatchStatus, bedClearance);
        const printer = await this.getPrinter(host, serial, token);
        assertActive();
        const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
        try {
            await invokeWithoutAck(printer, new GCodeFileCommand({ fileName: remotePath }));
        }
        catch (error) {
            watcher.dispose();
            throw error;
        }
        this.recordCheckedJob(host, serial, remotePath, requirements);
        const dispatch = await watcher.settled();
        return {
            status: "success", uploaded: true, printRequested: true, dispatch, remotePath,
            message: dispatch === "started"
                ? `The printer accepted and started ${remotePath}.`
                : `Sent the print command for ${remotePath}; the printer has not reported starting yet. Check get_printer_status before assuming it is printing.`,
        };
    }
    /**
     * A published print command is not proof the printer took it. Listen to the
     * reports the printer pushes anyway (no extra pushall polling on weak P1
     * boards): a new command-verification HMS means the firmware refused the
     * command; PREPARE/SLICING/RUNNING means it started. Attach before publishing.
     */
    watchDispatch(printer, host, serial, token, before, assertActive) {
        const windowMs = dispatchCheckMs();
        if (windowMs === 0)
            return { settled: async () => { assertActive(); return "unconfirmed"; }, dispose: () => { } };
        const key = (entry) => `${Number(entry?.attr)}:${Number(entry?.code)}:${entry?.timestamp ?? ""}`;
        const known = new Set((Array.isArray(before?.raw?.hms) ? before.raw.hms : []).map(key));
        const judge = (report) => {
            const hms = Array.isArray(report?.hms) ? report.hms : [];
            if (hms.some((entry) => Number(entry?.attr) === COMMAND_VERIFICATION_HMS.attr &&
                Number(entry?.code) === COMMAND_VERIFICATION_HMS.code && !known.has(key(entry))))
                return "rejected";
            if (["PREPARE", "SLICING", "RUNNING"].includes(String(report?.gcode_state ?? "").toUpperCase()))
                return "started";
            return undefined;
        };
        let resolveOutcome;
        const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
        const onRaw = (topic, payload) => {
            if (topic !== `device/${serial}/report`)
                return;
            let parsed;
            try {
                parsed = JSON.parse(payload.toString());
            }
            catch {
                return;
            }
            const verdict = judge(parsed?.print);
            if (verdict)
                resolveOutcome(verdict);
        };
        const cancelled = () => { try {
            assertActive();
            return false;
        }
        catch {
            return true;
        } };
        printer?.on?.("rawMessage", onRaw);
        const timer = setTimeout(() => resolveOutcome(undefined), windowMs);
        // A stop during the window must not end as "accepted and started".
        const cancelCheck = setInterval(() => { if (cancelled())
            resolveOutcome("cancelled"); }, 250);
        const dispose = () => {
            clearTimeout(timer);
            clearInterval(cancelCheck);
            printer?.off?.("rawMessage", onRaw);
            resolveOutcome(undefined);
        };
        return {
            dispose,
            settled: async () => {
                let verdict;
                try {
                    verdict = await outcome;
                }
                finally {
                    dispose();
                }
                // Nothing pushed during the window: take one full report, not a polling loop.
                if (verdict === undefined && !cancelled()) {
                    try {
                        verdict = judge((await this.getSafetyStatus(host, serial, token))?.raw);
                    }
                    catch { /* stays unconfirmed */ }
                }
                if (verdict === "rejected") {
                    // Nothing started, so there is no checked job to resume or clear later.
                    this.checkedJobs.delete(`${host}\n${serial}`);
                    throw new Error(COMMAND_REJECTED_MESSAGE);
                }
                if (verdict === "cancelled" || cancelled())
                    throw new Error(DISPATCH_CANCELLED_MESSAGE);
                return verdict ?? "unconfirmed";
            },
        };
    }
    async startJob(host, serial, token, filename, bambuModel) {
        assertDirectPrintSupported(bambuModel, serial);
        if (!normalizeModel(bambuModel))
            throw new Error("A supported bambuModel is required before printing.");
        const remotePath = normalizedRemotePath(filename);
        if (!remotePath.toLowerCase().endsWith(".gcode")) {
            throw new Error("Remote starts require inspectable .gcode. Use print_3mf with the local project for .3mf printing.");
        }
        return withPrinterOperation(host, serial, async (assertActive) => {
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-remote-check-"));
            const localPath = path.join(directory, path.basename(remotePath));
            try {
                await this.ftpDownload(host, token, remotePath, localPath);
                // Send a unique copy of the downloaded, inspected bytes. Starting the
                // original remote name would allow it to change after inspection.
                return await withPrintSnapshot(localPath, snapshot => this.printRawPrepared(host, serial, token, snapshot, remotePath, bambuModel, assertActive));
            }
            finally {
                await fs.rm(directory, { recursive: true, force: true });
            }
        });
    }
    async ftpDownload(host, token, remotePath, localPath) {
        const client = new FTPClient(15000);
        try {
            await client.access({ host, port: 990, user: "bblp", password: token, secure: "implicit", secureOptions: ftpsSecureOptions(host) });
            await this.waitForTlsSession(client);
            const size = await client.size(`/${remotePath}`);
            if (!Number.isFinite(size) || size <= 0 || size > 512 * 1024 * 1024)
                throw new Error("Remote print file is empty or exceeds the 512 MiB inspection limit.");
            await client.downloadTo(localPath, `/${remotePath}`);
        }
        finally {
            client.close();
        }
    }
    /**
     * Capture a single JPEG frame from the printer's chamber camera.
     *
     * Protocol per https://github.com/Doridian/OpenBambuAPI/blob/main/video.md
     *
     *   Connect TLS to <host>:6000 (self-signed cert -- skip verification).
     *   Send an 80-byte auth packet:
     *     [0..4]   uint32 LE  payload size = 0x40  (64)
     *     [4..8]   uint32 LE  type         = 0x3000
     *     [8..12]  uint32 LE  flags        = 0
     *     [12..16] uint32 LE  0
     *     [16..48] "bblp" + null padding to 32 bytes
     *     [48..80] access token + null padding to 32 bytes
     *
     *   The server then streams frames as repeating:
     *     [0..4]   uint32 LE  payload size
     *     [4..8]   uint32 LE  itrack (0)
     *     [8..12]  uint32 LE  flags  (1)
     *     [12..16] uint32 LE  0
     *     [16..16+payloadSize] JPEG (FF D8 ... FF D9)
     *
     * Verified models per upstream docs: A1, A1 mini, P1S, P1P. X1/X1C/X1E
     * and P2S use RTSP on port 322 instead. H2/H2S/H2D/H2C/X2D
     * use the same RTSP path.
     *
     * Read-only; no confirm gate. Default 8s timeout for cold-start latency.
     */
    async cameraSnapshot(host, _serial, token, options = {}) {
        const timeoutMs = options.timeoutMs ?? 8000;
        const model = (options.bambuModel ?? "").toLowerCase();
        // P1/A1 series still use the proprietary TCP-on-6000 framed JPEG path
        // (per https://github.com/Doridian/OpenBambuAPI/blob/main/video.md).
        const TCP_CAMERA_MODELS = new Set(["a1", "a1mini", "p1s", "p1p"]);
        // X1, P2S, H2 (H2S/H2D/H2C), AND X2D all use RTSP on port 322. The
        // OpenBambuAPI doc only mentions X1/P2S, but the HA bambulab
        // integration's models.py shows the printer reports its own
        // `ipcam.rtsp_url` for these models, and Parker (H2S) rejects the
        // A1/P1 80-byte auth packet on port 6000 (verified 2026-04-27 --
        // confirmed by local H2 camera transport probes).
        const RTSP_MODELS = new Set([
            "x1", "x1c", "x1carbon", "x1e", "p2s",
            "h2", "h2s", "h2d", "h2c", "h2dpro", "x2d",
        ]);
        if (!model) {
            throw new Error("camera_snapshot requires bambu_model or BAMBU_MODEL so it can choose the correct Bambu camera protocol.");
        }
        if (RTSP_MODELS.has(model)) {
            const jpeg = await this.fetchRtspCameraFrame(host, token, timeoutMs, options.ffmpegPath);
            const result = {
                status: "success",
                format: "image/jpeg",
                sizeBytes: jpeg.length,
                base64: jpeg.toString("base64"),
                transport: "rtsps-322",
            };
            if (options.savePath) {
                const fsSync = await import("node:fs");
                fsSync.writeFileSync(options.savePath, jpeg);
                result.savedTo = options.savePath;
            }
            return result;
        }
        if (model && !TCP_CAMERA_MODELS.has(model)) {
            throw new Error(`camera_snapshot: model "${model}" is not a known Bambu Lab printer model. Supported: ${[...TCP_CAMERA_MODELS, ...RTSP_MODELS].sort().join(", ")}`);
        }
        const jpeg = await this.fetchTcpCameraFrame(host, token, timeoutMs);
        const result = {
            status: "success",
            format: "image/jpeg",
            sizeBytes: jpeg.length,
            base64: jpeg.toString("base64"),
            transport: "tcp-6000",
        };
        if (options.savePath) {
            const fsSync = await import("node:fs");
            fsSync.writeFileSync(options.savePath, jpeg);
            result.savedTo = options.savePath;
        }
        return result;
    }
    /**
     * Pull a single JPEG frame from the printer's RTSP/RTSPS stream using
     * ffmpeg. Used for X1, P2S, H2-family printers, and X2D.
     *
     * URL pattern verified against HA bambulab's models.py example:
     *   rtsps://bblp:<access_code>@<host>:322/streaming/live/1
     *
     * ffmpeg invocation:
     *   ffmpeg -tls_verify 0 -rtsp_transport tcp -i <url> -frames:v 1 -f image2 -c:v mjpeg -y <out>
     *
     * -tls_verify 0 accepts the printer's self-signed certificate. This is
     * consistent with the existing local-device TLS/FTPS paths, which do not
     * have a public CA chain or hostname that ffmpeg can validate. The
     * connection is still encrypted and remains scoped to the configured
     * printer host. -rtsp_transport tcp avoids UDP NAT/firewall issues.
     * -frames:v 1 makes ffmpeg exit as soon as one frame lands. -y overwrites
     * the temp file.
     */
    async fetchRtspCameraFrame(host, token, timeoutMs, ffmpegPath) {
        const fsSync = await import("node:fs");
        const os = await import("node:os");
        const pathMod = await import("node:path");
        const { spawn } = await import("node:child_process");
        const tmpOut = pathMod.join(os.tmpdir(), `bambu-snap-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
        const url = `rtsps://bblp:${encodeURIComponent(token)}@${host}:322/streaming/live/1`;
        const bin = ffmpegPath ?? "ffmpeg";
        // Note: ffmpeg's `-stimeout` was removed in 8.0 and renamed across the
        // 5.x/6.x line; we rely on the outer kill timer instead so we don't
        // have to detect ffmpeg version. -rtsp_transport tcp avoids UDP NAT
        // headaches; -frames:v 1 makes ffmpeg exit on first frame.
        const args = [
            "-tls_verify", "0",
            "-rtsp_transport", "tcp",
            "-i", url,
            "-frames:v", "1",
            "-f", "image2",
            "-c:v", "mjpeg",
            "-y",
            "-loglevel", "error",
            tmpOut,
        ];
        return new Promise((resolve, reject) => {
            let stderr = "";
            const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
            const killTimer = setTimeout(() => {
                try {
                    proc.kill("SIGKILL");
                }
                catch { /* ignore */ }
                reject(new Error(`camera_snapshot: ffmpeg timed out after ${timeoutMs}ms`));
            }, timeoutMs + 1000);
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("error", (err) => {
                clearTimeout(killTimer);
                if (err.code === "ENOENT") {
                    reject(new Error(`camera_snapshot: ffmpeg binary not found at "${bin}". Install with \`brew install ffmpeg\` or pass ffmpegPath.`));
                }
                else {
                    reject(err);
                }
            });
            proc.on("close", (code) => {
                clearTimeout(killTimer);
                if (code !== 0) {
                    // Strip access code from error messages so we don't leak credentials.
                    const safeStderr = stderr.split(token).join("<token-redacted>").trim();
                    reject(new Error(`camera_snapshot: ffmpeg exited ${code}. stderr: ${safeStderr.slice(-1000)}`));
                    try {
                        fsSync.unlinkSync(tmpOut);
                    }
                    catch { /* ignore */ }
                    return;
                }
                try {
                    const jpeg = fsSync.readFileSync(tmpOut);
                    fsSync.unlinkSync(tmpOut);
                    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
                        reject(new Error("camera_snapshot: ffmpeg produced output that does not start with JPEG SOI"));
                        return;
                    }
                    resolve(jpeg);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    /**
     * Open the TLS-on-6000 socket, send the 80-byte auth packet, and read
     * a single complete JPEG frame. Returns the JPEG bytes.
     */
    async fetchTcpCameraFrame(host, token, timeoutMs) {
        const tls = await import("node:tls");
        const auth = Buffer.alloc(80, 0);
        auth.writeUInt32LE(0x40, 0); // payload size
        auth.writeUInt32LE(0x3000, 4); // type
        // flags=0, reserved=0 are already zero from Buffer.alloc.
        auth.write("bblp", 16, 4, "ascii");
        auth.write(token, 48, Math.min(32, Buffer.byteLength(token, "ascii")), "ascii");
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalLen = 0;
            const FRAME_HEADER_BYTES = 16;
            let payloadSize = null;
            let settled = false;
            const finish = (err, jpeg) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                if (err)
                    reject(err);
                else if (jpeg)
                    resolve(jpeg);
                else
                    reject(new Error("camera_snapshot: ended without jpeg payload"));
            };
            const timer = setTimeout(() => finish(new Error(`camera_snapshot: timed out after ${timeoutMs}ms`)), timeoutMs);
            const socket = tls.connect({
                host,
                port: 6000,
                rejectUnauthorized: false,
                // The printer uses TLS for confidentiality but presents a self-signed cert.
                // Same trust posture as the FTPS path (basic-ftp with rejectUnauthorized: false).
            }, () => {
                socket.write(auth);
            });
            socket.on("data", (data) => {
                chunks.push(data);
                totalLen += data.length;
                if (payloadSize === null && totalLen >= FRAME_HEADER_BYTES) {
                    const merged = Buffer.concat(chunks, totalLen);
                    payloadSize = merged.readUInt32LE(0);
                    if (payloadSize <= 0 || payloadSize > 5000000) {
                        finish(new Error(`camera_snapshot: unreasonable payload size ${payloadSize} from header; auth likely failed.`));
                        return;
                    }
                    // Reset chunk list to remaining bytes after the header.
                    const remainder = merged.subarray(FRAME_HEADER_BYTES);
                    chunks.length = 0;
                    chunks.push(remainder);
                    totalLen = remainder.length;
                }
                if (payloadSize !== null && totalLen >= payloadSize) {
                    const merged = Buffer.concat(chunks, totalLen);
                    const jpeg = merged.subarray(0, payloadSize);
                    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
                        finish(new Error(`camera_snapshot: payload does not start with JPEG SOI (FF D8); got ${jpeg[0].toString(16)} ${jpeg[1].toString(16)}.`));
                        return;
                    }
                    finish(null, jpeg);
                }
            });
            socket.on("error", (err) => finish(err));
            socket.on("end", () => finish(new Error("camera_snapshot: connection ended before a full JPEG frame arrived")));
        });
    }
    /**
     * Delete a single file from the printer's SD card via FTPS.
     *
     * Destructive. Caller MUST set confirm=true; otherwise we return without
     * touching the printer. Path is normalized the same way uploadFile()
     * normalizes -- if the caller passes a bare filename, we look in cache/.
     * Path traversal (`..`) is rejected.
     *
     * Only the printer-managed directories (cache/, timelapse/, logs/) are
     * accepted as parents to avoid letting an agent wander further into the
     * filesystem than expected.
     */
    async deleteFile(host, _serial, token, filename, confirm) {
        if (confirm !== true) {
            return {
                status: "skipped",
                deleted: false,
                remotePath: filename,
                message: "delete_printer_file requires confirm:true. No FTP request was made.",
            };
        }
        const normalizedFileName = filename.replace(/^\/+/, "");
        if (normalizedFileName.length === 0) {
            throw new Error("delete_printer_file: filename is required.");
        }
        if (normalizedFileName.split("/").some((seg) => seg === "..")) {
            throw new Error(`delete_printer_file: path traversal segments are not allowed (got "${filename}").`);
        }
        const remotePath = normalizedFileName.includes("/")
            ? normalizedFileName
            : `cache/${normalizedFileName}`;
        const topDir = remotePath.split("/")[0];
        const ALLOWED_DIRS = new Set(["cache", "timelapse", "logs"]);
        if (!ALLOWED_DIRS.has(topDir)) {
            throw new Error(`delete_printer_file: refusing to delete outside cache/, timelapse/, logs/. Got "${remotePath}".`);
        }
        await this.ftpDelete(host, token, `/${remotePath}`);
        return {
            status: "success",
            deleted: true,
            remotePath,
        };
    }
    /**
     * Delete a single remote file via FTPS, using basic-ftp directly so we
     * get the same TLS-session-ticket handshake as ftpUpload().
     */
    async ftpDelete(host, token, remotePath) {
        const client = new FTPClient(15000);
        try {
            await client.access({
                host,
                port: 990,
                user: "bblp",
                password: token,
                secure: "implicit",
                secureOptions: ftpsSecureOptions(host),
            });
            await this.waitForTlsSession(client);
            const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
            await client.remove(absoluteRemote);
        }
        finally {
            client.close();
        }
    }
    /**
     * Upload a file to the printer via FTP using basic-ftp directly.
     * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
     * into the target directory, then uploadFrom uses the full relative path
     * again, resulting in e.g. /cache/cache/file.3mf).
     */
    async ftpUpload(host, token, localPath, remotePath) {
        const client = new FTPClient(15000);
        try {
            await client.access({
                host,
                port: 990,
                user: "bblp",
                password: token,
                secure: "implicit",
                secureOptions: ftpsSecureOptions(host),
            });
            // With TLS 1.3 the session ticket arrives asynchronously; basic-ftp calls
            // getSession() when opening the data channel and gets undefined if the
            // ticket hasn't arrived yet, causing a fresh TLS negotiation that Bambu
            // printers reject. Wait for the session ticket before proceeding.
            await this.waitForTlsSession(client);
            // Use absolute path to avoid CWD side-effects
            const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
            const entries = await client.list(path.posix.dirname(absoluteRemote));
            const destinationName = path.posix.basename(absoluteRemote).toLowerCase();
            if (entries.some(entry => entry.name.toLowerCase() === destinationName)) {
                throw new Error(`Refusing to overwrite existing printer file ${absoluteRemote}. Choose a new filename.`);
            }
            const fileData = await fs.readFile(localPath);
            await client.uploadFrom(Readable.from(fileData), absoluteRemote);
        }
        finally {
            client.close();
        }
    }
    async waitForTlsSession(ftpClient) {
        const socket = ftpClient.ftp?.socket;
        if (!socket || typeof socket.getSession !== "function")
            return;
        if (socket.getSession())
            return;
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 1000);
            socket.once("session", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
    async disconnectAll() {
        await this.printerStore.disconnectAll();
    }
}
