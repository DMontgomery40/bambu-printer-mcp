export interface CadProcessOptions {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}
export interface CadSystem {
    platform: NodeJS.Platform;
    run(file: string, args: string[], options: CadProcessOptions): Promise<{
        stdout: string;
        stderr?: string;
    }>;
}
/** No shell, no inherited printer/provider environment, bounded output, and kill the entire dispatched group. */
export declare function runCadProcess(file: string, args: string[], options: CadProcessOptions): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare const defaultCadSystem: CadSystem;
export interface CadSandboxRoots {
    data: string;
    job: string;
    assets: string;
    python: string;
    readonly: string[];
}
/** Linux uses an empty mount tree and fresh user/PID/network namespaces. A missing/blocked bwrap is fatal. */
export declare function cadSandbox(platform: NodeJS.Platform, r: CadSandboxRoots): Promise<{
    command: string;
    args: string[];
}>;
