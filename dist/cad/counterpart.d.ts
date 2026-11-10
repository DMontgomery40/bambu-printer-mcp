import { type CadSystem } from "./process.js";
export declare const COUNTERPART_DIR: string;
export interface CounterpartStatus {
    ready: boolean;
    version: string | null;
    node: string;
    error?: string;
}
export declare function counterpartStatus(): Promise<CounterpartStatus>;
/** Build the script: STL, 3MF, the part records and the proofs; returns the kernel's receipt. */
export declare function counterpartBuild(system: CadSystem, o: {
    data: string;
    job: string;
    name: string;
    script: string;
    parameters: string;
    inputs: Record<string, string>;
    readonly: string[];
    inputDirs: string[];
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<Record<string, unknown>>;
/** The trusted inspection (no user code): measures the exported STL and renders the six views and a contact sheet. */
export declare function counterpartInspect(system: CadSystem, o: {
    data: string;
    job: string;
    name: string;
    stl: string;
    readonly: string[];
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<Record<string, unknown>>;
/** cad_check_fit on the kernel: exact mesh-boolean interference and BVH surface distance. */
export declare function counterpartFit(system: CadSystem, o: {
    data: string;
    job: string;
    request: string;
    readonly: string[];
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<Record<string, unknown>>;
