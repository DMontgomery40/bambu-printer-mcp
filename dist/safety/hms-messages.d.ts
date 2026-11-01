export declare const HMS_MESSAGES_SOURCE: {
    readonly studioTag: "v02.08.02.61";
    readonly studioCommit: "926a7192574bcb9b3a732e1ec59a46d79cb45466";
    /** Per table: Bambu's device_hms and device_error versions, and the SHA-256 of the English file used. */
    readonly tables: {
        readonly "093": {
            readonly hmsVersion: 202508191204;
            readonly errorVersion: 202508192303;
            readonly sha256: "7801fd6c355854b62ecb62ee32727b4e5dcca908841dbcfd5e5de45b3dfd1c25";
        };
        readonly "094": {
            readonly hmsVersion: 202503231214;
            readonly errorVersion: 202503231214;
            readonly sha256: "047c15e2140738ec08258b74536e6cb996cddf0c586c5c39e2318e54125a9e76";
        };
        readonly "20P": {
            readonly hmsVersion: 202511162200;
            readonly errorVersion: 202511162200;
            readonly sha256: "e4f067d027b9bcbb9bbf6cb90f41f11130cf4d83dffd3dee101db7826dc808c3";
        };
        readonly "22E": {
            readonly hmsVersion: 202510142200;
            readonly errorVersion: 202510142200;
            readonly sha256: "87426021aea2bd4e8d721e46e1c86808fd7c6fc06f52baf6d952ead9e8d14d1e";
        };
        readonly "239": {
            readonly hmsVersion: 202506171403;
            readonly errorVersion: 202506171403;
            readonly sha256: "c1d23d5302756d57df5cb9bc795d95fc54ef1db7565dca1f04b69a024886426a";
        };
        readonly "31B": {
            readonly hmsVersion: 202511162200;
            readonly errorVersion: 202511162200;
            readonly sha256: "dcf63657bff5451f0715ea3c032efe482279bc8cbc28cb9b8ae51c7354826574";
        };
    };
};
export type HmsText = string | Readonly<Record<string, string>>;
/** device_hms: 16 hex digits, attr then code, as in Bambu's long error code. */
export declare const HMS_MESSAGES: Readonly<Record<string, HmsText>>;
/** device_error: the printer's print_error as 8 hex digits. */
export declare const PRINT_ERROR_MESSAGES: Readonly<Record<string, HmsText>>;
