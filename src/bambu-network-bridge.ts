import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BAMBU_NETWORK_CERTIFICATES } from "./bambu-network-certs.js";

const FRAME_MAGIC = 0x52424a50;
const FRAME_HEADER_SIZE = 16;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_BINARY_DATA = 3;
const FRAME_TYPE_LOG = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
// bambu_networking.hpp ConnectStatus.
const LOCAL_CONNECT_STATUS = ["ok", "failed", "lost"];
// bambu_networking.hpp BAMBU_NETWORK_ERR_PRINT_LP_PUBLISH_MSG_FAILED.
const LOCAL_PRINT_PUBLISH_FAILED = -4030;
/** Waits from native/bambu-native-print.cpp, which prints through the same plug-in calls. */
export const LOCAL_PRINT_TIMING = Object.freeze({ connectTimeoutMs: 30_000, pollMs: 250, settleMs: 3_000, retryWaitMs: 8_000 });

export type LocalPrinter = { devId: string; devIp: string; username: string; password: string; useSsl: boolean };
export type BridgeJobUpdate = { status: unknown; code: unknown; msg: unknown };
export type LocalSession = { installCertificate: () => Promise<void>; settle: (ms: number) => Promise<void>; jobUpdates: BridgeJobUpdate[] };

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BambuNetworkBridgeOptions = {
  bridgeCommand?: string;
  configDir?: string;
  countryCode?: string;
  userInfo?: string;
  timeoutMs?: number;
  /** Trusted in-process preflight; never populated from tool arguments. */
  beforeDispatch?: (method: string) => Promise<void>;
  assertDispatchAllowed?: (method: string) => void;
  onDispatched?: (method: string) => void;
};

export type BambuNetworkBridgeStatus = {
  configured: boolean;
  command: string;
  platform: NodeJS.Platform;
  running: boolean;
  pid?: number;
  configDir: string;
  countryCode: string;
  agentReady: boolean;
  lastStderr: string;
  recentLogs: string[];
  runtime: {
    /** Folder passed to the plug-in's set_cert_file. */
    certDir: string;
    /** Linux only: absolute plug-in library paths passed to FULU's host. */
    pluginLibraries?: Record<string, string>;
    /** macOS only: conventional FULU runtime discovery. */
    macosRuntimeDir?: string;
    macosRuntimeDirExists?: boolean;
    macosPluginDir?: string;
    macosPluginDirExists?: boolean;
    macosMissingRuntimeFiles?: string[];
    macosMissingPluginFiles?: string[];
    suggestedMacCommand?: string;
  };
  note?: string;
};

/**
 * The plug-in's certificate folder: BAMBU_NETWORK_CERT_DIR when set, else
 * Bambu's pinned public certificates written to the agent's config folder,
 * which the host must already be able to read.
 */
export function bambuNetworkCertDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return trimEnv(env.BAMBU_NETWORK_CERT_DIR) || path.join(configDir, "cert");
}

export function prepareBambuNetworkCertDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const certDir = bambuNetworkCertDir(configDir, env);
  if (trimEnv(env.BAMBU_NETWORK_CERT_DIR)) return certDir;
  fs.mkdirSync(certDir, { recursive: true });
  for (const [name, { sha256, base64 }] of Object.entries(BAMBU_NETWORK_CERTIFICATES)) {
    const content = Buffer.from(base64, "base64");
    if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error(`Bundled Bambu certificate ${name} does not match its pinned SHA-256.`);
    const target = path.join(certDir, name);
    if (!fileExists(target) || !fs.readFileSync(target).equals(content)) fs.writeFileSync(target, content);
  }
  return certDir;
}

export function defaultBambuNetworkConfigDir(): string {
  return path.join(os.homedir(), ".config", "bambu-printer-mcp", "bambu-network");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveFirstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fileExists(candidate) && fs.statSync(candidate).isDirectory());
}

