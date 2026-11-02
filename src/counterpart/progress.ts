/**
 * counterpart_print_progress for Bambu printers: maps one merged MQTT report
 * to the counterpart/1 result (PRD §8.4, Bambu row). Pure, so tests and the
 * tool share it. Display data only: never a safety decision.
 */
import path from "node:path";
import { BAMBU_STAGES } from "../printers/bambu-stages.js";
import { HMS_MESSAGES, HMS_MESSAGES_SOURCE, PRINT_ERROR_MESSAGES, type HmsText } from "../safety/hms-messages.js";
import { studioDownloadedText } from "../studio-hms-text.js";
import { isDualNozzleModel, normalizeModel } from "../safety/limits.js";
import { finiteNumber, hmsCode, isHiddenNotice } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, type PrintProgress, type PrintState, type Problem, type ProblemSeverity, type Temperature } from "./schemas.js";

/** print_error / fail_reason 0300400C: "The task was canceled." in every bundled Bambu Studio table. */
export const TASK_CANCELLED = 0x0300400c;
/** Models whose chamber_temper is a real sensor; P1/A1 report a constant. H2-class models use the CTC value. */
const CHAMBER_SENSOR_MODELS = new Set(["x1", "x1c", "x1e"]);
/** Bambu Studio DevHMS.h HMSMessageLevel: 1 fatal, 2 serious, 3 common, 4 info. */
const HMS_SEVERITIES: Record<number, ProblemSeverity> = { 1: "fatal", 2: "error", 3: "warning", 4: "info" };

