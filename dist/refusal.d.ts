/**
 * A refusal with a stable code, returned as structuredContent.code on the tool's error, so clients such as
 * Counterpart act on the code instead of matching the message (whose words, HMS numbers, firmware and slicer
 * details change). None of them starts a print. Whether a print command was sent is dispatch truth: clients
 * read structuredContent.printOutcome for it, never these codes or the message.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file was uploaded and the command sent, but nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 * - printer-upload-failed: the print file didn't reach the printer, so no print command was sent.
 * - slicer-waiting-on-dialog: the slicer stopped working (no CPU, no output) as it does while a window waits for an
 *   answer, and was stopped; nothing was sliced or sent. Not the slicer's verdict on the model: no slicer_report.
 * - needs-more-filaments: the design is in more colours than there are filaments to slice it with (a two-colour 3MF on
 *   a printer with no AMS loaded); nothing was sliced. structuredContent.filament_slots says how many of each, and
 *   slicer_report.message the plain answer a client shows (scan-to-make #858, the DAD pass).
 */
export declare const REFUSAL_CODES: readonly ["printer-command-rejected", "printer-not-ready", "printer-upload-failed", "slicer-waiting-on-dialog", "needs-more-filaments"];
export type RefusalCode = (typeof REFUSAL_CODES)[number];
export declare class PrinterRefusal extends Error {
    readonly code: RefusalCode;
    constructor(code: RefusalCode, message: string);
}
/** A slicer stopped because it waited on a dialog (src/slicer/slicer-launch.ts); carries slicer-waiting-on-dialog. */
export declare class SlicerStalled extends PrinterRefusal {
    constructor(message: string);
}
/** counterpart/1 dispatch-tool errors describe dispatch truth independently of firmware-specific codes. */
export type PrintOutcome = "not-sent" | "unknown" | "rejected";
export declare function withPrintDispatch<T>(run: () => T): T;
/** Call immediately before handing a print command to a transport. An acknowledgement may then be lost. */
export declare function markPrintCommandSent(): void;
export declare function printOutcome(error: unknown): PrintOutcome;
/**
 * More filament colours than filament slots to slice with: the plain answer a person is shown, and the counts. The
 * DAD pass sliced its two-colour 3MF for a P1S with no AMS loaded and got only "2 filament colours were supplied for
 * 1 filament slots".
 */
export declare class FilamentSlotsError extends PrinterRefusal {
    readonly colours: number;
    readonly slots: number;
    readonly plain: string;
    /** The filament changes the slice would make, when the slicer reported them (a printer with too few feeds). */
    readonly changes?: number;
    /** The slicer's own words, or this server's when the printer's feeds decided it. */
    readonly detail: string;
    /** The printer's feeds and the slice's colours, when they decided it (slice_stl's filament_feed). */
    feed?: Record<string, unknown>;
    /** The slicer's own result.json for the slice the printer's feeds refused. */
    slicerResult?: unknown;
    /**
     * colours: the colours the design prints with; slots: the filaments there are to feed them (slice slots, or the
     * printer's AMS trays plus external spools). `options` carries the plain sentence when the printer's feeds decide
     * it, and the filament changes the slice would make.
     */
    constructor(colours: number, slots: number, options?: {
        plain?: string;
        changes?: number;
    });
}
