/**
 * The printer's answer to Pause, Resume or Stop, shared by every route (FULU's local network and Bambu Cloud,
 * and the direct local network a printer in LAN Only + Developer Mode takes).
 */
export type ControlReply = {
    accepted: boolean;
    errCode: number;
};
/**
 * The printer's answer to a control it was sent: it echoes command and sequence_id, with
 * err_code set when it refuses. A P1S on authorization firmware signs it: {"header":{...},"print":{...}}.
 */
export declare function controlReply(msg: unknown, command: string, sequenceId: string): ControlReply | undefined;
/**
 * The printer's authorization check refused the command (0x05024007-0x0502400B: unsigned, certificate not
 * trusted, malformed header, signature rejected). On a P1S 01.10.00.00 FULU's plug-in gets 0x0502400A for every
 * Pause and Stop over LAN and Bambu Cloud, while Bambu Studio and Bambu Handy are accepted.
 */
export declare function isAuthorizationRefusal(errCode: number): boolean;
/** What to tell a person about a refused control. direct: the control went straight to the printer (Developer Mode connection). */
export declare function refusedControlMessage(command: string, route: string, errCode: number, direct?: boolean): string;
