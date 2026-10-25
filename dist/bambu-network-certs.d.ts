/**
 * Bambu's public certificates from Bambu Studio v02.08.02.61 resources/cert,
 * the folder Bambu Studio and FULU's GUI pass to the networking plug-in's
 * set_cert_file. printer.cer holds the BBL CA roots that sign each printer's
 * LAN MQTT certificate; slicer_base64.cer is the cloud certificate. FULU's
 * standalone Linux host runtime ships only slicer_base64.cer, so its plug-in
 * cannot verify a LAN printer without these. Exact bytes, pinned by SHA-256
 * (the same pins as scripts/setup-bambu-native.mjs).
 */
export declare const BAMBU_NETWORK_CERTIFICATES: Readonly<Record<"printer.cer" | "slicer_base64.cer", {
    sha256: string;
    base64: string;
}>>;
