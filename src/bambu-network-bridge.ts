import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FRAME_MAGIC = 0x52424a50;
const FRAME_HEADER_SIZE = 16;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_BINARY_DATA = 3;
const FRAME_TYPE_LOG = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

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
    macosRuntimeDir: string;
    macosRuntimeDirExists: boolean;
    macosPluginDir?: string;
    macosPluginDirExists?: boolean;
    macosMissingRuntimeFiles: string[];
    macosMissingPluginFiles: string[];
    suggestedMacCommand?: string;
  };
  note?: string;
};

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

    let suggestedMacCommand: string | undefined;
    if (macosPluginDir) {
      const wrapper = path.join(macosPluginDir, "pjarczak-bambu-linux-host-wrapper");
      const host = path.join(macosRuntimeDir, "pjarczak_bambu_linux_host");
      suggestedMacCommand =
        `PJARCZAK_BAMBU_PLUGIN_DIR=${shellQuote(macosRuntimeDir)} ` +
        `${shellQuote(wrapper)} ${shellQuote(host)}`;
    }

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
      runtime: {
        macosRuntimeDir,
        macosRuntimeDirExists: fileExists(macosRuntimeDir),
        macosPluginDir,
        macosPluginDirExists: macosPluginDir ? fileExists(macosPluginDir) : undefined,
        macosMissingRuntimeFiles: collectMissingFiles(macosRuntimeDir, runtimeRequiredFiles),
        macosMissingPluginFiles: collectMissingFiles(macosPluginDir, pluginRequiredFiles),
        suggestedMacCommand,
      },
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
    const key = `${command}\n${configDir}\n${countryCode}\n${userInfo}`;

    if (this.agentId !== undefined && this.agentKey === key) {
      return { agent: this.agentId, handshake: this.handshake };
    }

    fs.mkdirSync(configDir, { recursive: true });

    this.handshake = await this.request("bridge.handshake", {}, options);
    assertBridgeOk(this.handshake, "bridge.handshake");
    if (this.needsExpectedVersionRetry(this.handshake) && !trimEnv(process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION)) {
      this.inferredExpectedNetworkVersion = this.handshake.network_actual_abi_version;
      await this.stop();
      this.handshake = await this.request("bridge.handshake", {}, options);
      assertBridgeOk(this.handshake, "bridge.handshake");
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
    await withAgent("net.set_country_code", { country_code: countryCode });
    await withAgent("net.start");
    await withAgent("net.connect_server", {}, false);

    if (userInfo) {
      await withAgent("net.change_user", { user_info: userInfo });
    }

    this.agentId = agent;
    this.agentKey = key;
    return { agent, handshake: this.handshake };
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
        new Error(`FULU BambuNetwork bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ${this.lastStderr}`.trim())
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