const STATES: Record<string, PrintState> = {
  IDLE: "idle", PREPARE: "preparing", SLICING: "preparing", RUNNING: "printing",
  PAUSE: "paused", FINISH: "finished", FAILED: "failed",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Bambu reports a user cancel as FAILED with 0300400C in print_error, or (X2D) in fail_reason. */
export function isCancelledReport(raw: Record<string, any>): boolean {
  return raw.gcode_state === "FAILED" &&
    (finiteNumber(raw.print_error) === TASK_CANCELLED || finiteNumber(raw.fail_reason) === TASK_CANCELLED);
}

/** gcode_state → counterpart/1 state. A connected printer with no or an unknown gcode_state is busy. */
export function bambuState(raw: Record<string, any>): PrintState {
  if (isCancelledReport(raw)) return "cancelled";
  const state = typeof raw.gcode_state === "string" ? STATES[raw.gcode_state.toUpperCase()] : undefined;
  return state ?? "busy";
}

/** 16 hex digits (attr then code) as Bambu writes them: AAAA_BBBB_CCCC_DDDD. */
export function formatHmsCode(hex: string): string {
  return `${hex.slice(0, 4)}_${hex.slice(4, 8)}_${hex.slice(8, 12)}_${hex.slice(12, 16)}`;
}

/** Bambu's page for an HMS code, as Bambu Studio's get_hms_wiki_url builds it, without the device serial. */
export function hmsUrl(hex: string): string {
  return `https://e.bambulab.com/index.php?e=${hex}&s=device_hms&lang=en`;
}

/** The table text for this printer's serial prefix, else the text most tables use. */
export function tableText(table: Readonly<Record<string, HmsText>>, code: string, serial: string): string | undefined {
  const entry = table[code];
  if (entry === undefined || typeof entry === "string") return entry;
  return entry[serial.trim().toUpperCase().slice(0, 3)] ?? entry["*"];
}

/** Bambu Studio's words for stg_cur. Like MachineObject::get_curr_stage, none without a stage list. */
export function stageWords(raw: Record<string, any>): string | undefined {
  const stage = finiteNumber(raw.stg_cur);
  if (stage === undefined || !Number.isInteger(stage) || stage < 0) return undefined;
  if (!Array.isArray(raw.stg) || raw.stg.length === 0) return undefined;
  return BAMBU_STAGES[stage];
}

function undocumented(code: string): string {
  return `Printer reported ${code}; Bambu Studio ${HMS_MESSAGES_SOURCE.studioTag} has no description for it.`;
}

/** print_error and hms[] as problems, in report order, without duplicates. */
export function bambuProblems(raw: Record<string, any>, serial: string, model: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (problem: Problem) => { if (!seen.has(problem.code)) { seen.add(problem.code); problems.push(problem); } };
  const error = finiteNumber(raw.print_error);
  // 0300400C only records a cancel; it is the state, not a problem.
  if (error !== undefined && Number.isInteger(error) && error > 0 && error <= 0xffffffff && error !== TASK_CANCELLED) {
    const code = error.toString(16).padStart(8, "0").toUpperCase();
    add({ code, severity: "error", message: tableText(PRINT_ERROR_MESSAGES, code, serial) ?? studioDownloadedText("error", code, serial) ?? undocumented(code) });
  }
  for (const reported of Array.isArray(raw.hms) ? raw.hms : []) {
    const entry = hmsCode(reported);
    if (!entry) {
      add({ code: "HMS_MALFORMED", severity: "error", message: "The printer reported an HMS entry that cannot be read." });
      continue;
    }
    const code = formatHmsCode(entry.hex);
    if (isHiddenNotice(serial, model, entry)) {
      add({ code, severity: "info", message: "Bambu lists this code for this printer without a description; the printer and Bambu Studio do not show it.", url: hmsUrl(entry.hex) });
      continue;
    }
    add({
      code,
      severity: HMS_SEVERITIES[entry.severity] ?? "error",
      // The pinned tag bundles no P1, X1 or A1 table; the user's own Studio download may have the text.
      message: tableText(HMS_MESSAGES, entry.hex, serial) ?? studioDownloadedText("hms", entry.hex, serial) ?? undocumented(code),
      url: hmsUrl(entry.hex),
    });
  }
  return problems;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function temperature(actual: unknown, target: unknown) {
  const current = finiteNumber(actual), wanted = finiteNumber(target);
  return current !== undefined && wanted !== undefined ? { actual: round1(current), target: round1(wanted) } : undefined;
}

function chamber(raw: Record<string, any>, model: string): number | undefined {
  // CTC packs the current temperature in the low 16 bits and the target in the high 16 bits.
  const ctc = raw.device?.ctc?.info?.temp;
  if (typeof ctc === "number" && Number.isInteger(ctc) && ctc >= 0 && ctc <= 0xffffffff) return ctc & 0xffff;
  const sensor = finiteNumber(raw.chamber_temper);
  return CHAMBER_SENSOR_MODELS.has(normalizeModel(model) ?? "") && sensor !== undefined ? round1(sensor) : undefined;
}

function rgb(value: unknown): string | undefined {
  return typeof value === "string" && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
    ? `#${value.replace(/^#/, "").slice(0, 6).toUpperCase()}` : undefined;
}

/**
 * The active extruder of a V2 report (H2D, H2C, X2D): Bambu Studio
 * DevExtruderSystem.cpp ParseV2_0 reads its index from device.extruder.state
 * bits 4-7 and that entry's packed temp and snow fields.
 */
function activeExtruder(raw: Record<string, any>): Record<string, any> | undefined {
  const extruder = raw.device?.extruder;
  const state = finiteNumber(extruder?.state);
  if (!Array.isArray(extruder?.info) || state === undefined || !Number.isInteger(state) || state < 0) return undefined;
  const current = (state >> 4) & 0xf;
  return extruder.info.find((entry: any) => finiteNumber(entry?.id) === current);
}

function packed(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}

/** V2 reports pack the active nozzle's current temperature in the low 16 bits and its target in the high 16. */
function nozzleTemperature(raw: Record<string, any>): Temperature | undefined {
  const temp = packed(activeExtruder(raw)?.temp);
  if (temp !== undefined) return { actual: temp & 0xffff, target: temp >>> 16 };
  return temperature(raw.nozzle_temper, raw.nozzle_target_temper);
}

function amsTray(raw: Record<string, any>, amsId: number, slotId: number): Record<string, any> | undefined {
  const units: any[] = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
  const unit = units.find((candidate, index) => (finiteNumber(candidate?.id) ?? index) === amsId);
  const trays: any[] = Array.isArray(unit?.tray) ? unit.tray : [];
  return trays.find((candidate, index) => (finiteNumber(candidate?.id) ?? index) === slotId);
}

/** The external spool's report: per-nozzle vir_slot entries (254 deputy/left, 255 main/right), else legacy vt_tray. */
function externalTray(raw: Record<string, any>, id: number): Record<string, any> | undefined {
  if (Array.isArray(raw.vir_slot)) {
    const slot = raw.vir_slot.find((entry: any) => finiteNumber(entry?.id) === id) ?? (raw.vir_slot.length === 1 ? raw.vir_slot[0] : undefined);
    if (slot) return slot;
  }
  return raw.vt_tray && typeof raw.vt_tray === "object" ? raw.vt_tray : undefined;
}

function described(slot: string, tray: Record<string, any> | undefined): NonNullable<PrintProgress["activeFilament"]> {
  const material = text(tray?.tray_type);
  const color = material ? rgb(tray?.tray_color) : undefined;
  return { slot, ...(material ? { material } : {}), ...(color ? { color } : {}) };
}

/**
 * The loaded filament. slot is the index ams_slots uses: amsId*4+tray for an
 * AMS, the unit id (128+) for an AMS-HT, and "ext" for a single-nozzle
 * printer's external spool ("254"/"255" per nozzle on dual-nozzle printers).
 */
function activeFilament(raw: Record<string, any>, model: string): PrintProgress["activeFilament"] {
  const dualNozzle = isDualNozzleModel(model);
  const extruder = activeExtruder(raw);
  const snow = packed(extruder?.snow);
  if (extruder && snow !== undefined) {
    if (snow === 0xffff) return undefined;
    const amsId = (snow >> 8) & 0xff, slotId = snow & 0xff;
    if (amsId === 254 || amsId === 255) return described(dualNozzle ? String(amsId) : "ext", externalTray(raw, amsId));
    if (amsId >= 0x80 && amsId <= 0x87) return described(String(amsId), amsTray(raw, amsId, slotId));
    return described(String(amsId * 4 + slotId), amsTray(raw, amsId, slotId));
  }
  // V1 (DevExtruderSystem.cpp ParseV1_0): tray_now 255 none, 254 the external spool,
  // 0x80-0x87 an AMS-HT unit, else amsId*4+tray.
  const trayNow = finiteNumber(raw.ams?.tray_now);
  if (trayNow === undefined || !Number.isInteger(trayNow) || trayNow < 0 || trayNow >= 255) return undefined;
  if (trayNow === 254) return described("ext", externalTray(raw, 254));
  if (trayNow >= 0x80 && trayNow <= 0x87) {
    const units: any[] = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
    const unit = units.find(candidate => finiteNumber(candidate?.id) === trayNow);
    const trays: any[] = Array.isArray(unit?.tray) ? unit.tray : [];
    // An AMS-HT has one tray; Bambu Studio addresses it as tray_now & 3.
    return described(String(trayNow), amsTray(raw, trayNow, trayNow & 0x3) ?? (trays.length === 1 ? trays[0] : undefined));
  }
  return described(String(trayNow), amsTray(raw, Math.floor(trayNow / 4), trayNow % 4));
}

/** A printer file path's basename (the jobName raw G-code prints return), as KAN-216 reads it. */
export function remoteJobName(value: unknown): string | undefined {
  const name = text(value);
  if (!name) return undefined;
  return path.posix.basename(name.replace(/\\/g, "/").replace(/^\d+:/, "")) || undefined;
}

function job(raw: Record<string, any>, state: PrintState): PrintProgress["job"] {
  if (state === "idle" || state === "busy" || state === "offline") return undefined;
  // subtask_name is the project name; a raw G-code print reports only its file path.
  const name = text(raw.subtask_name) ?? remoteJobName(raw.gcode_file);
  if (!name) return undefined;
  const result: NonNullable<PrintProgress["job"]> = { name };
  // LAN prints on P1/X1/A1 report task_id "0"; that identifies no job.
  const taskId = typeof raw.task_id === "number" ? String(raw.task_id) : text(raw.task_id);
  if (taskId && taskId !== "0") result.id = taskId;
  const progress = finiteNumber(raw.mc_percent);
  if (progress !== undefined && progress >= 0 && progress <= 100) result.progress = progress;
  // mc_remaining_time is in minutes.
  const remaining = finiteNumber(raw.mc_remaining_time);
  if (remaining !== undefined && remaining >= 0) result.remainingSec = Math.round(remaining * 60);
  const total = finiteNumber(raw.total_layer_num), layer = finiteNumber(raw.layer_num);
  if (total !== undefined && Number.isInteger(total) && total > 0) {
    result.totalLayers = total;
    if (layer !== undefined && Number.isInteger(layer) && layer >= 0) result.layer = layer;
  }
  const stage = stageWords(raw);
  if (stage) result.stage = stage;
  return result;
}

/** One merged MQTT report and the time it arrived → counterpart/1 progress. */
export function bambuProgress(raw: Record<string, any>, options: { receivedAt: number; serial: string; model?: string }): PrintProgress {
  const model = options.model ?? "";
  const state = bambuState(raw);
  const result: PrintProgress = { contract: COUNTERPART_CONTRACT, observedAt: new Date(options.receivedAt).toISOString(), state, problems: [] };
  const printJob = job(raw, state);
  if (printJob) result.job = printJob;
  const nozzle = nozzleTemperature(raw);
  const bed = temperature(raw.bed_temper, raw.bed_target_temper);
  const chamberTemperature = chamber(raw, model);
  if (nozzle || bed || chamberTemperature !== undefined) {
    result.temps = { ...(nozzle ? { nozzle } : {}), ...(bed ? { bed } : {}), ...(chamberTemperature !== undefined ? { chamber: chamberTemperature } : {}) };
  }
  const filament = activeFilament(raw, model);
  if (filament) result.activeFilament = filament;
  result.problems = bambuProblems(raw, options.serial, model);
  return result;
}

/** No report arrived: the printer is unreachable over MQTT. */
export function offlineProgress(observedAt: number): PrintProgress {
  return { contract: COUNTERPART_CONTRACT, observedAt: new Date(observedAt).toISOString(), state: "offline", problems: [] };
}
