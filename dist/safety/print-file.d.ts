export interface PrintFileInspection {
    model: string;
    nozzleDiameters: number[];
    materials: string[];
    usedFilamentPositions: number[];
    plateInternalPath?: string;
    sha256: string;
    maxNozzleTemperature: number;
    maxBedTemperature: number;
    maxChamberTemperature: number;
    bedType?: string;
    selectsAms: boolean;
    nozzleTypes?: string[];
    nozzleFlows?: string[];
}
/** Inspect the exact selected plate. This does not simulate firmware or arbitrary motion:
 * only declared object bounds are checked, never purge/homing/wipe travel coordinates.
 * It also cannot authenticate self-declared metadata or the physical spool/nozzle.
 */
export declare function inspectPrintFile(filePath: string, options: {
    model: string;
    nozzleDiameters?: number[];
    plateIndex?: number;
    bedType?: string;
}): Promise<PrintFileInspection>;
