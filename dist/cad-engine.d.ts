import { type CadStorage } from "./cad/storage.js";
import { type CadSystem } from "./cad/process.js";
import { type CounterpartStatus } from "./cad/counterpart.js";
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
    storage: CadStorage;
    error?: string;
    /** the second engine, chosen per cad_run/cad_check_fit call with engine: "counterpart" */
    counterpart?: CounterpartStatus;
}
export declare class CadEngine {
    private readonly options;
    private readonly system;
    readonly dataDir: string;
    constructor(options: CadOptions);
    status(): Promise<CadStatus>;
    failure(error: unknown, tool: string): Promise<{
        storage: CadStorage;
        status: "error";
        code: "cad-uv-missing" | "cad-data-volume-refused" | "cad-setup-busy" | "cad-operation-busy" | "cad-queue-timeout" | "cad-not-ready" | "cad-confinement-unavailable" | "cad-disabled" | "cad-failed";
        message: string;
        tool: string;
        retryable: boolean;
        suggestion: string;
    }>;
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
