import { COUNTERPART_CONTRACT } from "./schemas.js";
export declare class Make3mfError extends Error {
}
export type Make3mfResult = {
    contract: typeof COUNTERPART_CONTRACT;
    path: string;
    objects: number;
    filaments: number;
    parts: {
        name: string;
        stl_path: string;
        filament: number;
        triangles: number;
    }[];
};
export declare function makeCounterpart3mf(args: Record<string, unknown>): Promise<Make3mfResult>;
/**
 * Write the 3MF a cad_run design script returned as project_3mf() (src/cad/project3mf.py): `manifest` is the
 * sandbox's <name>.project.json, `partsDir` its STL parts, `inputs` the run's input snapshots by alias. A new project
 * is written as counterpart_make_3mf writes one, an object per assembly on its plate. An edit copies the base 3MF and
 * changes only what the script changed, so its print settings, painting, plates and other parts stay as they were.
 */
export declare function writeCadProject3mf(manifest: unknown, partsDir: string, inputs: Record<string, string>, outPath: string): Promise<{
    base: string | null;
    changed: string[];
}>;
