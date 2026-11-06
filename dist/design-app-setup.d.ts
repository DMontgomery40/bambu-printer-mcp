/** What these tools reach outside the server: tests replace every field. */
export type SetupSystem = {
    platform: NodeJS.Platform;
    home: string;
    /** Where staged downloads and installer output go before they are checked. */
    tmp: string;
    uid: number;
    /** The working directory dotenv read `.env` from when the server started. */
    cwd: string;
    run(file: string, args: string[], options?: {
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<{
        stdout: string;
    }>;
    download(url: string, signal?: AbortSignal): Promise<Buffer>;
    /** Whether something accepts a TCP connection on host:port within a second. */
    listening(host: string, port: number): Promise<boolean>;
    /** Installed Autodesk Fusion apps found by bundle identifier (Spotlight). */
    fusionByBundleId(): Promise<string[]>;
};
/**
 * What a setup subprocess (uvx and the Blender package it runs, tar, launchctl) may see: the basic login
 * environment, uv's own settings and the Blender bridge's, never printer access codes or other server secrets,
 * as the Blender bridge's own environment.
 */
export declare function setupEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare const defaultSetupSystem: SetupSystem;
/** The add-on's own default port; BLENDER_HOST and BLENDER_PORT move it, as they do for the Blender MCP server. */
export declare const BLENDER_ADDON_DEFAULT_PORT = 9876;
/** The running add-on's answer to get_addon_status, as far as setup needs it. */
export type BlenderAddonHandshake = {
    up_to_date?: boolean;
    protocol_version?: number | null;
    expected_protocol_version?: number;
    blender_version?: string | null;
};
/** get_addon_status's result, structured or as JSON text; a failed call throws with the add-on's own words. */
export declare function parseAddonHandshake(reply: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: {
        type: string;
        text?: string;
    }[];
}): BlenderAddonHandshake | undefined;
export type BlenderSetupReport = {
    /** False when the configured bridge isn't the upstream MCP for Blender package run with uvx; see reason. */
    supported: boolean;
    reason?: "not-configured" | "custom-command" | "custom-package";
    package?: string;
    package_version?: string;
    /** The add-on protocol the configured package needs. */
    expected_protocol?: number;
    /** Something answers on the add-on's port: Blender is running with the add-on started. */
    listening: boolean;
    /** The running add-on's handshake; null when it doesn't report one or couldn't be read (see live_error). Only read while listening. */
    live?: BlenderAddonHandshake | null;
    /** Why the running add-on's handshake couldn't be read. */
    live_error?: string;
    /** The add-on file Blender loads, and its protocol (null when the file has none). */
    target?: {
        path: string;
        protocol: number | null;
    } | null;
    /** Why there is no target. */
    target_problem?: "not-installed" | "several-modules";
    /** What the person can do, in plain words, when the add-on can't be checked or updated here (reason, target_problem). */
    message?: string;
    /** The installed file's protocol is what the package expects. */
    current?: boolean;
    /** Set by update. */
    replaced?: boolean;
    backup?: string;
};
/** One add-on module per Blender version folder; other versions are separate installs. */
export declare function selectBlenderAddonTarget(files: {
    path?: unknown;
    protocol?: unknown;
}[], blenderVersion?: string | null): {
    target: {
        path: string;
        protocol: number | null;
    };
} | {
    problem: "not-installed" | "several-modules";
};
export declare class BlenderAddonSetup {
    /** The running add-on's get_addon_status through this server's Blender bridge; undefined when it has none. */
    private readonly handshake;
    private readonly system;
    private readonly env;
    constructor(
    /** The running add-on's get_addon_status through this server's Blender bridge; undefined when it has none. */
    handshake: () => Promise<BlenderAddonHandshake | undefined>, system?: SetupSystem, env?: NodeJS.ProcessEnv);
    private inspect;
    /** What is installed, what the package expects, and what the running add-on says. Changes nothing. */
    check(): Promise<BlenderSetupReport>;
    /**
     * Replaces the installed add-on file with the one the configured package's own installer stages, pinned to the
     * inspected version. The existing file must be a regular local MCP for Blender add-on; the staged one must carry
     * the expected protocol. The old file is kept as a backup next to it, and the new one is renamed into place.
     * Blender keeps running the add-on it loaded until it is re-enabled or restarted.
     */
    /** `signal` ends the request: the installer is stopped and nothing is replaced once it is aborted. */
    update(signal?: AbortSignal): Promise<BlenderSetupReport>;
    private readonly serial;
    private replace;
}
export declare const BLENDER_SETUP_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly supported: {
            readonly type: "boolean";
            readonly description: "The configured bridge is the upstream MCP for Blender package run with uvx, so this tool can check and update its add-on.";
        };
        readonly reason: {
            readonly type: "string";
            readonly enum: readonly ["not-configured", "custom-command", "custom-package"];
        };
        readonly package: {
            readonly type: "string";
            readonly description: "The package as BLENDER_MCP_ARGS names it.";
        };
        readonly package_version: {
            readonly type: "string";
        };
        readonly expected_protocol: {
            readonly type: "integer";
            readonly description: "The add-on protocol the package needs.";
        };
        readonly listening: {
            readonly type: "boolean";
            readonly description: "The add-on answers on BLENDER_HOST:BLENDER_PORT (default localhost:9876): Blender is running with it started.";
        };
        readonly live: {
            readonly type: readonly ["object", "null"];
            readonly description: "The running add-on's get_addon_status (up_to_date, protocol_version, expected_protocol_version, blender_version); null when it has none or it couldn't be read. Only while listening.";
        };
        readonly live_error: {
            readonly type: "string";
            readonly description: "Why the running add-on's handshake couldn't be read.";
        };
        readonly target: {
            readonly type: readonly ["object", "null"];
            readonly properties: {
                readonly path: {
                    readonly type: "string";
                };
                readonly protocol: {
                    readonly type: readonly ["integer", "null"];
                };
            };
            readonly required: readonly ["path", "protocol"];
            readonly description: "The add-on file Blender loads (for the running Blender's version, when it reports one).";
        };
        readonly target_problem: {
            readonly type: "string";
            readonly enum: readonly ["not-installed", "several-modules"];
        };
        readonly message: {
            readonly type: "string";
            readonly description: "What the person can do, in plain words, when the add-on can't be checked or updated here (with reason or target_problem). Clients show it as it is.";
        };
        readonly current: {
            readonly type: "boolean";
            readonly description: "The installed file carries the expected protocol. A running Blender may still have the old add-on loaded: see live.";
        };
        readonly replaced: {
            readonly type: "boolean";
            readonly description: "update: the file was replaced. Blender runs the new add-on once it is re-enabled or Blender restarts.";
        };
        readonly backup: {
            readonly type: "string";
            readonly description: "update: the previous add-on file, kept next to it.";
        };
    };
    readonly required: readonly ["supported", "listening"];
};
/** The add-in and server commit Counterpart's Fusion design passes were accepted on (document binding, PRD §8.9). */
export declare const FUSION_ADDIN_REPOSITORY = "DMontgomery40/fusion360-mcp-server";
export declare const FUSION_ADDIN_COMMIT = "86a3016a5a5b4a705228acc2f3b75aff7dcfd758";
/** SHA-256 of every file in the add-in (`addon/`) at that commit. Setup installs nothing else. */
export declare const FUSION_ADDIN_FILES: Readonly<Record<string, string>>;
export type FusionAddinPin = {
    repository: string;
    commit: string;
    files: Readonly<Record<string, string>>;
};
export declare const FUSION_ADDIN_PIN: FusionAddinPin;
/** A login agent that gives Fusion the add-in's port however Fusion is opened (a GUI app never reads this .env). */
export declare const FUSION_PORT_AGENT_LABEL = "com.scantomake.mac.fusion-port";
export type FusionSetupReport = {
    platform: string;
    /** Setup installs on macOS only. */
    supported: boolean;
    fusion: {
        installed: boolean;
        path: string | null;
    };
    pin: {
        repository: string;
        commit: string;
    };
    addin: {
        path: string;
        installed: boolean;
        matches_pin: boolean;
        run_on_startup: boolean;
    };
    port: number;
    port_agent: {
        path: string;
        installed: boolean;
    };
    /** FUSION_MCP_COMMAND is set for this server. */
    configured: boolean;
    /** The .env this server read at start, when there is one. */
    env_file: string | null;
    /** Add-in at the pin, port agent installed and the bridge configured. Fusion itself may still need opening. */
    ready: boolean;
    /** When not ready: what is missing and what to do, in plain words clients show as they are. */
    message?: string;
    /** Set by install. */
    installed?: {
        addin: "installed" | "already-current";
        port_agent: "installed" | "already-current";
        env: "written" | "already-configured" | "no-env-file";
        env_backup?: string;
    };
};
export declare class FusionAddinSetup {
    /** FUSION_MCP_PORT, as the bridge resolves it. */
    private readonly port;
    /** The bridge arguments for the pinned server, written with the add-in so the two always match. */
    private readonly serverArgs;
    private readonly system;
    private readonly env;
    private readonly pin;
    constructor(
    /** FUSION_MCP_PORT, as the bridge resolves it. */
    port: () => number, 
    /** The bridge arguments for the pinned server, written with the add-in so the two always match. */
    serverArgs: readonly string[], system?: SetupSystem, env?: NodeJS.ProcessEnv, pin?: FusionAddinPin);
    private get addinsFolder();
    private get addinFolder();
    private get portAgent();
    private findFusion;
    /** Each pinned file at its pinned bytes; the manifest may carry only setup's runOnStartup change. Fusion's own caches are ignored. */
    private installedMatchesPin;
    private portAgentPlist;
    /**
     * The agent is installed when it sets this port and launchd has it loaded in the login session: a file whose load
     * failed is installed again. An agent written for another port is replaced by install.
     */
    private portAgentInstalled;
    /** What is installed. Changes nothing. */
    check(): Promise<FusionSetupReport>;
    /** The pinned add-in, downloaded and checked file by file: every entry a regular file or folder, nothing extra, nothing missing. */
    private downloadAddin;
    private installAddin;
    /** Writes the agent and loads it in the person's login session, where its RunAtLoad sets FUSION_MCP_PORT. */
    private installPortAgent;
    /**
     * Adds the bridge settings this server is missing to its own .env, after a copy of the file. A configured
     * FUSION_MCP_COMMAND is kept with its arguments: it may be a reviewed local runtime. The running server takes
     * the new settings at once.
     */
    private writeSettings;
    /** Installs the pinned add-in set to run on startup, the port login item, and this server's missing bridge settings. */
    /** `signal` ends the request: the download and tar are stopped, and nothing more is written once it is aborted. */
    install(signal?: AbortSignal): Promise<FusionSetupReport>;
    private readonly serial;
    private installMissing;
}
export declare const FUSION_SETUP_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly platform: {
            readonly type: "string";
        };
        readonly supported: {
            readonly type: "boolean";
            readonly description: "Setup installs on macOS only.";
        };
        readonly fusion: {
            readonly type: "object";
            readonly properties: {
                readonly installed: {
                    readonly type: "boolean";
                };
                readonly path: {
                    readonly type: readonly ["string", "null"];
                };
            };
            readonly required: readonly ["installed", "path"];
        };
        readonly pin: {
            readonly type: "object";
            readonly properties: {
                readonly repository: {
                    readonly type: "string";
                };
                readonly commit: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ["repository", "commit"];
        };
        readonly addin: {
            readonly type: "object";
            readonly properties: {
                readonly path: {
                    readonly type: "string";
                };
                readonly installed: {
                    readonly type: "boolean";
                };
                readonly matches_pin: {
                    readonly type: "boolean";
                };
                readonly run_on_startup: {
                    readonly type: "boolean";
                };
            };
            readonly required: readonly ["path", "installed", "matches_pin", "run_on_startup"];
        };
        readonly port: {
            readonly type: "integer";
        };
        readonly port_agent: {
            readonly type: "object";
            readonly properties: {
                readonly path: {
                    readonly type: "string";
                };
                readonly installed: {
                    readonly type: "boolean";
                };
            };
            readonly required: readonly ["path", "installed"];
        };
        readonly configured: {
            readonly type: "boolean";
            readonly description: "FUSION_MCP_COMMAND is set for this server.";
        };
        readonly env_file: {
            readonly type: readonly ["string", "null"];
            readonly description: "The .env this server read at start, when there is one.";
        };
        readonly ready: {
            readonly type: "boolean";
            readonly description: "The add-in is at the pin and runs on startup, the port login item is installed and the bridge is configured. Fusion may still need opening: see fusion_mcp_status.";
        };
        readonly message: {
            readonly type: "string";
            readonly description: "When not ready: what is missing and what to do, in plain words. Clients show it as it is.";
        };
        readonly installed: {
            readonly type: "object";
            readonly description: "install: what it did.";
            readonly properties: {
                readonly addin: {
                    readonly type: "string";
                    readonly enum: readonly ["installed", "already-current"];
                };
                readonly port_agent: {
                    readonly type: "string";
                    readonly enum: readonly ["installed", "already-current"];
                };
                readonly env: {
                    readonly type: "string";
                    readonly enum: readonly ["written", "already-configured", "no-env-file"];
                };
                readonly env_backup: {
                    readonly type: "string";
                };
            };
        };
    };
    readonly required: readonly ["platform", "supported", "fusion", "pin", "addin", "port", "port_agent", "configured", "env_file", "ready"];
};
