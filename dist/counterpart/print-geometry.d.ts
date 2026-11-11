/** Expected geometry from the exact selected plate's sliced commands, never printer progress. */
export interface LayerGeometry {
    layer: number;
    zMm: number;
    boundsMm?: [number, number, number, number];
}
export interface PrintGeometry {
    heightMm?: number;
    layers: LayerGeometry[];
}
export declare function geometryFromGcode(gcode: string): PrintGeometry;
/** Best-effort diagnostics only: an unreadable/oversize file cannot fail an already dispatched print. */
export declare function geometryFromFile(filePath: string): Promise<PrintGeometry | undefined>;