function resolveFirstDirectoryWithFile(candidates: string[], requiredFile: string): string | undefined {
  return candidates.find(
    (candidate) =>
      fileExists(candidate) &&
      fs.statSync(candidate).isDirectory() &&
      fileExists(path.join(candidate, requiredFile))
  );
}

function collectMissingFiles(baseDir: string | undefined, files: string[]): string[] {
  if (!baseDir) return files;
  return files.filter((file) => !fileExists(path.join(baseDir, file)));
}

/**
 * FULU's Linux host opens its network and source libraries by bare name from
 * its working directory instead of PJARCZAK_BAMBU_PLUGIN_DIR
 * (FULU-Foundation/OrcaSlicer-bambulab#51), so name them in that directory
 * unless they are already set. macOS wrappers run the host in a Linux guest
 * that may not see host paths, so they are left alone.
 */
export function linuxPluginLibraryEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const pluginDir = trimEnv(env.PJARCZAK_BAMBU_PLUGIN_DIR);
  if (platform !== "linux" || !pluginDir) return {};
  const libraries: Record<string, string> = {};
  if (!trimEnv(env.PJARCZAK_BAMBU_NETWORK_SO)) libraries.PJARCZAK_BAMBU_NETWORK_SO = path.resolve(pluginDir, "libbambu_networking.so");
  if (!trimEnv(env.PJARCZAK_BAMBU_SOURCE_SO)) libraries.PJARCZAK_BAMBU_SOURCE_SO = path.resolve(pluginDir, "libBambuSource.so");
  return libraries;
}

/** FULU's Linux host exits 101 when it cannot reopen a socket stdout (FULU-Foundation/OrcaSlicer-bambulab#50). */
const STDOUT_SOCKET_HINT =
  "Exit code 101 means FULU's Linux host could not reopen its stdout, which fails when stdout is a socket, as Node.js provides " +
  "(https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50). Launch the host through a wrapper that pipes its output through cat: " +
  "https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#linux";

/** Conventional FULU macOS runtime locations; the wrapper command is suggested only when it exists. */
function macosRuntimeHints(): Partial<BambuNetworkBridgeStatus["runtime"]> {
  const macosRuntimeDir =
    trimEnv(process.env.PJARCZAK_MAC_RUNTIME_DIR) ||
    path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "macos-bridge", "runtime");
  const macosPluginDir =
    trimEnv(process.env.BAMBU_NETWORK_PLUGIN_DIR) ||
    trimEnv(process.env.PJARCZAK_BAMBU_PLUGIN_DIR) ||
    resolveFirstDirectoryWithFile([
      path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "plugins"),
      "/Applications/Orca Studio.app/Contents/MacOS",
      "/Applications/OrcaSlicer.app/Contents/MacOS",
      "/Applications/OrcaSlicer-BMCU.app/Contents/MacOS",
      "/Applications/Orca Studio.app/Contents/Resources",
      "/Applications/OrcaSlicer.app/Contents/Resources",
      "/Applications/OrcaSlicer-BMCU.app/Contents/Resources",
      macosRuntimeDir,
    ], "pjarczak-bambu-linux-host-wrapper") ||
    resolveFirstExistingDirectory([macosRuntimeDir]);
  const runtimeRequiredFiles = [
    "libbambu_networking.so",
    "libBambuSource.so",
    "pjarczak_bambu_linux_host",
    "pjarczak_bambu_linux_host_abi1",
    "pjarczak_bambu_linux_host_abi0",
    "ca-certificates.crt",
    "slicer_base64.cer",
  ];
  const pluginRequiredFiles = [
    "pjarczak-bambu-linux-host-wrapper",
    "install_runtime_macos.sh",
    "verify_runtime_macos.sh",
  ];
  const wrapper = macosPluginDir ? path.join(macosPluginDir, "pjarczak-bambu-linux-host-wrapper") : undefined;
  return {
    macosRuntimeDir,
    macosRuntimeDirExists: fileExists(macosRuntimeDir),
    macosPluginDir,
    macosPluginDirExists: macosPluginDir ? fileExists(macosPluginDir) : undefined,
    macosMissingRuntimeFiles: collectMissingFiles(macosRuntimeDir, runtimeRequiredFiles),
    macosMissingPluginFiles: collectMissingFiles(macosPluginDir, pluginRequiredFiles),
    suggestedMacCommand: wrapper && fileExists(wrapper)
      ? `PJARCZAK_BAMBU_PLUGIN_DIR=${shellQuote(macosRuntimeDir)} ${shellQuote(wrapper)} ${shellQuote(path.join(macosRuntimeDir, "pjarczak_bambu_linux_host"))}`
      : undefined,
  };
}

