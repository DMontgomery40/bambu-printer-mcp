# bambu-printer-mcp

[![npm version](https://img.shields.io/npm/v/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-green.svg)](https://nodejs.org/en/download/)
[![GitHub stars](https://img.shields.io/github/stars/DMontgomery40/bambu-printer-mcp.svg?style=social&label=Star)](https://github.com/DMontgomery40/bambu-printer-mcp)
[![Downloads](https://img.shields.io/npm/dm/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)

A Bambu Lab-focused MCP server for controlling Bambu printers, manipulating STL files, and managing end-to-end 3MF print workflows from Claude Desktop, Claude Code, or any MCP-compatible client.

This is a stripped-down, Bambu-only fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server). All OctoPrint, Klipper, Duet, Repetier, Prusa Connect, and Creality Cloud support has been removed. What remains is a focused, lean implementation for Bambu Lab hardware.

Local handoff note: see [REMOTE-DEPLOYMENT.md](./REMOTE-DEPLOYMENT.md) for the custom H2D/H2S patches, per-printer MCP split, and remote deployment plan used in this clone.

---

## What's new in bambu-printer-mcp

This fork adds a substantial set of printer control tools beyond the upstream `mcp-3D-printer-server`. Everything listed below is unique to this package.

### v1.1.0 — AMS auto-match, camera snapshot, pause/resume, skip objects

- **AMS auto-match by RFID** (`auto_match_ams` on `print_3mf`) — resolves sliced 3MF filament requirements against live AMS inventory. Handles same-SKU different-color filaments. Dry-run with `resolve_3mf_ams_slots`.
- **Structured AMS inventory** (`get_printer_filaments`) — per-tray display names, profile resolution tier (`exact-model-nozzle`/`model`/`generic`/`unresolved`), match confidence, and a summary with recommended auto-slice filament.
- **AMS settle-time retry** — transparently retries when AMS data hasn't arrived on the first MQTT push from an idle printer.
- **Camera snapshot** (`camera_snapshot`) — JPEG from the chamber camera. TCP-on-6000 for A1/P1S/P1P, RTSP via ffmpeg for X1/P2S/H2 series.
- **Pause / resume** (`pause_print`, `resume_print`) — alongside the existing `cancel_print`.
- **Skip objects** (`skip_objects`) — skip specific object IDs during a running multi-object print. IDs from `list_3mf_plate_objects`.
- **HMS diagnostics** (`printer://{host}/hms` MCP resource) — read-only error summary with automatic settle retry.
- **Utility controls** — `set_print_speed` (silent/standard/sport/ludicrous), `clear_hms_errors`, `reread_ams_rfid`, `set_airduct_mode` (cooling/heating for H2/P2).
- **H2/H2D-safe print path** — correct `project_file` format with `ams_mapping2` parallel array, H2 firmware quirks handled.
- **BambuStudio CLI auto-flatten** (`BAMBU_CLI_FLATTEN=true`) — works around upstream profile inheritance bugs.
- **Print collar charm** (`print_collar_charm`) — specialized two-color wrapper with fixed tray policy.

### v1.1.1 — AMS dryer control (current)

- **AMS dryer start/stop** (`set_ams_drying`) — sends `print.ams_control` MQTT command. Works on heated AMS units (AMS Pro / AMS-HT). Action: `start` or `stop`, target by AMS index 0–3.
- Same-SKU different-color fix for `auto_match_ams`.
- AMS and HMS settle-time retry for idle printers.
- Validation script (`scripts/validate-printer.mjs`) for live printer testing.

> Full changelog at [CHANGELOG.md](./CHANGELOG.md).

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
- [Enabling Developer Mode (Required)](#enabling-developer-mode-required)
- [Finding Your Bambu Printer's Serial Number and Access Token](#finding-your-bambu-printers-serial-number-and-access-token)
- [AMS (Automatic Material System) Setup](#ams-automatic-material-system-setup)
- [Bambu Communication Notes (MQTT and FTP)](#bambu-communication-notes-mqtt-and-ftp)
  - [What this fork fixes](#what-this-fork-fixes)
  - [Verified print procedure (H2S, LAN-only, no client cert)](#verified-print-procedure-h2s-lan-only-no-client-cert)
- [Available Tools](#available-tools)
  - [STL Manipulation Tools](#stl-manipulation-tools)
  - [Printer Control Tools](#printer-control-tools)
  - [Slicing Tools](#slicing-tools)
  - [Advanced Tools](#advanced-tools)
- [Available Resources](#available-resources)
- [Example Commands for Claude](#example-commands-for-claude)
- [Bambu Lab Printer Limitations](#bambu-lab-printer-limitations)
- [General Limitations and Considerations](#general-limitations-and-considerations)
  - [Memory usage](#memory-usage)
  - [STL manipulation limitations](#stl-manipulation-limitations)
  - [Performance considerations](#performance-considerations)
- [License](#license)

</details>

---

## Description

`bambu-printer-mcp` is a Model Context Protocol server that gives Claude (or any MCP client) direct control over Bambu Lab 3D printers. The verified end-to-end path is: **slice in Bambu Studio, export a `.gcode.3mf`, hand the path to `print_3mf`** — the server reads the slicer's metadata out of the 3MF, builds the correct AMS mapping, uploads over FTPS, and starts the print via an MQTT `project_file` command. See [docs/SLICING.md](./docs/SLICING.md) for the full recipe and why in-process slicing is not the recommended path.

**What this is not.** This package intentionally supports only Bambu Lab printers. It does not include adapters for OctoPrint, Klipper (Moonraker), Duet, Repetier, Prusa Connect, or Creality Cloud. If you need multi-printer support, use the parent project [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) instead.

**Why a separate package?** The parent project carries all printer adapters in a single binary. When working exclusively with Bambu hardware, that breadth adds unnecessary weight. This fork strips the project to its Bambu core for a smaller, faster install. Both packages share the same protocol fixes and safety features.

**Note on resource usage.** STL manipulation loads entire mesh geometry into memory. For large or complex STL files (greater than 10 MB), these operations can be memory-intensive. See [General Limitations and Considerations](#general-limitations-and-considerations) for details.

---

## Features

- Get detailed printer status: temperatures (nozzle, bed, chamber), print progress, current layer, time remaining, and live AMS slot data
- Query live AMS inventory with resolved Bambu/Orca filament profile paths via `get_printer_filaments`. Includes per-tray display names, match confidence (`high`/`medium`/`low`/`none`), resolution tier (`exact-model-nozzle`/`model`/`generic`/`unresolved`), and a summary with recommended auto-slice filament. Retries automatically when AMS data hasn't arrived yet (common on first MQTT push from idle printers).
- List, upload, and delete files on the printer's SD card via FTPS
- Capture a JPEG snapshot from the chamber camera. Supports A1, A1 mini, P1S, P1P (TCP-on-6000), and X1, X1C, X1E, P2S, H2, H2S, H2D, H2C, H2D Pro (RTSP via ffmpeg). Requires ffmpeg in PATH for the RTSP path.
- Upload and print pre-sliced `.gcode.3mf` files with full plate selection and calibration flag control (recommended path — see [docs/SLICING.md](./docs/SLICING.md))
- Optional single-color auto-slice path via BambuStudio CLI. Set `BAMBU_CLI_FLATTEN=true` to enable a workaround that flattens BBL profile inheritance before invoking the CLI — works around upstream bugs in BambuStudio CLI mode ([#9636](https://github.com/bambulab/BambuStudio/issues/9636), [#9968](https://github.com/bambulab/BambuStudio/issues/9968)). Single-color smoke is verified on H2S/H2D/X1C/P1S. H2D two-color CLI slicing is blocked upstream ([#10408](https://github.com/bambulab/BambuStudio/issues/10408)); use a GUI-sliced `.gcode.3mf` for that workflow. Default off; Path A (GUI-slice) remains the recommended workflow for non-BBL profiles, multi-color H2D jobs, or first-time prints. See [docs/SLICING.md](./docs/SLICING.md).
- Parse AMS mapping from the 3MF's embedded slicer metadata (`Metadata/plate_<n>.json` + gcode filament header) and send it correctly formatted per the OpenBambuAPI spec, with correct H2S/H2D `ams_mapping2` parallel array format
- **Auto-match AMS slots by RFID** (`auto_match_ams` flag on `print_3mf`). Resolves required `tray_info_idx` from the sliced 3MF against live AMS inventory. Handles same-SKU different-color filaments by matching on `(tray_info_idx, tray_color)` and tracking already-claimed slots. Dry-run with `resolve_3mf_ams_slots` before printing.
- Cancel, pause, and resume in-progress print jobs via MQTT
- Skip specific objects during a running multi-object print via `skip_objects` (use `list_3mf_plate_objects` to find object IDs first)
- Set print speed mode (`silent`/`standard`/`sport`/`ludicrous`), clear HMS/print errors, trigger AMS RFID re-read, and control H2/P2 airduct mode (`cooling`/`heating`) via MQTT
- **Start/stop AMS filament drying** (`set_ams_drying`) on heated AMS units (AMS Pro / AMS-HT). Sends `print.ams_control` MQTT command.
- Set nozzle and bed temperature via G-code dispatch over MQTT
- Set fan speed (part, auxiliary, chamber) and chamber light mode (on/off/flashing) via MQTT
- Read HMS (Health Management System) diagnostics as an MCP resource at `printer://{host}/hms` — read-only error summary from the printer, with automatic settle retry
- Start G-code files already stored on the printer
- **Collar charm print wrapper** (`print_collar_charm`) — specialized two-color workflow with fixed tray policy for inner (black, AMS 1 slot 1) and outer (white, AMS 2 slot 1) charm parts
- STL manipulation: scale, rotate, extend base, merge vertices, center at origin, lay flat, and inspect model info
- Slice STL or 3MF files using BambuStudio, OrcaSlicer, PrusaSlicer, Cura, or Slic3r
- Inspect slicer settings from a saved 3MF template or extracted profile via `get_slice_settings`
- Enumerate saved slicing templates from the local registry via `list_templates`
- Save templates into the local registry via `save_template`
- Slice directly from a named template via `slice_with_template`
- For simple single-material slices, auto-select the printer's current or first loaded AMS filament when no explicit slicer profile or `load_filaments` override is provided
- Template-driven slicing can reuse a saved 3MF's process settings while still pulling the live printer filament choice over MQTT
- Optional Blender MCP bridge for advanced mesh operations
- Dual transport: stdio (default, for Claude Desktop / Claude Code) and Streamable HTTP

---

## Installation

### Prerequisites

- Node.js 18 or higher
- npm
- **BambuStudio** *(optional -- only needed for slicing)* -- [download from bambulab.com](https://bambulab.com/en/download/studio). Required by `slice_stl` and `print_3mf` auto-slice (when a 3MF has no embedded gcode). Not needed if you only print pre-sliced 3MF files. Default path: `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio` (macOS); set `SLICER_PATH` if installed elsewhere.

### Run without installing (npx)

The fastest way to get started. No global install required:

```bash
npx @rowbotik/bambu-printer-mcp
```

Set environment variables inline or via a `.env` file in your working directory (see [Configuration](#configuration)).

### Install globally from npm

```bash
npm install -g @rowbotik/bambu-printer-mcp
```

After installation, the `bambu-printer-mcp` command is available in your PATH.

### Install from source

```bash
git clone https://github.com/rowbotik/bambu-printer-mcp.git
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
# Compatible aliases also accepted:
# BAMBU_PRINTER_HOST / BAMBU_PRINTER_SERIAL / BAMBU_PRINTER_ACCESS_TOKEN

# --- Printer model (CRITICAL for safe operation) ---
BAMBU_MODEL=p1s                   # Your printer model: p1s, p1p, x1c, x1e, a1, a1mini, h2d, h2s
# Alias also accepted: BAMBU_PRINTER_MODEL
BED_TYPE=textured_plate           # Bed plate type: textured_plate, cool_plate, engineering_plate, hot_plate, supertack_plate
NOZZLE_DIAMETER=0.4               # Nozzle diameter in mm (default: 0.4)

# --- Slicer configuration (required for slice_stl and print_3mf auto-slice) ---
SLICER_TYPE=bambustudio           # Options: bambustudio, prusaslicer, orcaslicer, cura, slic3r
SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
                                  # Default on macOS. Adjust for your OS and install path.
# Alias also accepted: BAMBU_STUDIO_PATH
SLICER_PROFILE=                   # Optional: path to a slicer profile/config file

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
| `PRINTER_HOST` | `localhost` | Yes | IP address of the Bambu printer. Alias: `BAMBU_PRINTER_HOST` |
| `BAMBU_SERIAL` | | Yes | Printer serial number. Alias: `BAMBU_PRINTER_SERIAL` |
| `BAMBU_TOKEN` | | Yes | LAN access token. Alias: `BAMBU_PRINTER_ACCESS_TOKEN` |
| `BAMBU_MODEL` | | **Yes** | Printer model: `p1s`, `p1p`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`, `h2s`. **Required for safe operation** -- determines the correct G-code generation. Alias: `BAMBU_PRINTER_MODEL`. If omitted and the MCP client supports elicitation, the server will ask you interactively. |
| `BED_TYPE` | `textured_plate` | No | Bed plate type: `textured_plate`, `cool_plate`, `engineering_plate`, `hot_plate`, `supertack_plate` |
| `NOZZLE_DIAMETER` | `0.4` | No | Nozzle diameter in mm. Used to select the correct BambuStudio machine preset. |
| `SLICER_TYPE` | `bambustudio` | No | Slicer to use for slicing operations |
| `SLICER_PATH` | BambuStudio macOS path | No | Full path to the slicer executable. Alias: `BAMBU_STUDIO_PATH` |
| `SLICER_PROFILE` | | No | Path to a slicer profile or config file |
| `TEMP_DIR` | `./temp` | No | Directory for intermediate files |
| `MCP_TRANSPORT` | `stdio` | No | Transport mode: `stdio` or `streamable-http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | No | HTTP bind address (HTTP transport only) |
| `MCP_HTTP_PORT` | `3000` | No | HTTP port (HTTP transport only) |
| `MCP_HTTP_PATH` | `/mcp` | No | HTTP endpoint path (HTTP transport only) |
| `MCP_HTTP_STATEFUL` | `true` | No | Enable stateful HTTP sessions |
| `MCP_HTTP_JSON_RESPONSE` | `true` | No | Return structured JSON alongside text responses |
| `MCP_HTTP_ALLOWED_ORIGINS` | | No | Comma-separated list of allowed CORS origins |
| `BLENDER_MCP_BRIDGE_COMMAND` | | No | Command to invoke Blender MCP bridge |
| `BAMBU_CLI_FLATTEN` | `false` | No | When `true`, the MCP flattens BBL profile inheritance before invoking the BambuStudio CLI. Workaround for upstream issues [#9636](https://github.com/bambulab/BambuStudio/issues/9636) / [#9968](https://github.com/bambulab/BambuStudio/issues/9968). BBL printers only. Single-color smoke verified on H2S/H2D/X1C/P1S; H2D two-color CLI slicing remains blocked by [#10408](https://github.com/bambulab/BambuStudio/issues/10408). See [docs/SLICING.md](./docs/SLICING.md). |
| `BAMBU_PROFILES_ROOT` | derived from `SLICER_PATH` | No | Override path to the BambuStudio `Resources/profiles` directory used by the CLI flattener. Useful for non-standard installs or dev environments. |

SuperTack can be passed for pre-sliced print jobs, but BambuStudio CLI slicing currently fails fast for `supertack_plate` because the accepted CLI bed identifier is not verified. Use a pre-sliced 3MF for SuperTack until this is confirmed.

---

## Usage

Add this server to your MCP client's config (Claude Desktop, Claude Code, Cursor, Codex CLI, or any MCP-compatible client). The config format is the same everywhere -- an `mcpServers` entry with the command and env vars:

```json
{
  "mcpServers": {
    "bambu-printer": {
      "command": "npx",
      "args": ["-y", "@rowbotik/bambu-printer-mcp"],
      "env": {
        "PRINTER_HOST": "192.168.1.100",
        "BAMBU_SERIAL": "01P00A123456789",
        "BAMBU_TOKEN": "your_access_token",
        "BAMBU_MODEL": "p1s",
        "SLICER_TYPE": "bambustudio",
        "SLICER_PATH": "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"
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

## Enabling Developer Mode (Required)

This MCP server communicates directly with your printer over your local network using MQTT and FTPS. For this to work, **Developer Mode** must be enabled on the printer. Without it, the printer will reject third-party LAN connections even if you have the correct access code.

On H2D/H2-series firmware, the printer may stream `push_status` data without ever answering the legacy `get_version` handshake used by older libraries. This fork treats the live status stream as authoritative and does not require that extra ACK before considering the connection usable.

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

When you slice a model in Bambu Studio, the slicer embeds AMS mapping information inside the 3MF file at `Metadata/project_settings.config`. The `print_3mf` tool reads this file automatically and extracts the correct mapping. In most cases, you do not need to specify `ams_mapping` manually -- the tool handles it.

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

### Auto-match AMS by RFID

For pre-sliced 3MFs that declare filament types, the `auto_match_ams` flag on `print_3mf` (or the standalone `resolve_3mf_ams_slots` dry-run tool) automatically resolves the required filaments against your live AMS inventory. The matcher works as follows:

1. Reads the required `tray_info_idx` values from the 3MF's `Metadata/slice_info.config` and `Metadata/plate_<n>.json`
2. Reads your live AMS trays from the printer's MQTT status push
3. Matches on `(tray_info_idx, tray_color)` — so two filaments of the same SKU but different colors (e.g. two GFG02 PETG HF spools in black and white) resolve to different slots
4. Tracks already-claimed slots so two requirements can't collapse onto the same physical position
5. Falls back to SKU-only matching when the 3MF carries no color data or only one tray of that SKU is loaded

If resolution fails, returns a structured `missing` report with per-requirement reasons:
- `no_loaded_match` — no AMS tray of that SKU is loaded
- `color_mismatch` — the SKU matches but the loaded color differs
- `exhausted` — all matching trays are already claimed by other requirements
- `no_sku` — the 3MF doesn't declare a `tray_info_idx` for this filament

Dry-run with `resolve_3mf_ams_slots` before printing to preview the match without uploading or starting a job.

### AMS settle-time handling

The first MQTT status push from an idle printer is often sparse (model/module info only) — AMS slot data arrives on a second push. The server's filament inventory and HMS handlers both retry after a 1.5-second settle window when the expected data isn't present in the first response. This is transparent to the caller.

### Checking AMS status

Use `get_printer_filaments` for the parsed, enriched view (profile paths, display names, match confidence) or `get_printer_status` for the raw AMS data from the printer:

```
"What filaments are loaded in my AMS right now?"
```

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

According to the OpenBambuAPI spec, P1/A1/X1-series printers use a 5-element `ams_mapping` array where position `i` is the project filament index and the value is the AMS slot feeding that filament. For example, a single-filament print from AMS slot 0 sends `[0, -1, -1, -1, -1]`.

This fork sends the `project_file` command directly via `bambu-node` (bypassing `bambu-js` entirely for print initiation) and constructs the mapping in the format the target firmware expects:

```typescript
// P1/A1/X1-series: 5-element project lookup table
ams_mapping = [0, -1, -1, -1, -1];

// H2S/H2D: project-length lookup table + parallel ams_mapping2
ams_mapping = [-1, 1, -1, -1];
ams_mapping2 = [
  { ams_id: 255, slot_id: 255 },
  { ams_id: 0, slot_id: 1 },
  { ams_id: 255, slot_id: 255 },
  { ams_id: 255, slot_id: 255 }
];
```

The command payload also includes all required fields per the OpenBambuAPI spec: `param` (the internal gcode path within the 3MF), `url` (the sdcard path), `md5` (computed from the plate's embedded gcode), and all calibration flags.

### Verified print procedure (H2S, LAN-only, no client cert)

This is the sequence that successfully started a print on an H2S running current (post-Jan 2025) firmware in LAN-only mode. It's documented here because several common approaches fail on this firmware, and this fork's transport is what makes it reliable.

**Result:** print started in `RUNNING` state, printer accepted the MQTT `project_file` command, no client certificate was required. Authentication was plain `bblp` + LAN access code over TLS with `rejectUnauthorized: false`.

**What doesn't work on stock bambu-cli:**

- `bambu-cli print start <file>` and `bambu-cli files upload` both fail with `522 SSL connection failed: session reuse required`. Bambu's FTPS server requires TLS session reuse between the control and data channels, which the Go FTPS client in bambu-cli does not negotiate correctly.
- `bambu-cli print start --no-upload` still opens an FTPS session (to stat the remote file) and hits the same 522.

**What works — two-step upload + MQTT dispatch:**

1. **Upload the `.gcode.3mf` via curl** (curl's OpenSSL backend negotiates FTPS session reuse correctly):

   ```bash
   curl -k --ftp-pasv --ssl-reqd \
     -u "bblp:<ACCESS_CODE>" \
     -T /path/to/file.gcode.3mf \
     "ftps://<PRINTER_IP>:990/<remote-name>.gcode.3mf"
   ```

   Keep `<remote-name>` simple ASCII, ending in `.gcode.3mf`. The file lands at the FTP root, which corresponds to `/data/` on the printer's SD card.

2. **Send the `project_file` command over MQTT** to `device/<SERIAL>/request`:

   ```js
   import mqtt from "mqtt";
   const payload = {
     print: {
       sequence_id: "0",
       command: "project_file",
       param: "Metadata/plate_1.gcode",          // path inside the 3MF
       subtask_name: "<remote-name>.gcode.3mf",
       file: "<remote-name>.gcode.3mf",
       url: "ftp:///<remote-name>.gcode.3mf",    // three slashes, FTP root
       md5: "",
       project_id: "0", profile_id: "0", task_id: "0", subtask_id: "0",
       timelapse: false,
       bed_type: "auto",
       bed_leveling: true, bed_levelling: true,
       flow_cali: true, vibration_cali: true, layer_inspect: true,
       use_ams: true,
       ams_mapping: [0, -1, -1, -1, -1]
     }
   };
   const client = mqtt.connect(`mqtts://<PRINTER_IP>:8883`, {
     username: "bblp",
     password: "<ACCESS_CODE>",
     rejectUnauthorized: false,
   });
   client.on("connect", () => {
     client.publish(`device/<SERIAL>/request`, JSON.stringify(payload));
   });
   ```

**Notes:**

- `url` must be `ftp:///<filename>` (three slashes) — the empty host component is required; the printer rejects `ftp://<filename>` as "unsupported print file path or name".
- `param` uses the internal plate path inside the 3MF (`Metadata/plate_1.gcode` for plate 1), not a filesystem path.
- `md5: ""` is accepted; populating it is optional.
- On AMS-equipped H2 printers, `use_ams: false` does not suppress mapping lookup if the sliced file declares filaments. The working H2 path is to send `use_ams: true` plus a valid mapping. For H2, the mapping length must match the project-level filament declaration length, and the populated positions must match `plate_<n>.json.filament_ids`. Prefer `ams_slots` at the tool layer and let the server expand it. If no mapping is provided for an H2 pre-sliced job with declared filaments, the server fails before sending; pass explicit `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true`.
- No client X.509 certificate was needed. The earlier assumption that post-Jan 2025 firmware mandates mTLS on all models does not hold for the H2S in LAN mode — user/password over TLS is sufficient.
- The MCP server's `ftpUpload` helper (basic-ftp with `secure: "implicit"` and a short idle timeout) performs the equivalent upload natively and is the preferred path when using the server itself; the curl form is the manual-debug equivalent.

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

The server also accepts the alias variables `BAMBU_PRINTER_HOST`, `BAMBU_PRINTER_SERIAL`, and `BAMBU_PRINTER_ACCESS_TOKEN`, plus `BAMBU_PRINTER_MODEL` and `BAMBU_STUDIO_PATH`.

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

#### get_printer_filaments

Read the live AMS inventory and resolve each loaded tray to Bambu Studio
filament profile JSON paths when `bambu_model` is known. The result includes a
summary, per-slot display labels, profile match confidence, and a recommended
`load_filaments` value for simple single-material CLI slicing.

```json
{
  "bambu_model": "h2d",
  "nozzle_diameter": "0.4",
  "host": "192.168.1.100",
  "bambu_serial": "094...",
  "bambu_token": "your_access_token"
}
```

High-signal fields:

- `summary.loaded_slots`, `summary.resolved_profile_slots`,
  `summary.unresolved_loaded_slots`, `summary.empty_slots`
- `trays[].display_name`, `trays[].tray_color`, `trays[].remain_percent`
- `trays[].resolved_profile_path`
- `trays[].profile_resolution`: `exact-model-nozzle`, `model`, `generic`, or
  `unresolved`
- `trays[].match_confidence`: `high`, `medium`, `low`, or `none`
- `recommended.load_filaments`: the profile path the MCP will use for
  auto-slicing when no explicit filament override is provided

#### list_printer_files

List files stored on the printer's SD card. Scans the `cache/`, `timelapse/`, and `logs/` directories and returns both a flat list and a directory-grouped breakdown.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### camera_snapshot

Capture a single JPEG frame from the printer's chamber camera. Read-only.

Two transports are wired in, picked by `bambu_model`:

- **TCP-on-6000** for **A1, A1 mini, P1S, P1P**. Native protocol per [OpenBambuAPI/video.md](https://github.com/Doridian/OpenBambuAPI/blob/main/video.md): TLS on port 6000, 80-byte auth packet (`bblp` + access token), repeating 16-byte frame header + JPEG payload.
- **RTSP** for **X1, X1 Carbon, X1E, P2S** and **H2, H2S, H2D, H2C, H2D Pro**. Shells out to ffmpeg with `rtsps://bblp:<token>@<host>:322/streaming/live/1 -frames:v 1`. The H2 series wasn't documented in OpenBambuAPI's `video.md` but its firmware uses the same RTSP endpoint as X1 (verified live against an H2S, 2026-04-27).

**Requires ffmpeg in PATH** for the RTSP path. Install with `brew install ffmpeg` on macOS. Override the binary location with the `ffmpeg_path` tool argument if it lives elsewhere. The TCP-on-6000 path uses native Node TLS and does not require ffmpeg.

```json
{
  "save_path": "/tmp/snap.jpg",
  "timeout_ms": 8000,
  "bambu_model": "h2s",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

Returns `{ status, format: "image/jpeg", sizeBytes, base64, savedTo?, transport }`. `transport` is `"tcp-6000"` or `"rtsps-322"` so callers can tell which path produced the frame. Pass `save_path` to also write the bytes to disk; otherwise only the base64 payload is returned.

#### delete_printer_file

Delete a single file from the printer's SD card via FTPS. **Destructive.** Requires `confirm: true` — without it the call returns `status: "skipped"` and does not contact the printer. Path traversal segments (`..`) are rejected. Only files under `cache/`, `timelapse/`, and `logs/` can be deleted.

```json
{
  "filename": "old_print.gcode.3mf",
  "confirm": true,
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

A bare filename defaults to `cache/<filename>`. To target other directories pass a relative path:

```json
{ "filename": "timelapse/2026-04-26_12-00.mp4", "confirm": true }
{ "filename": "logs/printer.log", "confirm": true }
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

Cancel the currently running print job. Sends an `UpdateState` MQTT command with `state: "stop"`. Not resumable — use `pause_print` if you may want to continue.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### pause_print

Pause the currently running print job. Sends an `UpdateState` MQTT command with `state: "pause"`. Resumable via `resume_print`.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### resume_print

Resume a paused print job. Sends an `UpdateState` MQTT command with `state: "resume"`.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### clear_hms_errors

Clear HMS or print error state on the printer. Sends Bambu's `clean_print_error` MQTT command.

```json
{
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### set_print_speed

Set the active print speed mode. Accepted `mode` values are `silent`, `standard`, `sport`, `ludicrous`, or their numeric equivalents `1`, `2`, `3`, and `4`.

```json
{
  "mode": "sport",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### set_airduct_mode

Set H2/P2 airduct mode to `cooling` or `heating`. This is intended for supported printers only.

```json
{
  "mode": "cooling",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### reread_ams_rfid

Trigger a Bambu AMS RFID re-read for one AMS slot. This can move AMS filament; use it only when the printer is idle and unloaded.

```json
{
  "ams_id": 0,
  "slot_id": 1,
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

#### set_fan_speed

Set a printer fan speed from 0 to 100 percent. Accepted `fan` values are `part`, `auxiliary`, `chamber`, `1`, `2`, and `3`.

```json
{
  "fan": "chamber",
  "speed": 40,
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### set_light

Set a printer light node mode. Common Bambu firmware reports the chamber light as `chamber_light`; valid modes are `on`, `off`, and `flashing`.

```json
{
  "light": "chamber_light",
  "mode": "on",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### skip_objects

Skip specific object IDs during a running multi-object print. Use `list_3mf_plate_objects` on the sliced 3MF to find the IDs first.

```json
{
  "object_ids": [6495, 6496],
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

#### set_ams_drying

Start or stop the AMS filament drying cycle on heated AMS units (AMS Pro / AMS-HT). The `action` parameter accepts `start` or `stop`. The `ams_id` must be an integer from 0 to 3.

```json
{
  "action": "start",
  "ams_id": 0,
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token"
}
```

To stop drying:

```json
{
  "action": "stop",
  "ams_id": 0
}
```

#### print_3mf

The primary tool for starting a Bambu print. **Recommended input: a pre-sliced `.gcode.3mf` exported from Bambu Studio** — see [docs/SLICING.md](./docs/SLICING.md). This tool handles the complete workflow:

1. Checks whether the 3MF contains embedded G-code (`Metadata/plate_<n>.gcode` entries).
2. If no G-code is found, attempts to auto-slice via the configured slicer. This fallback is unreliable in practice (stale profiles, leftover multi-filament declarations) — prefer pre-slicing in Bambu Studio.
3. Parses the sliced 3MF to extract the correct plate file and compute its MD5 hash.
4. Also parses `Metadata/project_settings.config` to read AMS mapping embedded by Bambu Studio.
5. Uploads the 3MF to the printer's `cache/` directory via FTPS using `basic-ftp` directly (avoiding the bambu-js double-path bug).
6. Sends the correct MQTT print command for the target printer family. For H2S/H2D that means `project_file` with project-length `ams_mapping`, parallel `ams_mapping2`, and H2-compatible calibration flags.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.3mf",
  "bambu_model": "p1s",
  "bed_type": "textured_plate",
  "host": "192.168.1.100",
  "bambu_serial": "01P00A123456789",
  "bambu_token": "your_access_token",
  "bed_leveling": true,
  "flow_calibration": true,
  "vibration_calibration": true,
  "timelapse": false,
  "use_ams": true,
  "ams_mapping": [0, 1]
}
```

`bambu_model` is **required** -- it ensures the slicer generates G-code for the correct printer. Using the wrong model can cause the bed to crash into the nozzle. If `bambu_model` is not provided in the tool call and `BAMBU_MODEL` is not set in the environment, the server will ask you interactively via MCP elicitation (if your client supports it) or return a clear error.

`bed_type` defaults to `textured_plate` if omitted. `ams_slots` is the preferred override input; `ams_mapping` remains the raw escape hatch. On AMS-equipped H2 printers, `use_ams: false` does not suppress mapping lookup if the sliced file declares filaments. If no mapping is provided for an H2 pre-sliced job with declared filaments, the server fails before sending; pass explicit `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true`.

Set `auto_match_ams: true` to match the sliced 3MF's `tray_info_idx` values against the live AMS inventory and use the matching `ams_slots`. The matcher joins on `(tray_info_idx, tray_color)` and tracks already-claimed slots, so prints with two filaments of the same SKU but different colors (e.g. two GFG02 PETG HF in black and white) resolve correctly. Falls back to SKU-only when the 3MF's filament has no color set or only one tray of that SKU is loaded. Returns a structured `missing` report (`reason: "no_loaded_match" | "color_mismatch" | "exhausted" | "no_sku"`) when a filament can't be resolved. Ignored when you provide `ams_slots` or `ams_mapping` explicitly.

Layer height, nozzle temperature, and other slicer parameters cannot be overridden via this tool -- they are baked into the 3MF's G-code at slice time. Apply those settings in your slicer before generating the 3MF.

#### resolve_3mf_ams_slots

Dry-run the AMS match without uploading or starting a print. The tool reads `Metadata/plate_<n>.json` and `Metadata/slice_info.config`, then compares required `tray_info_idx` values against live AMS trays.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.gcode.3mf",
  "bambu_model": "h2d",
  "host": "192.168.1.100",
  "bambu_serial": "094...",
  "bambu_token": "your_access_token"
}
```

#### list_3mf_plate_objects

List object IDs from a sliced 3MF plate. Use this before `skip_objects` so you pass real Bambu object IDs instead of display-order guesses.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.gcode.3mf",
  "plate_index": 0
}
```

#### print_collar_charm

High-level wrapper for a prepared two-part dog-collar-charm workflow. This tool is intentionally specialized: it expects a prepared two-part charm project and applies a fixed tray policy.

- Smaller inner object -> black -> AMS 1 slot 1
- Larger outer object -> white -> AMS 2 slot 1

The tool will:

1. Resolve a local `.3mf` or `template_name`.
2. Auto-slice if the 3MF is still an unsliced project.
3. Inspect `Metadata/plate_1.json` to identify the smaller inner part and larger outer part.
4. Preflight the required AMS trays on the printer.
5. Dispatch the print through the existing H2-safe `print3mf` path using `ams_slots`.

```json
{
  "template_name": "collars/letter_charm_a",
  "bambu_model": "h2d",
  "host": "192.168.1.100",
  "bambu_serial": "03W09C123456789",
  "bambu_token": "your_access_token",
  "bed_leveling": true,
  "flow_calibration": true,
  "vibration_calibration": true,
  "timelapse": false
}
```

You can also pass `source_path` directly instead of `template_name`.

This wrapper currently assumes:

- the input is a prepared two-part charm `.3mf`, not a bare STL that needs color-region generation
- the selected plate has exactly 2 objects
- the selected plate has exactly 2 used filament positions
- the smaller object is the inner insert/letter and the larger object is the outer body

If the project does not match those assumptions, the tool fails fast with a structured error instead of guessing. The role-to-color and color-to-tray mapping is isolated in code so the next version can evolve toward customer-requested colors without replacing the whole wrapper.

</details>

<details>
<summary><strong>Click to expand Slicing Tools</strong></summary>

### Slicing Tools

> **Note:** the verified workflow is to slice in Bambu Studio (GUI) and feed the resulting `.gcode.3mf` to `print_3mf`. The CLI-driven slicing tools below (`slice_stl`, `slice_with_template`) work but are sensitive to profile drift and are not the recommended path for production prints. See [docs/SLICING.md](./docs/SLICING.md).

#### list_templates

List saved templates from the local registry directory. You can override the registry root with `BAMBU_TEMPLATE_DIR`.

```json
{}
```

Each result includes the template `name`, absolute `path`, source type, and relative path inside the registry. You can then pass `template_name` to `get_slice_settings`, `slice_stl`, or `print_3mf` instead of a raw path.

#### save_template

Copy a local `3mf`, `json`, or `.config` file into the template registry and register it under a reusable template name.

```json
{
  "source_path": "/path/to/sliced_project.3mf",
  "template_name": "collars/p1p_petg_default"
}
```

This creates the destination under the template registry directory and makes it available immediately to `list_templates`, `get_slice_settings`, `slice_with_template`, `slice_stl`, and `print_3mf`.

#### get_slice_settings

Inspect the slicer settings embedded in a saved 3MF template or in an extracted JSON/config profile without slicing anything.

```json
{
  "template_name": "h2s_template"
}
```

This returns a compact summary of the high-signal settings such as printer preset, default print profile, filament profiles, layer height, infill density, shell counts, support mode, and bed type. It accepts either `source_path` or `template_name`. For 3MF inputs it also writes the extracted settings blob to a temp path so the result can be reused directly.

#### slice_with_template

Slice an STL or 3MF using a named template from the local registry. This is a higher-level wrapper over `slice_stl` for template-based workflows.

```json
{
  "stl_path": "/path/to/model.stl",
  "template_name": "collars/p1p_petg_default",
  "bambu_model": "p1p"
}
```

This uses the named template as the slicing profile source and still supports live printer filament selection unless you explicitly override `load_filaments`. The template settings are applied at slice time, and the later `print_3mf` step computes H2-safe AMS mapping from the newly sliced output.

#### slice_stl

Slice an STL or 3MF file using an external slicer and return the path to the output file. The output is a sliced 3MF (for BambuStudio and OrcaSlicer) or a G-code file (for PrusaSlicer, Cura, Slic3r).

```json
{
  "stl_path": "/path/to/model.stl",
  "slicer_type": "bambustudio",
  "slicer_path": "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
  "slicer_profile": "/path/to/profile.ini"
}
```

`slicer_type` options: `bambustudio`, `orcaslicer`, `prusaslicer`, `cura`, `slic3r`. When omitted, the value from the `SLICER_TYPE` environment variable is used (default: `bambustudio`).

`slicer_path` and `slicer_profile` fall back to the `SLICER_PATH` and `SLICER_PROFILE` environment variables when omitted.

You can provide either `template_3mf_path` or `template_name` when you want to slice from a saved template. `template_name` resolves through the local template registry directory configured for the server.

For printing on a Bambu printer, the recommended workflow is: slice with `bambustudio` to get a sliced 3MF, then pass that output path to `print_3mf`.

#### BambuStudio Slicer Options

When `slicer_type` is `bambustudio` (the default), these additional parameters are available on `slice_stl`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `uptodate` | boolean | Update 3MF configs to latest BambuStudio presets |
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

- `printer://{host}/hms` -- HMS and error diagnostics from the latest status payload. Returns connection state, printer status, explicit HMS payloads when present, and shallow raw fields whose names indicate errors, failures, warnings, or HMS data.

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
- "Turn the chamber light on."
- "Set the chamber fan to 40 percent."
- "List the object IDs in this sliced 3MF."
- "Skip object 6495 on the current print."
- "Start the AMS drying cycle on AMS 0."
- "Stop drying on AMS 1."
- "Match the AMS slots for this 3MF against my loaded filaments without printing."
- "Auto-match AMS slots and print this 3MF."
- "Take a camera snapshot of the print bed."
- "Show me the HMS error codes on the printer."
- "What speed mode is the printer in?"
- "Set the airduct to cooling mode."

### Printing 3MF files

- "Print the file at ~/Downloads/bracket.3mf on my Bambu printer."
- "Upload bracket.3mf to the printer and start printing with AMS slots 0 and 1."
- "Print my_model.3mf with bed leveling enabled and vibration calibration off."
- "Upload this 3MF without printing it yet."
- "Slice model.stl with BambuStudio and then print the result."

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
- "Take this unsliced 3MF, slice it with BambuStudio, and print the result."
- "Scale this part to 80% of its size, lay it flat, and start a print."

---

## Bambu Lab Printer Limitations

Understanding these constraints will help you avoid frustrating errors and set appropriate expectations.

1. **Printable 3MF required for print_3mf.** The `print_3mf` tool expects a sliced 3MF containing at least one `Metadata/plate_<n>.gcode` entry. If you pass an unsliced 3MF (one exported from a CAD tool without slicing), the server will attempt to auto-slice it using the configured slicer — but this fallback is brittle and the recommended workflow is to pre-slice in Bambu Studio and pass the resulting `.gcode.3mf`. See [docs/SLICING.md](./docs/SLICING.md) for the full procedure.

2. **Layer height, temperature, and slicer settings are baked in.** The `project_file` MQTT command tells the printer which plate to run. It does not support overriding layer height, temperature targets, infill percentage, or other slicing parameters at print time. These must be set in your slicer before generating the 3MF.

3. **G-code and 3MF jobs use different command paths.** `start_print_job` sends a `GCodeFileCommand` over MQTT and is intended only for plain G-code files stored in the `cache/` directory. `.3mf` files must go through `print_3mf`, which sends the `project_file` command with plate selection, MD5 verification, and AMS mapping. Mixing these up will result in the printer either ignoring the command or displaying an error.

4. **Temperature commands depend on printer state.** `set_temperature` dispatches M104 or M140 G-code via MQTT. Whether the printer accepts these commands depends on its current firmware version and operational state. Some printer states (such as the idle screen with AMS management open) may ignore or queue the commands.

5. **Real-time status has latency.** `get_printer_status` sends a `push_all` MQTT request and waits up to 1.5 seconds for a response before reading cached state. If the printer is not responding quickly (busy, sleeping, or transitioning states), you may see slightly stale data. There is no persistent event subscription in this server -- each status call is a fresh request.

6. **LAN mode required.** All operations require the printer to be on the same local network as the machine running this server. Cloud-only or remote access setups are not supported. If your printer is connected only via Bambu Cloud and LAN mode is disabled, connection will fail.

7. **Self-signed TLS certificate.** The printer's FTPS server uses a self-signed certificate. The `basic-ftp` client is configured with `rejectUnauthorized: false` to accept it. This is standard for local network Bambu connections but assumes a trusted local network environment.

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

- Slicing with BambuStudio CLI can take 30 seconds to several minutes depending on model complexity, layer height, and your system's CPU. The `slice_stl` call is synchronous and will block until the slicer process completes.
- FTPS uploads for large 3MF files (multi-plate prints, high-detail models) may take 15 to 60 seconds depending on your local network speed.
- MQTT connections are pooled by `host + serial` key. The first call to any printer tool in a session establishes the MQTT connection; subsequent calls reuse it. If the connection drops (printer power cycled, network interruption), the next call will reconnect automatically.

---

## License

GPL-2.0. See [LICENSE](./LICENSE) for the full text.

This project is a fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) by David Montgomery, also GPL-2.0.

## Acknowledgements

Some printer command surfaces and workflow priorities were informed by [Bambuddy](https://github.com/maziggy/bambuddy), an AGPL-3.0 Bambu Lab printer management project. This project does not vendor Bambuddy code.
