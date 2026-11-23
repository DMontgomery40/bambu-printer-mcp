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
const RACK_STATUS = ["idle", "hotend-centre", "toolhead-centre", "calibrate-hotend-rack", "wait-hotend-heating", "cut-material",
  "unlock-hotend", "lift-hotend-rack", "place-hotend", "pick-hotend", "lock-hotend", "move", "hotend-info-refresh"] as const;
/** DevNozzleRack::RackType from info2 bits 1-4: A and B are the ZMULTI_A (AMS-3H) and ZMULTI_B racks. */
const RACK_TYPE: Record<number, string> = { 0: "AB", 1: "A", 2: "B", 3: "C" };
/** DevNozzleRack::RackABPos, reported only by a rack that is not directly connected (type AB). */
const RACK_AB_POSITION: Record<number, string> = { 0: "unknown", 1: "a-top", 2: "b-top", 3: "centre" };
/** DevDefs.h DevAmsType for the rack AMS units (devAmsTypeUtil::IsRackAms); Studio names ZMULTI_A "AMS-3H". */
const RACK_AMS_TYPE: Record<number, string> = { 6: "AMS-3H", 7: "AMS-B" };

export type Unknown = "unknown";
export interface ToolRackHolder {
  status: (typeof RACK_STATUS)[number] | Unknown;
  /** The report's job number as given; DevNozzleRack::IsPicking/IsPlacing read it together with `status`. */
  job: number;
  steps: number[];
  type: string | Unknown;
  calibrated: boolean | Unknown;
  /** Only for an AB rack; a directly connected rack reports none. */
  position?: string;
}
export interface ToolRackNozzle {
  /** The report's `id`: its low hex digit is the nozzle id, its next digit 1 marks a nozzle on the rack. */
  id: number;
  nozzleId: number;
  onRack: boolean;
  addrId?: number;
  /** DevNozzleRack::IsHotendDockingCalibrated: holder `info2` bit 5 + `addrId`, when both are reported. */
  dockCalibrated?: boolean;
  /** From `nozzle.exist`, bit `id`, when the report gives it. */
  present?: boolean;
  diameter?: number;
  type?: string;
  temperature?: { actual: number; target: number };
  /** Only on a directly connected rack, from `stat` bit 5 or bits 6-8. */
  filamentLoaded?: boolean;
  /** From `snow`: the AMS unit and slot feeding it; absent when it reports none (0xff). */
  feedingSlot?: { amsId: number; slotId: number };
  /** `bind_ams`, keeping only AMS unit ids the report lists, as Studio does. */
  boundAms?: number[];
  serial?: string;
  filamentId?: string;
  colour?: string;
}
export interface ToolRackAms { id: string; type: string; trays: number }
export interface ToolRack {
  source: string;
  holder?: ToolRackHolder;
  nozzles: ToolRackNozzle[];
  rackAms: ToolRackAms[];
}

const SOURCE = "Bambu Studio 02.09.01.70 field layout (DevNozzleRack, DevNozzleSystem, DevFilaSystem); not verified against an H3C report";

