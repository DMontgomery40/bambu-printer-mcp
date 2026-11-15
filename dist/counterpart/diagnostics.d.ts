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
/** Text with \\uXXXX, \\xXX and %XX escapes read, so "\\x70assword" and "pass%77ord" are seen as "password". */
export declare function decodeEscapes(text: string): string;
export declare function isSecretName(name: string): boolean;
/** The values of this environment's secret-named variables. */
export declare function environmentSecrets(env?: NodeJS.ProcessEnv): string[];
/** text with every known secret (configured, in this environment, or seen in tool arguments) removed in each encoded form. */
export declare function removeKnownSecrets(text: string, secrets?: Iterable<string>): string;
export declare const WITHHELD = "[line withheld: may contain a secret]";
/** Whether a line may carry a secret: a secret word anywhere in it, in any spelling or encoding. */
export declare function suspectLine(line: string): boolean;
/**
 * Free text with each suspect line withheld whole, with the lines that continue it; its time and level stay. A suspect
 * line that is only a name and a safe value stays, but what continues it is withheld all the same.
 */
export declare function withholdSuspectLines(text: string): string;
/**
 * text with every secret this module can recognise replaced, failing closed: known secret values in every encoded
 * form; then the named patterns (values of secret-named keys, cookies, authorization headers, URL credentials,
 * emails, JWTs, bare tokens, PEM blocks, other people's home folders); then every line that still names a secret
 * withheld whole. Serial numbers, hosts, error codes and lowercase hashes stay.
 */
export declare function redactText(text: string, secrets?: Iterable<string>): string;
/** The pattern rules alone (redactText without withholding lines): what each named form becomes. */
export declare function redactPatterns(text: string, secrets?: Iterable<string>): string;
/**
 * A logged or composed value with its secrets removed, by its structure: a secret-named key's value goes (a bare
 * measure such as tokenCount stays); an object where any field names a secret ({"name":"BAMBU_ACCESS_CODE", …})
 * loses its other scalars; a string holding JSON is read and walked; any other string is redacted as text, one
 * value per line, so a string that names a secret is withheld.
 */
export declare function redactValue(value: unknown, secrets?: Iterable<string>, depth?: number): unknown;
/** A JSON file's text with its values redacted by structure (it stays valid JSON); other text as free text. */
export declare function redactJsonText(text: string, secrets?: Iterable<string>): string;
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
    fixedNotes?: string[];
    maxBytes?: number;
    secrets?: string[];
}): DiagnosticsResult;
/**
 * Settings whose values are known not to be secret (paths, hosts, ports, modes, models, timeouts). Any other setting
 * shows only whether it is set: commands and their arguments, URLs and anything else can carry a credential.
 */
export declare const SAFE_SETTINGS: Set<string>;
/** The environment settings whose names match, sorted: a known non-secret one with its value, any other only "[set]" (or ""). */
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
