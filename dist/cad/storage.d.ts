export declare const CAD_SIZE_ESTIMATE: {
    expected_download_bytes: number;
    expected_installed_bytes: number;
};
export interface CadStorage {
    expected_download_bytes: number;
    expected_installed_bytes: number;
    installed_bytes: number | null;
    measurement: "allocated-last-setup";
    measured_at?: string;
}
export declare function storageInfo(marker: {
    installed_bytes?: unknown;
    measured_at?: unknown;
} | undefined, exists: boolean): CadStorage;
/** Allocated filesystem bytes, like du; no symlink traversal or double-counted hardlinks. */
export declare function measureEnvironment(data: string): Promise<number>;
/** Each immutable bundle contains exactly the declared files, retaining linked asset basenames. */
export declare function snapshotInputs(root: string, files: Record<string, string>, signal?: AbortSignal, index?: {
    directory: string;
    authorize: (directory: string) => Promise<string>;
}): Promise<{
    inputs: Record<string, string>;
    hashes: Record<string, string>;
    directory: null;
    added: number;
    reused: number;
} | {
    inputs: Record<string, string>;
    hashes: Record<string, string>;
    directory: string;
    added: number;
    reused: number;
}>;
