/** The status-only model value ("h3c") a reported model id, model name or value names, if any. */
export declare function statusOnlyModel(value: unknown): string | undefined;
/** The status-only model value a returned serial number's prefix names, if any. */
export declare function statusOnlyModelFromSerial(serial: unknown): string | undefined;
/** Bambu's display name ("H3C") for a status-only model id, model name or value. */
export declare function statusOnlyDisplayName(value: unknown): string | undefined;
/** Bambu's display name for a status-only printer's serial number. */
export declare function statusOnlyDisplayNameFromSerial(serial: unknown): string | undefined;
export declare function isStatusOnlyModel(value: unknown): boolean;
/** Why an operation on a printer that reported itself as status-only was refused before anything was sent to it. */
export declare function statusOnlyMessage(value: unknown): string;
/** Why a status-only model was refused as a bambu_model value. */
export declare function statusOnlyModelValueMessage(value: unknown): string;
