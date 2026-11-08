/**
 * A printer refusal with a stable diagnostic code, retained for existing clients.
 * Counterpart uses structuredContent.printOutcome for dispatch truth, never
 * these firmware-specific codes or the message.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file was uploaded and the command sent, but nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 * - printer-upload-failed: the print file didn't reach the printer, so no print command was sent.
 */
export declare const REFUSAL_CODES: readonly ["printer-command-rejected", "printer-not-ready", "printer-upload-failed"];
export type RefusalCode = (typeof REFUSAL_CODES)[number];
export declare class PrinterRefusal extends Error {
    readonly code: RefusalCode;
    constructor(code: RefusalCode, message: string);
}
/** counterpart/1 dispatch-tool errors describe dispatch truth independently of firmware-specific codes. */
export type PrintOutcome = "not-sent" | "unknown" | "rejected";
export declare function withPrintDispatch<T>(run: () => T): T;
/** Call immediately before handing a print command to a transport. An acknowledgement may then be lost. */
export declare function markPrintCommandSent(): void;
export declare function printOutcome(error: unknown): PrintOutcome;