function readFrameJson(payload: Buffer): unknown {
  const text = payload.toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

function isBridgeFailure(value: unknown): value is { ok: false; error?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

function bridgeValueAsNumber(value: unknown, method: string): number {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { value?: unknown }).value === "number"
  ) {
    return (value as { value: number }).value;
  }

  throw new Error(`FULU BambuNetwork bridge method ${method} did not return a numeric value.`);
}

function bridgeNumericResult(value: unknown): number | undefined {
  return typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "number"
    ? (value as { value: number }).value
    : undefined;
}

function assertBridgeOk(value: unknown, method: string): void {
  if (isBridgeFailure(value)) {
    const errorText = value.error === undefined ? "unknown bridge error" : String(value.error);
    throw new Error(`FULU BambuNetwork bridge method ${method} failed: ${errorText}`);
  }
}

export class BambuNetworkBridge {
  private child?: ChildProcessWithoutNullStreams;
  private commandLine?: string;
  private stdoutBuffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private agentId?: number;
  private agentKey?: string;
  private handshake?: unknown;
  private lastStderr = "";
  private recentLogs: string[] = [];
  private inferredExpectedNetworkVersion?: string;

  resolveBridgeCommand(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_BRIDGE_COMMAND) ||
      trimEnv(process.env.FULU_BAMBU_NETWORK_BRIDGE_COMMAND) ||
      trimEnv(process.env.PJARCZAK_BAMBU_BRIDGE_COMMAND) ||
      ""
    );
  }

  resolveConfigDir(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_CONFIG_DIR) ||
      trimEnv(process.env.PJARCZAK_BAMBU_PROBE_LOG_DIR) ||
      defaultBambuNetworkConfigDir()
    );
  }

  resolveCountryCode(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_COUNTRY_CODE) ||
      trimEnv(process.env.PJARCZAK_BAMBU_COUNTRY_CODE) ||
      "US"
    );
  }

  getStatus(options: BambuNetworkBridgeOptions = {}): BambuNetworkBridgeStatus {
    const command = this.resolveBridgeCommand(options.bridgeCommand);
    const configDir = this.resolveConfigDir(options.configDir);
    const countryCode = this.resolveCountryCode(options.countryCode);

    const runtime: BambuNetworkBridgeStatus["runtime"] = { certDir: bambuNetworkCertDir(configDir) };
    if (process.platform === "linux") {
      const pluginLibraries = {
        ...Object.fromEntries(["PJARCZAK_BAMBU_NETWORK_SO", "PJARCZAK_BAMBU_SOURCE_SO"].flatMap(name => {
          const value = trimEnv(process.env[name]);
          return value ? [[name, value]] : [];
        })),
        ...linuxPluginLibraryEnv(process.env, process.platform),
      };
      if (Object.keys(pluginLibraries).length) runtime.pluginLibraries = pluginLibraries;
    }
    if (process.platform === "darwin") Object.assign(runtime, macosRuntimeHints());

    return {
      configured: command.length > 0,
      command,
      platform: process.platform,
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid,
      configDir,
      countryCode,
      agentReady: this.agentId !== undefined,
      lastStderr: this.lastStderr,
      recentLogs: this.recentLogs.slice(-10),
      runtime,
      note: command
        ? undefined
        : "Set BAMBU_NETWORK_BRIDGE_COMMAND to the FULU OrcaSlicer-bambulab Linux host or macOS/WSL wrapper command.",
    };
  }

  async request(method: string, payload: JsonObject = {}, options: BambuNetworkBridgeOptions = {}): Promise<unknown> {
    if (!method.trim()) {
      throw new Error("BambuNetwork bridge method is required.");
    }

    await this.ensureStarted(options.bridgeCommand);
    await options.beforeDispatch?.(method);

    const id = this.nextRequestId++;
    const requestPayload = Buffer.from(JSON.stringify({ method, payload }), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER_SIZE + requestPayload.length);
    frame.writeUInt32LE(FRAME_MAGIC, 0);
    frame.writeUInt32LE(FRAME_TYPE_JSON_REQUEST, 4);
    frame.writeUInt32LE(id, 8);
    frame.writeUInt32LE(requestPayload.length, 12);
    requestPayload.copy(frame, FRAME_HEADER_SIZE);

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for FULU BambuNetwork bridge method ${method}.`));
      }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        options.assertDispatchAllowed?.(method);
        this.child!.stdin.write(frame, (error) => {
          if (error) {
            const pending = this.pending.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(id);
              pending.reject(error);
            }
          }
        });
        options.onDispatched?.(method);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async ensureAgent(options: BambuNetworkBridgeOptions = {}): Promise<{
    agent: number;
    handshake: unknown;
  }> {
    const command = this.resolveBridgeCommand(options.bridgeCommand);
    const configDir = this.resolveConfigDir(options.configDir);
    const countryCode = this.resolveCountryCode(options.countryCode);
    const userInfo = trimEnv(options.userInfo) || trimEnv(process.env.BAMBU_NETWORK_USER_INFO) || "";
    const certDir = bambuNetworkCertDir(configDir);
    const key = `${command}\n${configDir}\n${countryCode}\n${userInfo}\n${certDir}`;

    if (this.agentId !== undefined && this.agentKey === key) {
      return { agent: this.agentId, handshake: this.handshake };
    }

    fs.mkdirSync(configDir, { recursive: true });
    prepareBambuNetworkCertDir(configDir);

    this.handshake = await this.request("bridge.handshake", {}, options);
    assertBridgeOk(this.handshake, "bridge.handshake");
    if (this.needsExpectedVersionRetry(this.handshake) && !trimEnv(process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION)) {
      this.inferredExpectedNetworkVersion = this.handshake.network_actual_abi_version;
      await this.stop();
      this.handshake = await this.request("bridge.handshake", {}, options);
      assertBridgeOk(this.handshake, "bridge.handshake");
    }
    const loaded = this.handshake as { network_loaded?: unknown; network_status?: unknown } | undefined;
    if (loaded?.network_loaded === false && typeof loaded.network_status === "string" && /file open failed/i.test(loaded.network_status)) {
      throw new Error(
        `FULU BambuNetwork bridge could not open its networking library (${loaded.network_status}). ` +
        "Set PJARCZAK_BAMBU_PLUGIN_DIR to the directory containing libbambu_networking.so and libBambuSource.so, " +
        "or set PJARCZAK_BAMBU_NETWORK_SO and PJARCZAK_BAMBU_SOURCE_SO to their absolute paths: " +
        "https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#linux"
      );
    }

    const created = await this.request("net.create_agent", { log_dir: configDir, country_code: countryCode }, options);
    assertBridgeOk(created, "net.create_agent");
    const agent = bridgeValueAsNumber(created, "net.create_agent");

    const withAgent = async (method: string, payload: JsonObject = {}, hardFail = true): Promise<unknown> => {
      const response = await this.request(method, { ...payload, agent }, options);
      if (hardFail) assertBridgeOk(response, method);
      return response;
    };

    await withAgent("net.set_config_dir", { config_dir: configDir });
    await withAgent("net.init_log");
    // Bambu Studio and FULU's GUI set this before starting the agent. The
    // plug-in verifies a LAN printer with printer.cer from this folder, and
    // FULU's host crashes on connect_printer when no folder was ever set.
    await withAgent("net.set_cert_file", { folder: certDir, filename: "slicer_base64.cer" });
    await withAgent("net.set_country_code", { country_code: countryCode });
    await withAgent("net.start");
    // The plug-in runs callbacks through queue_on_main; FULU's host executes
    // them on its own dispatcher and queues on_local_connect for poll_events.
    await withAgent("net.set_queue_on_main_fn");
    await withAgent("net.set_on_local_connect_fn");
    await withAgent("net.connect_server", {}, false);

    if (userInfo) {
      await withAgent("net.change_user", { user_info: userInfo });
    }

    this.agentId = agent;
    this.agentKey = key;
    return { agent, handshake: this.handshake };
  }

  /**
   * Open the plug-in's own LAN MQTT session with a printer, in the order Bambu
   * Studio and native/bambu-native-print.cpp use: connect, install the
   * printer's application certificate (again on each "wait_info"), wait for
   * the local connection, request the printer's state and let the key
   * exchange settle. Without the certificate the plug-in uploads a job but
   * cannot encrypt or publish project_file (-4030). The session is closed
   * after `run`, so printer reports stop accumulating in the host's queue.
   */
  async withLocalSession<T>(
    printer: LocalPrinter,
    options: BambuNetworkBridgeOptions,
    assertActive: () => void,
    timing: typeof LOCAL_PRINT_TIMING,
    run: (session: LocalSession) => Promise<T>
  ): Promise<T> {
    const jobUpdates: BridgeJobUpdate[] = [];
    const installCertificate = async () => {
      await this.callWithAgent("net.install_device_cert", { dev_id: printer.devId, lan_only: true }, options);
      await this.callWithAgent("net.update_cert", {}, options);
    };
    // Drain queued events: collect job reports, return this printer's
    // local-connect statuses, and reinstall the certificate on "wait_info".
    const pump = async (): Promise<unknown[]> => {
      const polled = await this.request("bridge.poll_events", { limit: 1024 }, options) as { events?: unknown };
      assertBridgeOk(polled, "bridge.poll_events");
      const statuses: unknown[] = [];
      let waitInfo = false;
      for (const event of Array.isArray(polled?.events) ? polled.events : []) {
        if (event?.name === "job.update_status") jobUpdates.push({ status: event.payload?.status, code: event.payload?.code, msg: event.payload?.msg });
        const eventDev = event?.payload?.dev_id;
        if (eventDev !== undefined && eventDev !== "" && eventDev !== printer.devId) continue;
        if (event?.name === "on_local_connect") statuses.push(event.payload.status);
        if ((event?.name === "on_local_message" || event?.name === "on_message") && event.payload?.msg === "wait_info") waitInfo = true;
      }
      if (waitInfo) await installCertificate();
      return statuses;
    };
    const settle = async (ms: number) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        assertActive();
        await pump();
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      }
    };

    await this.ensureAgent(options);
    assertActive();
    for (const callback of ["net.set_on_printer_connected_fn", "net.set_on_local_message_fn"]) {
      assertBridgeOk(await this.callWithAgent(callback, {}, options), callback);
    }
    await this.callWithAgent("net.update_cert", {}, options);
    await pump();
    assertActive();
    const requested = await this.callWithAgent("net.connect_printer", {
      dev_id: printer.devId, dev_ip: printer.devIp, username: printer.username, password: printer.password, use_ssl: printer.useSsl,
    }, options);
    assertBridgeOk(requested, "net.connect_printer");
    const connectResult = bridgeValueAsNumber(requested, "net.connect_printer");
    if (connectResult !== 0) {
      throw new Error(`FULU BambuNetwork bridge could not start a LAN connection to printer ${printer.devId} (net.connect_printer returned ${connectResult}). No print command was sent.`);
    }

    let connected = false;
    try {
      await installCertificate();
      const deadline = Date.now() + timing.connectTimeoutMs;
      while (!connected) {
        assertActive();
        for (const status of await pump()) {
          if (status === 0) {
            connected = true;
            continue;
          }
          const reason = typeof status === "number" && LOCAL_CONNECT_STATUS[status] ? LOCAL_CONNECT_STATUS[status] : `reported status ${status}`;
          throw new Error(`FULU BambuNetwork bridge LAN connection to printer ${printer.devId} at ${printer.devIp} ${reason}. Check the printer IP, LAN access code and LAN mode. No print command was sent.`);
        }
        if (connected) break;
        if (Date.now() >= deadline) {
          throw new Error(`FULU BambuNetwork bridge did not connect to printer ${printer.devId} at ${printer.devIp} over LAN within ${Math.round(timing.connectTimeoutMs / 1000)} s. No print command was sent.`);
        }
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      }
      // Bambu Studio asks a newly connected printer for its full state and
      // security metadata before building the encrypted project_file message.
      for (const [message, qos] of [
        [{ pushing: { sequence_id: "1", command: "pushall", version: 1, push_target: 1 } }, 0],
        [{ info: { sequence_id: "2", command: "get_version" } }, 1],
        [{ system: { sequence_id: "3", command: "get_access_code" } }, 0],
      ] as const) {
        await this.callWithAgent("net.send_message_to_printer", { dev_id: printer.devId, msg: JSON.stringify(message), qos, flag: 0 }, options);
      }
      await settle(timing.settleMs);
      const result = await run({ installCertificate, settle, jobUpdates });
      await pump();
      return result;
    } finally {
      if (connected) await this.callWithAgent("net.disconnect_printer", {}, options).catch(() => undefined);
      await this.request("bridge.poll_events", { limit: 4096 }, options).catch(() => undefined);
    }
  }

  /**
   * Run a LAN print method in a local session. A synchronous -4030 means the
   * plug-in published nothing, so it is retried once after the certificate
   * exchange, as the native helper does; each attempt passes the caller's
   * fresh pre-dispatch checks.
   */
  async startLocalPrint(
    printer: LocalPrinter,
    method: string,
    payload: JsonObject,
    options: BambuNetworkBridgeOptions = {},
    assertActive: () => void = () => {},
    timing: typeof LOCAL_PRINT_TIMING = LOCAL_PRINT_TIMING
  ): Promise<{ result: unknown; jobUpdates: BridgeJobUpdate[] }> {
    return await this.withLocalSession(printer, options, assertActive, timing, async session => {
      let result = await this.callWithAgent(method, payload, options);
      if (bridgeNumericResult(result) === LOCAL_PRINT_PUBLISH_FAILED) {
        await session.settle(timing.retryWaitMs);
        await session.installCertificate();
        await session.settle(timing.settleMs);
        result = await this.callWithAgent(method, payload, options);
      }
      return { result, jobUpdates: session.jobUpdates };
    });
  }

  async callWithAgent(
    method: string,
    payload: JsonObject = {},
    options: BambuNetworkBridgeOptions = {}
  ): Promise<unknown> {
    const { agent } = await this.ensureAgent(options);
    return await this.request(method, { ...payload, agent }, options);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.commandLine = undefined;
    this.agentId = undefined;
    this.agentKey = undefined;
    this.handshake = undefined;
    this.stdoutBuffer = Buffer.alloc(0);

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`FULU BambuNetwork bridge stopped before ${pending.method} completed.`));
      this.pending.delete(id);
    }

    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 2000);
        child.once("close", () => {
          clearTimeout(forceTimer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }

  private async ensureStarted(commandOverride?: string): Promise<void> {
    const command = this.resolveBridgeCommand(commandOverride);
    if (!command) {
      throw new Error(
        "BAMBU_NETWORK_BRIDGE_COMMAND is required for FULU BambuNetwork support. " +
        "Point it at pjarczak_bambu_linux_host or the OrcaSlicer-bambulab macOS/WSL wrapper."
      );
    }

    if (this.child && this.child.exitCode === null && this.commandLine === command) {
      return;
    }

    if (this.child && this.commandLine !== command) {
      await this.stop();
    }

    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];

    this.child = spawn(shell, shellArgs, {
      env: {
        ...process.env,
        ...linuxPluginLibraryEnv(process.env, process.platform),
        PJARCZAK_BAMBU_COUNTRY_CODE: this.resolveCountryCode(),
        PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION:
          this.inferredExpectedNetworkVersion ||
          process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION ||
          "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.commandLine = command;

    const spawnedChild = this.child;
    spawnedChild.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    spawnedChild.stderr.on("data", (chunk: Buffer) => this.rememberStderr(chunk.toString("utf8")));
    spawnedChild.on("error", (error) => {
      if (this.child === spawnedChild) {
        this.rejectAllPending(error);
      }
    });
    spawnedChild.on("close", (code, signal) => {
      if (this.child !== spawnedChild) {
        return;
      }
      this.rejectAllPending(
        new Error(`FULU BambuNetwork bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ${this.lastStderr}`.trim() +
          (code === 101 ? ` ${STDOUT_SOCKET_HINT}` : ""))
      );
      this.child = undefined;
      this.commandLine = undefined;
      this.agentId = undefined;
      this.agentKey = undefined;
      this.handshake = undefined;
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (this.stdoutBuffer.length >= FRAME_HEADER_SIZE) {
      const magic = this.stdoutBuffer.readUInt32LE(0);
      if (magic !== FRAME_MAGIC) {
        const preview = this.stdoutBuffer.subarray(0, Math.min(this.stdoutBuffer.length, 120)).toString("utf8");
        this.rejectAllPending(new Error(`Invalid FULU BambuNetwork bridge frame magic. Output began with: ${preview}`));
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }

      const type = this.stdoutBuffer.readUInt32LE(4);
      const id = this.stdoutBuffer.readUInt32LE(8);
      const size = this.stdoutBuffer.readUInt32LE(12);
      if (this.stdoutBuffer.length < FRAME_HEADER_SIZE + size) {
        return;
      }

      const payload = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + size);
      this.stdoutBuffer = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE + size);

      if (type === FRAME_TYPE_JSON_RESPONSE) {
        this.resolvePendingJson(id, payload);
      } else if (type === FRAME_TYPE_LOG) {
        this.rememberLog(payload.toString("utf8"));
      } else if (type === FRAME_TYPE_BINARY_DATA) {
        this.rememberLog(`received ${payload.length} bytes of bridge binary data for request ${id}`);
      } else {
        this.rememberLog(`ignored bridge frame type ${type} for request ${id}`);
      }
    }
  }

  private resolvePendingJson(id: number, payload: Buffer): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.rememberLog(`received response for unknown bridge request ${id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    try {
      pending.resolve(readFrameJson(payload));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rememberLog(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    this.recentLogs.push(trimmed);
    if (this.recentLogs.length > 25) {
      this.recentLogs = this.recentLogs.slice(-25);
    }
  }

  private rememberStderr(message: string): void {
    const combined = `${this.lastStderr}${message}`;
    this.lastStderr = combined.length > 4000 ? combined.slice(-4000) : combined;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private needsExpectedVersionRetry(handshake: unknown): handshake is {
    network_actual_abi_version: string;
    network_loaded?: boolean;
    network_status?: string;
  } {
    if (typeof handshake !== "object" || handshake === null) {
      return false;
    }

    const value = handshake as {
      network_actual_abi_version?: unknown;
      network_loaded?: unknown;
      network_status?: unknown;
    };

    return (
      value.network_loaded === false &&
      typeof value.network_actual_abi_version === "string" &&
      value.network_actual_abi_version.length > 0 &&
      typeof value.network_status === "string" &&
      value.network_status.toLowerCase().includes("expected abi version")
    );
  }
}
