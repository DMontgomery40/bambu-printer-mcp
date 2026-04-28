#!/usr/bin/env node
/**
 * Dispatch a pre-sliced .gcode.3mf to a Bambu printer via the MCP's
 * print_3mf tool. Spawns the MCP server in stdio mode using the
 * BAMBU_PRINTER_* env vars and calls the tool.
 *
 * Usage:
 *   PRINTER_HOST=192.168.x.y \
 *   BAMBU_SERIAL=... \
 *   BAMBU_TOKEN=... \
 *   BAMBU_MODEL=h2d \
 *   node scripts/print-on-printer.mjs \
 *     --file /path/to/sliced.gcode.3mf \
 *     [--bed textured_plate] \
 *     [--auto-match-ams | --ams-slots 0,1] \
 *     [--no-confirm]
 *
 * Without --no-confirm, prints the dispatch summary and waits for
 * Enter before sending. This actually starts a print, so the
 * confirmation gate is on by default.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

function parseArgs() {
  const out = {
    file: null,
    bed: "textured_plate",
    autoMatch: false,
    amsSlots: null,
    confirm: true,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--bed") out.bed = argv[++i];
    else if (a === "--auto-match-ams") out.autoMatch = true;
    else if (a === "--ams-slots") out.amsSlots = argv[++i].split(",").map((n) => Number(n));
    else if (a === "--no-confirm") out.confirm = false;
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!out.file) { console.error("Missing --file"); process.exit(2); }
  return out;
}

async function main() {
  const args = parseArgs();
  const required = ["PRINTER_HOST", "BAMBU_SERIAL", "BAMBU_TOKEN", "BAMBU_MODEL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing env: ${missing.join(", ")}`); process.exit(2); }

  const callArgs = {
    three_mf_path: args.file,
    bambu_model: process.env.BAMBU_MODEL,
    bed_type: args.bed,
    bed_leveling: true,
    flow_calibration: true,
    vibration_calibration: true,
    timelapse: false,
    use_ams: true,
  };
  if (args.autoMatch) callArgs.auto_match_ams = true;
  if (args.amsSlots) callArgs.ams_slots = args.amsSlots;

  console.log("[dispatch] target printer:", process.env.PRINTER_HOST, `(${process.env.BAMBU_MODEL})`);
  console.log("[dispatch] file:", args.file);
  console.log("[dispatch] tool args:", { ...callArgs, three_mf_path: path.basename(args.file) });

  if (args.confirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question("[dispatch] proceed? [y/N] ", resolve));
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("[dispatch] aborted");
      process.exit(0);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, MCP_TRANSPORT: "stdio" },
    stderr: "pipe",
  });

  const client = new Client({ name: "print-on-printer", version: "0.0.1" });
  await client.connect(transport);

  const t0 = Date.now();
  const result = await client.callTool({ name: "print_3mf", arguments: callArgs });
  const dt = Date.now() - t0;
  await transport.close();

  console.log(`[dispatch] returned in ${dt}ms; isError=${result.isError ?? false}`);
  for (const c of result.content ?? []) {
    if (c.type === "text") {
      try { console.log(JSON.stringify(JSON.parse(c.text), null, 2)); }
      catch { console.log(c.text); }
    }
  }
  process.exit(result.isError ? 1 : 0);
}

main().catch((err) => {
  console.error(`[dispatch] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
