/** A parenthesized explanation of a plug-in print result, or "" when it names no known cause. */
export declare function describeBambuNetworkPrintError(value: number): string;
/** Waits from native/bambu-native-print.cpp, which prints through the same plug-in calls. */
export declare const LOCAL_PRINT_TIMING: Readonly<{
    connectTimeoutMs: 30000;
    pollMs: 250;
    settleMs: 3000;
    retryWaitMs: 8000;
}>;
export type LocalPrinter = {
    devId: string;
    devIp: string;
    username: string;
    password: string;
    useSsl: boolean;
};
export type BridgeJobUpdate = {
    status: unknown;
    code: unknown;
    msg: unknown;
};
export type LocalSession = {
    installCertificate: () => Promise<void>;
    settle: (ms: number) => Promise<void>;
    jobUpdates: BridgeJobUpdate[];
};
type JsonObject = Record<string, unknown>;
export type BambuNetworkBridgeOptions = {
    bridgeCommand?: string;
    configDir?: string;
    countryCode?: string;
    userInfo?: string;
    timeoutMs?: number;
    /** Trusted in-process preflight; never populated from tool arguments. */
    beforeDispatch?: (method: string) => Promise<void>;
    assertDispatchAllowed?: (method: string) => void;
    onDispatched?: (method: string) => void;
};
export type BambuNetworkBridgeStatus = {
    configured: boolean;
    command: string;
    platform: NodeJS.Platform;
    running: boolean;
    pid?: number;
    configDir: string;
    countryCode: string;
    agentReady: boolean;
    lastStderr: string;
    recentLogs: string[];
    runtime: {
        /** Folder passed to the plug-in's set_cert_file. */
        certDir: string;
        /** Linux only: absolute plug-in library paths passed to FULU's host. */
        pluginLibraries?: Record<string, string>;
        /** macOS only: conventional FULU runtime discovery. */
        macosRuntimeDir?: string;
        macosRuntimeDirExists?: boolean;
        macosPluginDir?: string;
        macosPluginDirExists?: boolean;
        macosMissingRuntimeFiles?: string[];
        macosMissingPluginFiles?: string[];
        suggestedMacCommand?: string;
    };
    note?: string;
};
/**
 * The plug-in's certificate folder: BAMBU_NETWORK_CERT_DIR when set, else
 * Bambu's pinned public certificates written to the agent's config folder,
 * which the host must already be able to read.
 */
export declare function bambuNetworkCertDir(configDir: string, env?: NodeJS.ProcessEnv): string;
export declare function prepareBambuNetworkCertDir(configDir: string, env?: NodeJS.ProcessEnv): string;
export declare function defaultBambuNetworkConfigDir(): string;
/**
 * FULU's Linux host opens its network and source libraries by bare name from
 * its working directory instead of PJARCZAK_BAMBU_PLUGIN_DIR
 * (FULU-Foundation/OrcaSlicer-bambulab#51), so name them in that directory
 * unless they are already set. macOS wrappers run the host in a Linux guest
 * that may not see host paths, so they are left alone.
 */
export declare function linuxPluginLibraryEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string>;
export declare class BambuNetworkBridge {
    private child?;
    private commandLine?;
    private stdoutBuffer;
    private pending;
    private nextRequestId;
    private agentId?;
    private agentKey?;
    private handshake?;
    private lastStderr;
    private recentLogs;
    private inferredExpectedNetworkVersion?;
    /** Whether the host accepted the certificate folder and callbacks a LAN session needs. */
    private localSessionReady;
    /**
     * The plug-in holds one LAN printer connection and the host one event queue,
     * so LAN sessions run one at a time, as Bambu Studio connects one printer.
     */
    private localSessionTail;
    resolveBridgeCommand(override?: string): string;
    resolveConfigDir(override?: string): string;
    resolveCountryCode(override?: string): string;
    getStatus(options?: BambuNetworkBridgeOptions): BambuNetworkBridgeStatus;
    request(method: string, payload?: JsonObject, options?: BambuNetworkBridgeOptions): Promise<unknown>;
    ensureAgent(options?: BambuNetworkBridgeOptions): Promise<{
        agent: number;
        handshake: unknown;
    }>;
    /**
     * Open the plug-in's own LAN MQTT session with a printer, in the order Bambu
     * Studio and native/bambu-native-print.cpp use: connect, install the
     * printer's application certificate (again on each "wait_info"), wait for
     * the local connection, request the printer's state and let the key
     * exchange settle. Without the certificate the plug-in uploads a job but
     * cannot encrypt or publish project_file (-4030). The session is closed
     * after `run`, so printer reports stop accumulating in the host's queue.
     */
    withLocalSession<T>(printer: LocalPrinter, options: BambuNetworkBridgeOptions, assertActive: () => void, timing: typeof LOCAL_PRINT_TIMING, run: (session: LocalSession) => Promise<T>): Promise<T>;
    private runLocalSession;
    /**
     * Run a LAN print method in a local session. A synchronous -4030 means the
     * plug-in published nothing, so it is retried once after the certificate
     * exchange, as the native helper does; each attempt passes the caller's
     * fresh pre-dispatch checks.
     */
    startLocalPrint(printer: LocalPrinter, method: string, payload: JsonObject, options?: BambuNetworkBridgeOptions, assertActive?: () => void, timing?: typeof LOCAL_PRINT_TIMING): Promise<{
        result: unknown;
        jobUpdates: BridgeJobUpdate[];
    }>;
    callWithAgent(method: string, payload?: JsonObject, options?: BambuNetworkBridgeOptions): Promise<unknown>;
    stop(): Promise<void>;
    private ensureStarted;
    private handleStdout;
    private resolvePendingJson;
    private rememberLog;
    private rememberStderr;
    private rejectAllPending;
    private needsExpectedVersionRetry;
}
export {};
