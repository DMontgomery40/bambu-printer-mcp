/** Encode text for a quoted XML attribute, preserving whitespace through XML parsing. */
export declare function xmlAttribute(value: string): string;
/** Studio 02.08.02.61 bbs_3mf.cpp writes object opt_serialize values without XML escaping.
 * Only repair its single-line key/value metadata form. Unexpected malformed XML fails closed. */
export declare function escapedModelSettings(xml: string): Promise<string>;
/** Normalize only a newly produced/restored slice, before caching or handing it to the client. */
export declare function normalize3mfMetadata(filePath: string): Promise<void>;
