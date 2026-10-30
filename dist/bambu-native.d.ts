export type BambuNativePrintOptions = {
    host: string;
    serial: string;
    token: string;
    filePath: string;
    remoteName?: string;
    projectName: string;
    presetName: string;
    plateIndex: number;
    bedType: string;
    useAMS: boolean;
    amsMapping?: string;
    amsMapping2?: string;
    amsMappingInfo?: string;
    nozzleMapping?: string;
    nozzlesInfo?: string;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    timelapse?: boolean;
    /** true: the SD card or USB stick; false: internal storage (eMMC); unset: BAMBU_NATIVE_TRY_EMMC_PRINT or internal. Reported as the requested storage. */
    externalStorage?: boolean;
};
export type BambuNativeControlOptions = {
    host: string;
    serial: string;
    token: string;
    messageJson: string;
    qos?: number;
    flag?: number;
};
export type BambuNativeUpdateCallback = (line: string) => void;
export type BambuNativeExecution = {
    signal?: AbortSignal;
    /** Recheck the shared stop/heater-off generation while the helper runs. */
    assertActive?: () => void;
    /** Read and validate fresh printer state immediately before each guarded dispatch. */
    beforeDispatch?: () => Promise<void>;
};
export type BambuNativeFanCommand = {
    fan: "part" | "auxiliary" | "right_auxiliary" | "chamber";
    fanIndex: 1 | 2 | 3 | 10;
    requestedSpeed: number;
    speed: number;
    messageJson: string;
};
export type BambuNativeTemperatureCommand = {
    component: "bed" | "nozzle";
    requestedTemperature: number;
    temperature: number;
    messageJson: string;
};
/**
 * Hosts for which the native helper and Bambu's networking plug-in exist.
 * Bambu publishes its Linux plug-in for x86-64 only.
 */
export declare function isBambuNativePlatform(platform?: NodeJS.Platform, arch?: string): boolean;
/**
 * Private directory used by `bambu-printer-mcp-native-setup` on Linux. Mirrors
 * nativeHomeDir() in native/bambu-native-print.cpp: empty values count as unset.
 */
export declare function bambuNativeHomeDir(env?: NodeJS.ProcessEnv): string;
export declare const BAMBU_NATIVE_CERTIFICATES: readonly ["slicer_base64.cer", "printer.cer"];
/**
 * The networking plug-in followed by the library it loads from its own
 * directory for the eMMC file tunnel; without it uploads fail with -4.
 */
export declare const BAMBU_NATIVE_PLUGIN_LIBRARIES: readonly ["libbambu_networking.so", "libBambuSource.so"];
/**
 * The only Linux plug-in build whose PrintParams layout matches the helper
 * (Bambu Studio v02.08.02.61, network agent 02.08.02.54). The setup installs
 * exactly these files and the server refuses anything else.
 */
export declare const BAMBU_NATIVE_PINNED_PLUGIN: Readonly<{
    version: "02.08.02.54";
    sha256: Readonly<Record<"libbambu_networking.so" | "libBambuSource.so", string>>;
}>;
/** Layout shared by the Linux setup script, the server and the helper's environment. */
export declare function bambuNativeManagedPaths(env?: NodeJS.ProcessEnv): {
    home: string;
    helper: string;
    plugin: string;
    certDir: string;
    configDir: string;
    receipt: string;
};
export declare const BAMBU_NATIVE_SOURCE: string;
export declare function sha256Hex(data: Buffer | string): string;
export declare function sha256File(file: string): string;
/**
 * Name the setup from this server's own version, whose helper source it
 * accepts, and its own install directory when that is not the default.
 */
export declare function bambuNativeSetupCommand(version?: string, env?: NodeJS.ProcessEnv): string;
export declare function assertBambuNativeAvailable(): void;
/**
 * True when X2D controls should use the native route. macOS keeps its
 * unconditional routing. Linux opts in only with a complete installation, so
 * stop, pause and heater-off keep their MQTT route otherwise.
 */
export declare function bambuNativeControlsAvailable(): boolean;
/** Why native X2D controls are not used on this host, or undefined when they are. */
export declare function bambuNativeUnavailableReason(): string | undefined;
/**
 * Interrupt this printer's pending print, upload and heating helpers and
 * resolve once they have exited, so none can still dispatch afterwards.
 */
export declare function interruptNativeOperations(serial: string): Promise<void>;
export declare function buildBambuNativeFanCommand(fan: string | number, speed: number, sequenceId?: string): BambuNativeFanCommand;
export declare function buildBambuNativeTemperatureCommand(component: string, temperature: number, sequenceId?: string): BambuNativeTemperatureCommand;
export declare function validateBambuNativeControlMessage(messageJson: string): {
    messageJson: string;
    command: string;
};
/** Public raw input is limited to metadata and read-only calibration queries. */
export declare function validateBambuNativeMetadata(messageJson: string): string;
export declare function sendCommandWithBambuNative(options: BambuNativeControlOptions, execution?: BambuNativeExecution): Promise<Record<string, unknown>>;
export declare function probeBambuNative(host: string, token: string): Promise<Record<string, unknown>>;
export declare function printWithBambuNative(options: BambuNativePrintOptions, onUpdate: BambuNativeUpdateCallback | undefined, execution: BambuNativeExecution & {
    beforeDispatch: () => Promise<void>;
}): Promise<Record<string, unknown>>;
export declare function uploadWithBambuNative(options: BambuNativePrintOptions, onUpdate?: BambuNativeUpdateCallback, execution?: BambuNativeExecution): Promise<Record<string, unknown>>;
