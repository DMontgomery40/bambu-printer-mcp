import { type CadStorage } from "./cad/storage.js";
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
    storage: CadStorage;
    error?: string;
    /** Set when this call re-verified a runtime that only the engine's own sources had changed under. */
    reverified?: string;
}
export declare class CadEngine {
    private readonly options;
    private readonly system;
    readonly dataDir: string;
    private reverifyFailure?;
    /** How long a re-check waits for another CAD operation to let go of the engine (Counterpart reads status with 30 s). */
    busyWaitMs: number;
    /** Within this window a freed engine is re-checked here; later this call only waits for the other call's result, so
     * a wait plus a ~17 s re-check cannot overrun the status deadline. */
    busyRetryMs: number;
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
    /**
     * The proof setup ends with: the runtime's imports, then the confined build, STL and STEP round trip, then the ready
     * marker with the engine fingerprint and the runtime identity it proved. Shared by cad_setup and the automatic
     * re-verification after an update that changed only the engine's sources.
     */
    private verify;
    /**
     * Re-verifies without installing when only the engine's own sources changed since the last proof (#609): the
     * marker matches this platform, build123d and data device, its engine fingerprint differs, and the installed
     * runtime still matches requirements.lock exactly with the same interpreter. Anything else, including a changed
     * lock, still needs cad_setup with install: true. A failed re-verification is reported, not retried, until the
     * engine changes again or setup runs.
     */
    ensureReady(signal?: AbortSignal, deadline?: number): Promise<CadStatus>;
    private onlyEngineChanged;
    /** The interpreter the venv runs and whether its installed distributions are exactly requirements.lock's pins. */
    private runtimeIdentity;
    private fingerprint;
    private requireSupportedStorage;
    private inputFile;
    run(args: CadArguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /**
     * When build() returned project_3mf(), write <name>.3mf from the sandbox's manifest and part STLs (this trusted
     * process writes it; the sandbox only meshed the parts) and read it back as list_3mf_plates does.
     */
    private project3mf;
    checkFit(args: CadArguments, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
