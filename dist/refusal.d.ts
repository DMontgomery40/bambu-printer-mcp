/**
 * A printer refusal with a stable code, returned as structuredContent.code on the tool's error, so clients
 * such as Counterpart act on the code instead of matching the message (whose words, HMS numbers and
 * firmware details change with the printer). Neither one starts a print.
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
