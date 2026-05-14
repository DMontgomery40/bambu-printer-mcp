#!/usr/bin/env node
/**
 * One-shot probe of the H2 chamber camera via the MCP camera_snapshot tool
 * with experimental:true. Spawns the MCP server in stdio mode, calls the
 * tool, and prints the structured result (or error) plus what landed on
 * disk if a save_path was provided.
 *
 * Usage:
 *   PRINTER_HOST=192.168.68.93 \
 *   BAMBU_SERIAL=0938AC5B0600334 \
 *   BAMBU_TOKEN=<8-digit access code> \
 *   BAMBU_MODEL=h2s \
 *   node scripts/probe-h2-camera.mjs [--save /tmp/parker-probe.jpg] [--timeout 12000]
 *
 * Read-only: this never writes to the printer. Worst case is a clean error.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

function parseArgs() {
  const out = { save: undefined, timeout: 12000 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--save") out.save = argv[++i];
    else if (argv[i] === "--timeout") out.timeout = Number(argv[++i]);
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const required = ["PRINTER_HOST", "BAMBU_SERIAL", "BAMBU_TOKEN", "BAMBU_MODEL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, MCP_TRANSPORT: "stdio" },
    stderr: "pipe",
  });

  const client = new Client({ name: "h2-camera-probe", version: "0.0.1" });
  await client.connect(transport);

  const callArgs = {
    bambu_model: process.env.BAMBU_MODEL,
    experimental: true,
    timeout_ms: args.timeout,
  };
  if (args.save) callArgs.save_path = args.save;

  console.log(`[probe] calling camera_snapshot with`, {
    ...callArgs,
    host: process.env.PRINTER_HOST,
  });

  const t0 = Date.now();
  let result;
  try {
    result = await client.callTool({ name: "camera_snapshot", arguments: callArgs });
  } catch (err) {
    console.error(`[probe] tool call threw: ${err?.message ?? err}`);
    await transport.close();
    process.exit(1);
  }
  const dt = Date.now() - t0;

  await transport.close();

  console.log(`[probe] returned in ${dt}ms; isError=${result.isError ?? false}`);
  for (const c of result.content ?? []) {
    if (c.type === "text") {
      // Truncate base64 in display; print metadata.
      try {
        const parsed = JSON.parse(c.text);
        if (parsed.base64) parsed.base64 = `<${parsed.base64.length} base64 chars>`;
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(c.text);
      }
    } else {
      console.log("[non-text content]", JSON.stringify(c, null, 2));
    }
  }

  if (args.save) {
    if (fs.existsSync(args.save)) {
      const stat = fs.statSync(args.save);
      const head = fs.readFileSync(args.save, { encoding: null }).slice(0, 4);
      const isJpeg = head[0] === 0xff && head[1] === 0xd8;
      console.log(`[probe] saved file: ${args.save} size=${stat.size} bytes, JPEG SOI=${isJpeg}`);
    } else {
      console.log(`[probe] no file at ${args.save} (tool likely errored before write)`);
    }
  }

  process.exit(result.isError ? 1 : 0);
}

main().catch((err) => {
  console.error(`[probe] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
