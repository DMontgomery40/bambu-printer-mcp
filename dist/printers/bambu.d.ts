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
export declare class BambuImplementation {
    private printerStore;
    constructor();
    private getPrinter;
    private resolveProjectFileMetadata;
    getStatus(host: string, serial: string, token: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    cancelJob(host: string, serial: string, token: string): Promise<any>;
    pauseJob(host: string, serial: string, token: string): Promise<any>;
    resumeJob(host: string, serial: string, token: string): Promise<any>;
    clearHmsErrors(host: string, serial: string, token: string): Promise<any>;
    setPrintSpeed(host: string, serial: string, token: string, speedMode: string | number): Promise<any>;
    setAirductMode(host: string, serial: string, token: string, mode: string): Promise<any>;
    rereadAmsRfid(host: string, serial: string, token: string, amsId: number, slotId: number): Promise<any>;
    setTemperature(host: string, serial: string, token: string, component: string, temperature: number): Promise<{
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
    uploadFile(host: string, serial: string, token: string, filePath: string, filename: string, print: boolean): Promise<Record<string, unknown>>;
    startJob(host: string, serial: string, token: string, filename: string): Promise<{
        status: string;
        message: string;
        file: string;
    }>;
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
     * and P2S use RTSP on port 322 instead -- not implemented yet. H2/H2S/H2D
     * are not documented; we fail fast rather than guess at the protocol.
     *
     * Read-only; no confirm gate. Default 8s timeout for cold-start latency.
     */
    cameraSnapshot(host: string, _serial: string, token: string, options?: {
        savePath?: string;
        timeoutMs?: number;
        bambuModel?: string;
        /**
         * Opt-in: try the TCP-on-6000 path for hardware whose camera
         * protocol isn't documented upstream (currently H2 series). The
         * A1/P1 wire format may or may not work; if it does, we get a
         * JPEG. If not, the connection fails or the auth handshake is
         * rejected and the caller gets a clean error. No data is
         * exfiltrated either way -- read-only.
         */
        experimental?: boolean;
    }): Promise<{
        status: string;
        format: string;
        sizeBytes: number;
        base64: string;
        savedTo?: string;
        width?: number;
        height?: number;
        note?: string;
    }>;
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
    deleteFile(host: string, _serial: string, token: string, filename: string, confirm: boolean): Promise<{
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