/** An integer field, as Studio's `.get<int>()` reads it: a JSON integer only, never a numeric string. */
function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
/** DevUtil::get_flag_bits on an integer: (value >> start) & mask. */
function bits(value: number, start: number, count = 1): number {
  return Number((BigInt(value) >> BigInt(start)) & ((1n << BigInt(count)) - 1n));
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The holder as Studio reads it, and whether its rack is directly connected (raw type above AB). */
function decodeHolder(holder: Record<string, any>): { holder: ToolRackHolder; directlyConnected: boolean; info2?: number } {
  const stat = int(holder.stat);
  const info2 = int(holder.info2);
  const legacyCalibration = int(holder.info);
  let type: string | Unknown = "unknown";
  let calibrated: boolean | Unknown = legacyCalibration === 1 ? true : legacyCalibration === 0 ? false : "unknown";
  // Studio's raw rack type: -1 none, 0 AB (also implied by a legacy `info`), above 0 directly connected.
  let rackType = Object.prototype.hasOwnProperty.call(holder, "info") ? 0 : -1;
  if (rackType === 0) type = "AB";
  if (info2 !== undefined && info2 >= 0) {
    calibrated = bits(info2, 0) === 1;
    rackType = bits(info2, 1, 4);
    type = RACK_TYPE[rackType] ?? "unknown";
  }
  const position = int(holder.pos);
  return { directlyConnected: rackType > 0, info2: info2 !== undefined && info2 >= 0 ? info2 : undefined, holder: {
    status: stat !== undefined && stat >= 0 && stat < RACK_STATUS.length ? RACK_STATUS[stat] : "unknown",
    job: int(holder.job) ?? 0,
    steps: Array.isArray(holder.step) ? holder.step.filter((step: unknown) => Number.isSafeInteger(step)) : [],
    type, calibrated,
    // DevNozzleRack reads pos only when the rack is not directly connected (type AB or none).
    ...(rackType <= 0 && position !== undefined ? { position: RACK_AB_POSITION[position] ?? "unknown" } : {}),
  } };
}

function decodeNozzle(entry: Record<string, any>, nozzle: Record<string, any>, rack: { direct: boolean; info2?: number; amsIds: Set<number> }): ToolRackNozzle | undefined {
  const id = int(entry.id);
  if (id === undefined || id < 0) return undefined;
  const decoded: ToolRackNozzle = { id, nozzleId: bits(id, 0, 4), onRack: bits(id, 4, 4) === 1 };
  const addrId = int(entry.addr_id);
  if (addrId !== undefined && addrId >= 0) {
    decoded.addrId = addrId;
    if (rack.info2 !== undefined) decoded.dockCalibrated = bits(rack.info2, 5 + addrId) === 1;
  }
  const exist = int(nozzle.exist);
  if (exist !== undefined && exist >= 0) decoded.present = bits(exist, id) === 1;
  const diameter = typeof entry.diameter === "number" ? entry.diameter : typeof entry.diameter === "string" ? Number(entry.diameter) : undefined;
  if (diameter !== undefined && Number.isFinite(diameter) && diameter > 0) decoded.diameter = diameter;
  if (typeof entry.type === "string" && entry.type) decoded.type = entry.type;
  const temp = int(entry.temp);
  if (temp !== undefined && temp >= 0) decoded.temperature = { actual: bits(temp, 0, 16), target: bits(temp, 16, 16) };
  const stat = int(entry.stat);
  if (rack.direct && stat !== undefined && stat >= 0) decoded.filamentLoaded = bits(stat, 5) === 1 || bits(stat, 6, 3) !== 0;
  const snow = int(entry.snow);
  if (snow !== undefined && snow >= 0 && bits(snow, 0, 8) !== 0xff) decoded.feedingSlot = { amsId: bits(snow, 8, 8), slotId: bits(snow, 0, 8) };
  if (Array.isArray(entry.bind_ams)) decoded.boundAms = entry.bind_ams.filter((value: unknown) => Number.isSafeInteger(value) && rack.amsIds.has(value as number));
  if (typeof entry.sn === "string" && entry.sn) decoded.serial = entry.sn;
  if (typeof entry.fila_id === "string" && entry.fila_id) decoded.filamentId = entry.fila_id;
  if (typeof entry.color_m === "string" && entry.color_m) decoded.colour = entry.color_m;
  return decoded;
}

function amsUnits(raw: Record<string, any>): Record<string, any>[] {
  return Array.isArray(raw.ams?.ams) ? raw.ams.ams.filter(object) : [];
}
/** An AMS unit's id, which Studio requires and parses as an integer. */
function amsId(unit: Record<string, any>): number | undefined {
  const id = typeof unit.id === "string" && /^\d+$/.test(unit.id.trim()) ? Number(unit.id) : int(unit.id);
  return id !== undefined && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}
/** AMS units whose `info` (a hex string) names a rack AMS type in bits 0-3, with the trays they report. */
function rackAmsUnits(raw: Record<string, any>): ToolRackAms[] {
  return amsUnits(raw).flatMap(unit => {
    const id = amsId(unit);
    if (id === undefined || typeof unit.info !== "string" || !/^[0-9a-f]{1,13}$/i.test(unit.info.trim())) return [];
    const type = RACK_AMS_TYPE[bits(Number.parseInt(unit.info.trim(), 16), 0, 4)];
    return type ? [{ id: String(id), type, trays: Array.isArray(unit.tray) ? unit.tray.length : 0 }] : [];
  });
}

/** The tool rack, nozzles and rack AMS units a report describes, or undefined when it describes none of them. */
export function decodeToolRack(raw: unknown): ToolRack | undefined {
  if (!object(raw)) return undefined;
  const decoded = object(raw.device?.holder) ? decodeHolder(raw.device.holder) : undefined;
  const holder = decoded?.holder;
  const rack = { direct: decoded?.directlyConnected === true, info2: decoded?.info2,
    amsIds: new Set(amsUnits(raw).flatMap(unit => { const id = amsId(unit); return id === undefined ? [] : [id]; })) };
  const nozzle = object(raw.device?.nozzle) ? raw.device.nozzle : undefined;
  const nozzles = Array.isArray(nozzle?.info)
    ? nozzle!.info.flatMap((entry: unknown) => {
        const decodedNozzle = object(entry) ? decodeNozzle(entry, nozzle!, rack) : undefined;
        return decodedNozzle ? [decodedNozzle] : [];
      })
    : [];
  const rackAms = rackAmsUnits(raw);
  if (!holder && nozzles.length === 0 && rackAms.length === 0) return undefined;
  return { source: SOURCE, ...(holder ? { holder } : {}), nozzles, rackAms };
}
