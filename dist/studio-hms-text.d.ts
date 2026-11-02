/** Bambu Studio's downloaded text for a 16-hex HMS code or an 8-hex print_error code, by serial prefix, else from hms_en.json. */
export declare function studioDownloadedText(kind: "hms" | "error", code: string, serial: string): string | undefined;
