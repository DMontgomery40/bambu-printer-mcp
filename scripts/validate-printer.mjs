#!/usr/bin/env node
/**
 * Validate HMS diagnostics, chamber light, and fan control against an idle
 * printer. Reads printer config from env vars matching the MCP server's
 * convention:
 *   BAMBU_PRINTER_HOST, BAMBU_PRINTER_SERIAL, BAMBU_PRINTER_ACCESS_TOKEN
 *
 * Usage:
 *   BAMBU_PRINTER_HOST=192.168.68.93 \
 *     BAMBU_PRINTER_SERIAL=0938AC5B0600334 \
 *     BAMBU_PRINTER_ACCESS_TOKEN=a0b9d3b2 \
 *     BAMBU_PRINTER_MODEL=H2S \
 *     node scripts/validate-printer.mjs
 *
 * Or with .env (not needed — passes env forward to spawned server).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(DIR, "..", "dist/index.js");

const host = process.env.BAMBU_PRINTER_HOST;
const serial = process.env.BAMBU_PRINTER_SERIAL;
const token = process.env.BAMBU_PRINTER_ACCESS_TOKEN;
const model = process.env.BAMBU_PRINTER_MODEL;

if (!host || !serial || !token) {
  console.error("Missing BAMBU_PRINTER_HOST, BAMBU_PRINTER_SERIAL, or BAMBU_PRINTER_ACCESS_TOKEN");
  process.exit(2);
}

console.log(`Target: ${model ?? "<no model>"} @ ${host} (${serial})`);
console.log("");

// ── Start the MCP server as a child process ────────────────────────────────
const server = spawn(process.execPath, [SERVER_ENTRY], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    MCP_TRANSPORT: "stdio",
  },
});

let reqId = 0;
let pendingResolve = null;
let pendingTimeout = null;
let buffer = "";

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  try {
    const parsed = JSON.parse(buffer);
    buffer = "";
    if (pendingResolve) {
      clearTimeout(pendingTimeout);
      pendingResolve(parsed);
      pendingResolve = null;
    }
  } catch {
    // incomplete JSON — wait for more data
  }
});

function send(method, params = {}) {
  const id = ++reqId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  server.stdin.write(msg);
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingTimeout = setTimeout(() => {
      pendingResolve = null;
      reject(new Error(`Request ${id} (${method}) timed out after 15s`));
    }, 15000);
  });
}

async function initialize() {
  const resp = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "validate-printer", version: "0.1.0" },
  });
  await send("notifications/initialized");
  return resp;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Run the validations ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log("✅");
    passed++;
  } catch (err) {
    console.log(`❌  ${err.message}`);
    failed++;
  }
}

try {
  console.log("1. Initialize MCP server connection");
  await initialize();
  console.log("   ✅ initialized\n");

  console.log("2. HMS Diagnostics Resource");
  const hmsUri = `printer://${host}/hms`;
  await runTest(`read ${hmsUri}`, async () => {
    const resp = await send("resources/read", { uri: hmsUri });
    const content = resp.result?.contents?.[0];
    if (!content) throw new Error(`No content in response: ${JSON.stringify(resp)}`);
    const data = typeof content.text === "string" ? JSON.parse(content.text) : content.text;
    if (typeof data !== "object") throw new Error(`Unexpected HMS data type: ${typeof data}`);
    // Check for expected fields — presence of hms array or status fields
    const hasState = "state" in data || "print_status" in data || "gcode_state" in data;
    const hasHms = data.hms != null;
    if (!hasState && !hasHms) {
      console.warn(`\n      ⚠  No expected fields found. Raw: ${JSON.stringify(data).slice(0, 300)}`);
    }
    console.log(`      state: ${data.gcode_state ?? data.print_status ?? data.state ?? "?"}`);
    console.log(`      hms_errors: ${Array.isArray(data.hms) ? data.hms.length : data.hms ?? 0}`);
  });

  console.log("\n3. Chamber Light Control");
  await runTest("set_light → on", async () => {
    const resp = await send("tools/call", {
      name: "set_light",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        light: "chamber_light",
        mode: "on",
      },
    });
    if (resp.error) throw new Error(`set_light(on) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  // Small pause for the light command to settle
  await sleep(500);

  await runTest("set_light → off", async () => {
    const resp = await send("tools/call", {
      name: "set_light",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        light: "chamber_light",
        mode: "off",
      },
    });
    if (resp.error) throw new Error(`set_light(off) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  console.log("\n4. Fan Control");
  await runTest("set_fan_speed → aux 30%", async () => {
    const resp = await send("tools/call", {
      name: "set_fan_speed",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        fan: "auxiliary",
        speed: 30,
      },
    });
    if (resp.error) throw new Error(`set_fan_speed(30) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  await sleep(500);

  await runTest("set_fan_speed → aux 0% (off)", async () => {
    const resp = await send("tools/call", {
      name: "set_fan_speed",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        fan: "auxiliary",
        speed: 0,
      },
    });
    if (resp.error) throw new Error(`set_fan_speed(0) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });
  console.log("\n5. Airduct Mode (H2/P2)");
  await runTest("set_airduct_mode → cooling", async () => {
    const resp = await send("tools/call", {
      name: "set_airduct_mode",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        mode: "cooling",
      },
    });
    if (resp.error) throw new Error(`airduct(cooling) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  await sleep(500);

  await runTest("set_airduct_mode → heating (restore)", async () => {
    const resp = await send("tools/call", {
      name: "set_airduct_mode",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        mode: "heating",
      },
    });
    if (resp.error) throw new Error(`airduct(heating) returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  console.log("\n6. HMS Errors — check + clear");
  await runTest("read HMS to find current errors", async () => {
    const resp = await send("resources/read", { uri: `printer://${host}/hms` });
    const content = resp.result?.contents?.[0];
    if (!content) throw new Error(`No content: ${JSON.stringify(resp)}`);
    const data = typeof content.text === "string" ? JSON.parse(content.text) : content.text;
    const hms = data.hms;
    const hasErrors = Array.isArray(hms) && hms.length > 0;
    console.log(`      hms_errors: ${Array.isArray(hms) ? hms.length : 0} ${hasErrors ? "(present)" : "(none)"}`);
    // Store whether errors exist for the next test
    if (hasErrors) console.log(`      first error: ${JSON.stringify(hms[0])}`);
  });

  await runTest("clear_hms_errors (safe call)", async () => {
    const resp = await send("tools/call", {
      name: "clear_hms_errors",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
      },
    });
    // Accept either success or "no errors to clear" — both are valid
    if (resp.error) {
      const msg = JSON.stringify(resp.error).toLowerCase();
      if (msg.includes("no error") || msg.includes("not found") || msg.includes("no hms")) {
        console.log(`      (no errors to clear — acceptable)`);
        return;
      }
      throw new Error(`clear_hms_errors returned error: ${JSON.stringify(resp.error)}`);
    }
    const result = resp.result?.content?.[0]?.text ?? "";
    console.log(`      response: ${result.slice(0, 200)}`);
  });

  console.log("\n7. get_printer_status (MQTT read-back)");
  await runTest("get_printer_status → basic fields", async () => {
    const resp = await send("tools/call", {
      name: "get_printer_status",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
      },
    });
    if (resp.error) throw new Error(`get_printer_status error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    if (!result) throw new Error("Empty response from get_printer_status");
    try {
      const data = JSON.parse(result);
      console.log(`      gcode_state: ${data.gcode_state ?? "?"}`);
      console.log(`      nozzle_temp: ${data.temperatures?.nozzle?.actual ?? "?"}°C (target ${data.temperatures?.nozzle?.target ?? "?"})`);
      console.log(`      bed_temp: ${data.temperatures?.bed?.actual ?? "?"}°C (target ${data.temperatures?.bed?.target ?? "?"})`);
      console.log(`      chamber_temp: ${data.temperatures?.chamber ?? "?"}°C`);
      console.log(`      print_progress: ${data.print?.progress ?? "N/A"}`);
      const amsUnitCount = Array.isArray(data.ams?.ams) ? data.ams.ams.length : 0;
      console.log(`      ams_units: ${amsUnitCount}`);
      if (amsUnitCount > 0) {
        const trayCount = data.ams.ams.reduce((sum, u) => sum + (Array.isArray(u.tray) ? u.tray.length : 0), 0);
        console.log(`      total_trays: ${trayCount}`);
      }
    } catch {
      console.log(`      (raw): ${result.slice(0, 200)}`);
    }
  });

  console.log("\n8. get_printer_filaments (AMS inventory)");
  await runTest("get_printer_filaments → loaded trays", async () => {
    const resp = await send("tools/call", {
      name: "get_printer_filaments",
      arguments: {
        host,
        bambu_serial: serial,
        bambu_token: token,
        bambu_model: model || "h2s",
      },
    });
    if (resp.error) throw new Error(`get_printer_filaments error: ${JSON.stringify(resp.error)}`);
    const result = resp.result?.content?.[0]?.text ?? "";
    if (!result) throw new Error("Empty response from get_printer_filaments");
    const data = JSON.parse(result);
    console.log(`      loaded_slots: ${data.summary?.loaded_slots ?? 0}`);
    console.log(`      resolved_profiles: ${data.summary?.resolved_profile_slots ?? 0}`);
    console.log(`      empty_slots: ${data.summary?.empty_slots ?? 0}`);
    console.log(`      current_slot: ${data.summary?.current_slot ?? "none"}`);
    if (Array.isArray(data.trays)) {
      for (const t of data.trays.slice(0, 4)) {
        console.log(`      tray slot=${t.slot} loaded=${t.loaded} type=${t.tray_type} profile=${t.resolved_base_profile_name ?? "?"}`);
      }
    }
    // Accept "no AMS" as a valid printer state (the printer may simply have
    // no AMS unit connected).
    if ((data.summary?.loaded_slots ?? 0) === 0 && (data.summary?.empty_slots ?? 0) === 0) {
      console.log(`      (no AMS data — printer may have no AMS unit connected)`);
    }
  });
} finally {
  server.stdin.end();
  server.kill();
}

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
process.exit(failed > 0 ? 1 : 0);
