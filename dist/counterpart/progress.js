/**
 * counterpart_print_progress for Bambu printers: maps one merged MQTT report
 * to the counterpart/1 result (PRD §8.4, Bambu row). Pure, so tests and the
 * tool share it. Display data only: never a safety decision.
 */
import { BAMBU_STAGES } from "../printers/bambu-stages.js";
import { HMS_MESSAGES, HMS_MESSAGES_SOURCE, PRINT_ERROR_MESSAGES } from "../safety/hms-messages.js";
import { normalizeModel } from "../safety/limits.js";
import { finiteNumber, hmsCode, isHiddenNotice } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT } from "./schemas.js";
/** print_error / fail_reason 0300400C: "The task was canceled." in every bundled Bambu Studio table. */
export const TASK_CANCELLED = 0x0300400c;
/** Models whose chamber_temper is a real sensor; P1/A1 report a constant. H2-class models use the CTC value. */
const CHAMBER_SENSOR_MODELS = new Set(["x1", "x1c", "x1e"]);
/** Bambu Studio DevHMS.h HMSMessageLevel: 1 fatal, 2 serious, 3 common, 4 info. */
const HMS_SEVERITIES = { 1: "fatal", 2: "error", 3: "warning", 4: "info" };
const STATES = {
    IDLE: "idle", PREPARE: "preparing", SLICING: "preparing", RUNNING: "printing",
    PAUSE: "paused", FINISH: "finished", FAILED: "failed",
};
function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** Bambu reports a user cancel as FAILED with 0300400C in print_error, or (X2D) in fail_reason. */
export function isCancelledReport(raw) {
    return raw.gcode_state === "FAILED" &&
        (finiteNumber(raw.print_error) === TASK_CANCELLED || finiteNumber(raw.fail_reason) === TASK_CANCELLED);
}
/** gcode_state → counterpart/1 state. A connected printer with no or an unknown gcode_state is busy. */
export function bambuState(raw) {
    if (isCancelledReport(raw))
        return "cancelled";
    const state = typeof raw.gcode_state === "string" ? STATES[raw.gcode_state.toUpperCase()] : undefined;
    return state ?? "busy";
}
/** 16 hex digits (attr then code) as Bambu writes them: AAAA_BBBB_CCCC_DDDD. */
export function formatHmsCode(hex) {
    return `${hex.slice(0, 4)}_${hex.slice(4, 8)}_${hex.slice(8, 12)}_${hex.slice(12, 16)}`;
}
/** Bambu's page for an HMS code, as Bambu Studio's get_hms_wiki_url builds it, without the device serial. */
export function hmsUrl(hex) {
    return `https://e.bambulab.com/index.php?e=${hex}&s=device_hms&lang=en`;
}
/** The table text for this printer's serial prefix, else the text most tables use. */
export function tableText(table, code, serial) {
    const entry = table[code];
    if (entry === undefined || typeof entry === "string")
        return entry;
    return entry[serial.trim().toUpperCase().slice(0, 3)] ?? entry["*"];
}
/** Bambu Studio's words for stg_cur. Like MachineObject::get_curr_stage, none without a stage list. */
export function stageWords(raw) {
    const stage = finiteNumber(raw.stg_cur);
    if (stage === undefined || !Number.isInteger(stage) || stage < 0)
        return undefined;
    if (!Array.isArray(raw.stg) || raw.stg.length === 0)
        return undefined;
    return BAMBU_STAGES[stage];
}
function undocumented(code) {
    return `Printer reported ${code}; Bambu Studio ${HMS_MESSAGES_SOURCE.studioTag} has no description for it.`;
}
/** print_error and hms[] as problems, in report order, without duplicates. */
export function bambuProblems(raw, serial, model) {
    const problems = [];
    const seen = new Set();
    const add = (problem) => { if (!seen.has(problem.code)) {
        seen.add(problem.code);
        problems.push(problem);
    } };
    const error = finiteNumber(raw.print_error);
    // 0300400C only records a cancel; it is the state, not a problem.
    if (error !== undefined && Number.isInteger(error) && error > 0 && error <= 0xffffffff && error !== TASK_CANCELLED) {
        const code = error.toString(16).padStart(8, "0").toUpperCase();
        add({ code, severity: "error", message: tableText(PRINT_ERROR_MESSAGES, code, serial) ?? undocumented(code) });
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
            message: tableText(HMS_MESSAGES, entry.hex, serial) ?? undocumented(code),
            url: hmsUrl(entry.hex),
        });
    }
    return problems;
}
const round1 = (value) => Math.round(value * 10) / 10;
function temperature(actual, target) {
    const current = finiteNumber(actual), wanted = finiteNumber(target);
    return current !== undefined && wanted !== undefined ? { actual: round1(current), target: round1(wanted) } : undefined;
}
function chamber(raw, model) {
    // CTC packs the current temperature in the low 16 bits and the target in the high 16 bits.
    const ctc = raw.device?.ctc?.info?.temp;
    if (typeof ctc === "number" && Number.isInteger(ctc) && ctc >= 0 && ctc <= 0xffffffff)
        return ctc & 0xffff;
    const sensor = finiteNumber(raw.chamber_temper);
    return CHAMBER_SENSOR_MODELS.has(normalizeModel(model) ?? "") && sensor !== undefined ? round1(sensor) : undefined;
}
function rgb(value) {
    return typeof value === "string" && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
        ? `#${value.replace(/^#/, "").slice(0, 6).toUpperCase()}` : undefined;
}
/** tray_now 0–253 is AMS slot amsId*4+trayId (the index ams_slots uses), 254 the external spool, 255 none. */
function activeFilament(raw) {
    const trayNow = finiteNumber(raw.ams?.tray_now);
    if (trayNow === undefined || !Number.isInteger(trayNow) || trayNow < 0 || trayNow >= 255)
        return undefined;
    let tray;
    if (trayNow === 254)
        tray = raw.vt_tray;
    else {
        const units = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
        for (const [unitIndex, unit] of units.entries()) {
            const amsId = finiteNumber(unit?.id) ?? unitIndex;
            for (const [trayIndex, candidate] of (Array.isArray(unit?.tray) ? unit.tray : []).entries()) {
                if (amsId * 4 + (finiteNumber(candidate?.id) ?? trayIndex) === trayNow)
                    tray = candidate;
            }
        }
    }
    const material = text(tray?.tray_type);
    const color = material ? rgb(tray?.tray_color) : undefined;
    return { slot: trayNow === 254 ? "ext" : String(trayNow), ...(material ? { material } : {}), ...(color ? { color } : {}) };
}
function job(raw, state) {
    if (state === "idle" || state === "busy" || state === "offline")
        return undefined;
    const name = text(raw.subtask_name) ?? text(raw.gcode_file);
    if (!name)
        return undefined;
    const result = { name };
    // LAN prints on P1/X1/A1 report task_id "0"; that identifies no job.
    const taskId = typeof raw.task_id === "number" ? String(raw.task_id) : text(raw.task_id);
    if (taskId && taskId !== "0")
        result.id = taskId;
    const progress = finiteNumber(raw.mc_percent);
    if (progress !== undefined && progress >= 0 && progress <= 100)
        result.progress = progress;
    // mc_remaining_time is in minutes.
    const remaining = finiteNumber(raw.mc_remaining_time);
    if (remaining !== undefined && remaining >= 0)
        result.remainingSec = Math.round(remaining * 60);
    const total = finiteNumber(raw.total_layer_num), layer = finiteNumber(raw.layer_num);
    if (total !== undefined && Number.isInteger(total) && total > 0) {
        result.totalLayers = total;
        if (layer !== undefined && Number.isInteger(layer) && layer >= 0)
            result.layer = layer;
    }
    const stage = stageWords(raw);
    if (stage)
        result.stage = stage;
    return result;
}
/** One merged MQTT report and the time it arrived → counterpart/1 progress. */
export function bambuProgress(raw, options) {
    const model = options.model ?? "";
    const state = bambuState(raw);
    const result = { contract: COUNTERPART_CONTRACT, observedAt: new Date(options.receivedAt).toISOString(), state, problems: [] };
    const printJob = job(raw, state);
    if (printJob)
        result.job = printJob;
    const nozzle = temperature(raw.nozzle_temper, raw.nozzle_target_temper);
    const bed = temperature(raw.bed_temper, raw.bed_target_temper);
    const chamberTemperature = chamber(raw, model);
    if (nozzle || bed || chamberTemperature !== undefined) {
        result.temps = { ...(nozzle ? { nozzle } : {}), ...(bed ? { bed } : {}), ...(chamberTemperature !== undefined ? { chamber: chamberTemperature } : {}) };
    }
    const filament = activeFilament(raw);
    if (filament)
        result.activeFilament = filament;
    result.problems = bambuProblems(raw, options.serial, model);
    return result;
}
/** No report arrived: the printer is unreachable over MQTT. */
export function offlineProgress(observedAt) {
    return { contract: COUNTERPART_CONTRACT, observedAt: new Date(observedAt).toISOString(), state: "offline", problems: [] };
}
