import { COUNTERPART_CONTRACT } from "./schemas.js";
export declare class PartMeshesError extends Error {
}
export interface PartMesh {
    id: string;
    name: string;
    plate?: number;
    color?: string;
    filament?: number;
    painted?: true;
    stl_path: string;
    triangles: number;
    size_mm: [number, number, number];
}
export interface PartMeshes {
    contract: typeof COUNTERPART_CONTRACT;
    units: "mm";
    folder: string;
    parts: PartMesh[];
    skipped?: {
        id: string;
        name: string;
        reason: string;
    }[];
}
export declare function partMeshes(args: Record<string, unknown>): Promise<PartMeshes>;
export declare const PART_MESHES_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        units: {
            type: string;
            const: string;
        };
        folder: {
            type: string;
            description: string;
        };
        parts: {
            type: string;
            items: {
                type: string;
                properties: {
                    id: {
                        type: string;
                        description: string;
                    };
                    name: {
                        type: string;
                    };
                    plate: {
                        type: string;
                        minimum: number;
                        description: string;
                    };
                    color: {
                        type: string;
                        pattern: string;
                        description: string;
                    };
                    filament: {
                        type: string;
                        minimum: number;
                    };
                    painted: {
                        type: string;
                        const: boolean;
                        description: string;
                    };
                    stl_path: {
                        type: string;
                    };
                    triangles: {
                        type: string;
                        minimum: number;
                    };
                    size_mm: {
                        type: string;
                        items: {
                            type: string;
                        };
                        minItems: number;
                        maxItems: number;
                    };
                };
                required: string[];
            };
        };
        skipped: {
            type: string;
            items: {
                type: string;
                properties: {
                    id: {
                        type: string;
                    };
                    name: {
                        type: string;
                    };
                    reason: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
