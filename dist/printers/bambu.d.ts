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
