#!/usr/bin/env node
/**
 * Raw byte dump of what the H2 chamber camera socket returns after the
 * A1/P1-style auth packet. No frame parsing, no JPEG validation. We just
 * connect TLS to <host>:6000, send the 80-byte auth, then print the first
 * N bytes the server replies with as a hex+ASCII dump.
 *
 * Goal: figure out the H2 frame header layout. Initial probe failed at
 * "got ff ff" after the presumed 16-byte header, so the actual layout is
 * different. Looking for: where does FF D8 (JPEG SOI) actually start, and
 * what's in the bytes before it.
 */

import tls from "node:tls";

const host = process.env.PRINTER_HOST;
const token = process.env.BAMBU_TOKEN;
const captureBytes = Number(process.env.CAPTURE_BYTES ?? 256);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 8000);

if (!host || !token) {
  console.error("Missing PRINTER_HOST or BAMBU_TOKEN env");
  process.exit(2);
}

const auth = Buffer.alloc(80, 0);
auth.writeUInt32LE(0x40, 0);
auth.writeUInt32LE(0x3000, 4);
auth.write("bblp", 16, 4, "ascii");
auth.write(token, 48, Math.min(32, Buffer.byteLength(token, "ascii")), "ascii");

console.log(`[raw] connecting ${host}:6000 with 80-byte A1/P1 auth packet, capture=${captureBytes} bytes, timeout=${timeoutMs}ms`);

const buffers = [];
let total = 0;
let settled = false;

const finish = (note) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket.destroy();
  const merged = Buffer.concat(buffers, total);
  const slice = merged.subarray(0, Math.min(captureBytes, merged.length));
  console.log(`[raw] captured ${slice.length} bytes total (${note ?? "ok"})`);

  // Hex+ASCII dump in 16-byte rows.
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    console.log(`${i.toString(16).padStart(4, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }

  // Try to find JPEG SOI inside the captured window.
  for (let i = 0; i < slice.length - 1; i++) {
    if (slice[i] === 0xff && slice[i + 1] === 0xd8) {
      console.log(`[raw] JPEG SOI (FF D8) found at offset 0x${i.toString(16)} (${i} bytes from start)`);
      break;
    }
  }

  // Also try to interpret possible header fields at common offsets.
  if (slice.length >= 24) {
    console.log(`[raw] uint32 LE at 0x00: ${slice.readUInt32LE(0)} (expected payload size)`);
    console.log(`[raw] uint32 LE at 0x04: ${slice.readUInt32LE(4)}`);
    console.log(`[raw] uint32 LE at 0x08: ${slice.readUInt32LE(8)}`);
    console.log(`[raw] uint32 LE at 0x0c: ${slice.readUInt32LE(12)}`);
    console.log(`[raw] uint32 LE at 0x10: ${slice.readUInt32LE(16)}`);
    console.log(`[raw] uint32 LE at 0x14: ${slice.readUInt32LE(20)}`);
  }

  process.exit(0);
};

const timer = setTimeout(() => finish(`timeout after ${timeoutMs}ms`), timeoutMs);

const socket = tls.connect(
  { host, port: 6000, rejectUnauthorized: false },
  () => {
    socket.write(auth);
  }
);

socket.on("data", (chunk) => {
  buffers.push(chunk);
  total += chunk.length;
  if (total >= captureBytes) finish("captured target byte count");
});

socket.on("error", (err) => {
  console.error(`[raw] socket error: ${err.message}`);
  finish(`error: ${err.message}`);
});

socket.on("end", () => finish("server closed connection"));
