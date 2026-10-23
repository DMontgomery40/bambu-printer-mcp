interface CachedProfile {
    subPath: string;
    data: Record<string, unknown>;
}
/** Read raw source diffs, not merged profiles: inheritance/includes still use the shared resolver. */
export declare function decodeOrcaBblCache(bytes: Buffer): CachedProfile[];
/** Expand only the selected installation's cache in the owning server's private temp directory. */
export declare function materializeOrcaProfilesRoot(profilesRoot: string, tempDir: string): Promise<string>;
interface CliProfiles {
    settingsArg?: string;
    filamentPaths: string[];
}
/** Orca v2 cache builds resolve User presets by loaded file identity, not just inherits. */
export declare function stageOrcaCliProfiles(profilesRoot: string, tempDir: string, bundle: CliProfiles): Promise<CliProfiles & {
    extraArgs: string[];
}>;
export {};
