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
