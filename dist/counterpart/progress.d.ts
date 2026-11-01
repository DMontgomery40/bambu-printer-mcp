import { type HmsText } from "../safety/hms-messages.js";
import { type PrintProgress, type PrintState, type Problem } from "./schemas.js";
/** print_error / fail_reason 0300400C: "The task was canceled." in every bundled Bambu Studio table. */
export declare const TASK_CANCELLED = 50348044;
/** Bambu reports a user cancel as FAILED with 0300400C in print_error, or (X2D) in fail_reason. */
export declare function isCancelledReport(raw: Record<string, any>): boolean;
/** gcode_state → counterpart/1 state. A connected printer with no or an unknown gcode_state is busy. */
export declare function bambuState(raw: Record<string, any>): PrintState;
/** 16 hex digits (attr then code) as Bambu writes them: AAAA_BBBB_CCCC_DDDD. */
export declare function formatHmsCode(hex: string): string;
/** Bambu's page for an HMS code, as Bambu Studio's get_hms_wiki_url builds it, without the device serial. */
export declare function hmsUrl(hex: string): string;
/** The table text for this printer's serial prefix, else the text most tables use. */
export declare function tableText(table: Readonly<Record<string, HmsText>>, code: string, serial: string): string | undefined;
/** Bambu Studio's words for stg_cur. Like MachineObject::get_curr_stage, none without a stage list. */
export declare function stageWords(raw: Record<string, any>): string | undefined;
/** print_error and hms[] as problems, in report order, without duplicates. */
export declare function bambuProblems(raw: Record<string, any>, serial: string, model: string): Problem[];
/** One merged MQTT report and the time it arrived → counterpart/1 progress. */
export declare function bambuProgress(raw: Record<string, any>, options: {
    receivedAt: number;
    serial: string;
    model?: string;
}): PrintProgress;
/** No report arrived: the printer is unreachable over MQTT. */
export declare function offlineProgress(observedAt: number): PrintProgress;
