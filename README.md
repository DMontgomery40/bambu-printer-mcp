# bambu-printer-mcp

> **Thank you, [FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/watch?v=1jhRqgHxEP8), and the [OrcaSlicer-bambulab contributors](https://github.com/FULU-Foundation/OrcaSlicer-bambulab).** We stand with open-source developers, the right to repair, and your right to control hardware you own. You should be able to choose your software and print without a vendor cloud standing in the way.
>
> **Want to skip Bambu's software and cloud?** Use FULU OrcaSlicer-bambulab to slice and export, then this MCP's direct LAN path on supported printers and firmware. That workflow does not require Bambu Studio, Bambu Connect, or Bambu Cloud. Start with the [FULU setup guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md). The optional BambuNetwork bridge is a separate path that still uses Bambu's networking runtime; cloud jobs still use Bambu's services.

[![npm version](https://img.shields.io/npm/v/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
[![Tested with Node.js 24](https://img.shields.io/badge/tested%20with-Node.js%2024-green.svg)](https://nodejs.org/en/download/)
[![GitHub stars](https://img.shields.io/github/stars/DMontgomery40/bambu-printer-mcp.svg?style=social&label=Star)](https://github.com/DMontgomery40/bambu-printer-mcp)
[![Downloads](https://img.shields.io/npm/dm/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)

A Bambu Lab-focused MCP server for controlling Bambu printers, manipulating STL files, and managing end-to-end 3MF print workflows from Claude Desktop, Claude Code, or any MCP-compatible client.

**[Browse the documentation site](https://dmontgomery40.github.io/bambu-printer-mcp/)** for searchable setup guides, slicing and AMS guidance, and the full tool reference. It is generated from this README and the docs folder.

Built with help from our [contributors](./CONTRIBUTORS.md). Huge thanks to everyone sharing fixes, careful bug reports, and real printer testing!

This is a stripped-down, Bambu-only fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server). All OctoPrint, Klipper, Duet, Repetier, Prusa Connect, and Creality Cloud support has been removed. What remains is a focused, lean implementation for Bambu Lab hardware.

---

## Set up with your agent

Tell your agent your printer's **model and LAN address**, if you know them, then copy and paste this:

```text
Install bambu-printer-mcp in the agent/harness I'm using now.

Read https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md
and https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md
for the current setup instructions and supported workflows.

Detect my OS and harness, then use its native MCP configuration or installer.
Preserve my existing servers and settings. Prefer the published npm package
(npx -y bambu-printer-mcp, stdio); use Node.js 24 if a runtime is needed.

Find existing printer settings in relevant local configuration or available
LAN discovery. Confirm the detected printer's model, address, and identity
with me before connecting. Ask only for values you cannot find:
PRINTER_HOST, BAMBU_MODEL, BAMBU_SERIAL, and BAMBU_TOKEN (the LAN access code).
Keep credentials in local/private configuration; do not repeat access codes
or tokens in chat. Never guess the printer model.

Use direct LAN printing by default. Explain any LAN/Developer Mode setting
I need to enable. Prefer FULU OrcaSlicer-bambulab GUI slicing/export; discover
an existing slicer before suggesting an install. For FULU/Orca CLI auto-slicing,
require MCP 1.1.11+ and its matching installed profile tree (see guide).
A slicer is not needed here to print a pre-sliced file. Configure the optional FULU
BambuNetwork bridge only if I choose it, and explain its runtime/auth needs.
X2D supports status and slicing; native printing requires macOS and a locally built helper.

If this harness does not already provide code mode or an equivalent, suggest
a compatible code-mode integration as an optional addition. It is not required;
finish ordinary MCP setup without it unless I choose to add it.

Verify that the MCP initializes, lists its tools, and reads printer status.
Do not start a print or change printer settings as a setup test. Tell me what
worked and whether I need to restart or reload the harness.
```

[Setup reference](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md) · [FULU guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md) · [Optional code mode](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md#optional-code-mode)

## What to ask your agent

Ask for the result you want, not the steps. Current models plan across tools: they search the web, read photos, look up exact dimensions, edit models, slice, and print. Expect a question or two when a choice matters, such as which filament to use or whether to start the print.

This server provides the printer, slicing, AMS, and mesh tools. Web search, photos, and Blender edits come from your agent and its other connections, such as a [Blender MCP server](#blender-mcp). Printing a model your agent edited uses CLI slicing with your installed slicer presets; see the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).

### Start from anything

- **"Here's a phone stand on MakerWorld. Make it fit the new iPhone and print it in black."**\
  Your agent looks up Apple's published dimensions, adjusts the stand in Blender, slices it for your printer, and finds the AMS tray with black filament.
- **"I want one of these."** *(with a photo of a planter you saw at a café)*\
  It works out the shape and size from the photo, finds or models a matching design, and asks about anything the photo can't show.
- **"Can you print a replacement?"** *(with a photo of a snapped dishwasher rack clip)*\
  It asks for a measurement or two where the fit matters, models the part, and prints it in a loaded material that suits the job.

### From anywhere, while it prints

If your agent is always on, such as OpenClaw or Hermes Agent running on a computer at home, message it from Telegram or any other chat app. For direct LAN printing, the server runs on the printer's local network; you don't have to.

- **"How's the print going? Send me a picture."**\
  It reports progress and time remaining, and sends a snapshot from the chamber camera.
- **"The corner is lifting. Pause it."**\
  It pauses the job so you can decide whether to resume or cancel.
- **"One of the parts came loose. Skip it and keep printing the rest."**\
  It finds that object on the plate and skips only that one.
- **"Start drying the PETG so it's ready when I get home."**\
  On a heated AMS, it starts the drying cycle for the unit holding that spool.

### Before you print

- **"Take a picture and make sure the bed is clear, then start the bracket I sliced last night."**\
  It checks the camera image before it sends the job.
- **"What's loaded in the AMS? Print this in whatever black I have."**\
  It reads the live AMS inventory and matches the file's filaments to your trays.
- **"Are there any errors on the printer?"**\
  It reads the printer's HMS diagnostics and explains them.

<details>
<summary><strong>Start here</strong></summary>

## Start here

| I want to… | Read next |
|---|---|
| Use open-source slicing and a cloud-free print workflow | [FULU setup: slicer, LAN, and optional bridge](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md) |
| Connect this MCP to my agent | [Copy the setup request](#set-up-with-your-agent) |
| See what my agent can do with it | [What to ask your agent](#what-to-ask-your-agent) |
| Troubleshoot setup or configure it manually | [Installation, environment variables, and LAN reference](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md) |
| Prepare a printable file or troubleshoot slicing | [Slicing guide and model routing](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md) |
| Choose filament trays or inspect a printer | [AMS setup](#ams-automatic-material-system-setup) and [printer tools](#printer-control-tools) |
| Edit an STL through Blender | [Blender MCP setup](#blender-mcp) |
| See release changes or contributor credit | [Changelog](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/CHANGELOG.md), [releases](https://github.com/DMontgomery40/bambu-printer-mcp/releases), and [contributors](./CONTRIBUTORS.md) |

</details>

<details>
<summary><strong>What's new in bambu-printer-mcp</strong></summary>

## What's new in bambu-printer-mcp

See the [changelog](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/CHANGELOG.md) for versioned changes. Recent releases add reliable npm and desktop-extension installs, standard Blender MCP integration, corrected P2S/A1 routing, and safer multi-filament CLI slicing. X2D status and slicing are available, with optional native printing on macOS through the installed Bambu Studio networking plug-in.

</details>

<details>
<summary><strong>Table of Contents</strong></summary>

## Table of Contents

- [Start here](#start-here)
- [Description](#description)
- [FULU and open-source printing](#fulu-and-open-source-printing)
- [Features](#features)
- [Set up with your agent](#set-up-with-your-agent)
- [What to ask your agent](#what-to-ask-your-agent)
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
- [Bambu Lab Printer Limitations](#bambu-lab-printer-limitations)
- [General Limitations and Considerations](#general-limitations-and-considerations)
  - [Memory usage](#memory-usage)
  - [STL manipulation limitations](#stl-manipulation-limitations)
  - [Performance considerations](#performance-considerations)
- [Acknowledgements](#acknowledgements)
- [License](#license)

</details>

<details>
<summary><strong>Description</strong></summary>

## Description

`bambu-printer-mcp` is a Model Context Protocol server for Bambu Lab 3D printers. A straightforward workflow is: **slice in FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio, export a sliced `.gcode.3mf`, then pass its path to `print_3mf`**. The default direct LAN path uploads via FTPS and chooses the MQTT command for the target model. See the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md) for CLI options, model routing, and validation limits.

**What this is not.** This package intentionally supports only Bambu Lab printers. It does not include adapters for OctoPrint, Klipper (Moonraker), Duet, Repetier, Prusa Connect, or Creality Cloud. If you need multi-printer support, use the parent project [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) instead.

**Why a separate package?** The parent project carries all printer adapters in a single binary. When working exclusively with Bambu hardware, that breadth adds unnecessary weight. This fork strips the project to its Bambu core for a smaller, faster install. See each project's changelog for its current fixes and supported workflows.

**Note on resource usage.** STL manipulation loads entire mesh geometry into memory. For large or complex STL files (greater than 10 MB), these operations can be memory-intensive. See [General Limitations and Considerations](#general-limitations-and-considerations) for details.

</details>

<details>
<summary><strong>FULU and open-source printing</strong></summary>

## FULU and open-source printing

[FULU OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) is a supported slicer target (`SLICER_TYPE=orcaslicer-bambulab`; aliases include `fulu-orca` and `orca-studio`). Use its GUI to export a sliced project for direct LAN printing, or configure its CLI with matching installed profiles. From 1.1.11, FULU/Orca share the [machine-preset gate and profile safety checks](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#fulu-and-orca-cli-safety-limit).

The optional FULU **BambuNetwork bridge** exposes `bambu_network_bridge_status`, `bambu_network_call`, and `print_3mf_bambu_network`, also reachable through `print_3mf` with `connection_mode: "bambu_network"`. Slicer selection does not enable the bridge. It needs a separately installed FULU runtime and an explicit launch command; cloud printing also needs an authenticated BambuNetwork session.

**[Follow the FULU setup guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md)** for the direct LAN recipe, Linux/Windows/macOS bridge setup, connection probes, authentication, and troubleshooting. Bridge protocol tests and a successful handshake do not establish a successful physical print.

</details>

<details>
<summary><strong>Features</strong></summary>

## Features

- Get detailed printer status: temperatures (nozzle, bed, chamber), print progress, current layer, time remaining, and live AMS slot data
- Query live AMS inventory with resolved Bambu/Orca filament profile paths via `get_printer_filaments`. Includes per-tray display names, match confidence (`high`/`medium`/`low`/`none`), resolution tier (`exact-model-nozzle`/`model`/`generic`/`unresolved`), and a summary with recommended auto-slice filament. Retries automatically when AMS data hasn't arrived yet (common on first MQTT push from idle printers).
- List, upload, and delete files on the printer's SD card via FTPS
- Capture a JPEG snapshot from the chamber camera. Supports A1, A1 mini, P1S, P1P (TCP-on-6000), and X1, X1C, X1E, P2S, H2, H2S, H2D, H2C, H2D Pro, X2D (RTSP via ffmpeg). Requires ffmpeg in PATH for the RTSP path.
- Upload and print pre-sliced `.3mf` projects with checked plate selection and calibration flags. Legacy `.gcode.3mf` routes require a single external-spool-only plate; see the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).
- Slice through BambuStudio CLI with automatic BBL inheritance/include resolution, per-slot filament colours, and fallback prime-tower placement for multi-nozzle printers. Missing dependencies stop the slice; custom settings and saved project tower positions are preserved. Multi-colour slicing is verified by the contributor on BambuStudio 02.08.02.60 for Windows; older CLI versions have separate limitations. See [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).
- Recognize X2D status and slice with its own installed BambuStudio preset (`BAMBU_MODEL=x2d`). On macOS, `print_3mf` selects the native eMMC route after resolving the model, including an elicited model. Install the optional helper as described below; Linux/Windows native print requests fail before slicing or contacting the printer. Legacy FTPS and remote G-code starts remain unsupported for X2D.
- Parse AMS mapping from the 3MF's embedded slicer metadata (`Metadata/plate_<n>.json` + gcode filament header) and send it correctly formatted per the OpenBambuAPI spec, with correct H2S/H2D/H2C `ams_mapping2` parallel array format
- **Auto-match AMS slots by RFID** (`auto_match_ams` flag on `print_3mf`). Resolves required `tray_info_idx` from the sliced 3MF against live AMS inventory. Handles same-SKU different-color filaments by matching on `(tray_info_idx, tray_color)` and tracking already-claimed slots. Dry-run with `resolve_3mf_ams_slots` before printing.
- Cancel, pause, and resume in-progress print jobs via MQTT
- Skip specific objects during a running multi-object print via `skip_objects` (use `list_3mf_plate_objects` to find object IDs first)
- Set print speed mode (`silent`/`standard`/`sport`/`ludicrous`), clear HMS/print errors, trigger AMS RFID re-read, and control H2/P2 airduct mode (`cooling`/`heating`) via MQTT
- **Start/stop AMS filament drying** (`set_ams_drying`) on heated AMS units (AMS Pro / AMS-HT). Sends `print.ams_control` MQTT command.
- Set nozzle and bed temperature via G-code dispatch over MQTT
- Confirm print starts and positive manual heating through a human preflight prompt. Finished-bed clearance and hardware-error clearing require explicit human acknowledgment; see [hardware safety and headless configuration](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).
- Set fan speed (part, auxiliary, chamber) and chamber light mode (on/off/flashing) via MQTT
- Read HMS (Health Management System) diagnostics as an MCP resource at `printer://{host}/hms` — read-only error summary from the printer, with automatic settle retry
- Start G-code files already stored on the printer
- **Collar charm print wrapper** (`print_collar_charm`) — specialized two-color workflow with fixed tray policy for inner (black, AMS 1 slot 1) and outer (white, AMS 2 slot 1) charm parts
- STL manipulation: scale, rotate, extend base, merge vertices, center at origin, lay flat, and inspect model info
- Slice STL or 3MF files using an external CLI. BambuStudio, FULU, and Orca require the exact machine preset and resolve BBL dependencies before slicing; see [FULU/Orca CLI setup and validation limits](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#fulu-and-orca-cli-safety-limit).
- Inspect slicer settings from a saved 3MF template or extracted profile via `get_slice_settings`
- Enumerate saved slicing templates from the local registry via `list_templates`
- Save templates into the local registry via `save_template`
- Slice directly from a named template via `slice_with_template`
- For simple single-material slices, auto-select the printer's current or first loaded AMS filament when no explicit slicer profile or `load_filaments` override is provided
- Template-driven slicing can reuse a saved 3MF's process settings while still pulling the live printer filament choice over MQTT
- Optional Blender MCP bridge for advanced mesh operations
- Dual transport: stdio (default, for Claude Desktop / Claude Code) and Streamable HTTP

</details>

<details>
<summary><strong>AMS (Automatic Material System) Setup</strong></summary>

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

Mapping is positional: each entry corresponds to a project filament, and `-1` means unused. H2/P2S project-file commands use project-length mapping plus a parallel `ams_mapping2`; other project-file routes retain at least five positions without truncating longer projects. Prefer `ams_slots` in plate filament order or `auto_match_ams: true` when you do not already have the full project mapping.

### Single-material prints

For a single-material plate, explicitly select its loaded tray. For example, use AMS slot 2:

```json
{
  "three_mf_path": "/path/to/model.3mf",
  "ams_slots": [2]
}
```

This expands slot 2 into the correct project filament position. There is no universal fixed default mapping for every model and project.

### Printing without AMS

If you are using the direct-feed spool holder (no AMS attached) or want to bypass the AMS entirely, set `use_ams` to `false`:

```json
{
  "three_mf_path": "/path/to/model.3mf",
  "use_ams": false
}
```

For H2 projects with declared filaments, also provide the required mapping; `use_ams: false` alone does not remove the firmware's mapping requirement. See [`print_3mf`](#print_3mf).

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

</details>

<details>
<summary><strong>Bambu Communication Notes (MQTT and FTP)</strong></summary>

## Bambu Communication Notes (MQTT and FTP)

Bambu Lab printers do not use a conventional REST API. Instead, they expose two local protocols that this server uses directly:

**MQTT (port 8883, TLS):** All printer commands and state reports flow over an MQTT broker running on the printer itself. Authentication uses username `bblp` and your LAN access code; the serial number identifies the device topics. Commands like starting a print, cancelling a job, and dispatching G-code lines are all MQTT publishes to the device topic. Status data is received by subscribing to the printer's report topic and requesting a `push_all` refresh. This implementation is based on community reverse engineering documented in the [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) project.

**FTPS (port 990, implicit TLS):** File operations (upload and directory listing) use FTPS. The printer's SD card is accessible as a filesystem with directories including `cache/` (for 3MF and G-code print files), `timelapse/`, and `logs/`. Authentication uses the username `bblp` and your access token as the password.

### What this fork fixes

This package works around two protocol-level issues in the underlying `bambu-js` library.

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

For the non-H2/P2S project-file route, this implementation retains at least five positions in the `ams_mapping` array where position `i` is the project filament index and the value is the AMS slot feeding that filament. For example, a single-filament print from AMS slot 0 sends `[0, -1, -1, -1, -1]`.

This fork sends the `project_file` command directly via `bambu-node` (bypassing `bambu-js` entirely for print initiation) and constructs the mapping in the format the target firmware expects:

```typescript
// Non-H2/P2S project_file: at least five entries; preserve longer projects
ams_mapping = [0, -1, -1, -1, -1];

// H2S/H2D/H2C/P2S: project-length lookup table + parallel ams_mapping2
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

This is the sequence that successfully started a print on an H2S in the original LAN-only test. It's documented here because several common approaches fail on this firmware, and this fork's transport is what makes it reliable.

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

</details>

<details>
<summary><strong>Available Tools</strong></summary>

## Available Tools

<details>
<summary><strong>STL Manipulation Tools</strong></summary>

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
<summary><strong>Printer Control Tools</strong></summary>

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
- **RTSP** for **X1, X1 Carbon, X1E, P2S, X2D** and **H2, H2S, H2D, H2C, H2D Pro**. Shells out to ffmpeg with `rtsps://bblp:<token>@<host>:322/streaming/live/1 -frames:v 1`. The H2 series wasn't documented in OpenBambuAPI's `video.md` but its firmware uses the same RTSP endpoint as X1 (verified live against an H2S, 2026-04-27).

**Requires ffmpeg in PATH** for the RTSP path. Install with `brew install ffmpeg` on macOS. Configure a trusted custom binary with the server-side `FFMPEG_PATH` environment variable, or set `MCP_ALLOW_EXECUTABLE_ARG=1` before using the `ffmpeg_path` tool argument. The TCP-on-6000 path uses native Node TLS and does not require ffmpeg.

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
```

```json
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

Set a checked target temperature for the bed or nozzle through MQTT. Positive targets require the printer model and fresh matching printer telemetry; nozzle heating also requires the declared loaded `material` and matching `nozzle_diameter` (default 0.4). Independent model/component and material ceilings apply. A target of zero turns the heater off without requiring material or nozzle metadata. Accepted `component` values are `bed`, `nozzle`, `extruder`, `tool`, and `tool0`.

Manual nozzle heating checks the reported currently loaded AMS tray or external spool. It refuses ambiguous active-nozzle/material selection on multi-nozzle printers; use a checked sliced job or the printer's own controls there. Stop and heater-off commands cancel pending server print/heating operations. Resuming through MCP requires the same paused job inspected and started by this server instance, with fresh matching telemetry; other paused jobs remain controllable at the printer.

```json
{
  "component": "nozzle",
  "temperature": 220,
  "bambu_model": "p1s",
  "material": "PLA",
  "nozzle_diameter": 0.4,
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

The primary tool for starting a Bambu print. **Recommended input: a pre-sliced `.gcode.3mf` exported from FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio** — see [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md). This tool handles the complete workflow:

1. Checks whether the 3MF contains embedded G-code (`Metadata/plate_<n>.gcode` entries).
2. If no G-code is found, attempts to auto-slice via the configured slicer. Profile preparation or slicing failures stop the operation before upload. See the slicing guide for tested CLI versions and combinations.
3. Parses the sliced 3MF to extract the correct plate file and compute its MD5 hash.
4. Reads slicer metadata and any explicit AMS selection to build the filament mapping.
5. Uploads via `basic-ftp` to the model-specific location: SD root for H2/full-size A1, `cache/` for P1/X1/A1 mini/P2S. X2D `print_3mf` instead uses its checked native eMMC route on macOS.
6. Sends the correct MQTT print command for the target printer family. For H2S/H2D/H2C that means `project_file` with project-length `ams_mapping`, parallel `ams_mapping2`, and H2-compatible calibration flags.

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

`bambu_model` is **required** for model-specific routing and preset selection. It does not by itself validate pre-sliced G-code. BambuStudio, FULU, and Orca CLI preparation additionally require the exact model/nozzle machine preset and reject incomplete profiles. Using the wrong model can damage hardware. If `bambu_model` is not provided in the tool call and `BAMBU_MODEL` is not set in the environment, the server will ask you interactively via MCP elicitation (if your client supports it) or return a clear error.

`bed_type` defaults to `textured_plate` if omitted. `ams_slots` is the preferred override input; `ams_mapping` remains the raw escape hatch. On AMS-equipped H2 printers, `use_ams: false` does not suppress mapping lookup if the sliced file declares filaments. If no mapping is provided for an H2 pre-sliced job with declared filaments, the server fails before sending; pass explicit `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true`.

Set `auto_match_ams: true` to match the sliced 3MF's `tray_info_idx` values against the live AMS inventory and use the matching `ams_slots`. The matcher joins on `(tray_info_idx, tray_color)` and tracks already-claimed slots, so prints with two filaments of the same SKU but different colors (e.g. two GFG02 PETG HF in black and white) resolve correctly. Falls back to SKU-only when the 3MF's filament has no color set or only one tray of that SKU is loaded. Returns a structured `missing` report (`reason: "no_loaded_match" | "color_mismatch" | "exhausted" | "no_sku"`) when a filament can't be resolved. Ignored when you provide `ams_slots` or `ams_mapping` explicitly.

Layer height, nozzle temperature, and other slicer parameters cannot be overridden via this tool -- they are baked into the 3MF's G-code at slice time. Apply those settings in your slicer before generating the 3MF.

For the optional FULU bridge, set `connection_mode: "bambu_network"` and explicitly choose `connection_type: "cloud"` or `"lan"`; see [FULU setup](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md). A successful command submission is not proof that the printer accepted it: inspect printer state, HMS errors, and the printer itself.

#### bambu_network_bridge_status

Inspect the configured FULU bridge without starting it using `{}`. Use `{"connect": true}` to launch the host, handshake, and initialize an agent. See [bridge probes](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#probe-without-printing) for interpreting the result.

#### bambu_network_call

Call an allowed read-only probe such as `{"method": "net.is_user_login", "payload": {}}`. The default injects the initialized agent; use `with_agent: false` for `bridge.handshake`. Raw printer mutations and unknown methods are refused; use the dedicated checked print or printer tools.

#### X2D native transport (macOS)

Install Bambu Studio and its networking plug-in, plus the Apple command-line developer tools (`clang++`). The plug-in is loaded at runtime and is not redistributed. In the installed `bambu-printer-mcp` package directory, run `npm run build:native`. For a global install, locate that directory with `npm root -g`; for an extracted desktop extension, run the same command in the extension directory. Rebuild after updating the package. Linux and Windows can still use status and slicing, but this native helper supports macOS only.

The npm package and desktop bundle include `native/bambu-native-print.cpp` and `scripts/build-bambu-native.zsh`, never a developer's compiled binary. The server finds the built helper relative to its installed package, regardless of the launch directory. A trusted server setting `BAMBU_NATIVE_HELPER` can select an alternate executable.

For X2D, `print_3mf` defaults to `connection_mode: "bambu_native"`; legacy `lan_mqtt_ftps` requests are redirected to it. Supply `ams_slots`, a complete project-level `ams_mapping`, or `auto_match_ams: true`. An external-spool job requires explicit `use_ams: false`. Raw `ams_mapping2` and nozzle/extra-option overrides are rejected before dispatch; the server derives both AMS representations from the checked structured mapping. Model/nozzle/material inspection, fresh printer-state checks, and human preflight apply before the helper receives a private snapshot. The native helper requests fresh shared printer-state authorization immediately before each print submission, including a certificate retry; custom helpers must support this handshake. Native upload-only requests use the same all-plate inspection as FTPS uploads. They accept `project_name`, `preset_name`, `bed_type`, and an existing `plate_index`; AMS, nozzle, and calibration print options are rejected. Use `print_3mf` for checked print settings.

The helper waits for connection/certificate exchange and retries only the initial `-4030` send once. Previous hardware testing reached `RUNNING` on X2D; this revision is validated with mocked transport regressions and clean installs, not a new physical print. `bambu_connect` is an optional macOS handoff for user review in Bambu Connect and does not start a print. Native task, heater, and error controls retain the common safety checks; raw controls cannot bypass them. Request cancellation, stop, and heater-off interrupt pending native helpers; the server waits for process exit before releasing a checked file. A command already sent to the printer cannot be recalled by cancelling the request, so verify printer state before retrying.

#### x2d_native_control

This optional X2D metadata tool accepts `ams_filament_setting` and `extrusion_cali_sel`, plus the read-only queries `extrusion_cali_get`, `extrusion_cali_get_result`, and `flowrate_get_result`. It validates command fields, numeric metadata, and AMS unit/slot selection. Motion, filament loading, heating, safety-setting changes, and task control are not exposed through raw JSON; use the dedicated checked tools where available. A metadata declaration does not verify the physical spool contents.

#### print_3mf_bambu_network

Submit a sliced project through FULU's separately configured networking runtime. `connection_type` defaults to `cloud`. Both cloud and LAN bridge jobs require a printer IP, LAN access code, matching serial/device ID, and fresh MQTT safety telemetry. File, raw AMS/nozzle mapping, and extra-option overrides cannot replace checked parameters. See [print examples and AMS requirements](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#print-through-the-bridge). A zero bridge return code confirms submission, not a physical print or direct X2D support.

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
<summary><strong>Slicing Tools</strong></summary>

### Slicing Tools

> **Note:** the verified workflow is to slice in Bambu Studio (GUI) and feed the resulting `.gcode.3mf` to `print_3mf`. The CLI-driven slicing tools below (`slice_stl`, `slice_with_template`) work but are sensitive to profile drift and are not the recommended path for production prints. See [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).

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

Slice an STL or 3MF file using an external slicer and return the path to the output file. The output is a sliced 3MF (for BambuStudio, OrcaSlicer, and FULU OrcaSlicer-bambulab) or a G-code file (for PrusaSlicer, Cura, Slic3r).

```json
{
  "stl_path": "/path/to/model.stl",
  "slicer_type": "bambustudio",
  "bambu_model": "p1s"
}
```

`slicer_type` options: `bambustudio`, `orcaslicer`, `orcaslicer-bambulab` (FULU), `prusaslicer`, `cura`, `slic3r`. Aliases include `fulu-orca` and `orca-studio`. When omitted, the value from the `SLICER_TYPE` environment variable is used (default: `bambustudio`).

**FULU/Orca CLI safety:** from 1.1.11, these backends require the exact model/nozzle preset from the selected installation and stop on profile preparation failures. A process override cannot bypass that gate. See [configuration and validation limits](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#fulu-and-orca-cli-safety-limit).

`slicer_path` and `slicer_profile` fall back to the `SLICER_PATH` and `SLICER_PROFILE` environment variables when omitted. Per-call `slicer_path` overrides require `MCP_ALLOW_EXECUTABLE_ARG=1`.

You can provide either `template_3mf_path` or `template_name` when you want to slice from a saved template. `template_name` resolves through the local template registry directory configured for the server.

For printing on a Bambu printer, the recommended workflow is: export a sliced 3MF from your selected Bambu-compatible slicer, then pass that output path to `print_3mf`.

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
| `filament_colours` | string | Slot colours, one `#RRGGBB` per filament slot, semicolon-separated. Explicit values take priority, followed by input 3MF colours, each custom profile's colour, then the BambuStudio default. |
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

These defaults reduce stale-profile problems; inspect downloaded models and their slice preview before printing. When calling `slice_stl` directly, you have full control over every flag.

</details>

<details>
<summary><strong>Advanced Tools</strong></summary>

### Advanced Tools

#### Blender MCP

Use a standard stdio Blender MCP server with `BLENDER_MCP_COMMAND` and
`BLENDER_MCP_ARGS`. For the common Blender MCP server, install `uv` and its
matching Blender addon, enable the addon, and start its connection inside
Blender. Set the command to your full `uvx` path and the argument array to
`["blender-mcp"]`. The Claude Desktop extension also offers these two optional
settings. Printer tools work without Blender configured.

1. Call `blender_mcp_status` with `{"connect": true}` to initialize the server
   and discover its tools and input schemas. A connected MCP server does not
   by itself prove that the Blender addon is running.
2. Call `blender_mcp_call` with a discovered tool name and its arguments. The
   full MCP result, including images and errors, is returned. For example:

```json
{
  "tool_name": "get_scene_info",
  "arguments": {"user_prompt": "Inspect the scene before preparing a print."}
}
```

For advanced Blender operations, forward `execute_blender_code` with `code`
and the user's original `user_prompt`. These calls may edit the active scene.
Use the discovered schema rather than assuming a tool exists.

#### blender_mcp_edit_model

The standard MCP edit helper imports an STL, applies ordered edits, and exports
an STL without replacing the input or an existing output. Supported operations
are `decimate:<ratio>` (greater than 0 through 1), `remesh:<voxel size>` (positive,
in STL coordinate units), and `boolean_union:<STL path>`. Other operations can
use `blender_mcp_call`. Both processes must have access to the same file paths.
When `BLENDER_MCP_COMMAND` selects standard MCP, the advertised tool schema
requires an explicit `output_path` for both preview and execution. Legacy-only
bridge configurations keep `output_path` optional for compatibility.

```json
{
  "stl_path": "/path/to/model.stl",
  "output_path": "/path/to/model-edited.stl",
  "operations": ["decimate:0.5"],
  "user_prompt": "Reduce the triangle count of this model for printing.",
  "execute": false
}
```

The default preview returns the plan and generated Python without launching
Blender. Set `execute` to `true` to run it. A successful standard edit returns
`output_verified: true`, `output_path`, byte count, and triangle count after
checking the matching export receipt and a valid finite mesh. The helper
preserves existing scene objects and requires Object Mode. Inspect the result
before slicing; a valid STL is not a guarantee of printability.

The bridge enforces request deadlines, closes child connections, and never
replays interrupted editing requests. After a timeout, inspect Blender before
trying the edit again because execution may already have started.

Existing custom executables still work through `BLENDER_MCP_BRIDGE_COMMAND`.
They receive `MCP_BLENDER_PAYLOAD` with the requested file and operations;
their results explicitly report `output_verified: false`. A missing executable
configuration is an error when execution is requested. Per-call legacy
`bridge_command` overrides remain disabled unless `MCP_ALLOW_EXECUTABLE_ARG=1`.

</details>

</details>

<details>
<summary><strong>Available Resources</strong></summary>

## Available Resources

Resources follow the MCP resource protocol and can be read by calling `ReadResource` with a URI. The server also lists them via `ListResources`.

### Printer resources

- `printer://{host}/status` -- Current printer status. Equivalent to calling `get_printer_status`. Returns a JSON object with temperature, progress, layer, AMS, and raw state data.

- `printer://{host}/files` -- File listing for the printer's SD card. Equivalent to calling `list_printer_files`. Returns files grouped by directory.

- `printer://{host}/hms` -- HMS and error diagnostics from the latest status payload. Returns connection state, printer status, explicit HMS payloads when present, and shallow raw fields whose names indicate errors, failures, warnings, or HMS data.

**Example:** To read the status of the default printer, use URI `printer://192.168.1.100/status`. The host segment must match a configured printer IP; the server uses `PRINTER_HOST` if the default URI template is used.

</details>

<details>
<summary><strong>Bambu Lab Printer Limitations</strong></summary>

## Bambu Lab Printer Limitations

Understanding these constraints will help you avoid frustrating errors and set appropriate expectations.

1. **Printable 3MF required for print_3mf.** The `print_3mf` tool expects a sliced 3MF containing at least one `Metadata/plate_<n>.gcode` entry. If you pass an unsliced 3MF (one exported from a CAD tool without slicing), the server attempts auto-slicing. BambuStudio, FULU, and Orca CLI paths require the matching machine preset and complete profile preparation; any inspection or slicing failure stops before upload. For a previewable workflow, pre-slice in FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio and pass the resulting `.gcode.3mf`. See [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md) for the full procedure.

2. **Layer height, temperature, and slicer settings are baked in.** The `project_file` MQTT command tells the printer which plate to run. It does not support overriding layer height, temperature targets, infill percentage, or other slicing parameters at print time. These must be set in your slicer before generating the 3MF.

3. **G-code and 3MF jobs use different command paths.** `start_print_job` sends a `GCodeFileCommand` over MQTT and is intended only for plain G-code files stored in the `cache/` directory. Sliced 3MF files must go through `print_3mf`, which selects the model-specific command and upload location. See the [routing table](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md#firmware-routing-handled-internally). Mixing these up will result in the printer either ignoring the command or displaying an error.

4. **Temperature commands depend on printer state.** `set_temperature` dispatches M104 or M140 G-code via MQTT. Whether the printer accepts these commands depends on its current firmware version and operational state. Some printer states (such as the idle screen with AMS management open) may ignore or queue the commands.

5. **Status and command submission are separate evidence.** Local MQTT connections are reused and status is read from received printer reports. Reports can lag during startup, sleep, or state transitions. Inspect HMS errors and the printer's actual state after submitting a job; a tool's success response is not physical-print confirmation.

6. **Network requirements depend on the path.** Direct MQTT/FTPS tools require local reachability and compatible LAN/Developer Mode settings. FULU bridge cloud jobs use BambuNetwork and require its runtime, internet access, and authentication. Standard status, camera, file, and control tools remain local; bridge printing does not turn them into cloud tools.

7. **Self-signed TLS certificate.** The printer's FTPS server uses a self-signed certificate. The `basic-ftp` client is configured with `rejectUnauthorized: false` to accept it. This is standard for local network Bambu connections but assumes a trusted local network environment.

</details>

<details>
<summary><strong>General Limitations and Considerations</strong></summary>

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

</details>

<details>
<summary><strong>License</strong></summary>

## License

GPL-2.0. See [LICENSE](./LICENSE) for the full text.

This project is a fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) by David Montgomery, also GPL-2.0.

</details>

<details>
<summary><strong>Acknowledgements</strong></summary>

## Acknowledgements

Thank you to **[FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/watch?v=1jhRqgHxEP8), and the [OrcaSlicer-bambulab community](https://github.com/FULU-Foundation/OrcaSlicer-bambulab)** for advancing user choice and interoperability. Our support for open-source tools, repair rights, and printing without Bambu's software or cloud is a project priority. See the [FULU setup guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md) and [contributor credits](./CONTRIBUTORS.md).

Some printer command surfaces and workflow priorities were informed by [Bambuddy](https://github.com/maziggy/bambuddy), an AGPL-3.0 Bambu Lab printer management project. This project does not vendor Bambuddy code.

</details>
