#!/usr/bin/env node
/**
 * A stand-in for FULU's pjarczak_bambu_linux_host that speaks the same framed
 * stdin/stdout protocol and reproduces behaviour observed with the real v1.0.0
 * host, plug-in 02.05.02.58 and a P1S (2026-10-25):
 * - FAKE_FULU_EXIT_CODE exits at once (101 is the real host's socket-stdout failure);
 * - without PJARCZAK_BAMBU_PLUGIN_DIR the handshake reports "file open failed";
 * - connect_printer/disconnect_printer before set_cert_file crash the host;
 * - a LAN connection fails (status 1, "-1") unless the certificate folder has printer.cer;
 * - start_local_print uploads but returns -4030 ("send msg failed") until the
 *   device certificate is installed after the printer connected.
 * Every request is appended to FAKE_FULU_LOG as JSON, without passwords.
 */
import fs from "node:fs";
import path from "node:path";

// The real host exits 101 after its startup probe, so the first request is already written.
if (process.env.FAKE_FULU_EXIT_CODE) process.stdin.once("data", () => process.exit(Number(process.env.FAKE_FULU_EXIT_CODE)));

const MAGIC = 0x52424a50;
const log = entry => { if (process.env.FAKE_FULU_LOG) fs.appendFileSync(process.env.FAKE_FULU_LOG, `${JSON.stringify(entry)}\n`); };
log({ start: true, env: Object.fromEntries(["PJARCZAK_BAMBU_PLUGIN_DIR", "PJARCZAK_BAMBU_NETWORK_SO", "PJARCZAK_BAMBU_SOURCE_SO"].map(name => [name, process.env[name] ?? null])) });

const state = { certFolder: undefined, connected: false, certInstalled: false, events: [], publishFailures: Number(process.env.FAKE_FULU_PUBLISH_FAILURES ?? 0) };
const crash = () => { process.stderr.write("Segmentation fault (core dumped)\n"); process.exit(139); };
const queue = (name, payload) => state.events.push({ agent: 1, name, payload });

function handle(method, payload) {
  const ok = (value = 0, extra = {}) => ({ ok: true, value, ...extra });
  switch (method) {
    case "bridge.handshake": {
      const loaded = Boolean(process.env.PJARCZAK_BAMBU_PLUGIN_DIR || process.env.PJARCZAK_BAMBU_NETWORK_SO);
      return { ok: true, network_loaded: loaded, network_status: loaded ? "loaded" : "validate failed: file open failed", bridge_version: "FAKE" };
    }
    case "net.create_agent": return ok(1);
    case "net.set_cert_file":
      state.certFolder = payload.folder;
      return ok();
    case "bridge.poll_events": {
      const events = state.events.splice(0, payload.limit ?? 64);
      return { ok: true, events };
    }
    case "net.connect_printer": {
      if (!state.certFolder) crash();
      const trusted = fs.existsSync(path.join(state.certFolder, "printer.cer"));
      const status = trusted ? Number(process.env.FAKE_FULU_CONNECT_STATUS ?? 0) : 1;
      state.connected = status === 0;
      state.certInstalled = false;
      setTimeout(() => queue("on_local_connect", { dev_id: payload.dev_id, status, msg: status === 0 ? "ssl:" : "-1" }), 20);
      return ok();
    }
    case "net.disconnect_printer":
      if (!state.certFolder) crash();
      state.connected = false;
      return ok();
    case "net.install_device_cert":
      if (state.connected) state.certInstalled = true;
      return ok();
    case "net.start_local_print": {
      const jobId = payload.client_job_id;
      queue("job.update_status", { job_id: jobId, status: 1, code: 100, msg: "0.0M/0.0M" });
      const publish = state.connected && state.certInstalled && state.publishFailures-- <= 0;
      if (!publish) queue("job.update_status", { job_id: jobId, status: 3, code: -4030, msg: "send msg failed" });
      return ok(publish ? 0 : -4030, { job_id: jobId });
    }
    default:
      return ok();
  }
}

let buffer = Buffer.alloc(0);
if (!process.env.FAKE_FULU_EXIT_CODE) process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 16 && buffer.length >= 16 + buffer.readUInt32LE(12)) {
    if (buffer.readUInt32LE(0) !== MAGIC) process.exit(2);
    const id = buffer.readUInt32LE(8);
    const size = buffer.readUInt32LE(12);
    const { method, payload = {} } = JSON.parse(buffer.subarray(16, 16 + size).toString("utf8"));
    buffer = buffer.subarray(16 + size);
    const logged = { ...payload, ...(payload.password ? { password: "[redacted]" } : {}) };
    if (logged.params?.password) logged.params = { ...logged.params, password: "[redacted]" };
    log({ method, payload: logged });
    const body = Buffer.from(JSON.stringify(handle(method, payload)));
    const frame = Buffer.alloc(16 + body.length);
    frame.writeUInt32LE(MAGIC, 0);
    frame.writeUInt32LE(2, 4);
    frame.writeUInt32LE(id, 8);
    frame.writeUInt32LE(body.length, 12);
    body.copy(frame, 16);
    process.stdout.write(frame);
  }
});
process.stdin.on("end", () => process.exit(0));
