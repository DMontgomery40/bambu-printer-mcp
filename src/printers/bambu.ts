import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { Client as FTPClient } from "basic-ftp";
import { BambuPrinter } from "bambu-js";
import * as mqtt from "mqtt";
import {
  BambuClient,
  GCodeFileCommand,
  GCodeLineCommand,
  PushAllCommand,
  UpdateFanCommand,
  UpdateLightCommand,
  UpdateStateCommand,
} from "bambu-node";

/**
 * Post-Jan-2025 H2D firmware requires mTLS with a Bambu-issued client cert.
 * Loads cert+key once from:
 *   - BAMBU_CLIENT_CERT / BAMBU_CLIENT_KEY env vars (paths), or
 *   - ~/Desktop/bambu certs/embedded-cert.pem + embedded-key.pem (default)
 * Returns null if files missing — caller falls back to no-cert TLS.
 */
function loadClientCreds(): { cert: Buffer; key: Buffer } | null {
  const defaultDir = path.join(os.homedir(), "Desktop", "bambu certs");
  const certPath = process.env.BAMBU_CLIENT_CERT || path.join(defaultDir, "embedded-cert.pem");
  const keyPath = process.env.BAMBU_CLIENT_KEY || path.join(defaultDir, "embedded-key.pem");
  try {
    if (!existsSync(certPath) || !existsSync(keyPath)) return null;
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch {
    return null;
  }
}

const CLIENT_CREDS = loadClientCreds();

const COMMAND_SETTLE_MS = 300;

const MODEL_ID_TO_NAME: Record<string, string> = {
  O1D: "H2D",
  O1E: "H2D Pro",
  O1S: "H2S",
  N2S: "A1",
  A1M: "A1 Mini",
  C11: "P1P",
  C12: "P1S",
  "BL-P001": "X1C",
  "BL-P002": "X1",
  C13: "X1E",
};

interface BambuPrintOptionsInternal {
  projectName: string;
  filePath: string;
  useAMS?: boolean;
  plateIndex?: number;
  bedType?: string;
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
  layerInspect?: boolean;
  timelapse?: boolean;
  amsMapping?: number[];
  /**
   * Per-used-filament absolute tray index, one entry per position in the
   * selected plate's `filament_ids`. Example: plate uses project filament 1
   * only, and you want to pull from AMS 0 tray 1 -> pass `[1]`. The server
   * expands this into the project-level `ams_mapping` array at the right
   * position automatically (H2-series). Preferred over `amsMapping` for
   * ergonomic callers; `amsMapping` takes precedence if both are set.
   */
  amsSlots?: number[];
  md5?: string;
}

interface ProjectFileMetadata {
  plateFileName: string;
  plateInternalPath: string;
  md5: string;
  /** Number of filament slots declared at project level (length the H2
   * firmware expects for `ams_mapping`). Parsed from the gcode header
   * `; filament_colour = ...` list. */
  projectFilamentCount: number;
  /** 0-based positions in the project filament list that the selected plate
   * actually uses, from `Metadata/plate_<n>.json.filament_ids`. For a
   * single-filament cube that pulls only project filament 1, this is `[1]`. */
  usedFilamentPositions: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveModelName(data: Record<string, any>): string {
  const modelId = `${data?.model_id ?? ""}`.toUpperCase();
  return (
    MODEL_ID_TO_NAME[modelId] ||
    data?.model ||
    data?.device?.devModel ||
    data?.device?.dev_model ||
    "Unknown"
  );
}

async function invokeWithoutAck(printer: BambuClient, command: { invoke(client: BambuClient): Promise<void> }) {
  await command.invoke(printer);
  await sleep(COMMAND_SETTLE_MS);
}

function getPrinterKey(host: string, serial: string, token: string): string {
  return `${host}-${serial}-${token}`;
}

class TolerantBambuClient extends BambuClient {
  /**
   * H2D-class firmware streams push status immediately after subscribe, but
   * never answers bambu-node's initial get_version round-trip. Avoid treating
   * that missing ACK as a failed connection.
   */
  protected override async onConnect(): Promise<void> {
    const subscribe = (this as any).subscribe.bind(this);
    await subscribe(`device/${this.config.serialNumber}/report`);
  }

  /**
   * H2S/H2D printers don't respond to get_version with module info.
   * Infer model from serial number prefix so downstream code (Job, status
   * parsing, etc.) has a valid printerModel instead of undefined.
   */
  private inferModelFromSerial(): string | undefined {
    const sn = this.config.serialNumber;
    if (sn.startsWith("093")) return "H2S";
    if (sn.startsWith("094")) return "H2D";
    if (sn.startsWith("00M")) return "X1C";
    if (sn.startsWith("00W")) return "X1";
    if (sn.startsWith("03W")) return "X1E";
    if (sn.startsWith("01S")) return "P1P";
    if (sn.startsWith("01P")) return "P1S";
    if (sn.startsWith("030")) return "A1";
    if (sn.startsWith("039")) return "A1M";
    return undefined;
  }

  /**
   * Override bambu-node's MQTT connect to pass a client cert+key for mTLS.
   * Post-Jan-2025 H2D firmware rejects TLS handshakes without a valid Bambu-
   * issued client certificate. Options mirror the upstream implementation
   * plus `cert`/`key` when creds are available.
   */
  override async connect(): Promise<[void]> {
    await new Promise<void>((resolve, reject) => {
      const self: any = this;
      if (self.mqttClient) {
        throw new Error("Can't establish a new connection while running another one!");
      }
      const tlsOpts: Record<string, unknown> = {
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
      const client = mqtt.connect(
        `mqtts://${self.config.host}:${self.config.port}`,
        tlsOpts as any
      );
      self.mqttClient = client;
      client.on("connect", async (...args: any[]) => {
        try {
          await self.onConnect(...args);
          self.emit("client:connect");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      client.on("disconnect", () => {
        self.emit("client:disconnect", false);
        self.emit("printer:statusUpdate", self._printerStatus, "OFFLINE");
        self._printerStatus = "OFFLINE";
        if (self.currentJob) self.emit("job:pause", self.currentJob, true);
      });
      client.on("offline", () => {
        self.emit("client:disconnect", true);
        self.emit("printer:statusUpdate", self._printerStatus, "OFFLINE");
        self._printerStatus = "OFFLINE";
        if (self.currentJob) self.emit("job:pause", self.currentJob, true);
      });
      client.on("message", (topic: string, payload: Buffer) =>
        self.emit("rawMessage", topic, payload)
      );
      client.on("error", (err: Error) => {
        self.emit("client:error", err);
        reject(err);
      });
    });
    // H2S/H2D printers don't respond to get_version with module info.
    // Infer model from serial number prefix so downstream code works.
    if (!this.data.model) {
      const inferred = this.inferModelFromSerial();
      if (inferred) {
        (this.data as any).model = inferred;
        this.emit("printer:dataUpdate", this.data, { model: inferred } as any);
      }
    }
    return [undefined as unknown as void];
  }
}

/** Build FTPS secureOptions that include the client cert+key when available. */
function ftpsSecureOptions(): Record<string, unknown> {
  const opts: Record<string, unknown> = { rejectUnauthorized: false };
  if (CLIENT_CREDS) {
    opts.cert = CLIENT_CREDS.cert;
    opts.key = CLIENT_CREDS.key;
  }
  return opts;
}

class BambuClientStore {
  private printers: Map<string, BambuClient> = new Map();
  private initialConnectionPromises: Map<string, Promise<void>> = new Map();
  private reportSnapshots: Map<string, Record<string, any>> = new Map();
  private initialReportPromises: Map<string, Promise<void>> = new Map();
  private initialReportResolvers: Map<string, () => void> = new Map();

  private ensureInitialReportPromise(key: string): Promise<void> {
    const existing = this.initialReportPromises.get(key);
    if (existing) {
      return existing;
    }

    const promise = new Promise<void>((resolve) => {
      this.initialReportResolvers.set(key, resolve);
    });
    this.initialReportPromises.set(key, promise);
    return promise;
  }

  private resolveInitialReport(key: string): void {
    const resolve = this.initialReportResolvers.get(key);
    if (!resolve) {
      return;
    }

    this.initialReportResolvers.delete(key);
    resolve();
  }

  private updateReportSnapshot(key: string, update: Record<string, any>): void {
    if (!update || Object.keys(update).length === 0) {
      return;
    }

    const previous = this.reportSnapshots.get(key) || {};
    this.reportSnapshots.set(key, { ...previous, ...update });
    this.resolveInitialReport(key);
  }

  getCachedReport(host: string, serial: string, token: string): Record<string, any> | null {
    return this.reportSnapshots.get(getPrinterKey(host, serial, token)) || null;
  }

  async waitForInitialReport(
    host: string,
    serial: string,
    token: string,
    timeoutMs = 4000
  ): Promise<Record<string, any> | null> {
    const key = getPrinterKey(host, serial, token);
    const existing = this.reportSnapshots.get(key);
    if (existing && Object.keys(existing).length > 0) {
      return existing;
    }

    const reportPromise = this.ensureInitialReportPromise(key);

    try {
      await Promise.race([
        reportPromise,
        sleep(timeoutMs).then(() => {
          throw new Error(`Timed out waiting for initial printer report after ${timeoutMs}ms.`);
        }),
      ]);
    } catch (error) {
      console.warn(`No initial printer report received for ${serial}:`, error);
    }

    return this.reportSnapshots.get(key) || null;
  }

  async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    const key = getPrinterKey(host, serial, token);

    if (this.printers.has(key)) {
      return this.printers.get(key)!;
    }

    if (this.initialConnectionPromises.has(key)) {
      await this.initialConnectionPromises.get(key);
      if (this.printers.has(key)) {
        return this.printers.get(key)!;
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
      } catch {
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
      this.printers.delete(key);
      this.initialConnectionPromises.delete(key);
      this.initialReportPromises.delete(key);
      this.initialReportResolvers.delete(key);
    });

    printer.on("client:disconnect", () => {
      this.printers.delete(key);
      this.initialConnectionPromises.delete(key);
      this.initialReportPromises.delete(key);
      this.initialReportResolvers.delete(key);
    });

    const connectPromise = printer.connect().then(() => {});
    this.initialConnectionPromises.set(key, connectPromise);

    try {
      await connectPromise;
      return printer;
    } catch (error) {
      this.initialConnectionPromises.delete(key);
      throw error;
    }
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const printer of this.printers.values()) {
      disconnectPromises.push(
        (async () => {
          try {
            await printer.disconnect();
          } catch (error) {
            console.error("Failed to disconnect Bambu client", error);
          }
        })()
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.printers.clear();
    this.initialConnectionPromises.clear();
    this.initialReportPromises.clear();
    this.initialReportResolvers.clear();
  }
}

export class BambuImplementation {
  private printerStore: BambuClientStore;

  constructor() {
    this.printerStore = new BambuClientStore();
  }

  private async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    return this.printerStore.getPrinter(host, serial, token);
  }

  private async resolveProjectFileMetadata(
    localThreeMfPath: string,
    plateIndex?: number
  ): Promise<ProjectFileMetadata> {
    const archive = await fs.readFile(localThreeMfPath);
    const zip = await JSZip.loadAsync(archive);

    const plateEntries = Object.values(zip.files).filter(
      (entry) => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name)
    );

    if (plateEntries.length === 0) {
      throw new Error(
        "3MF does not contain any Metadata/plate_<n>.gcode entries. Re-slice and export a printable 3MF."
      );
    }

    let selectedEntry = plateEntries.sort((a, b) => a.name.localeCompare(b.name))[0];

    if (plateIndex !== undefined) {
      const expectedEntryName = `Metadata/plate_${plateIndex + 1}.gcode`;
      const matchedEntry = plateEntries.find(
        (entry) => entry.name.toLowerCase() === expectedEntryName.toLowerCase()
      );

      if (!matchedEntry) {
        const available = plateEntries.map((entry) => entry.name).join(", ");
        throw new Error(
          `Requested plateIndex=${plateIndex} (${expectedEntryName}) not present in 3MF. Available: ${available}`
        );
      }

      selectedEntry = matchedEntry;
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
    } else {
      // Fallback: count filament_ids header entries.
      const idsLine = head.match(/;\s*filament_ids\s*=\s*([^\n\r]+)/i);
      if (idsLine) {
        projectFilamentCount = idsLine[1].split(";").filter((s) => s.trim()).length;
      }
    }

    // Used filament positions: from Metadata/plate_<n>.json.filament_ids.
    // These are 0-based positions into the project filament list that the
    // selected plate actually consumes.
    let usedFilamentPositions: number[] = [];
    const plateJsonName = selectedEntry.name.replace(/\.gcode$/i, ".json");
    const plateJsonEntry = zip.file(plateJsonName);
    if (plateJsonEntry) {
      try {
        const raw = await plateJsonEntry.async("string");
        const json = JSON.parse(raw);
        if (Array.isArray(json.filament_ids)) {
          usedFilamentPositions = json.filament_ids
            .filter((n: unknown) => Number.isInteger(n))
            .map((n: number) => n);
        }
      } catch {
        // tolerate malformed plate_N.json -- caller can pass amsMapping directly
      }
    }
    if (usedFilamentPositions.length === 0) usedFilamentPositions = [0];

    return {
      plateFileName: path.posix.basename(selectedEntry.name),
      plateInternalPath: selectedEntry.name,
      md5,
      projectFilamentCount,
      usedFilamentPositions,
    };
  }

  async getStatus(host: string, serial: string, token: string): Promise<any> {
    try {
      const printer = await this.getPrinter(host, serial, token);

      try {
        await invokeWithoutAck(printer, new PushAllCommand());
      } catch (error) {
        console.warn("PushAllCommand failed, continuing with cached status", error);
      }

      const cachedData = await this.printerStore.waitForInitialReport(host, serial, token);
      const data =
        cachedData && Object.keys(cachedData).length > 0
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
    } catch (error) {
      console.error(`Failed to get Bambu status for ${serial}:`, error);
      return { status: "error", connected: false, error: (error as Error).message };
    }
  }

  async print3mf(
    host: string,
    serial: string,
    token: string,
    options: BambuPrintOptionsInternal
  ): Promise<any> {
    if (!options.filePath.toLowerCase().endsWith(".3mf")) {
      throw new Error("print3mf requires a .3mf input file.");
    }

    // Normalise remote filename: collapse double-extension artifacts like
    // "Cube.gcode.3mf.gcode.3mf" -> "Cube.gcode.3mf" so firmware can identify
    // the container format from the extension.
    let remoteFileName = path.basename(options.filePath);
    remoteFileName = remoteFileName.replace(/\.gcode\.3mf\.gcode\.3mf$/i, ".gcode.3mf");

    // H2S/H2D land files at the FTP root and reference them via ftp:///<name>.
    // P1/A1/X1 use /cache/<name> and file:///sdcard/cache/<name>.
    const isH2 = serial.startsWith("093") || serial.startsWith("094");
    const remoteProjectPath = isH2 ? remoteFileName : `cache/${remoteFileName}`;
    const remoteUploadPath = isH2 ? `/${remoteFileName}` : `/cache/${remoteFileName}`;
    const projectUrl = isH2
      ? `ftp:///${remoteFileName}`
      : `file:///sdcard/${remoteProjectPath}`;

    // Upload via basic-ftp directly (bypasses bambu-js double-path bug)
    await this.ftpUpload(host, token, options.filePath, remoteUploadPath);

    // Pre-sliced .gcode.3mf files: routing depends on firmware generation.
    // P1/A1/X1 series: project_file returns 405004002 for .gcode.3mf (firmware
    // doesn't recognise the container), so use gcode_file instead.
    // H2S/H2D: gcode_file is not supported; project_file works because the
    // firmware can open the zip and find Metadata/plate_<n>.gcode directly.
    if (options.filePath.toLowerCase().endsWith(".gcode.3mf")) {
      if (!isH2) {
        const printer = await this.getPrinter(host, serial, token);
        await invokeWithoutAck(printer, new GCodeFileCommand({ fileName: remoteProjectPath }));
        return {
          status: "success",
          message: `Uploaded and started gcode.3mf print: ${options.projectName}`,
          remoteProjectPath,
        };
      }
      // H2S/H2D: fall through to project_file path below
    }

    const projectMetadata = await this.resolveProjectFileMetadata(
      options.filePath,
      options.plateIndex
    );

    // Send project_file command via bambu-node MQTT (bypasses bambu-js
    // hardcoded use_ams=true and missing ams_mapping support)
    const printer = await this.getPrinter(host, serial, token);
    const md5 = options.md5 ?? projectMetadata.md5;

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
    const validateTrayValue = (v: unknown, label: string): void => {
      if (
        !Number.isInteger(v) ||
        (v as number) < -1 ||
        ((v as number) > 15 && (v as number) < 128) ||
        (v as number) > 254
      ) {
        throw new Error(
          `${label} values must be integers in [-1, 15] (absolute tray) or 128-254 (HT/external); got ${v}`
        );
      }
    };

    let baseMapping: number[];
    if (options.amsMapping && options.amsMapping.length > 0) {
      for (const v of options.amsMapping) validateTrayValue(v, "ams_mapping");
      baseMapping = options.amsMapping.slice();
    } else if (options.amsSlots && options.amsSlots.length > 0) {
      for (const v of options.amsSlots) validateTrayValue(v, "amsSlots");
      const positions = projectMetadata.usedFilamentPositions;
      if (options.amsSlots.length !== positions.length) {
        throw new Error(
          `amsSlots length ${options.amsSlots.length} does not match used filament count ${positions.length} (plate uses positions ${JSON.stringify(positions)}). Provide one tray per used filament, or use amsMapping for a raw project-level array.`
        );
      }
      const projectLen = Math.max(
        projectMetadata.projectFilamentCount,
        ...positions.map((p) => p + 1)
      );
      baseMapping = Array<number>(projectLen).fill(-1);
      positions.forEach((pos, i) => {
        baseMapping[pos] = options.amsSlots![i];
      });
    } else {
      const positions = projectMetadata.usedFilamentPositions;
      const projectLen = Math.max(
        projectMetadata.projectFilamentCount,
        ...positions.map((p) => p + 1),
        1
      );
      baseMapping = Array<number>(projectLen).fill(-1);
      positions.forEach((pos, i) => {
        baseMapping[pos] = i;
      });
    }

    let amsMapping: number[];
    let amsMapping2: Array<{ ams_id: number; slot_id: number }>;
    if (isH2) {
      const projLen = Math.max(projectMetadata.projectFilamentCount, baseMapping.length, 1);
      amsMapping = Array.from({ length: projLen }, (_, i) =>
        i < baseMapping.length ? baseMapping[i] : -1
      );
      amsMapping2 = amsMapping.map((v) => {
        if (v < 0 || v === 255) return { ams_id: 255, slot_id: 255 };
        if (v >= 128) return { ams_id: 128, slot_id: v - 128 };
        if (v === 254) return { ams_id: 254, slot_id: 254 };
        return { ams_id: Math.floor(v / 4), slot_id: v % 4 };
      });
    } else {
      amsMapping = Array.from({ length: 5 }, (_, i) =>
        i < baseMapping.length ? baseMapping[i] : -1
      );
      amsMapping2 = [];
    }

    const b = (v: any) => (v ? 1 : 0);
    let projectFileCmd: Record<string, any>;
    if (isH2) {
      const submissionId = String(Date.now() & 0x7fffffff);
      projectFileCmd = {
        print: {
          sequence_id: "0",
          command: "project_file",
          param: `Metadata/${projectMetadata.plateFileName}`,
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
    } else {
      projectFileCmd = {
        print: {
          command: "project_file",
          param: `Metadata/${projectMetadata.plateFileName}`,
          url: projectUrl,
          subtask_name: options.projectName,
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

    await printer.publish(projectFileCmd);
    await new Promise((resolve) => setTimeout(resolve, 300));

    return {
      status: "success",
      message: `Uploaded and started 3MF print: ${options.projectName}`,
      remoteProjectPath,
      plateFile: projectMetadata.plateFileName,
      platePath: projectMetadata.plateInternalPath,
      md5,
      amsMapping,
    };
  }

  async cancelJob(host: string, serial: string, token: string): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);

    try {
      await invokeWithoutAck(printer, new UpdateStateCommand({ state: "stop" }));
      return { status: "success", message: "Cancel command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to cancel print: ${(error as Error).message}`);
    }
  }

  async pauseJob(host: string, serial: string, token: string): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);
    try {
      await invokeWithoutAck(printer, new UpdateStateCommand({ state: "pause" }));
      return { status: "success", message: "Pause command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to pause print: ${(error as Error).message}`);
    }
  }

  async resumeJob(host: string, serial: string, token: string): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);
    try {
      await invokeWithoutAck(printer, new UpdateStateCommand({ state: "resume" }));
      return { status: "success", message: "Resume command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to resume print: ${(error as Error).message}`);
    }
  }

  async clearHmsErrors(host: string, serial: string, token: string): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);
    await printer.publish({
      print: {
        command: "clean_print_error",
        sequence_id: "0",
      },
    });
    await sleep(COMMAND_SETTLE_MS);
    return { status: "success", message: "HMS clear command sent." };
  }

  async setPrintSpeed(host: string, serial: string, token: string, speedMode: string | number): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);
    const normalized =
      typeof speedMode === "number" ? String(Math.trunc(speedMode)) : speedMode.trim().toLowerCase();
    const mode =
      normalized === "silent" ? 1 :
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

  async setAirductMode(host: string, serial: string, token: string, mode: string): Promise<any> {
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

  async rereadAmsRfid(
    host: string,
    serial: string,
    token: string,
    amsId: number,
    slotId: number
  ): Promise<any> {
    const printer = await this.getPrinter(host, serial, token);
    const normalizedAmsId = Math.trunc(amsId);
    const normalizedSlotId = Math.trunc(slotId);

    if (!Number.isInteger(normalizedAmsId) || normalizedAmsId < 0 || normalizedAmsId > 3) {
      throw new Error("ams_id must be an integer from 0 to 3.");
    }
    if (!Number.isInteger(normalizedSlotId) || normalizedSlotId < 0 || normalizedSlotId > 3) {
      throw new Error("slot_id must be an integer from 0 to 3.");
    }

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

  async setTemperature(
    host: string,
    serial: string,
    token: string,
    component: string,
    temperature: number
  ) {
    const printer = await this.getPrinter(host, serial, token);

    const normalizedComponent = component.toLowerCase();
    const targetTemperature = Math.round(temperature);

    if (targetTemperature < 0 || targetTemperature > 300) {
      throw new Error("Temperature must be between 0 and 300°C.");
    }

    let gcode: string;
    if (normalizedComponent === "bed") {
      gcode = `M140 S${targetTemperature}`;
    } else if (
      normalizedComponent === "extruder" ||
      normalizedComponent === "nozzle" ||
      normalizedComponent === "tool" ||
      normalizedComponent === "tool0"
    ) {
      gcode = `M104 S${targetTemperature}`;
    } else {
      throw new Error(
        `Unsupported temperature component: ${component}. Use one of: bed, nozzle, extruder.`
      );
    }

    await invokeWithoutAck(printer, new GCodeLineCommand({ gcodes: [gcode] }));
    return {
      status: "success",
      message: `Temperature command sent for ${normalizedComponent}.`,
      command: gcode,
    };
  }

  async setFanSpeed(
    host: string,
    serial: string,
    token: string,
    fan: string | number,
    speed: number
  ) {
    const printer = await this.getPrinter(host, serial, token);
    const normalizedFan = typeof fan === "number" ? fan : fan.trim().toLowerCase();
    const fanId =
      normalizedFan === 1 || normalizedFan === "1" || normalizedFan === "part" || normalizedFan === "part_cooling"
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

    await invokeWithoutAck(
      printer,
      new UpdateFanCommand({ fan: fanId as any, speed: targetSpeed as any })
    );
    return {
      status: "success",
      message: `Fan speed command sent for fan ${fanId}.`,
      fan: fanId,
      speed: targetSpeed,
    };
  }

  async setLight(
    host: string,
    serial: string,
    token: string,
    light: string,
    mode: string
  ) {
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

    await invokeWithoutAck(
      printer,
      new UpdateLightCommand({
        light: normalizedLight as any,
        mode: normalizedMode as any,
      })
    );
    return {
      status: "success",
      message: `Light command sent for ${normalizedLight}.`,
      light: normalizedLight,
      mode: normalizedMode,
    };
  }

  async skipObjects(
    host: string,
    serial: string,
    token: string,
    objectIds: number[]
  ) {
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

  async getFiles(host: string, serial: string, token: string) {
    const printer = new BambuPrinter(host, serial, token);
    const directories = ["cache", "timelapse", "logs"];
    const filesByDirectory: Record<string, string[]> = {};

    await printer.manipulateFiles(async (context) => {
      for (const directory of directories) {
        try {
          filesByDirectory[directory] = await context.readDir(directory);
        } catch {
          filesByDirectory[directory] = [];
        }
      }
    });

    const files = Object.entries(filesByDirectory).flatMap(([directory, names]) =>
      names.map((name) => `${directory}/${name}`)
    );

    return {
      files,
      directories: filesByDirectory,
    };
  }

  async getFile(host: string, serial: string, token: string, filename: string) {
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

  async uploadFile(
    host: string,
    serial: string,
    token: string,
    filePath: string,
    filename: string,
    print: boolean
  ) {
    await fs.access(filePath);

    const normalizedFileName = filename.replace(/^\/+/, "");
    const remotePath = normalizedFileName.includes("/")
      ? normalizedFileName
      : `cache/${normalizedFileName}`;

    // Use direct FTP upload (bypasses bambu-js double-path bug)
    await this.ftpUpload(host, token, filePath, `/${remotePath}`);

    const response: Record<string, unknown> = {
      status: "success",
      uploaded: true,
      remotePath,
      printRequested: print,
    };

    if (print) {
      if (remotePath.toLowerCase().endsWith(".gcode")) {
        response.startResult = await this.startJob(host, serial, token, remotePath);
      } else if (remotePath.toLowerCase().endsWith(".3mf")) {
        response.note =
          "3MF upload complete. Use print_3mf to start a project print with plate and metadata options.";
      } else {
        throw new Error(
          "Automatic print after upload supports .gcode only. Use print_3mf for .3mf project prints."
        );
      }
    }

    return response;
  }

  async startJob(host: string, serial: string, token: string, filename: string) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".3mf") && !lower.endsWith(".gcode.3mf")) {
      throw new Error("Use print_3mf for .3mf project files.");
    }

    const printer = await this.getPrinter(host, serial, token);

    const normalizedFileName = filename.replace(/^\/+/, "");
    const remoteFile = normalizedFileName.includes("/")
      ? normalizedFileName
      : `cache/${normalizedFileName}`;

    await invokeWithoutAck(printer, new GCodeFileCommand({ fileName: remoteFile }));

    return {
      status: "success",
      message: `Start command sent for ${remoteFile}.`,
      file: remoteFile,
    };
  }

  /**
   * Upload a file to the printer via FTP using basic-ftp directly.
   * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
   * into the target directory, then uploadFrom uses the full relative path
   * again, resulting in e.g. /cache/cache/file.3mf).
   */
  private async ftpUpload(
    host: string,
    token: string,
    localPath: string,
    remotePath: string
  ): Promise<void> {
    const client = new FTPClient(15_000);
    try {
      await client.access({
        host,
        port: 990,
        user: "bblp",
        password: token,
        secure: "implicit",
        secureOptions: ftpsSecureOptions(),
      });
      // With TLS 1.3 the session ticket arrives asynchronously; basic-ftp calls
      // getSession() when opening the data channel and gets undefined if the
      // ticket hasn't arrived yet, causing a fresh TLS negotiation that Bambu
      // printers reject. Wait for the session ticket before proceeding.
      await this.waitForTlsSession(client);
      // Use absolute path to avoid CWD side-effects
      const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
      const remoteDir = path.posix.dirname(absoluteRemote);
      await client.ensureDir(remoteDir);
      // uploadFrom with just the basename since we're already in the right dir
      await client.uploadFrom(localPath, path.posix.basename(absoluteRemote));
    } finally {
      client.close();
    }
  }

  private async waitForTlsSession(ftpClient: FTPClient): Promise<void> {
    const socket = (ftpClient as any).ftp?.socket;
    if (!socket || typeof socket.getSession !== "function") return;
    if (socket.getSession()) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      socket.once("session", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async disconnectAll(): Promise<void> {
    await this.printerStore.disconnectAll();
  }
}
