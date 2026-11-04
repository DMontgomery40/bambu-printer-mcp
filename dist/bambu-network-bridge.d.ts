/** A parenthesized explanation of a plug-in print result, or "" when it names no known cause. */
export declare function describeBambuNetworkPrintError(value: number): string;
/** Waits from native/bambu-native-print.cpp, which prints through the same plug-in calls. */
export type LocalTiming = {
    connectTimeoutMs: number;
    pollMs: number;
    settleMs: number;
    retryWaitMs: number;
};
export declare const LOCAL_PRINT_TIMING: Readonly<LocalTiming>;
/** A control waits briefly for the certificate message, then sends; -4/-4030 returns are retried after a reinstall. */
export type LocalControlTiming = LocalTiming & {
    certificateWaitMs: number;
    attempts: number;
    deliveryMs: number;
};
export declare const LOCAL_CONTROL_TIMING: Readonly<LocalControlTiming>;
export { controlReply, isAuthorizationRefusal } from "./control-reply.js";
/** Cloud session waits: connection and printer subscription, certificate, settle after the state requests. */
export type CloudTiming = {
    connectTimeoutMs: number;
    pollMs: number;
    settleMs: number;
    certificateWaitMs: number;
};
export declare const CLOUD_PRINT_TIMING: Readonly<CloudTiming>;
export type CloudSession = {
    settle: (ms: number) => Promise<void>;
    /** Ask the plug-in to install the printer's certificate again, as Bambu Studio does after a failed send. */
    installCertificate: () => Promise<void>;
    /** Wait up to ms for device_cert_installed; true once it has arrived. */
    certificateReadyWithin: (ms: number) => Promise<boolean>;
    /** This printer's cloud messages, as they arrive. */
    messages: string[];
    jobUpdates: BridgeJobUpdate[];
};
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
    /** Waits up to ms for FULU's certificate-installed message for this printer; false if it never came. */
    certificateReadyWithin: (ms: number) => Promise<boolean>;
    /** This printer's messages about stop/pause/resume, as they arrive. */
    controlMessages: string[];
    jobUpdates: BridgeJobUpdate[];
};
/** One line per FULU event or control send, for diagnosing controls. Never includes access codes. */
export type BridgeTrace = (entry: Record<string, unknown>) => void;
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
    /** Diagnostics for a print control: every FULU event and send in its session. */
    trace?: BridgeTrace;
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
 * The client identity FULU's GUI gives the plug-in before agent start
 * (GUI_App::init_http_extra_header). Through the Linux bridge FULU presents
 * itself as Bambu Studio at the version its plug-in ABI belongs to
 * (PJarczakLinuxBridgeConfig.cpp forced_client_version, "02.05.02.51").
 * Bambu's cloud issues the printer-control certificate and creates print
 * tasks for this client, so an agent started without it is an unknown client.
 * The device id is kept in the config folder so it stays the same per install.
 */
export declare function bambuNetworkClientHeaders(configDir: string, env?: NodeJS.ProcessEnv): Record<string, string>;
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
    withLocalSession<T>(printer: LocalPrinter, options: BambuNetworkBridgeOptions, assertActive: () => void, timing: Readonly<LocalTiming>, run: (session: LocalSession) => Promise<T>): Promise<T>;
    private runLocalSession;
    /**
     * Run a LAN print method in a local session. A synchronous -4030 means the
     * plug-in published nothing, so it is retried once after the certificate
     * exchange, as the native helper does; each attempt passes the caller's
     * fresh pre-dispatch checks.
     */
    startLocalPrint(printer: LocalPrinter, method: string, payload: JsonObject, options?: BambuNetworkBridgeOptions, assertActive?: () => void, timing?: Readonly<LocalTiming>): Promise<{
        result: unknown;
        jobUpdates: BridgeJobUpdate[];
    }>;
    /**
     * A print control (stop, pause, resume) through the same authenticated LAN
     * session as a FULU print. FULU's own app sends controls exactly this way
     * (send_message_to_printer, qos 1, flag 0) on a connection whose certificate
     * is installed. A fresh connection can report SEND_MSG_FAILED (-4) or
     * LP_PUBLISH_MSG_FAILED (-4030) while that exchange finishes: those returns
     * mean nothing was sent, so the certificate is reinstalled and the control
     * tried again, as the native X2D helper does. Any other return is final.
     * beforeDispatch runs before every send, so a resume re-checks the paused job.
     */
    sendLocalPrintCommand(printer: LocalPrinter, command: "stop" | "pause" | "resume", options?: BambuNetworkBridgeOptions, beforeDispatch?: () => Promise<void>, timing?: Readonly<LocalControlTiming>): Promise<Record<string, unknown>>;
    /**
     * Open the plug-in's Bambu Cloud session with a printer bound to the account, in the order
     * Bambu Studio uses (GUI_App.cpp on_server_connected / on_printer_connected): wait for the
     * cloud connection, select and subscribe to the printer, and when it connects request its
     * state (pushall, get_version, get_access_code) and install its certificate for cloud use.
     * Without that state the plug-in refuses a cloud print with -3140 (ENC_FLAG_NOT_READY).
     * Shares the LAN session queue: one reader of the plug-in's events at a time.
     */
    withCloudSession<T>(devId: string, options: BambuNetworkBridgeOptions, assertActive: () => void, timing: Readonly<CloudTiming>, run: (session: CloudSession) => Promise<T>): Promise<T>;
    /**
     * A cloud print in a cloud session, so the plug-in has the printer's state. With a fallback this is
     * Bambu Studio's order for a cloud-bound printer it can also reach on the LAN (PrintJob.cpp,
     * SendAttemptRoute::LanWithRecord, then ::Cloud): start_local_print_with_record, then start_print
     * when the first failed before its print command was sent. `firstFailure` is the first method's result.
     */
    startCloudPrint(devId: string, method: string, payload: JsonObject, options?: BambuNetworkBridgeOptions, assertActive?: () => void, timing?: Readonly<CloudTiming>, fallbackMethod?: string): Promise<{
        result: unknown;
        jobUpdates: BridgeJobUpdate[];
        firstFailure?: number;
    }>;
    /**
     * A print control over Bambu Cloud: how Bambu Studio and FULU's slicer control a printer
     * bound to the account (MachineObject::publish_json → cloud_publish_json: send_message,
     * qos 1, flag 0), in a cloud session. Held open like the LAN control.
     */
    sendCloudPrintCommand(devId: string, command: "stop" | "pause" | "resume", options?: BambuNetworkBridgeOptions, beforeDispatch?: () => Promise<void>, timing?: Readonly<LocalControlTiming>): Promise<Record<string, unknown>>;
    /** Appends control diagnostics to control-trace.log in the bridge's config folder. */
    private controlTrace;
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
