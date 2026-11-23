/**
 * Read-only decoding of a tool-rack printer's report, as Bambu Studio reads it, for get_printer_status.
 *
 * Source: Bambu Studio v02.09.01.70 (commit 56a57d00a591360cf41bf21383915ee5bf357be5),
 * src/slic3r/GUI/DeviceCore: DevNozzleRack.h/.cpp (ParseRackInfoV1_0), DevNozzleSystem.cpp (ParseV2_0),
 * DevFilaSystem.cpp (ParseAmsInfo), DevDefs.h (DevAmsType) and DevUtil.cpp (get_flag_bits).
 * No H3C report has been captured: the field layout is Studio's, not an observed printer's.
 *
 * This only names what the report says. It is never safety evidence: nothing here selects a nozzle, a filament or a
 * spool, and a rack position, a nozzle id, a logical filament and a profile variant stay separate values.
 */
/** DevNozzleRack::RackStatus. A value outside -1..12 is unknown, as Studio resets it. */
declare const RACK_STATUS: readonly ["idle", "hotend-centre", "toolhead-centre", "calibrate-hotend-rack", "wait-hotend-heating", "cut-material", "unlock-hotend", "lift-hotend-rack", "place-hotend", "pick-hotend", "lock-hotend", "move", "hotend-info-refresh"];
export type Unknown = "unknown";
export interface ToolRackHolder {
    status: (typeof RACK_STATUS)[number] | Unknown;
    /** 0 none, 1 picking, 2 placing, 3 both (DevNozzleRack::IsPicking/IsPlacing read it with `status`). */
    job: number;
    steps: number[];
    type: string | Unknown;
    calibrated: boolean | Unknown;
    /** Dock (hotend address) ids info2 marks as calibrated: bit 5 + address. */
    calibratedDocks: number[];
    /** Only for an AB rack; a directly connected rack reports none. */
    position?: string;
}
export interface ToolRackNozzle {
    /** The report's `id`: its low hex digit is the nozzle id, its next digit 1 marks a nozzle on the rack. */
    id: number;
    nozzleId: number;
    onRack: boolean;
    addrId?: number;
    /** From `nozzle.exist`, bit `id`, when the report gives it. */
    present?: boolean;
    diameter?: number;
    type?: string;
    temperature?: {
        actual: number;
        target: number;
    };
    /** Only on a directly connected rack, from `stat` bit 5 or bits 6-8. */
    filamentLoaded?: boolean;
    /** From `snow`: the AMS unit and slot feeding it; absent when it reports none (0xff). */
    feedingSlot?: {
        amsId: number;
        slotId: number;
    };
    boundAms?: number[];
    serial?: string;
    filamentId?: string;
    colour?: string;
}
export interface ToolRackAms {
    id: string;
    type: string;
    extruderId: number;
    trays: number;
}
export interface ToolRack {
    source: string;
    holder?: ToolRackHolder;
    nozzles: ToolRackNozzle[];
    rackAms: ToolRackAms[];
}
/** The tool rack, nozzles and rack AMS units a report describes, or undefined when it describes none of them. */
export declare function decodeToolRack(raw: unknown): ToolRack | undefined;
export {};
