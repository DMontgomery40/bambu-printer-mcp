import { type CadSystem } from "./cad/process.js";
export type CadArguments = Record<string, unknown>;
export interface CadOptions {
    dataDir?: string;
    outputRoots: string[];
    system?: CadSystem;
}
export interface CadStatus {
    configured: boolean;
    ready: boolean;
    python: string | null;
    build123d: string;
    platform: string;
    error?: string;
}
export declare class CadEngine {
    private readonly options;
    private readonly system;
    readonly dataDir: string;
    constructor(options: CadOptions);
    status(): Promise<CadStatus>;
    private allowedDirectory;
    private environment;
    private exclusive;
    private confined;
    setup(args: CadArguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    private fingerprint;
    private requireSupportedStorage;
    private inputFile;
    run(args: CadArguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    checkFit(args: CadArguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
