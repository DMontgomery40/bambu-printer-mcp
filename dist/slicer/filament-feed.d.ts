/**
 * Whether the printer can feed a multi-colour slice itself (beta 8 DAD replay, Nov 17): a two-colour 3MF sliced for a
 * P1S with no AMS succeeded with 85 filament changes and no word, so a tester would have been sent a print that stops
 * 85 times for a manual swap. Shared by bambu-printer-mcp and mcp-3D-printer-server.
 *
 * How the printer's feeds are known (the judgement, written down):
 * - Feeds are the AMS trays the printer reports (every tray of every AMS unit, loaded or not: a person can load an
 *   empty one). Without an AMS, its external spool holders, one per nozzle (two on a dual-nozzle model). A print
 *   doesn't mix the external spool with AMS trays, so the two are not added.
 * - Known only from a connected printer's report that carries its AMS block; one that lists no AMS unit in it means
 *   no AMS. A report without the block says nothing. The model alone never decides it: every model's AMS is
 *   optional.
 * - Counted per plate: a project whose plates each print in one colour needs no change, and a slice that reports no
 *   filament change is never refused.
 * - Unknown when there are no printer credentials, the printer can't be reached, the caller said
 *   use_printer_filaments: false, or the printer isn't a Bambu. Then the slice succeeds, flagged: the colours and the
 *   filament changes are in the result and its message, so a client never sends it on silently.
 * - Known too few feeds: the slice is refused with needs-more-filaments, as 1.1.97 refuses more colours than slots,
 *   unless the caller says the person will change filament by hand (manual_filament_changes: true).
 */
import { FilamentSlotsError } from "../refusal.js";
export interface PrinterFeed {
    known: boolean;
    /** AMS trays the printer reports (0: no AMS). */
    ams_slots: number;
    /** External spool holders: one per nozzle. */
    external: number;
    /** How it was known, or why it isn't. */
    source: string;
}
/** The feeds a connected Bambu printer's raw report shows. */
export declare function feedFromBambuReport(raw: unknown, connected: boolean, dualNozzle: boolean): PrinterFeed;
export declare const UNKNOWN_FEED: (source: string, dualNozzle?: boolean) => PrinterFeed;
/**
 * The colours a slice prints with and its filament changes, from Bambu Studio / OrcaSlicer's result.json: the plate
 * with the most colours (each plate prints on its own), and its filament changes.
 */
export declare function sliceColours(result: unknown): {
    colours: number;
    changes: number | undefined;
};
export interface FeedVerdict {
    /** The structured facts every multi-colour slice carries (additive). */
    facts?: {
        colours: number;
        filament_changes?: number;
        printer: "feeds-all" | "too-few-feeds" | "unknown";
        feeds?: number;
        source: string;
        manual?: true;
    };
    /** A sentence for slicer_report.message on a slice that worked. */
    note?: string;
    /** The refusal, when the printer is known not to feed the colours and the caller didn't accept manual changes. */
    refusal?: FilamentSlotsError;
}
/** The verdict on one slice: nothing for a one-colour slice. */
export declare function feedVerdict(result: unknown, feed: PrinterFeed, manual: boolean): FeedVerdict;
