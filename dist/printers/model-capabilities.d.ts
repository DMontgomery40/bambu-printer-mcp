export declare function normalizeModelName(model: unknown): string;
export declare const P1_MODELS: Set<string>;
export declare const P2_MODELS: Set<string>;
export declare const H2_MODELS: Set<string>;
export declare const X1_MODELS: Set<string>;
export declare const X2_MODELS: Set<string>;
export declare const A1_MODELS: Set<string>;
export declare const LEGACY_SDCARD_PRINT_MODELS: Set<string>;
export declare function isLegacySdcardPrintModel(model: unknown): boolean;
/** x1/p1/a1 -> /cache. p2/h2/x2 -> ftp root + ams_mapping2. model wins over serial. */
export declare function usesRootFtpPrintPath(model?: unknown, serial?: string): boolean;
