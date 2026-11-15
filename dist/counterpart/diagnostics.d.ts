export declare const DIAGNOSTICS_DEFAULT_BYTES = 4194304;
export declare const DIAGNOSTICS_MAX_BYTES = 8388608;
export type DiagnosticsFile = {
    name: string;
    content: string;
    truncated: boolean;
};
export type DiagnosticsResult = {
    package: string;
    version: string;
    files: DiagnosticsFile[];
    notes: string[];
};
/** A file on disk, whose tail goes in, or text the server composes. `missing` is the note when the file is absent. */
export type DiagnosticsSource = {
    name: string;
    file: string;
    missing?: string;
} | {
    name: string;
    text: string;
};
export declare const DIAGNOSTICS_INPUT_PROPERTIES: {
    printer: {
        type: string;
        description: string;
    };
    max_bytes: {
        type: string;
        minimum: number;
        maximum: number;
        description: string;
    };
};
export declare const DIAGNOSTICS_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        package: {
            type: string;
            description: string;
        };
        version: {
            type: string;
            description: string;
        };
        files: {
            type: string;
            items: {
                type: string;
                properties: {
                    name: {
                        type: string;
                        description: string;
                    };
                    content: {
                        type: string;
                        description: string;
                    };
                    truncated: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        notes: {
            type: string;
            items: {
                type: string;
            };
            description: string;
        };
    };
    required: string[];
};
/** The max_bytes a call asks for, checked. */
export declare function diagnosticsBudget(value: unknown): number;
/**
 * Keeps what this server writes through console.error and console.warn (its stderr diagnostics: MQTT, connection,
 * bridge and slicer messages) in memory as well. Writing to stderr is unchanged. Idempotent.
 */
export declare function captureServerLog(): void;
/** Records a failed tool call: its name and error, not its arguments. */
export declare function recordToolError(tool: string, error: unknown): void;
/** Remembers the values of a tool call's secret-named arguments (access codes, API keys, tokens) for redaction. */
export declare function rememberSecretArguments(args: unknown): void;
export declare const serverLogText: () => string;
export declare const toolErrorsText: () => string;
/** For tests: forgets what was recorded. */
export declare function resetDiagnosticsMemory(): void;
export declare function isSecretName(name: string): boolean;
/** The values of this environment's secret-named variables. */
export declare function environmentSecrets(env?: NodeJS.ProcessEnv): string[];
/**
 * text with every secret this module can recognise replaced: values of secret-named keys and arguments, the known
 * secret values anywhere (configured access codes, API keys, tokens and passwords, and any seen in tool arguments),
 * cookies, authorization headers, URL credentials, emails, JWTs, PEM private keys and long random tokens. Serial
 * numbers, hosts and lowercase hashes stay.
 */
export declare function redactText(text: string, secrets?: Iterable<string>): string;
/** The last `bytes` of text, starting at a whole line where one starts inside it. */
export declare function tailText(text: string, bytes: number): {
    text: string;
    cut: boolean;
};
/**
 * The bundle from sources, in their order: each file's tail, redacted. Small sources go in whole; the rest share what
 * is left equally, keeping their newest lines. Names, contents and notes together stay within maxBytes.
 */
export declare function buildDiagnostics(options: {
    package: string;
    version: string;
    sources: DiagnosticsSource[];
    notes?: string[];
    maxBytes?: number;
    secrets?: string[];
}): DiagnosticsResult;
/** The environment settings whose names match, sorted; a secret-named one shows only "[set]". */
export declare function settingsSnapshot(names: RegExp, env?: NodeJS.ProcessEnv): Record<string, string>;
/** The text of a JSON value for a bundle file. */
export declare const jsonText: (value: unknown) => string;
/** The newest `count` *.log files directly in each folder, newest first; absent folders are skipped. */
export declare function newestLogs(folders: string[], count: number, exclude?: string[]): string[];
/**
 * The version of the app an executable belongs to, read without running it: a macOS bundle's Info.plist
 * (CFBundleShortVersionString, else CFBundleVersion), else a version in the file's own name (AppImage). Undefined
 * when neither says.
 */
export declare function appVersion(executable: string | undefined): string | undefined;
