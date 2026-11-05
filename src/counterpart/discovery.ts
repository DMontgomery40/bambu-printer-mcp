/**
 * counterpart_discover_printers (counterpart/1): Bambu printers on the local network, from their own SSDP
 * announcements (NOTIFY on UDP 2021, and the answers to one M-SEARCH). Bounded and never failing: a port another app
 * holds (Bambu Studio) is "unavailable", not "none found". Never fetches a URL, connects to or authenticates with a printer.
 */
import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { normalizeModel } from "../safety/limits.js";
import { MODEL_IDS, SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./schemas.js";

export type FoundPrinter = {
  kind: typeof PRINTER_KINDS[number]; source: "ssdp" | "bonjour"; name: string; host: string;
  port?: number; serial?: string; model?: string; firmware?: string;
};
export type Discovery = { contract: typeof COUNTERPART_CONTRACT; network: "complete" | "unavailable"; printers: FoundPrinter[] };

/** This server's model value (bambu_model) for a serial number's first three characters, when it has one. */
export function modelFromSerial(serial: string | undefined): string | undefined {
  return serial ? normalizeModel(SERIAL_MODELS[serial.trim().slice(0, 3).toUpperCase()] ?? "") : undefined;
}
/**
 * DevModel ids Bambu Studio's machine definitions (profiles/BBL/machine/*.json `model_id`) use that the safety identity
 * table doesn't list, for naming a found printer only. Never identity evidence for a print.
 */
const ANNOUNCED_MODEL_IDS: Record<string, string> = { N1: "A1 Mini", N7: "P2S" };
/** This server's model value for a DevModel id Bambu Studio's printer definitions use (C12 is the P1S). */
export function modelFromDevModel(id: string | undefined): string | undefined {
  const key = id?.trim().toUpperCase();
  return key ? normalizeModel(MODEL_IDS[key] ?? ANNOUNCED_MODEL_IDS[key] ?? "") : undefined;
}

export function privateIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split(".").map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** One SSDP packet from a Bambu printer. The sender must be the printer itself (Location equals its address). */
export function parseBambuAdvert(packet: Buffer, address: string): FoundPrinter | undefined {
  if (packet.length > 8192 || !privateIPv4(address)) return undefined;
  const lines = packet.toString("utf8").split("\r\n");
  if (!["NOTIFY * HTTP/1.1", "HTTP/1.1 200 OK"].includes(lines.shift() ?? "")) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 1) return undefined;
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
    if (headers.has(key) || /[\x00-\x1f\x7f]/.test(value)) return undefined;
    headers.set(key, value);
  }
  if (headers.get("location") !== address) return undefined;
  const serial = headers.get("usn"), devModel = headers.get("devmodel.bambu.com");
  if (!serial || !/^[A-Za-z0-9]{1,64}$/.test(serial) || !devModel || devModel.length > 64) return undefined;
  const firmware = headers.get("devversion.bambu.com");
  const model = modelFromDevModel(devModel) ?? modelFromSerial(serial);
  return { kind: "bambu", source: "ssdp", host: address, serial: serial.toUpperCase(), ...(model ? { model } : {}),
    name: (headers.get("devname.bambu.com") || devModel).slice(0, 128),
    ...(firmware && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware) ? { firmware } : {}) };
}

/** A send completes before the next interface: dgram resolves addresses asynchronously even for IP literals. */
export async function sendDiscoveryProbes(socket: Pick<Socket, "addMembership" | "setMulticastInterface" | "setMulticastTTL" | "send">, addresses: string[], active: () => boolean) {
  for (const address of addresses) {
    if (!active()) return;
    try {
      socket.addMembership("239.255.255.250", address);
      socket.setMulticastInterface(address); socket.setMulticastTTL(1);
      await new Promise<void>((resolve, reject) => socket.send("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n",
        2021, "239.255.255.250", error => error ? reject(error) : resolve()));
    } catch { /* Other interfaces can still answer. */ }
  }
}

/** Listens on UDP 2021 for `durationMs` (bounded 500–15000 ms). */
export function discoverBambu(durationMs = 4000): Promise<{ state: "complete" | "unavailable"; printers: FoundPrinter[] }> {
  const ms = Number.isFinite(durationMs) ? Math.max(500, Math.min(15_000, Math.round(durationMs))) : 4000;
  return new Promise(resolve => {
    const socket = createSocket({ type: "udp4", reuseAddr: true }), found = new Map<string, FoundPrinter>();
    let finished = false;
    const finish = (state: "complete" | "unavailable") => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket.close(); } catch { /* not bound yet */ }
      resolve({ state, printers: [...found.values()].sort((a, b) => (a.serial ?? "").localeCompare(b.serial ?? "")) });
    };
    const timer = setTimeout(() => finish("complete"), ms);
    socket.on("error", () => finish("unavailable"));
    socket.on("message", (data, peer) => { const value = parseBambuAdvert(data, peer.address); if (value && found.size < 64) found.set(`${value.serial}@${value.host}`, value); });
    try {
      socket.bind(2021, "0.0.0.0", () => {
        const interfaces = Object.values(networkInterfaces()).flat().filter(nic => nic && !nic.internal && nic.family === "IPv4" && privateIPv4(nic.address));
        void sendDiscoveryProbes(socket, interfaces.map(nic => nic!.address), () => !finished);
      });
    } catch { finish("unavailable"); }
  });
}

export const DISCOVER_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    network: { type: "string", enum: ["complete", "unavailable"] },
    printers: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: [...PRINTER_KINDS] }, source: { type: "string", enum: ["ssdp", "bonjour"] }, name: { type: "string" },
      host: { type: "string" }, port: { type: "integer" }, serial: { type: "string" }, model: { type: "string" }, firmware: { type: "string" },
    }, required: ["kind", "source", "name", "host"] } },
  },
  required: ["contract", "network", "printers"],
};
