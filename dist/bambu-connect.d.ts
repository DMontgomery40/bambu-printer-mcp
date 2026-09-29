export type BambuConnectImportOptions = {
    filePath: string;
    name?: string;
    version?: string;
};
export declare function buildBambuConnectImportUrl(options: BambuConnectImportOptions): string;
export declare function importFileViaBambuConnect(options: BambuConnectImportOptions): Promise<Record<string, unknown>>;
