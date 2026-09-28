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
export declare function assertBambuNativeAvailable(): void;
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
export declare function printWithBambuNative(options: BambuNativePrintOptions, onUpdate?: BambuNativeUpdateCallback, execution?: BambuNativeExecution): Promise<Record<string, unknown>>;
export declare function uploadWithBambuNative(options: BambuNativePrintOptions, onUpdate?: BambuNativeUpdateCallback, execution?: BambuNativeExecution): Promise<Record<string, unknown>>;
