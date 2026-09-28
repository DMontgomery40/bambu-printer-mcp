import { inspectPrintFile } from "../safety/print-file.js";
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
export declare class BambuImplementation {
    private readonly confirm?;
    private printerStore;
    private checkedJobs;
    private clearedErrors;
    constructor(confirm?: ((message: string) => Promise<boolean>) | undefined);
    confirmHardwareAction(message: string, physicalCheck?: boolean): Promise<void>;
    private finishedJobIdentity;
    confirmPrintPreflight(serial: string, status: any, inspection: Awaited<ReturnType<typeof inspectPrintFile>>): Promise<string | undefined>;
    assertBedClearance(status: any, confirmedFinishedJob: string | undefined): void;
    private getPrinter;
    /** Internal handoff from a successful inspected transport; never exposed as an MCP tool. */
    recordCheckedJob(host: string, serial: string, remotePath: string, requirements: PrinterStateRequirements): void;
    private validateLoadedGcodeState;
    private resolveProjectFileMetadata;
    /** Safety reads never use the display cache or configured-serial model inference. */
    getSafetyStatus(host: string, serial: string, token: string): Promise<any>;
    getStatus(host: string, serial: string, token: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    private print3mfPrepared;
    cancelJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    pauseJob(host: string, serial: string, token: string, dispatch?: () => Promise<any>): Promise<any>;
    resumeJob(host: string, serial: string, token: string, dispatch?: (assertActive: () => void) => Promise<any>): Promise<any>;
    clearHmsErrors(host: string, serial: string, token: string, dispatch?: (assertActive: () => void) => Promise<any>): Promise<any>;
    setPrintSpeed(host: string, serial: string, token: string, speedMode: string | number): Promise<any>;
    setAirductMode(host: string, serial: string, token: string, mode: string): Promise<any>;
    rereadAmsRfid(host: string, serial: string, token: string, amsId: number, slotId: number): Promise<any>;
    setTemperature(host: string, serial: string, token: string, component: string, temperature: unknown, bambuModel?: string, material?: string, nozzleDiameter?: number, dispatch?: (heater: "bed" | "nozzle", target: number, assertActive: () => void) => Promise<any>): Promise<{
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
    getFile(host: string, serial: string, token: string, filename: string): Promise<{
        name: string;
        exists: boolean;
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
        remotePath: string;
        message: string;
    }>;
    private printRawPrepared;
    startJob(host: string, serial: string, token: string, filename: string, bambuModel?: string): Promise<{
        status: string;
        uploaded: boolean;
        printRequested: boolean;
        remotePath: string;
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
     * Open the TLS-on-6000 socket, send the 80-byte auth packet, and read
     * a single complete JPEG frame. Returns the JPEG bytes.
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
export {};
