/**
 * counterpart_discover_printers (counterpart/1): Bambu printers on the local network, from their own SSDP
 * announcements (NOTIFY on UDP 2021, and the answers to one M-SEARCH). Bounded and never failing: a port another app
 * holds (Bambu Studio) is "unavailable", not "none found". Never fetches a URL, connects to or authenticates with a printer.
 */
import { type Socket } from "node:dgram";
import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./schemas.js";
export type FoundPrinter = {
    kind: typeof PRINTER_KINDS[number];
    source: "ssdp" | "bonjour";
    name: string;
    host: string;
    port?: number;
    serial?: string;
    model?: string;
    firmware?: string;
};
export type Discovery = {
    contract: typeof COUNTERPART_CONTRACT;
    network: "complete" | "unavailable";
    printers: FoundPrinter[];
};
/** This server's model value (bambu_model) for a serial number's first three characters, when it has one. */
export declare function modelFromSerial(serial: string | undefined): string | undefined;
/** This server's model value for a DevModel id Bambu Studio's printer definitions use (C12 is the P1S). */
export declare function modelFromDevModel(id: string | undefined): string | undefined;
export declare function privateIPv4(value: string): boolean;
/** One SSDP packet from a Bambu printer. The sender must be the printer itself (Location equals its address). */
export declare function parseBambuAdvert(packet: Buffer, address: string): FoundPrinter | undefined;
/** A send completes before the next interface: dgram resolves addresses asynchronously even for IP literals. */
export declare function sendDiscoveryProbes(socket: Pick<Socket, "addMembership" | "setMulticastInterface" | "setMulticastTTL" | "send">, addresses: string[], active: () => boolean): Promise<void>;
/** Listens on UDP 2021 for `durationMs` (bounded 500–15000 ms). */
export declare function discoverBambu(durationMs?: number): Promise<{
    state: "complete" | "unavailable";
    printers: FoundPrinter[];
}>;
export declare const DISCOVER_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        network: {
            type: string;
            enum: string[];
        };
        printers: {
            type: string;
            items: {
                type: string;
                properties: {
                    kind: {
                        type: string;
                        enum: ("bambu" | "octoprint" | "klipper" | "prusa" | "duet" | "repetier" | "creality")[];
                    };
                    source: {
                        type: string;
                        enum: string[];
                    };
                    name: {
                        type: string;
                    };
                    host: {
                        type: string;
                    };
                    port: {
                        type: string;
                    };
                    serial: {
                        type: string;
                    };
                    model: {
                        type: string;
                    };
                    firmware: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
