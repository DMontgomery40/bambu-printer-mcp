# bambu-printer-mcp

> **Thank you, [FULU Foundation](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) and [Louis Rossmann](https://www.youtube.com/watch?v=1jhRqgHxEP8).** This project stands with printer owners, repair rights, and open-source developers who should be able to build interoperable tools without being bullied out of serving their communities. FULU's OrcaSlicer-bambulab fork is a first-class slicer target here.

[![npm version](https://img.shields.io/npm/v/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-green.svg)](https://nodejs.org/en/download/)
[![GitHub stars](https://img.shields.io/github/stars/DMontgomery40/bambu-printer-mcp.svg?style=social&label=Star)](https://github.com/DMontgomery40/bambu-printer-mcp)
[![Downloads](https://img.shields.io/npm/dm/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)

A Bambu Lab-focused MCP server for controlling Bambu printers, manipulating STL files, and managing end-to-end 3MF print workflows from Claude Desktop, Claude Code, or any MCP-compatible client.

This is a stripped-down, Bambu-only fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server). All OctoPrint, Klipper, Duet, Repetier, Prusa Connect, and Creality Cloud support has been removed. What remains is a focused, lean implementation for Bambu Lab hardware.

<details>
<summary><strong>Click to expand Table of Contents</strong></summary>

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Run without installing (npx)](#run-without-installing-npx)
  - [Install globally from npm](#install-globally-from-npm)
  - [Install from source](#install-from-source)
- [Configuration](#configuration)
  - [Environment variables reference](#environment-variables-reference)
- [Usage](#usage)
- [FULU OrcaSlicer-bambulab Support](#fulu-orcaslicer-bambulab-support)
- [Enabling Developer Mode (Required)](#enabling-developer-mode-required)
- [Finding Your Bambu Printer's Serial Number and Access Token](#finding-your-bambu-printers-serial-number-and-access-token)
- [AMS (Automatic Material System) Setup](#ams-automatic-material-system-setup)
- [Bambu Communication Notes (MQTT and FTP)](#bambu-communication-notes-mqtt-and-ftp)
  - [What this fork fixes](#what-this-fork-fixes)
- [Available Tools](#available-tools)
  - [STL Manipulation Tools](#stl-manipulation-tools)
  - [Printer Control Tools](#printer-control-tools)
  - [Slicing Tools](#slicing-tools)
  - [Advanced Tools](#advanced-tools)
- [Available Resources](#available-resources)
- [Example Commands for Claude](#example-commands-for-claude)
- [Troubleshooting and Tester Reports](#troubleshooting-and-tester-reports)
- [Bambu Lab Printer Limitations](#bambu-lab-printer-limitations)
- [General Limitations and Considerations](#general-limitations-and-considerations)
  - [Memory usage](#memory-usage)
  - [STL manipulation limitations](#stl-manipulation-limitations)
  - [Performance considerations](#performance-considerations)
- [License](#license)

</details>

---

## Description

`bambu-printer-mcp` is a Model Context Protocol server that gives Claude (or any MCP client) control over Bambu Lab 3D printers. It handles the full local workflow: manipulate an STL, auto-slice it with BambuStudio or FULU OrcaSlicer-bambulab if needed, upload the resulting 3MF over FTPS, and start the print via an MQTT `project_file` command -- all without leaving your conversation.

It also has an optional FULU BambuNetwork bridge path. When pointed at the OrcaSlicer-bambulab Linux host or macOS/WSL wrapper, the MCP can call FULU's restored BambuNetwork methods directly, including cloud/remote printing through `print_3mf_bambu_network`.

**What this is not.** This package intentionally supports only Bambu Lab printers. It does not include adapters for OctoPrint, Klipper (Moonraker), Duet, Repetier, Prusa Connect, or Creality Cloud. If you need multi-printer support, use the parent project [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) instead.

**Why a separate package?** The parent project carries all printer adapters in a single binary. When working exclusively with Bambu hardware, that breadth adds unnecessary weight. This fork strips the project to its Bambu core for a smaller, faster install. Both packages share the same protocol fixes and safety features.

**Note on resource usage.** STL manipulation loads entire mesh geometry into memory. For large or complex STL files (greater than 10 MB), these operations can be memory-intensive. See [General Limitations and Considerations](#general-limitations-and-considerations) for details.

---

## Features

- Get detailed printer status: temperatures (nozzle, bed, chamber), print progress, current layer, time remaining, and live AMS slot data
- List, upload, and manage files on the printer's SD card via FTPS
- Upload and print `.3mf` files with full plate selection and calibration flag control
- Automatic slicing: pass an unsliced 3MF to `print_3mf` and the server will slice it with BambuStudio CLI, OrcaSlicer, or FULU OrcaSlicer-bambulab before uploading
- Parse AMS mapping from the 3MF's embedded slicer config (`Metadata/project_settings.config`) and send it correctly formatted per the OpenBambuAPI spec
- Cancel in-progress print jobs via MQTT
- Set nozzle and bed temperature via G-code dispatch over MQTT
- Start G-code files already stored on the printer
- STL manipulation: scale, rotate, extend base, merge vertices, center at origin, lay flat, and inspect model info
- Slice STL or 3MF files using BambuStudio, FULU OrcaSlicer-bambulab, OrcaSlicer, PrusaSlicer, Cura, or Slic3r
- Optional FULU BambuNetwork bridge support for restored BambuNetwork login/status/raw calls and cloud or LAN 3MF print starts
- Optional Blender MCP bridge for advanced mesh operations
- Dual transport: stdio (default, for Claude Desktop / Claude Code) and Streamable HTTP

---

## Installation

### Prerequisites

- Node.js 18 or higher
- npm
- **A Bambu-compatible slicer** *(optional -- only needed for slicing)*. Required by `slice_stl` and `print_3mf` auto-slice when a 3MF has no embedded G-code. Use [FULU OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) with `SLICER_TYPE=orcaslicer-bambulab`, or use [BambuStudio](https://bambulab.com/en/download/studio) with `SLICER_TYPE=bambustudio`. Not needed if you only print pre-sliced 3MF files.
- **FULU BambuNetwork runtime** *(optional -- only needed for restored cloud/BambuNetwork printing)*. Install FULU OrcaSlicer-bambulab, then point `BAMBU_NETWORK_BRIDGE_COMMAND` at its bridge host or platform wrapper. See [FULU OrcaSlicer-bambulab Support](#fulu-orcaslicer-bambulab-support).

### Run without installing (npx)

The fastest way to get started. No global install required:

```bash
npx bambu-printer-mcp
```

Set environment variables inline or via a `.env` file in your working directory (see [Configuration](#configuration)).

### Install globally from npm

```bash
npm install -g bambu-printer-mcp
```

After installation, the `bambu-printer-mcp` command is available in your PATH.

### Install from source

```bash
git clone https://github.com/DMontgomery40/bambu-printer-mcp.git
cd bambu-printer-mcp
npm install
npm run build
npm link
```

`npm link` makes the `bambu-printer-mcp` binary available globally without publishing to npm.

---

## Configuration

Create a `.env` file in the directory where you run the server, or pass environment variables directly in your MCP client config. All printer connection variables can also be passed as tool arguments on a per-call basis, which is useful when working with multiple printers.

```env
# --- Bambu printer connection (required for all printer tools) ---
PRINTER_HOST=192.168.1.100        # IP address of your Bambu printer on the local network
BAMBU_SERIAL=01P00A123456789      # Printer serial number (see Finding Your Serial Number below)
BAMBU_TOKEN=your_access_token     # LAN access token from printer touchscreen

# --- Printer model (CRITICAL for safe operation) ---
BAMBU_MODEL=p1s                   # Your printer model: p1s, p1p, x1c, x1e, a1, a1mini, h2d
BED_TYPE=textured_plate           # Bed plate type: textured_plate, cool_plate, engineering_plate, hot_plate
NOZZLE_DIAMETER=0.4               # Nozzle diameter in mm (default: 0.4)

# --- Slicer configuration (required for slice_stl and print_3mf auto-slice) ---
SLICER_TYPE=orcaslicer-bambulab   # Options: bambustudio, orcaslicer, orcaslicer-bambulab,
                                  # prusaslicer, cura, slic3r. Aliases: fulu-orca, orca-studio.
SLICER_PATH=/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer
                                  # Adjust for your OS and install path. BambuStudio also works.
SLICER_PROFILE=                   # Optional: path to a slicer profile/config file

# --- FULU BambuNetwork bridge (optional; restores cloud/BambuNetwork printing) ---
BAMBU_DEV_ID=01P00A123456789      # BambuNetwork device id; often the same as serial
BAMBU_NETWORK_BRIDGE_COMMAND=     # Full shell command for pjarczak_bambu_linux_host or wrapper
BAMBU_NETWORK_CONFIG_DIR=         # Optional; defaults to ~/.config/bambu-printer-mcp/bambu-network
BAMBU_NETWORK_COUNTRY_CODE=US     # BambuNetwork region/country code
BAMBU_NETWORK_USER_INFO=          # Optional raw user_info JSON if you need net.change_user

# --- Temporary file directory ---
TEMP_DIR=/tmp/bambu-mcp-temp      # Directory for intermediate files. Created automatically if absent.

# --- MCP transport ---
MCP_TRANSPORT=stdio               # Options: stdio (default), streamable-http

# --- Streamable HTTP transport (only used when MCP_TRANSPORT=streamable-http) ---
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
MCP_HTTP_PATH=/mcp
MCP_HTTP_STATEFUL=true
MCP_HTTP_JSON_RESPONSE=true
MCP_HTTP_ALLOWED_ORIGINS=http://localhost

# --- Optional Blender MCP bridge ---
BLENDER_MCP_BRIDGE_COMMAND=       # Shell command to invoke your Blender MCP bridge executable
```

### Environment variables reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `PRINTER_HOST` | `localhost` | Yes | IP address of the Bambu printer |
| `BAMBU_SERIAL` | | Yes | Printer serial number |
| `BAMBU_TOKEN` | | Yes | LAN access token |
| `BAMBU_MODEL` | | **Yes** | Printer model: `p1s`, `p1p`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`. **Required for safe operation** -- determines the correct G-code generation. If omitted and the MCP client supports elicitation, the server will ask you interactively. |
| `BED_TYPE` | `textured_plate` | No | Bed plate type: `textured_plate`, `cool_plate`, `engineering_plate`, `hot_plate` |
| `NOZZLE_DIAMETER` | `0.4` | No | Nozzle diameter in mm. Used to select the correct Bambu-compatible machine preset. |
| `SLICER_TYPE` | `bambustudio` | No | Slicer to use for slicing operations: `bambustudio`, `orcaslicer`, `orcaslicer-bambulab`, `prusaslicer`, `cura`, or `slic3r`. Aliases such as `fulu-orca` and `orca-studio` are accepted. |
| `SLICER_PATH` | Platform default for the selected slicer | No | Full path to the slicer executable, or a command name on `PATH` such as `OrcaSlicer` |
| `SLICER_PROFILE` | | No | Path to a slicer profile or config file |
| `BAMBU_DEV_ID` | `BAMBU_SERIAL` | No | BambuNetwork device id used by `print_3mf_bambu_network`; often the same value as the printer serial. |
| `BAMBU_NETWORK_BRIDGE_COMMAND` | | No | Full shell command that starts FULU's `pjarczak_bambu_linux_host`, `pjarczak-bambu-linux-host-wrapper`, or WSL wrapper. Required for BambuNetwork tools. |
| `FULU_BAMBU_NETWORK_BRIDGE_COMMAND` | | No | Alternate env name accepted for the same bridge command. |
| `BAMBU_NETWORK_CONFIG_DIR` | `~/.config/bambu-printer-mcp/bambu-network` | No | Config/log directory passed to FULU `net.create_agent` and `net.set_config_dir`. |
| `BAMBU_NETWORK_COUNTRY_CODE` | `US` | No | Country code passed to the FULU BambuNetwork agent. |
| `BAMBU_NETWORK_USER_INFO` | | No | Optional raw `user_info` JSON string passed to FULU `net.change_user`. Usually you can reuse the login/config state from OrcaSlicer-bambulab instead. |
| `TEMP_DIR` | `./temp` | No | Directory for intermediate files |
| `MCP_TRANSPORT` | `stdio` | No | Transport mode: `stdio` or `streamable-http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | No | HTTP bind address (HTTP transport only) |
| `MCP_HTTP_PORT` | `3000` | No | HTTP port (HTTP transport only) |
| `MCP_HTTP_PATH` | `/mcp` | No | HTTP endpoint path (HTTP transport only) |
| `MCP_HTTP_STATEFUL` | `true` | No | Enable stateful HTTP sessions |
| `MCP_HTTP_JSON_RESPONSE` | `true` | No | Return structured JSON alongside text responses |
| `MCP_HTTP_ALLOWED_ORIGINS` | | No | Comma-separated list of allowed CORS origins |
| `BLENDER_MCP_BRIDGE_COMMAND` | | No | Command to invoke Blender MCP bridge |

---

## Usage

Add this server to your MCP client's config (Claude Desktop, Claude Code, Cursor, Codex CLI, or any MCP-compatible client). The config format is the same everywhere -- an `mcpServers` entry with the command and env vars:

```json
{
  "mcpServers": {
    "bambu-printer": {
      "command": "npx",
      "args": ["-y", "bambu-printer-mcp"],
      "env": {
        "PRINTER_HOST": "192.168.1.100",
        "BAMBU_SERIAL": "01P00A123456789",
        "BAMBU_TOKEN": "your_access_token",
        "BAMBU_MODEL": "p1s",
        "SLICER_TYPE": "orcaslicer-bambulab",
        "SLICER_PATH": "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
      }
    }
  }
}
```

Where this config lives depends on your client:

| Client | Config location |
|--------|----------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (global) | `~/.claude/settings.json` |
| Cursor | MCP settings in Cursor preferences |
| Codex CLI | MCP config per Codex docs |

Restart your client after editing the config.

### Recommended: use with codemode-mcp

For any MCP server with a large tool surface, wrapping it behind [codemode-mcp](https://github.com/jx-codes/codemode-mcp) dramatically reduces token usage. Instead of exposing every tool definition to the model (which can consume tens of thousands of tokens per turn), codemode lets the agent write code against a two-tool interface (`search()` and `execute()`), loading only the tools it needs on demand.

Anthropic and Cloudflare independently demonstrated this pattern reduces MCP token costs by up to 98%:

- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (Anthropic)
- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) (Cloudflare)

This applies to all MCP servers, not just this one.

---

## FULU OrcaSlicer-bambulab Support

FULU's [OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) restores full BambuNetwork support for Bambu Lab printers. This MCP now supports it in two separate ways:

1. **Slicer/exporter mode.** Set `SLICER_TYPE=orcaslicer-bambulab` to slice STL or 3MF inputs with FULU's fork. The aliases `fulu-orca`, `orca-studio`, and `orca-bambulab` are also accepted.
2. **BambuNetwork bridge mode.** Set `BAMBU_NETWORK_BRIDGE_COMMAND` to FULU's Linux host or platform wrapper. Then use `bambu_network_bridge_status`, `bambu_network_call`, or `print_3mf_bambu_network` to go through FULU's restored BambuNetwork path.

These modes are intentionally separate. The default `print_3mf` path remains transparent local MQTT/FTPS. The BambuNetwork path is opt-in, because it uses FULU's restored network library and runtime instead of the MCP's direct LAN implementation.

### Current status, honestly

This is an MCP server that people can clone, configure, and run. The repo now contains the FULU bridge client, tool schemas, behavior tests, built `dist/` output, and macOS setup documentation. It is not being presented as magic or as a finished bypass for every Bambu firmware. The point of this release is to make the FULU path available from MCP, keep the old local Bambu flow intact, and collect real printer reports quickly.

As of 2026-05-13, the validation matrix is:

| Surface | Status | Notes |
|---|---|---|
| Source checkout | Working | `git clone`, `npm install`, `npm run build`, and `npm test` are the intended maintainer/dev path. |
| MCP stdio transport | Working | Covered by behavior tests: initialize, list tools, success call, structured failure. |
| MCP Streamable HTTP transport | Working | Covered by behavior tests, including origin rejection. |
| FULU slicer aliasing | Working | `orcaslicer-bambulab`, `fulu-orca`, `orca-studio`, and `orca-bambulab` normalize to the Bambu-compatible Orca CLI flow. |
| BambuStudio CLI fallback | Working | The existing `bambustudio` slicer path still works and remains the conservative fallback for slicing. |
| FULU bridge protocol | Working in tests | The MCP speaks FULU's framed JSON protocol, creates an agent, retries ABI detection, and handles non-zero print return codes as failures. |
| macOS bridge launch | Partially working | On Apple Silicon, the FULU runtime can verify and the x86_64 Lima bridge can handshake from this MCP. Real print start still needs iteration. |
| macOS print start | Not proven | Test bench result: FULU LAN print reached the bridge but returned `send msg failed`; direct MQTT/FTPS upload reached the printer but the printer reported HMS `0500050000010007` (`MQTT Command verification failed`). |
| Linux print start | Needs testers | This should be the cleanest FULU runtime because the Linux host and `.so` files run natively, but it needs real printer confirmations. |
| Windows print start | Needs testers | WSL 2 support follows FULU's runtime model, but we need Windows testers with real printers before calling it proven. |

The older local fallback is still here: `SLICER_TYPE=bambustudio` or `SLICER_TYPE=orcaslicer-bambulab` uses a slicer CLI to produce a Bambu 3MF, then the MCP uses the direct Bambu LAN path (`print_3mf`) with FTPS upload and MQTT status/control. That path remains useful for printers and firmware that still accept third-party local project commands, and it is covered by the repo behavior tests. The new `connection_mode: "bambu_network"` path is the FULU bridge path.

Important wording detail: when `print_3mf` returns success, it means the file was uploaded and the MQTT `project_file` command was sent. On newer locked-down firmware, the printer can still reject that command after receipt. Check `get_printer_status` for `gcode_state`, HMS messages, and actual motion before declaring that a print started.

### Clone-and-run checklist

For a source checkout, use the same shape on every OS:

```bash
git clone https://github.com/DMontgomery40/bambu-printer-mcp.git
cd bambu-printer-mcp
npm install
npm run build
npm test
```

Then choose one of the two print paths:

| Path | Use when | Key env/tool settings |
|---|---|---|
| Direct local Bambu path | You are on the same LAN and your firmware still accepts third-party MQTT `project_file` commands. | `PRINTER_HOST`, `BAMBU_SERIAL`, `BAMBU_TOKEN`, `BAMBU_MODEL`, then call `print_3mf`. |
| FULU BambuNetwork path | You want to test restored BambuNetwork behavior through FULU's runtime. | `BAMBU_NETWORK_BRIDGE_COMMAND`, `BAMBU_DEV_ID`, `BAMBU_MODEL`, then call `print_3mf_bambu_network` or `print_3mf` with `connection_mode: "bambu_network"`. |

Minimum local direct `.env`:

```env
PRINTER_HOST=192.168.1.100
BAMBU_SERIAL=01P00A123456789
BAMBU_TOKEN=your_lan_access_code
BAMBU_MODEL=p1s
SLICER_TYPE=bambustudio
SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
```

Minimum FULU bridge `.env`:

```env
BAMBU_MODEL=p1s
BAMBU_DEV_ID=01P00A123456789
BAMBU_NETWORK_COUNTRY_CODE=US
BAMBU_NETWORK_BRIDGE_COMMAND=/path/to/pjarczak_bambu_linux_host_or_platform_wrapper
SLICER_TYPE=orcaslicer-bambulab
SLICER_PATH=/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer
```

Do not paste access codes, serial numbers, cloud tokens, or account JSON into public issues. Redact them and keep only the last few characters if you need to distinguish devices.

### Slicer/exporter mode

```env
SLICER_TYPE=orcaslicer-bambulab
SLICER_PATH=/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer
```

For Bambu-family slicing, `orcaslicer`, `orcaslicer-bambulab`, and `bambustudio` all use the Bambu-compatible CLI flow: `--slice`, `--export-3mf`, `--load-settings`, `--allow-newer-file`, and the AMS/object/plate flags exposed by `slice_stl`. That produces a sliced 3MF with embedded `Metadata/plate_<n>.gcode`, which either local `print_3mf` or bridge `print_3mf_bambu_network` can use.

### BambuNetwork bridge mode

FULU's bridge host speaks a small binary-framed JSON protocol over stdin/stdout. This MCP implements that protocol directly and initializes the same agent shape FULU uses:

- `bridge.handshake`
- `net.create_agent`
- `net.set_config_dir`
- `net.init_log`
- `net.set_country_code`
- `net.start`
- `net.connect_server`

The high-level print tool builds FULU-style `PrintParams` and calls one of these bridge methods:

| MCP `bambu_network_method` | FULU method | Typical use |
|---|---|---|
| `start_print` | `net.start_print` | Cloud/BambuNetwork print. This is the default when `connection_type` is `cloud`. |
| `start_local_print` | `net.start_local_print` | Local LAN print through FULU without record upload. This is the default when `connection_type` is `lan`. |
| `start_local_print_with_record` | `net.start_local_print_with_record` | Local LAN print plus BambuNetwork task record behavior, matching Orca's preferred LAN path when possible. |
| `start_send_gcode_to_sdcard` | `net.start_send_gcode_to_sdcard` | Send sliced G-code/3MF content to SD card through the bridge. Useful for probing runtime behavior. |
| `start_sdcard_print` | `net.start_sdcard_print` | Start an already-present SD card job through the bridge. |

Use this probe first:

```json
{
  "connect": true
}
```

with the `bambu_network_bridge_status` tool. The response includes runtime hints, missing macOS files, the resolved config directory, and the suggested macOS wrapper command when it can infer one.

Healthy bridge status should show:

```json
{
  "configured": true,
  "connected": true,
  "agentReady": true,
  "handshake": {
    "network_loaded": true,
    "source_loaded": true,
    "network_actual_abi_version": "02.05.02.58"
  }
}
```

The exact ABI version can change with FULU's bundled BambuNetwork library. This MCP reads `network_actual_abi_version` from `bridge.handshake` and retries with `PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION` automatically when the bridge reports an expected-version mismatch. You should not need to set that variable manually unless you are debugging the bridge itself.

### macOS runtime

FULU's upstream README currently says "macOS: Work in progress." For this MCP, macOS is wired up enough to install, verify, launch, and probe the FULU bridge runtime when FULU's macOS bridge payload is installed and you point the MCP at the wrapper. Real print-start behavior still needs more Mac tester feedback.

FULU's macOS runtime uses Lima under:

```text
~/Library/Application Support/OrcaSlicer/macos-bridge/
```

The runtime directory should contain files such as `pjarczak_bambu_linux_host`, `libbambu_networking.so`, `libBambuSource.so`, `ca-certificates.crt`, and `slicer_base64.cer`. The plugin/resource directory should contain `pjarczak-bambu-linux-host-wrapper`, `install_runtime_macos.sh`, and `verify_runtime_macos.sh`.

After installing FULU OrcaSlicer-bambulab, run the bridge status probe. If it finds the wrapper and runtime, it will return a command like this:

```bash
export BAMBU_NETWORK_BRIDGE_COMMAND="PJARCZAK_BAMBU_PLUGIN_DIR='$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime' '$HOME/Library/Application Support/OrcaSlicer/plugins/pjarczak-bambu-linux-host-wrapper' '$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime/pjarczak_bambu_linux_host'"
export BAMBU_NETWORK_COUNTRY_CODE=US
```

If the probe reports missing runtime files, launch FULU OrcaSlicer-bambulab once and let it install its macOS bridge runtime. If your package exposes the scripts directly, the install/verify flow is:

```bash
"$HOME/Library/Application Support/OrcaSlicer/plugins/install_runtime_macos.sh" -PluginDir "$HOME/Library/Application Support/OrcaSlicer/plugins"
"$HOME/Library/Application Support/OrcaSlicer/plugins/verify_runtime_macos.sh" -PluginDir "$HOME/Library/Application Support/OrcaSlicer/plugins"
```

On newer Lima releases, FULU's installed script may need the modern template URL form. If runtime install fails with `template ".yaml" not found`, start the named Lima instance once with:

```bash
limactl start --name=orcaslicer-bambu-network --tty=false --mount-writable --vm-type=vz --network=vzNAT --rosetta template://default
```

On Apple Silicon, if the default Lima/Rosetta runtime starts but the bridge host crashes with architecture or `Bus error` failures, use an x86_64 Lima instance and point the same wrapper at it:

```bash
export BAMBU_NETWORK_BRIDGE_COMMAND="PJARCZAK_MAC_LIMA_INSTANCE=orcaslicer-bambu-network-x86 PJARCZAK_BAMBU_PLUGIN_DIR='$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime' '$HOME/Library/Application Support/OrcaSlicer/plugins/pjarczak-bambu-linux-host-wrapper' '$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime/pjarczak_bambu_linux_host'"
```

The app name and resource path can differ by build, so trust `bambu_network_bridge_status` over hard-coded examples.

macOS troubleshooting notes:

| Symptom | Meaning | Next step |
|---|---|---|
| `configured: false` | `BAMBU_NETWORK_BRIDGE_COMMAND` is empty. | Run `bambu_network_bridge_status` without `connect`, copy the suggested command if present, or set it manually. |
| Missing wrapper files | FULU's plugin files were not installed where the MCP expects. | Launch FULU OrcaSlicer-bambulab once, then run `verify_runtime_macos.sh`. |
| Missing runtime `.so` files | The Linux bridge payload did not install into `macos-bridge/runtime`. | Run `install_runtime_macos.sh`, then `verify_runtime_macos.sh`. |
| `template ".yaml" not found` | Lima's template syntax changed. | Use the `template://default` command shown above. |
| `Bus error` or architecture crash | Rosetta/arm64 guest/runtime mismatch. | Try the x86_64 Lima instance command shown above. |
| `send msg failed` during print | The FULU bridge ran, but the printer/network layer rejected the print start. | Report platform, printer model, firmware, method used, and redacted bridge output. |

### Linux runtime

On Linux, point the bridge command at FULU's host binary with access to the bundled Bambu network shared libraries:

```bash
export BAMBU_NETWORK_BRIDGE_COMMAND="/path/to/pjarczak_bambu_linux_host"
export PJARCZAK_BAMBU_PLUGIN_DIR="/path/to/fulu-orca-plugin-or-runtime"
export BAMBU_NETWORK_COUNTRY_CODE=US
```

Linux testers: please report whether `bambu_network_bridge_status` can create an agent, whether `print_3mf_bambu_network` returns `value: 0`, and whether the printer actually transitions out of `IDLE`. Include distro, CPU architecture, printer model, firmware version, and whether the job was `cloud` or `lan`.

### Windows runtime

Windows support follows FULU's WSL 2 requirement. Enable WSL 2 as FULU documents, restart Windows, then use a `wsl ...` command that starts FULU's bridge host from the Linux environment:

```powershell
setx BAMBU_NETWORK_BRIDGE_COMMAND "wsl -- /path/to/pjarczak_bambu_linux_host"
```

If your FULU build includes `pjarczak_wsl_run_host.sh`, prefer that wrapper because it prepares the expected WSL runtime layout.

Windows testers needed. The useful report is:

- Windows version and CPU architecture.
- WSL distro name and WSL version.
- Whether FULU OrcaSlicer-bambulab itself can print through BambuNetwork.
- Output from `bambu_network_bridge_status` with secrets redacted.
- Which print method was used: `start_print`, `start_local_print`, or `start_local_print_with_record`.
- Printer model, firmware, LAN-only/developer-mode state, and whether the printer moved beyond `IDLE`.

### Printing through BambuNetwork

Cloud/restored internet print:

```json
{
  "three_mf_path": "/Users/you/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_type": "cloud",
  "dev_id": "01P00A123456789"
}
```

LAN/local print through the FULU bridge:

```json
{
  "three_mf_path": "/Users/you/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_type": "lan",
  "dev_id": "01P00A123456789",
  "dev_ip": "192.168.1.100",
  "bambu_token": "your_access_token"
}
```

You can also route the existing `print_3mf` tool through FULU by passing:

```json
{
  "three_mf_path": "/Users/you/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_mode": "bambu_network",
  "connection_type": "cloud",
  "dev_id": "01P00A123456789"
}
```

Force a specific FULU method while testing:

```json
{
  "three_mf_path": "/Users/you/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_type": "lan",
  "bambu_network_method": "start_local_print_with_record",
  "dev_id": "01P00A123456789",
  "dev_ip": "192.168.1.100",
  "bambu_token": "your_access_token"
}
```

---

## Enabling Developer Mode (Required)

This MCP server communicates directly with your printer over your local network using MQTT and FTPS. For this to work, **Developer Mode** must be enabled on the printer. Without it, the printer will reject third-party LAN connections even if you have the correct access code.

Developer Mode is available on the following firmware versions and later:

| Series | Minimum Firmware |
|--------|-----------------|
| P1 Series (P1P, P1S) | `01.08.02.00` |
| X1 Series (X1C, X1E) | `01.08.03.00` |
| A1 Series (A1, A1 Mini) | `01.05.00.00` |
| H2D | `01.01.00.01` |

If your firmware is older than these versions, update through Bambu Studio or the Bambu Handy app before proceeding.

### Step 1: Navigate to Network Settings

On the printer's touchscreen, go to **Settings**, then select the **Network** (WLAN) page. You should see your WiFi network name, IP address, and the LAN Only Mode toggle.

<p align="center">
  <img src="docs/images/p1s-network-settings.jpeg" width="400" alt="P1S network settings screen showing WLAN, LAN Only Mode, IP address, and Access Code" />
</p>

### Step 2: Enable LAN Only Mode

Toggle **LAN Only Mode** to **ON**. This enables direct local network communication protocols (MQTT on port 8883 and FTPS on port 990) that this server requires.

**Important:** Enabling LAN Only Mode disconnects the printer from Bambu Lab's cloud services. The Bambu Handy mobile app will stop working while this mode is active. Bambu Studio and OrcaSlicer can still connect over LAN.

### Step 3: Enable Developer Mode

Once LAN Only Mode is on, a **Developer Mode** option appears in the same settings menu. Toggle it **ON**. This allows third-party clients (like this MCP server) to authenticate and send commands over MQTT.

### Step 4: Note the Access Code

The **Access Code** displayed on the network settings screen is your LAN access token. You will need this value for the `BAMBU_TOKEN` environment variable.

<p align="center">
  <img src="docs/images/p1s-access-code.jpeg" width="400" alt="P1S network settings showing the Access Code field" />
</p>

The access code can be refreshed by tapping the circular arrow icon next to it. If you refresh it, any existing connections using the old code will be disconnected and you will need to update your configuration with the new code.

---

## Finding Your Bambu Printer's Serial Number and Access Token

Two values are required to connect directly to a Bambu Lab printer over your local network: the printer's serial number and its LAN access token (the Access Code from Developer Mode setup above).

### Serial number

The serial number is printed on a sticker on the back or underside of the printer. It typically follows one of these formats:

- P1 Series: begins with `01P`
- X1 Series: begins with `01X`
- A1 Series: begins with `01A`

You can also find it on the printer's touchscreen. Navigate to **Settings** and select the **Device Info** page:

<p align="center">
  <img src="docs/images/p1s-device-info.jpeg" width="400" alt="P1S device info screen showing model name, serial number, AMS serial, and printing time" />
</p>

The **Printer** line shows your serial number. In Bambu Studio, you can also find it under Device > Device Management in the printer information panel.

### LAN access token

The access token is the **Access Code** shown on the printer's network settings screen. It is separate from your Bambu Cloud account password. If you followed the [Developer Mode setup](#enabling-developer-mode-required) above, you already have this value.

**P1 Series (P1P, P1S):**
1. On the printer touchscreen, go to Settings.
2. Select the Network / WLAN page.
3. The Access Code is displayed at the bottom of the screen.

**X1 Series (X1C, X1E):**
1. On the printer touchscreen, go to Settings.
2. Select Network.
3. Enable LAN Only Mode and Developer Mode if not already on.
4. The Access Code appears on this screen.

**A1 and A1 Mini:**
1. Open the Bambu Handy app on your phone.
2. Connect to your printer.
3. Navigate to Settings > Network.
4. The Access Code is shown here.

Your printer must also be logged into a Bambu Cloud account for LAN mode to function. You can verify this on the cloud/account settings screen:

<p align="center">
  <img src="docs/images/p1s-cloud-account.jpeg" width="400" alt="P1S cloud account screen showing logged-in user with Logout button" />
</p>

**Troubleshooting:** If the LAN Only Mode or Developer Mode options are not visible, your printer firmware is likely outdated. Update to the latest firmware version through Bambu Studio or the Bambu Handy app and try again.

---

## AMS (Automatic Material System) Setup

The Bambu AMS is a multi-spool feeder that lets you assign different filaments to different parts of a multi-color or multi-material print. This section explains how AMS slot mapping works with this MCP server.

### How AMS slots work

The AMS has 4 slots per unit, numbered 0 through 3. If you have multiple AMS units chained together, the second unit's slots are 4 through 7, and so on. When you slice a model in Bambu Studio or OrcaSlicer, each color/material in the print is assigned to a specific AMS slot.

### Automatic AMS mapping from the 3MF

When you slice a model in Bambu Studio or OrcaSlicer, the slicer embeds AMS mapping information inside the 3MF file at `Metadata/project_settings.config`. The `print_3mf` tool reads this file automatically and extracts the correct mapping. In most cases, you do not need to specify `ams_mapping` manually -- the tool handles it.

### Manual AMS mapping

If you need to override the embedded mapping (for example, you swapped filament positions since slicing), pass the `ams_mapping` array to `print_3mf`:

```json
{
  "three_mf_path": "/path/to/model.3mf",
  "ams_mapping": [0, 2],
  "use_ams": true
}
```

Each element in the array corresponds to a filament slot used in the print file, in the order they appear in the slicer. The value is the physical AMS slot number (0-based) where that filament is currently loaded. In the example above, the first filament in the print uses AMS slot 0, and the second uses AMS slot 2.

The server pads this array to the 5 elements required by the printer's MQTT protocol. An `ams_mapping` of `[0, 2]` becomes `[0, 2, -1, -1, -1]` on the wire, where `-1` indicates unused positions.

### Single-material prints

For a single-material print (the most common case), the default mapping is `[-1, -1, -1, -1, 0]`, which tells the printer to pull filament from AMS slot 0. If your filament is in a different slot, specify it:

```json
{
  "three_mf_path": "/path/to/model.3mf",
  "ams_mapping": [2]
}
```

This tells the printer to use AMS slot 2 for the single filament in the print.

### Printing without AMS

If you are using the direct-feed spool holder (no AMS attached) or want to bypass the AMS entirely, set `use_ams` to `false`:

```json
{
  "three_mf_path": "/path/to/model.3mf",
  "use_ams": false
}
```

### Checking AMS status

Use `get_printer_status` to see which filaments are currently loaded in each AMS slot, including material type and color data reported by the printer:

```
"What filaments are loaded in my AMS right now?"
```

The `ams` field in the status response contains the raw AMS data from the printer, including tray information for each slot.

---

## Bambu Communication Notes (MQTT and FTP)

Bambu Lab printers do not use a conventional REST API. Instead, they expose two local protocols that this server uses directly:

**MQTT (port 8883, TLS):** All printer commands and state reports flow over an MQTT broker running on the printer itself. The broker requires your serial number as the client ID and your access token as the password. Commands like starting a print, cancelling a job, and dispatching G-code lines are all MQTT publishes to the device topic. Status data is received by subscribing to the printer's report topic and requesting a `push_all` refresh. This implementation is based on community reverse engineering documented in the [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) project.

**FTPS (port 990, implicit TLS):** File operations (upload and directory listing) use FTPS. The printer's SD card is accessible as a filesystem with directories including `cache/` (for 3MF and G-code print files), `timelapse/`, and `logs/`. Authentication uses the username `bblp` and your access token as the password.

### What this fork fixes

Both this package and the parent project (`mcp-3D-printer-server`) include fixes for two protocol-level issues in the underlying `bambu-js` library.

**Bug 1: FTP double-path error in bambu-js.**

The `bambu-js` library's `sendFile` method has a path construction bug. It calls `ensureDir` to change the working directory into the target directory (e.g., `/cache`), and then calls `uploadFrom` with the full relative path including the directory prefix (e.g., `cache/file.3mf`). The result is that the file lands at the wrong path on the printer (e.g., `/cache/cache/file.3mf` instead of `/cache/file.3mf`), and the subsequent print command fails because it references a file that does not exist at the expected path.

This fork bypasses `bambu-js` for all uploads and uses `basic-ftp` directly. The upload function (`ftpUpload`) connects to the printer, resolves the absolute remote path, changes to the correct directory with `ensureDir`, and then uploads using only the basename -- avoiding the double-path construction entirely.

```typescript
// From src/printers/bambu.ts
private async ftpUpload(host, token, localPath, remotePath): Promise<void> {
  const client = new FTPClient(15_000);
  await client.access({ host, port: 990, user: "bblp", password: token,
                        secure: "implicit", secureOptions: { rejectUnauthorized: false } });
  const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  const remoteDir = path.posix.dirname(absoluteRemote);
  await client.ensureDir(remoteDir);
  // basename only -- no double-path
  await client.uploadFrom(localPath, path.posix.basename(absoluteRemote));
  client.close();
}
```

**Bug 2: AMS mapping format in the project_file MQTT command.**

The `bambu-js` library's project file command hardcodes `use_ams: true` and does not support the `ams_mapping` field at all. Without the fix, the mapping is a simple array of slot indices (e.g., `[0, 2]`), which does not match the OpenBambuAPI specification.

According to the OpenBambuAPI spec, `ams_mapping` must be a 5-element array where each position corresponds to a filament color slot in the print file. Unused positions must be padded with `-1`. For example, a print using only AMS slot 0 sends `[-1, -1, -1, -1, 0]`.

This fork sends the `project_file` command directly via `bambu-node` (bypassing `bambu-js` entirely for print initiation) and constructs the `ams_mapping` array correctly:

```typescript
// From src/printers/bambu.ts
let amsMapping: number[];
if (options.amsMapping && options.amsMapping.length > 0) {
  amsMapping = Array.from({ length: 5 }, (_, i) =>
    i < options.amsMapping!.length ? options.amsMapping![i] : -1
  );
} else {
  amsMapping = [-1, -1, -1, -1, 0];  // default: slot 0 only
}
```

The command payload also includes all required fields per the OpenBambuAPI spec: `param` (the internal gcode path within the 3MF), `url` (the sdcard path), `md5` (computed from the plate's embedded gcode), and all calibration flags.

---

## Available Tools

<details>
<summary><strong>Click to expand STL Manipulation Tools</strong></summary>

### STL Manipulation Tools

All STL tools load the full mesh geometry into memory. For files larger than 10 MB, monitor memory usage and prefer testing on smaller files first.

#### get_stl_info

Inspect an STL file without modifying it. Returns bounding box dimensions, face count, vertex count, and model center.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### scale_stl

Scale an STL model along individual axes. Omit any axis to leave it unchanged (defaults to 1.0).

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_x": 1.5,
  "scale_y": 1.5,
  "scale_z": 1.0
}
```

For uniform scaling, set all three axes to the same value:

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_x": 2.0,
  "scale_y": 2.0,
  "scale_z": 2.0
}
```

#### rotate_stl

Rotate an STL model around one or more axes. Angles are in degrees. Omitted axes default to 0.

```json
{
  "stl_path": "/path/to/model.stl",
  "angle_x": 0,
  "angle_y": 0,
  "angle_z": 90
}
```

#### extend_stl_base

Add solid geometry underneath the model to increase its base height. Useful for improving bed adhesion on models with a small or unstable footprint.

```json
{
  "stl_path": "/path/to/model.stl",
  "extension_height": 3.0
}
```

`extension_height` is in millimeters.

#### merge_vertices

Merge vertices that are closer together than the specified tolerance. This can close small gaps in a mesh and slightly reduce file size. Useful as a cleanup step before slicing.

```json
{
  "stl_path": "/path/to/model.stl",
  "tolerance": 0.01
}
```

`tolerance` is in millimeters and defaults to 0.01 if omitted.

#### center_model

Translate the model so the center of its bounding box sits at the world origin (0, 0, 0). Useful before applying transformations or exporting for use in another tool.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### lay_flat

Identify the largest flat surface on the model and rotate the model so that face is oriented downward on the XY plane (Z = 0). This is a common preparation step before slicing to minimize the need for supports.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

Note: this works best on models with a clearly dominant flat face. Results on organic or rounded shapes may be unpredictable.

</details>

<details>
<summary><strong>Click to expand Printer Control Tools</strong></summary>

### Printer Control Tools

All printer tools accept optional `host`, `bambu_serial`, and `bambu_token` arguments. If omitted, values fall back to the environment variables `PRINTER_HOST`, `BAMBU_SERIAL`, and `BAMBU_TOKEN`. Passing them explicitly is useful when working with more than one printer.

#### get_printer_status

Retrieve current printer state including temperatures, print progress, layer count, time remaining, and AMS slot data. Internally sends a `push_all` MQTT command to force a fresh status report before reading cached state.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

Returns a structured object with fields including `status` (gcode_state string), `temperatures.nozzle`, `temperatures.bed`, `temperatures.chamber`, `print.progress`, `print.currentLayer`, `print.totalLayers`, `print.timeRemaining`, and `ams` (raw AMS data from the printer).

#### list_printer_files

List files stored on the printer's SD card. Scans the `cache/`, `timelapse/`, and `logs/` directories and returns both a flat list and a directory-grouped breakdown.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### upload_gcode

Write G-code content from a string directly to the printer's `cache/` directory. The content is written to a temporary file and uploaded via FTPS.

```json
{
  "filename": "calibration.gcode",
  "gcode": "G28\nM104 S210\nG1 X100 Y100 Z10 F3000\n",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### upload_file

Upload a local file (G-code or 3MF) to the printer. If `print` is `true` and the file is a `.gcode` file, `start_print_job` is called automatically after a successful upload. For `.3mf` files, upload completes normally but you must use `print_3mf` to initiate the print (which handles plate selection and metadata).

```json
{
  "file_path": "/Users/yourname/Downloads/part.3mf",
  "filename": "part.3mf",
  "print": false,
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### start_print_job

Start printing a `.gcode` file that is already on the printer's SD card. Do not use this for `.3mf` files -- use `print_3mf` instead, which handles the `project_file` MQTT command with proper metadata.

```json
{
  "filename": "cache/calibration.gcode",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

If `filename` does not include a directory prefix, the server prepends `cache/` automatically.

#### cancel_print

Cancel the currently running print job. Sends an `UpdateState` MQTT command with `state: "stop"`.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### set_temperature

Set the target temperature for the bed or nozzle. Dispatches an M140 (bed) or M104 (nozzle) G-code command via MQTT. Valid range is 0 to 300 degrees Celsius. Accepted values for `component` are `bed`, `nozzle`, `extruder`, `tool`, and `tool0`.

```json
{
  "component": "nozzle",
  "temperature": 220,
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### print_3mf

The primary tool for the direct local Bambu path. This tool handles the complete workflow:

1. Checks whether the 3MF contains embedded G-code (`Metadata/plate_<n>.gcode` entries).
2. If no G-code is found, automatically slices the file using the configured slicer before proceeding.
3. Parses the sliced 3MF to extract the correct plate file and compute its MD5 hash.
4. Also parses `Metadata/project_settings.config` to read AMS mapping embedded by Bambu Studio or OrcaSlicer.
5. Uploads the 3MF to the printer's `cache/` directory via FTPS using `basic-ftp` directly (avoiding the bambu-js double-path bug).
6. Sends a `project_file` MQTT command with the plate path, MD5, AMS mapping (formatted as a 5-element array per the OpenBambuAPI spec), and calibration flags.

This path uses BambuStudio/Orca/FULU as a slicer CLI only. It does not use FULU's BambuNetwork runtime unless you explicitly set `connection_mode: "bambu_network"`.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "bed_type": "textured_plate",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token",
  "slicer_type": "orcaslicer-bambulab",
  "slicer_path": "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
  "plate_index": 0,
  "bed_leveling": true,
  "flow_calibration": true,
  "vibration_calibration": true,
  "timelapse": false,
  "use_ams": true,
  "ams_mapping": [0, 1]
}
```

`bambu_model` is **required** -- it ensures the slicer generates G-code for the correct printer. Using the wrong model can cause the bed to crash into the nozzle. If `bambu_model` is not provided in the tool call and `BAMBU_MODEL` is not set in the environment, the server will ask you interactively via MCP elicitation (if your client supports it) or return a clear error.

`bed_type` defaults to `textured_plate` if omitted. AMS mapping from the 3MF's slicer config is used automatically when present; the `ams_mapping` argument overrides it. Setting `use_ams: false` disables AMS entirely regardless of other mapping values.

`slicer_type`, `slicer_path`, and `slicer_profile` only matter when `print_3mf` receives an unsliced 3MF and needs to auto-slice it. Use `orcaslicer-bambulab` for FULU's fork, `orcaslicer` for upstream OrcaSlicer, or `bambustudio` for BambuStudio. `plate_index` is zero-based and selects which embedded `Metadata/plate_<n>.gcode` file to print.

Layer height, nozzle temperature, and other slicer parameters cannot be overridden via this tool -- they are baked into the 3MF's G-code at slice time. Apply those settings in your slicer before generating the 3MF.

On firmware that enforces Bambu's newer command verification, this direct path can upload the 3MF and still be rejected when the printer receives the MQTT `project_file` command. In that case, `get_printer_status` may show HMS `0500050000010007`, which BambuStudio's own HMS table describes as `MQTT Command verification failed`. That is the exact situation the FULU bridge path is meant to keep iterating on.

To use FULU's restored BambuNetwork path from the same tool, pass `connection_mode: "bambu_network"`. In that mode, local `BAMBU_SERIAL`/`BAMBU_TOKEN` are not required for cloud print starts, but `dev_id` is required.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_mode": "bambu_network",
  "connection_type": "cloud",
  "dev_id": "01P00A123456789"
}
```

#### print_3mf_bambu_network

Start a 3MF print through FULU OrcaSlicer-bambulab's restored BambuNetwork runtime. This tool builds FULU-compatible `PrintParams`, converts `plate_index` from MCP zero-based to FULU one-based indexing, preserves slicer auto-slice behavior for unsliced 3MFs, and sends the job through the bridge.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_type": "cloud",
  "dev_id": "01P00A123456789",
  "bed_type": "textured_plate",
  "plate_index": 0,
  "use_ams": true,
  "ams_mapping": [0, 1]
}
```

The tool treats any non-zero numeric return from FULU's print method as a failure, even if the bridge response itself says `ok: true`. This matters because the bridge can successfully load and call the network library while the library returns a BambuNetwork print error such as `-4030`.

When debugging, start with the defaults:

- `connection_type: "cloud"` uses `start_print`.
- `connection_type: "lan"` uses `start_local_print`.
- Add `bambu_network_method: "start_local_print_with_record"` to mimic Orca's richer LAN path.

For LAN/local bridge printing, include `dev_ip` and the printer access code:

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "connection_type": "lan",
  "dev_id": "01P00A123456789",
  "dev_ip": "192.168.1.100",
  "bambu_token": "your_access_token"
}
```

#### bambu_network_bridge_status

Inspect the configured FULU bridge command and runtime. Pass `connect: true` to start the bridge, run `bridge.handshake`, create a BambuNetwork agent, and return the handshake plus macOS runtime hints.

```json
{
  "connect": true,
  "country_code": "US"
}
```

Use this before every print debugging session. Useful fields:

| Field | What it means |
|---|---|
| `configured` | Whether `BAMBU_NETWORK_BRIDGE_COMMAND` or an equivalent env var is set. |
| `connected` | Whether the bridge process started and agent initialization completed for this probe. |
| `agentReady` | Whether the MCP has an initialized BambuNetwork agent handle. |
| `handshake.network_loaded` | Whether FULU's BambuNetwork library loaded. |
| `handshake.source_loaded` | Whether FULU's BambuSource library loaded. |
| `handshake.network_actual_abi_version` | The ABI version reported by the loaded network library. The MCP can auto-retry with this value. |
| `runtime.macosMissingRuntimeFiles` | Missing macOS runtime files under `~/Library/Application Support/OrcaSlicer/macos-bridge/runtime`. |
| `runtime.macosMissingPluginFiles` | Missing macOS wrapper/install/verify files under the FULU plugin directory. |

#### bambu_network_call

Call a raw FULU bridge method. By default the tool initializes an agent and injects its `agent` id into the payload. Set `with_agent: false` for methods such as `bridge.handshake`.

```json
{
  "method": "net.is_user_login",
  "payload": {}
}
```

Examples:

```json
{
  "method": "bridge.handshake",
  "payload": {},
  "with_agent": false
}
```

```json
{
  "method": "net.get_user_selected_machine",
  "payload": {}
}
```

Raw bridge calls are for diagnostics and compatibility testing. Do not paste account `user_info` JSON or access tokens into issue reports.

</details>

<details>
<summary><strong>Click to expand Slicing Tools</strong></summary>

### Slicing Tools

#### slice_stl

Slice an STL or 3MF file using an external slicer and return the path to the output file. The output is a sliced 3MF for Bambu-compatible slicers (`bambustudio`, `orcaslicer`, `orcaslicer-bambulab`) or a G-code file for PrusaSlicer, Cura, and Slic3r.

```json
{
  "stl_path": "/path/to/model.stl",
  "bambu_model": "p1s",
  "slicer_type": "orcaslicer-bambulab",
  "slicer_path": "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
  "slicer_profile": "/path/to/profile.ini"
}
```

`slicer_type` options: `bambustudio`, `orcaslicer`, `orcaslicer-bambulab`, `prusaslicer`, `cura`, `slic3r`. Aliases such as `fulu-orca`, `orca-studio`, and `orca-bambulab` are accepted. When omitted, the value from the `SLICER_TYPE` environment variable is used (default: `bambustudio`).

`slicer_path` and `slicer_profile` fall back to the `SLICER_PATH` and `SLICER_PROFILE` environment variables when omitted.

For printing on a Bambu printer, the recommended workflow is: slice with `orcaslicer-bambulab`, `orcaslicer`, or `bambustudio` to get a sliced 3MF, then pass that output path to `print_3mf`.

#### Bambu-compatible Slicer Options

When `slicer_type` is `bambustudio`, `orcaslicer`, or `orcaslicer-bambulab`, these additional parameters are available on `slice_stl`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `uptodate` | boolean | Update 3MF configs to latest Bambu-compatible presets |
| `repetitions` | number | Number of copies to print |
| `orient` | boolean | Auto-orient model for optimal printability |
| `arrange` | boolean | Auto-arrange objects on the build plate |
| `ensure_on_bed` | boolean | Lift floating models onto the bed |
| `clone_objects` | string | Clone counts per object, comma-separated (e.g. `"1,3,1,10"`) |
| `skip_objects` | string | Object indices to skip, comma-separated (e.g. `"3,5,10"`) |
| `load_filaments` | string | Filament profile paths, semicolon-separated |
| `load_filament_ids` | string | Filament-to-object mapping, comma-separated |
| `enable_timelapse` | boolean | Enable timelapse-aware slicing |
| `allow_mix_temp` | boolean | Allow mixed-temperature filaments on one plate |
| `scale` | number | Uniform scale factor |
| `rotate` | number | Z-axis rotation in degrees |
| `rotate_x` | number | X-axis rotation in degrees |
| `rotate_y` | number | Y-axis rotation in degrees |
| `min_save` | boolean | Produce smaller output 3MF (faster uploads) |
| `skip_modified_gcodes` | boolean | Ignore stale custom gcodes in the 3MF |
| `slice_plate` | number | Which plate to slice (0 = all plates, default: 0) |

**Example: Slice with auto-orient and 3 copies**
```json
{
  "stl_path": "/path/to/model.stl",
  "bambu_model": "p1s",
  "orient": true,
  "arrange": true,
  "repetitions": 3
}
```

#### Smart Defaults (print_3mf auto-slice)

When `print_3mf` detects an unsliced 3MF and auto-slices it, these defaults are applied automatically:

- `uptodate: true` -- prevents stale config bugs from downloaded 3MFs
- `ensure_on_bed: true` -- safety net, lifts floating models onto the bed
- `min_save: true` -- smaller output for faster FTP uploads to the printer
- `skip_modified_gcodes: true` -- strips custom gcodes from other users' profiles

These defaults keep you safe when printing downloaded models. When calling `slice_stl` directly, you have full control over every flag.

</details>

<details>
<summary><strong>Click to expand Advanced Tools</strong></summary>

### Advanced Tools

#### blender_mcp_edit_model

Send a set of named edit operations (remesh, boolean, decimate, etc.) to a Blender MCP bridge command for advanced mesh work that goes beyond what the built-in STL tools support.

When `execute` is `false` (the default), the tool returns the payload that would be sent without running anything -- useful for previewing what would be dispatched.

When `execute` is `true`, the server invokes the configured bridge command with the payload as a JSON-encoded environment variable (`MCP_BLENDER_PAYLOAD`). The bridge command must be set via the `BLENDER_MCP_BRIDGE_COMMAND` environment variable or passed inline as `bridge_command`.

```json
{
  "stl_path": "/path/to/model.stl",
  "operations": ["remesh", "decimate:0.5", "boolean_union:/path/to/other.stl"],
  "execute": false
}
```

```json
{
  "stl_path": "/path/to/model.stl",
  "operations": ["remesh"],
  "bridge_command": "/usr/local/bin/blender-mcp-bridge",
  "execute": true
}
```

</details>

---

## Available Resources

Resources follow the MCP resource protocol and can be read by calling `ReadResource` with a URI. The server also lists them via `ListResources`.

### Printer resources

- `printer://{host}/status` -- Current printer status. Equivalent to calling `get_printer_status`. Returns a JSON object with temperature, progress, layer, AMS, and raw state data.

- `printer://{host}/files` -- File listing for the printer's SD card. Equivalent to calling `list_printer_files`. Returns files grouped by directory.

**Example:** To read the status of the default printer, use URI `printer://192.168.1.100/status`. The host segment must match a configured printer IP; the server uses `PRINTER_HOST` if the default URI template is used.

---

## Example Commands for Claude

After connecting the MCP server in Claude Desktop or Claude Code, you can ask Claude to perform these operations directly in conversation.

### Printer status and control

- "What is the current status of my Bambu printer?"
- "What temperature is the bed at right now?"
- "Show me the files on my printer's SD card."
- "Cancel the current print job."
- "Set the nozzle temperature to 220 degrees."
- "Set the bed to 65 degrees."

### Printing 3MF files

- "Print the file at ~/Downloads/bracket.3mf on my Bambu printer."
- "Upload bracket.3mf to the printer and start printing with AMS slots 0 and 1."
- "Print my_model.3mf with bed leveling enabled and vibration calibration off."
- "Upload this 3MF without printing it yet."
- "Slice model.stl with FULU OrcaSlicer-bambulab and then print the result."
- "Probe the FULU BambuNetwork bridge and tell me whether the macOS runtime is ready."
- "Print bracket.3mf through FULU BambuNetwork cloud printing on my P1S."

### STL manipulation

- "What are the dimensions of this STL file?"
- "Scale model.stl to twice its current size."
- "Scale this model so it is 150% as wide but stays the same height."
- "Rotate this STL 90 degrees around the Z axis."
- "Extend the base of this model by 3mm so it sticks to the bed better."
- "Center this model at the origin."
- "Orient this model so its largest flat face is on the bottom."
- "Merge any near-duplicate vertices in this STL to clean it up."

### Combined workflows

- "Rotate model.stl 45 degrees around Z, extend the base by 2mm, then print it on my Bambu P1S."
- "Take this unsliced 3MF, slice it with OrcaSlicer-bambulab, and print the result."
- "Scale this part to 80% of its size, lay it flat, and start a print."

---

## Troubleshooting and Tester Reports

The fastest way to improve this is to keep reports concrete. A print command that was merely published is not the same thing as a printer starting motion. Always check the printer status after a print attempt.

### Quick diagnosis flow

1. Run `get_printer_status` first. Confirm the printer is connected, idle, has an SD card/storage available, and reports the expected model.
2. If using a source checkout, run `npm run build` and `npm test` so local TypeScript or behavior-test failures are separated from printer/runtime failures.
3. If using direct local printing, call `print_3mf`, then immediately call `get_printer_status` again. Look for `gcode_state`, `subtask_name`, `mc_percent`, and `hms`.
4. If using FULU, call `bambu_network_bridge_status` with `connect: true` before printing. Confirm `network_loaded`, `source_loaded`, and `agentReady`.
5. Try the default FULU method for your connection type. If LAN fails, retry with `bambu_network_method: "start_local_print_with_record"` and include the return code in your report.
6. Report whether the printer actually left `IDLE`. A returned value of `0` is useful, but printer motion/status is the proof.

### Common symptoms

| Symptom | Likely layer | What to check |
|---|---|---|
| `BAMBU_MODEL is required` | Safety gate | Set `BAMBU_MODEL` or pass `bambu_model`. The server intentionally refuses to guess printer model for print operations. |
| Slicer CLI cannot find a Bambu profile | Slicer setup | Use BambuStudio or Orca/FULU with installed printer profiles, or set `BAMBU_SLICER_PROFILE_DIRS` for custom profile locations. |
| `3MF does not contain Metadata/plate_<n>.gcode` | Unsliced file | Let `print_3mf` auto-slice with a configured slicer, or export a sliced 3MF from BambuStudio/Orca/FULU first. |
| FTPS upload fails | Local LAN file path/auth | Confirm Developer Mode/LAN access code, printer IP, port `990`, and SD card/storage state. |
| Direct path says command sent but printer stays `IDLE` | Printer rejected MQTT command | Check `hms`; `0500050000010007` means `MQTT Command verification failed`. Try the FULU bridge path and report firmware/model details. |
| `bambu_network_bridge_status` cannot start | Bridge command/runtime | Check `BAMBU_NETWORK_BRIDGE_COMMAND`, wrapper path, runtime files, and Lima/WSL setup. |
| FULU print returns `-4030` or `send msg failed` | BambuNetwork runtime/printer acceptance | Bridge reached the library, but the print start failed. Report method, platform, firmware, connection type, and redacted bridge status. |
| Bridge loads only after ABI retry | Expected with some FULU builds | The MCP auto-detects `network_actual_abi_version`; include it in reports but do not manually set it unless debugging. |

### Minimal useful report

Please include:

- OS and architecture: for example `macOS 15 Apple Silicon`, `Ubuntu x86_64`, or `Windows 11 + WSL 2`.
- Install source: npm package version, git commit SHA, or local branch.
- Printer model and firmware version.
- Slicer used: `bambustudio`, `orcaslicer`, or `orcaslicer-bambulab`.
- Print path used: direct `print_3mf`, `print_3mf` with `connection_mode: "bambu_network"`, or `print_3mf_bambu_network`.
- FULU method if applicable: `start_print`, `start_local_print`, `start_local_print_with_record`, `start_send_gcode_to_sdcard`, or `start_sdcard_print`.
- Redacted `bambu_network_bridge_status` output when using FULU.
- Return payload from the failed tool call with access codes, serial numbers, tokens, cloud account data, and local usernames redacted.
- `get_printer_status` after the attempt, especially `gcode_state` and `hms`.

Please do not include:

- Full printer serial number.
- LAN access code.
- Bambu account token or raw `user_info` JSON.
- Public IPs, VPN hostnames, or home-network details that are not needed for debugging.

---

## Bambu Lab Printer Limitations

Understanding these constraints will help you avoid frustrating errors and set appropriate expectations.

1. **Printable 3MF required for print_3mf.** The `print_3mf` tool expects a sliced 3MF containing at least one `Metadata/plate_<n>.gcode` entry. If you pass an unsliced 3MF (one exported from a CAD tool without slicing), the server will attempt to auto-slice it using the configured slicer. If auto-slicing fails, the tool errors out rather than sending an incomplete command to the printer.

2. **Layer height, temperature, and slicer settings are baked in.** The `project_file` MQTT command tells the printer which plate to run. It does not support overriding layer height, temperature targets, infill percentage, or other slicing parameters at print time. These must be set in your slicer before generating the 3MF.

3. **G-code and 3MF jobs use different command paths.** `start_print_job` sends a `GCodeFileCommand` over MQTT and is intended only for plain G-code files stored in the `cache/` directory. `.3mf` files must go through `print_3mf`, which sends the `project_file` command with plate selection, MD5 verification, and AMS mapping. Mixing these up will result in the printer either ignoring the command or displaying an error.

4. **Temperature commands depend on printer state.** `set_temperature` dispatches M104 or M140 G-code via MQTT. Whether the printer accepts these commands depends on its current firmware version and operational state. Some printer states (such as the idle screen with AMS management open) may ignore or queue the commands.

5. **Real-time status has latency.** `get_printer_status` sends a `push_all` MQTT request and waits up to 1.5 seconds for a response before reading cached state. If the printer is not responding quickly (busy, sleeping, or transitioning states), you may see slightly stale data. There is no persistent event subscription in this server -- each status call is a fresh request.

6. **Direct MCP printing is LAN-only; FULU bridge printing is opt-in.** The default MQTT/FTPS tools require the printer to be on the same local network as the machine running this server with Developer Mode enabled. Remote/cloud printing requires the optional FULU BambuNetwork bridge and `print_3mf_bambu_network`.

7. **Self-signed TLS certificate.** The printer's FTPS server uses a self-signed certificate. The `basic-ftp` client is configured with `rejectUnauthorized: false` to accept it. This is standard for local network Bambu connections but assumes a trusted local network environment.

8. **Newer firmware can reject third-party project commands after upload.** A successful FTPS upload and MQTT publish does not guarantee the printer accepted the job. On the macOS test bench, the printer returned HMS `0500050000010007`, which BambuStudio describes as `MQTT Command verification failed`. This README calls that out because pretending the job started would waste everyone's time.

---

## General Limitations and Considerations

### Memory usage

STL manipulation tools load the entire mesh into memory as Three.js geometry. For large files:

- Files over 10 MB can consume several hundred MB of RAM during processing.
- Running multiple operations sequentially on large files may cause memory to accumulate between garbage collection cycles.
- If you encounter out-of-memory errors, try splitting large operations or working with smaller/simplified meshes.
- The server has no built-in memory cap. On constrained systems, set the `TEMP_DIR` to a fast local path and avoid processing multiple large files concurrently.

### STL manipulation limitations

- `lay_flat` identifies the largest flat face by analyzing surface normals. It works reliably on mechanical parts with clear flat faces and less reliably on organic or curved models where no single dominant face exists.
- `extend_stl_base` adds a new rectangular solid beneath the model. For models with complex or non-planar undersides, the result may include gaps or intersections at the join. Review the modified STL before printing.
- `merge_vertices` uses a distance tolerance to identify near-duplicate vertices. Setting the tolerance too high can alter model geometry. The default of 0.01 mm is safe for most models.
- Non-manifold meshes (meshes with holes, overlapping faces, or internal geometry) may produce unpredictable results for any transformation operation. Use a mesh repair tool (Meshmixer, PrusaSlicer's repair function, or Bambu Studio's repair option) before working with problematic files.

### Performance considerations

- Slicing with BambuStudio or OrcaSlicer CLI can take 30 seconds to several minutes depending on model complexity, layer height, and your system's CPU. The `slice_stl` call is synchronous and will block until the slicer process completes.
- FTPS uploads for large 3MF files (multi-plate prints, high-detail models) may take 15 to 60 seconds depending on your local network speed.
- MQTT connections are pooled by `host + serial` key. The first call to any printer tool in a session establishes the MQTT connection; subsequent calls reuse it. If the connection drops (printer power cycled, network interruption), the next call will reconnect automatically.

---

## License

GPL-2.0. See [LICENSE](./LICENSE) for the full text.

This project is a fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) by David Montgomery, also GPL-2.0.
