import { CameraStreams, type FrameOptions } from "./camera-stream.js";
import { inspectPrintFile, type PrintFileInspection } from "../safety/print-file.js";
import { type PrinterStateRequirements } from "../safety/printer-state.js";
export declare function assertDirectPrintSupported(model: string | undefined, serial?: string): void;
interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string;
    bambuModel?: string;
    nozzleDiameters?: number[];
    useAMS?: boolean;
    plateIndex?: number;
    bedType?: string;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    /** Explicit Studio option values (0 off, 1 on, 2 auto); see studio-print-options.ts. */
    autoBedLeveling?: number;
    autoFlowCali?: number;
    autoOffsetCali?: number;
    extruderCaliManualMode?: number;
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
/** A merged MQTT report and when it last arrived (ms since epoch). */
export type ProgressReport = {
    raw: Record<string, any>;
    receivedAt: number;
};
/** The inspected bytes and limits of a started job, for the resume prompt and byte check. */
export type CheckedFile = {
    sha256: string;
    /** A project's printed plate: its number and the SHA-256 of its Metadata/plate_<index>.gcode. */
    plate?: {
        index: number;
        sha256: string;
    };
    model: string;
    maxNozzleTemperature: number;
    maxBedTemperature: number;
    maxChamberTemperature: number;
    materials: string[];
};
/** What a resume needs to know about a started file (filePath, the inspected snapshot): its bytes, printed plate, limits and used materials. */
export declare function checkedFile(inspection: PrintFileInspection, filePath: string): Promise<CheckedFile>;
export type PrintPreflight = {
    finishedJob?: string;
    serial: string;
    model: string;
    notices: string[];
};
export { cameraFrameParser } from "./camera-wire.js";
export declare class BambuImplementation {
    private readonly confirm?;
    private printerStore;
    readonly cameraStreams: CameraStreams;
    /**
     * The job each printer may resume, keyed host and serial. Cancel, a report
     * that it ended after it was seen running, or another job seen in its place
     * retires it, so a later job that reuses the name is never resumed.
     */
    private checkedJobs;
    /** In-flight counterpart_print_progress reads, one per printer. */
    private progressReads;
    private clearedErrors;
    constructor(confirm?: ((message: string) => Promise<boolean>) | undefined);
    /**
     * Ask a person through MCP elicitation, only for a physical check or a prompt with
     * requiredBecause (why a person must accept it). Ordinary print, heating and resume
     * starts do not ask: the client's own button is the yes, and the printer runs its
     * own checks.
     */
    confirmHardwareAction(message: string, physicalCheck?: boolean, requiredBecause?: string): Promise<void>;
    private finishedJobIdentity;
    /**
     * Record the current job and notices during preflight so a changed printer state
     * is detected before dispatch.
     */
    confirmPrintPreflight(serial: string, status: any, inspection: Awaited<ReturnType<typeof inspectPrintFile>>): Promise<PrintPreflight>;
    /** Stop a print whose confirmed situation changed: a newly finished job, or a hidden HMS notice the preflight did not name. */
    assertPrintPreflight(status: any, preflight: PrintPreflight): void;
    private getPrinter;
    /**
     * Internal handoff from a successful inspected transport; never exposed as
     * an MCP tool. uploadedHere is false for the plug-in routes, where Bambu's
     * plug-in or cloud put the file on the printer at a path this server has not
     * verified: a resume then re-reads it if it can and otherwise matches the
     * unique name, as KAN-216 does for firmware that cannot download a file.
     */
    recordCheckedJob(host: string, serial: string, remotePath: string, requirements: PrinterStateRequirements, file: CheckedFile, uploadedHere?: boolean): void;
    /** Feed one merged report to the resume record (internal; the client store calls it for every report). */
    observeReport(host: string, serial: string, raw: Record<string, any> | undefined): void;
    private validateLoadedGcodeState;
    private resolveProjectFileMetadata;
    /** Safety reads never use the display cache or configured-serial model inference. */
    getSafetyStatus(host: string, serial: string, token: string): Promise<any>;
    /**
     * The merged MQTT report for counterpart_print_progress and when it arrived.
     * On a held session it comes from the cache with no printer traffic. PushAll
     * is sent only to fill a cold cache, or at most once per STALE_REPORT_MS when
     * the printer has been quiet for longer than that (P1-series firmware lags
     * when asked often). The whole read, connection and publish included, is
     * bounded by timeoutMs: the MQTT connect to an unreachable printer keeps
     * retrying, so it must not hold the call. Then the result is null, or a stale
     * report that could not be refreshed in time. Display data only; safety
     * checks use getSafetyStatus.
     */
    readProgressReport(host: string, serial: string, token: string, timeoutMs?: number): Promise<ProgressReport | null>;
    private firstProgressReport;
    private refreshProgressReport;
    getStatus(host: string, serial: string, token: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    private print3mfPrepared;
    cancelJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    private invokeEmergencyCommand;
    /** Raw MQTT stop for routes that already ran the shared cancellation steps. */
    sendStopOverMqtt(host: string, serial: string, token: string, signal?: AbortSignal): Promise<any>;
    /** Raw MQTT heater-off; switching off needs no material or model declaration. */
    sendHeaterOffOverMqtt(host: string, serial: string, token: string, heater: "bed" | "nozzle", signal?: AbortSignal): Promise<any>;
    pauseJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    /**
     * Resume reheats and moves the printer, so it is gated like a print start:
     * only the job this server inspected and started, while a fresh report shows
     * it paused, with its bytes re-read over FTPS and compared. Only a file that
     * could not be re-read asks a person. The record must still
     * be current at every check, including the native helper's last one.
     */
    resumeJob(host: string, serial: string, token: string, dispatch?: (assertActive: () => void, beforeDispatch: () => Promise<void>) => Promise<any>): Promise<any>;
    /**
     * Re-read a started job's bytes over FTPS: the uploaded file, else the plate
     * G-code the printer extracted from the project to print it. The first file
     * that can be read decides; a mismatch is reported as changed.
     */
    private rereadJob;
    /** SHA-256 of a printer file, streamed from an FTPS download into a private directory. */
    private remoteSha256;
    clearHmsErrors(host: string, serial: string, token: string, dispatch?: (assertActive: () => void, beforeDispatch: () => Promise<void>) => Promise<any>): Promise<any>;
    setPrintSpeed(host: string, serial: string, token: string, speedMode: string | number): Promise<any>;
    setAirductMode(host: string, serial: string, token: string, mode: string): Promise<any>;
    rereadAmsRfid(host: string, serial: string, token: string, amsId: number, slotId: number): Promise<any>;
    setTemperature(host: string, serial: string, token: string, component: string, temperature: unknown, bambuModel?: string, material?: string, nozzleDiameter?: number, dispatch?: (heater: "bed" | "nozzle", target: number, assertActive: () => void, beforeDispatch?: () => Promise<void>) => Promise<any>): Promise<{
        routes: any;
        native_error: any;
        mqtt_error: any;
        status: string;
        message: string;
        command: string;
    } | {
        routes?: undefined;
        native_error?: undefined;
        mqtt_error?: undefined;
        status: string;
        message: string;
        command: string;
    }>;
    setFanSpeed(host: string, serial: string, token: string, fan: string | number, speed: number): Promise<{
        status: string;
        message: string;
        fan: number;
        speed: number;
    }>;
    setLight(host: string, serial: string, token: string, light: string, mode: string): Promise<{
        status: string;
        message: string;
        light: string;
        mode: string;
    }>;
    setAmsDrying(host: string, serial: string, token: string, action: string, amsId: number): Promise<any>;
    skipObjects(host: string, serial: string, token: string, objectIds: number[]): Promise<{
        status: string;
        message: string;
        object_ids: number[];
    }>;
    getFiles(host: string, serial: string, token: string): Promise<{
        files: string[];
        directories: Record<string, string[]>;
    }>;
    uploadFile(host: string, serial: string, token: string, filePath: string, filename: string, print: boolean, bambuModel?: string, upload?: (snapshot: string, destination: string, assertActive: () => void) => Promise<void>): Promise<{
        status: string;
        uploaded: boolean;
        remotePath: string;
        printRequested: boolean;
        inspected: boolean;
    } | {
        status: string;
        uploaded: boolean;
        printRequested: boolean;
        dispatch: "started" | "unconfirmed";
        remotePath: string;
        jobName: string;
        message: string;
    }>;
    private printRawPrepared;
    /**
     * A published print command is not proof the printer took it. Listen to the
     * reports the printer pushes anyway (no extra pushall polling on weak P1
     * boards): a new command-verification HMS means the firmware refused the
     * command; PREPARE/SLICING/RUNNING means it started. Attach before publishing.
     */
    private watchDispatch;
    startJob(host: string, serial: string, token: string, filename: string, bambuModel?: string): Promise<{
        status: string;
        uploaded: boolean;
        printRequested: boolean;
        dispatch: "started" | "unconfirmed";
        remotePath: string;
        jobName: string;
        message: string;
    }>;
    private ftpDownload;
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
    cameraStreamStart(host: string, serial: string, token: string, options?: {
        bambuModel?: string;
        fps?: number;
        idleTimeoutMs?: number;
        ffmpegPath?: string;
    }): {
        status: "started" | "running";
        transport: import("./camera-stream.js").CameraTransport;
        fps: number;
        startedAt: string;
    };
    cameraStreamFrame(host: string, serial: string, options?: FrameOptions): Promise<import("./camera-stream.js").StreamFrameResult | {
        status: string;
        seq: number;
    }>;
    cameraStreamStop(host: string, serial: string): {
        status: string;
    };
    cameraSnapshot(host: string, _serial: string, token: string, options?: {
        savePath?: string;
        timeoutMs?: number;
        bambuModel?: string;
        /**
         * Reserved. Earlier this flag let callers probe the H2 series via
         * the A1/P1 TCP-on-6000 path. Diagnostics confirmed the printer
         * does not speak that protocol; H2 uses RTSP, same as X1. The
         * flag is now ignored. Kept on the type to avoid breaking
         * existing callers.
         */
        experimental?: boolean;
        /**
         * Optional override for the ffmpeg binary path used by the RTSP
         * path. Defaults to `ffmpeg` (relies on $PATH).
         */
        ffmpegPath?: string;
    }): Promise<{
        status: string;
        format: string;
        sizeBytes: number;
        base64: string;
        savedTo?: string;
        width?: number;
        height?: number;
        note?: string;
        transport?: "tcp-6000" | "rtsps-322";
    }>;
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
    private fetchRtspCameraFrame;
    /**
     * Open the TLS-on-6000 socket, send the 80-byte auth packet, and return
     * a live JPEG frame. The printer first replays the last frame it buffered,
     * which after an idle period can show the chamber as it was long ago (a
     * finished part still on the bed), so that frame and any byte-identical
     * repeat of it are discarded and the next frame returned; live frames always
     * differ by sensor noise. If no live frame arrives in time, this fails rather
     * than return a possibly stale image.
     */
    private fetchTcpCameraFrame;
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
    deleteFile(host: string, _serial: string, token: string, filename: string, confirm: unknown): Promise<{
        status: string;
        deleted: boolean;
        remotePath: string;
        message?: string;
    }>;
    /**
     * Delete a single remote file via FTPS, using basic-ftp directly so we
     * get the same TLS-session-ticket handshake as ftpUpload().
     */
    private ftpDelete;
    /**
     * Upload a file to the printer via FTP using basic-ftp directly.
     * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
     * into the target directory, then uploadFrom uses the full relative path
     * again, resulting in e.g. /cache/cache/file.3mf).
     */
    private ftpUpload;
    private waitForTlsSession;
    disconnectAll(): Promise<void>;
}
