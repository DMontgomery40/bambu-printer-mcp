# Slicing Guide

[Back to README](../README.md) · [Agent setup](../README.md#set-up-with-your-agent) · [FULU setup](./FULU.md)

## TL;DR

For offline prepared-file evidence, call `inspect_print_file` with `file_path`, explicit `bambu_model`, and optional zero-based `plate_index`, `nozzle_diameters` and `bed_type`. It inspects a private read-only snapshot using the existing safety engine and returns a versioned SHA/byte-length/plate receipt, declarations and checked temperature peaks. It neither contacts a printer nor slices input. `evidence: "file-only"` and `dispatch_authorized: false` mean the result cannot replace fresh printer preflight or human authorization; actual printing independently checks its final dispatched snapshot.

Printing includes a mandatory preflight of the final selected G-code and fresh MQTT reports. The requested model, file model, printer identity, and reported nozzle diameters must agree. Missing or contradictory safety information stops the operation. Positive heating commands must fit independent hardware and material ceilings, including later commands and waiting-temperature targets. These ceilings allow supported purge routines; they are not recommended print temperatures.

Print starts and positive manual heating ask for human confirmation through MCP elicitation. The print prompt shows the verified model, nozzle diameters, declared materials, temperature peaks, and file hash. Confirm the physical spool labels and a clear build plate. `BAMBU_REQUIRE_CONFIRMATION=0` opts a deliberately headless setup out of ordinary prompts; a printer reporting `FINISH` still requires confirmation that the previous part and debris are removed. Clearing hardware errors always requires human confirmation, returns the reported codes, and makes the next print prompt ask that those causes are resolved. Clients without elicitation support cannot bypass those physical checks. A prompt waits ten minutes for an answer by default (`BAMBU_CONFIRMATION_TIMEOUT_MS`); an unanswered prompt is reported as a timeout and nothing is sent to the printer. Stop and heater-off remain available without confirmation.

PLA uses a 260°C normal/manual policy ceiling. The inspector permits one bounded, exact X1E startup purge sequence up to 290°C, then requires normal targets before deposition. This is command-form validation, not a simulation of firmware timing. Explicit laser/cutting job metadata and recognized laser-enabling commands are refused; this server supports FFF printing.

Archives with duplicate, case-colliding, hidden, or inconsistent entries are rejected. The dispatched plate path and checksum come from the inspected entry. Inspection accepts files up to 256 MiB and archives up to 512 MiB uncompressed; ZIP64 is unsupported. Printable upload-only operations inspect every plate and verify live model/nozzles, use unique remote names, and refuse existing remote destinations. Upload inspection does not authorize a later print or establish its AMS mapping.

Pre-sliced dual-nozzle jobs retain their complete diameter list. Pass `nozzle_diameters: [0.4, 0.6]` to explicitly require that configuration, or omit nozzle arguments to compare the file's declared diameters directly with live telemetry. A scalar `nozzle_diameter` requires that size throughout the job. Mixed-diameter projects require GUI slicing before printing; the CLI preset path supports a uniform diameter.

Use a sliced file carrying its machine, nozzle, filament, and bed metadata. Declare non-RFID materials in the slicer and supply the complete physical AMS mapping or select external-spool printing. Available printer-reported materials are compared with that declaration. Reports cannot prove the contents of a manually labelled spool, the physical nozzle behind a manual setting, or that the build plate is clear. The checks validate declared object bounds and supported thermal syntax; they do not simulate arbitrary motion or authenticate a file's metadata.

Legacy P1/X1/A1-mini `.gcode.3mf` transport cannot send an AMS mapping or select a plate. It accepts a single external-spool-only plate; export a `.3mf` project for checked AMS mappings. Remote `.gcode` starts download and inspect the file, then print a uniquely named checked copy. The optional BambuNetwork wrapper also requires local MQTT telemetry even for cloud dispatch. Its raw mutation and parameter-override routes are restricted.

Resume accepts an inspected job started by this server through either direct printing or the BambuNetwork wrapper, after fresh paused-job identity and configuration checks. Bridge submissions use a unique task name as well as a unique remote filename; `project_name` (or the legacy `task_name` label) remains the project label.

These preflight changes have automated regression coverage with intercepted printer transports. Earlier live-print evidence below predates this additional gate; no new physical print is claimed by those tests.

| Use case | Path | Status |
|---|---|---|
| Single-colour BambuStudio CLI slicing | MCP slices via CLI with automatic BBL profile resolution | ✅ Works (verified H2S, H2D, X1C, P1S on 02.06.01.55). H2C requires Bambu Studio 2.4.0+ and `BAMBU_MODEL=h2c`. |
| FULU/Orca CLI preparation (1.1.11+) | Same exact-machine gate and BBL dependency resolution | Regression-tested preparation and failure handling; live slicer/version validation remains separate. |
| Multi-color BambuStudio CLI slicing | MCP prepares every filament slot's colour and a fallback tower position | Contributor-verified on Windows BambuStudio 02.08.02.60, including four-colour X2D slicing. See version limits below. |
| X2D status and slicing | `BAMBU_MODEL=x2d` with an installed X2D preset | Available. Native printing additionally requires macOS or x86-64 Linux and the optional helper; legacy FTPS remains unsupported. |
| Pre-sliced `.gcode.3mf` → printer | MCP `print_3mf` | ✅ Works (verified live on Kingpin H2D) |
| Other slicing combinations | Pre-slice in the GUI, then use `print_3mf` for a supported printer | Inspect the preview and use the printer's supported transport. |

Choose GUI export or CLI slicing. FULU export plus the direct LAN print path does not require Bambu Studio, Bambu Connect, or Bambu Cloud. See [FULU setup](./FULU.md) for that workflow and the separate optional BambuNetwork bridge.

**Path A — pre-slice in FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio:**

```
Mesh ──► chosen slicer GUI ──► sliced .gcode.3mf ──► MCP print_3mf
         slice + preview + export
```

**Path B — let the MCP slice via BambuStudio, FULU, or Orca CLI (BBL printers only):**

```
STL/3MF ──► MCP slice_stl / print_3mf ──► (auto-flatten profiles) ──► chosen CLI ──► sliced .gcode.3mf
```

Path B works because the MCP now flattens BBL profile inheritance before
calling the CLI — a workaround for several upstream bugs in BambuStudio's
CLI mode (issues
[#9636](https://github.com/bambulab/BambuStudio/issues/9636) and
[#9968](https://github.com/bambulab/BambuStudio/issues/9968)). Verified
on H2S, H2D, X1C, and P1S with stock BBL profiles for single-colour slicing.
The newer multi-colour evidence and version limits are described below.
H2C is accepted as `BAMBU_MODEL=h2c`; use Bambu Studio 2.4.0 or newer for
the H2C printer preset and do not substitute `h2d`.

BBL profile resolution now runs automatically for CLI slicing.
`BAMBU_CLI_FLATTEN` is no longer required and cannot disable resolution.
Missing parents, missing or malformed includes, cycles, and unresolved filament
slots stop the slice before the CLI runs; the MCP does not fall back to partial
profiles. Standalone custom process and filament configs remain usable, and
custom BBL-derived profiles retain their settings on top of resolved parents.
For BambuStudio, FULU, and Orca CLI tools, `slicer_profile` supplies process settings; the
selected model's bundled machine preset must still be available. It is not a
replacement machine configuration or a way to bypass model validation.
Machine settings carried by a template's `project_settings`, a custom process
file, or a custom filament file (for example another printer's start G-code,
`printer_model`, or nozzle values) are dropped and logged before the CLI runs;
the selected machine preset keeps them.
Pre-sliced 3MF printing does not require running this CLI profile preparation.

Profile discovery follows the active executable: macOS app bundles, Windows
`resources/profiles`, and Linux `share/BambuStudio/profiles` / `share/OrcaSlicer/profiles` layouts are
recognized. For AppImages or other layouts whose profiles are not accessible
beside the executable, set `BAMBU_PROFILES_ROOT` to the matching installation's
directory containing `BBL`. An unavailable tree produces an error rather than
using another installation's settings.

## Orca cache-based installations

Local Orca builds that ship a version-2 `BBL.opc` instead of machine/process/filament JSON can use the selected installation directly. Set `SLICER_TYPE=orcaslicer` and `SLICER_PATH` to that build. The package must also contain `BBL/cli_config.json`: earlier cache-only packages without it still stop before slicing. Unknown cache versions, corrupt data and unresolved model/nozzle or profile dependencies fail explicitly.

The MCP validates and expands that installation's cache into its private temporary directory, then uses a separate private Orca data directory for generated User presets. It preserves custom settings and passes positional colours, bed selection and saved tower coordinates through Orca's project-level CLI options. Native extrusion mode stays enabled for these builds, allowing multi-colour wipe towers. Your installed profiles and running GUI are not changed. The remote `orca-slicer-api` route still requires its matching JSON profile mirror.

Verified software: the [October 23 nightly](https://github.com/OrcaSlicer/OrcaSlicer/commit/14da40e3a7b82aa8fc88593c2cf880e66560028f), macOS universal asset `669077524`, SHA-256 `b7d0cc57d0ff5bc0663d48676939aa4ade6573301d25220d3476c3fe8f97406e`. Real isolated P1S 0.4 single- and two-colour slices preserve custom temperatures, ordered colours and tower coordinates, and their exact output passes independent file/plate inspection. Cache/profile tests also cover A1 mini, H2D, H2C, X2D and P1S 0.2. Those tests do not establish physical printing or Linux/Windows slicer behavior. Stable/alpha packages are separate artifacts; this is not a claim that every Orca version works.

## Multi-colour CLI support and version limits

The CLI can crash when a project uses a filament after the first but its
loaded profiles leave `filament_colour` at a single-entry default. The MCP
now supplies one colour per slot. Explicit `filament_colours` values take
priority, then the input 3MF's colours, each profile's own colour, and finally
the BambuStudio default. Custom filament settings remain intact.

For multi-nozzle printers, an unset tower position is placed within the
shared nozzle area. Saved project positions and explicit process positions
are preserved. This does not guarantee a collision-free layout: inspect the
slicer preview for the actual model and tower geometry.

[Sebastian's contribution](https://github.com/DMontgomery40/bambu-printer-mcp/pull/18)
includes real Windows BambuStudio `02.08.02.60` bisection and a successful
four-colour X2D slice. This is slicing evidence, not a physical-print test.

Older H2D failures remain separate evidence: `02.06.00.51` crashed during
slicer setup, and `02.06.01.55` reported `No valid nozzle found` / code `-100`
on an exported multi-colour project. These were filed in
[BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408).
The colour fix does not establish that every older-version or multi-material
failure is resolved. Use a GUI-sliced project when a CLI combination fails.

X2D has its own preset, status identification, and slicing support. On macOS and
x86-64 Linux, `print_3mf` uses the optional native helper and Bambu's networking
plug-in, after the shared print safety checks. The job goes to a ready SD card or
USB stick, otherwise to internal storage (eMMC).
See native setup for [macOS](../README.md#x2d-native-transport-macos) and
[Linux](../README.md#x2d-native-transport-linux). Other operating systems, and
Linux without the helper, reject native print requests before slicing or connecting. Legacy
FTPS/remote-file starts remain unsupported; do not choose H2D as a substitute
model. Existing H2S/H2D print routes remain unchanged.

## Why Path A is still recommended

GUI slicing lets you inspect supports, colours, tool changes, and tower placement before printing. It is also the fallback when a CLI build rejects flags, cannot resolve the selected profiles, or crashes.

Bambu-compatible CLI preparation supports bundled BBL presets and standalone custom process/filament overrides; custom BBL-derived settings are retained after dependency resolution. The selected model's bundled machine preset is still required. FULU/Orca and their aliases use the same machine-preset gate from 1.1.11. See [FULU/Orca CLI setup and validation limits](./FULU.md#fulu-and-orca-cli-safety-limit).

A failed inspection or auto-slice stops before upload. The server never deliberately sends the original unsliced project as a fallback.

## Path B mechanics (CLI auto-flatten)

Before BambuStudio, FULU, or Orca CLI slicing, the MCP:

1. Requires the exact model/nozzle machine preset in the selected installation's BBL tree, validates its identity, and reads each leaf profile JSON.
2. Resolves `inherits` and `include` recursively: inherited settings first,
   include templates in order, then the profile's own keys. Cycles and
   unresolved references are errors, including within templates.
3. Sets `from: "User"`, `inherits: <leaf machine name>`, and
   `printer_settings_id` / `print_settings_id` / `filament_settings_id`
   so the CLI's compatibility check passes.
4. Derives nozzle settings from the selected machine profile and nozzle configuration. `nozzle_volume_type` (`standard` or `high_flow`) sets the machine's `nozzle_volume_type`, which selects each profile's Standard or High Flow values; a flow type the preset does not declare in `extruder_variant_list` is refused. Use the exact model preset; a successful slice for another model does not validate the target printer.
5. Auto-extends `compatible_printers` to include the chosen machine
   when the user picked a non-default printer/process combo.
6. Removes every key the resolved machine preset defines, other than profile
   metadata such as `name`, `inherits`, and `compatible_printers`, from the
   process and filament configs, because the CLI applies every key in every
   loaded file. For legacy JSON-based OrcaSlicer, absolute-extrusion normalization
   (`use_relative_e_distances = 0`, no per-layer `G92 E0`) is applied to the
   machine config. Cache-based Orca builds preserve their native extrusion mode
   and use the private preset-loading route described above.
7. Writes flattened temp configs and passes those paths to
   `--load-settings` / `--load-filaments`.

For project 3MF input, a single filament override is repeated across all
declared project slots. An explicit list preserves order and duplicate paths
and must provide one profile per slot. This prevents later slots from retaining
a foreign printer's filament settings; it does not change object assignments or
AMS tray mapping. A geometry-only 3MF without project settings has no embedded
slot list to replace.

Implementation: [`src/slicer/profile-flatten.ts`](../src/slicer/profile-flatten.ts).
Optional installed-slicer smoke test: `node scripts/test-cli-slice.mjs --model h2s` (substitute the supported target model). This slices a fixture; it does not print.

## Remote Orca slicing

Set `SLICER_TYPE=orca-slicer-api` to use a separately hosted
[AFKFelix/orca-slicer-api](https://github.com/AFKFelix/orca-slicer-api) service.
The MCP host does not need an Orca executable or `SLICER_PATH`. It still needs a
read-only copy or mount of the **matching remote Orca installation's**
`resources/profiles` tree, including `BBL/cli_config.json` and the exact
model/nozzle machine preset:

```dotenv
SLICER_TYPE=orca-slicer-api
SLICER_API_URL=http://orcaslicer:3000
BAMBU_PROFILES_ROOT=/mnt/orca/resources/profiles
SLICER_API_MODE=sync
SLICER_API_TIMEOUT_MS=600000
```

`SLICER_API_URL` is trusted server configuration, never a tool argument. A proxy
path prefix is supported. Use HTTPS when the connection needs transport
protection. The URL cannot contain credentials, a query, or a fragment. For
reverse-proxy authentication, set `SLICER_API_TOKEN`; the default header is
`Authorization: Bearer <token>`. Set `SLICER_API_TOKEN_HEADER=X-API-Key` to send the
raw token through a custom header. Redirects are rejected, returned job URLs are
ignored, and remote errors do not echo response bodies or authentication values.

The backend targets the upstream API contract at
[`a9a28f0a7b0c6f51b9be158509e9e9677532b868`](https://github.com/AFKFelix/orca-slicer-api/tree/a9a28f0a7b0c6f51b9be158509e9e9677532b868).
`sync` submits multipart data to `/slice`. `async` submits once to `/slice-async`,
polls `/slice-async/{requestId}`, downloads its `/result`, and deletes the finished
job. The timeout covers submission, polling and downloading (default ten minutes;
accepted range 1–3600000 ms). Timeout or cancellation does not cancel an active
upstream job: the API has no active-job cancellation endpoint. The client reports
that work may continue and never retries submission automatically.

Before HTTP submission, the same local Orca preparation resolves `inherits` and
`include` recursively, validates the exact bundled machine and its CLI config,
preserves custom process/filament overrides, and prepares colour and nozzle
settings. The client uploads those complete machine, process and filament JSON
files with `resolveProfileInheritance=false`; their retained leaf identity
metadata serves the CLI compatibility check. The service cannot substitute its
default profiles for missing local machine provenance.

The supported subset is STL or 3MF input with **exactly one filament slot** and
one positive, one-based `slice_plate` (default `1`). Uploaded profiles preserve
custom settings and a single explicit/project/profile filament colour. Bed type,
nozzle type and nozzle flow settings use the existing validated profile overlays.
`arrange=true` and `orient=true` are supported. Explicit `false` for either is
rejected because the pinned upstream multipart implementation treats nonempty
strings as true. Requests for all plates (`slice_plate=0`), multiple filament
slots, object/filament-ID remapping, repetitions, transforms, and CLI-only flags
such as `ensure_on_bed`, `uptodate`, `min_save`, `skip_modified_gcodes`,
`enable_timelapse`, and `allow_mix_temp` are rejected rather than dropped. Use a
local backend when those controls are required.

Downloads are capped at 100 MB, saved under a unique private output name, and
independently inspected as a sliced 3MF before being returned. The selected plate
must retain its original `Metadata/plate_N.gcode` identity; renumbered results
are rejected. The file must match the prepared model, nozzle diameters and
material, and its commands must pass the existing independent safety inspection.
Printing still performs its own fresh live-printer preflight. HTTP fixture tests
verify the transport and failure boundaries; they do not establish a real Orca
slice or physical print.

## Why the sliced file matters

The slicer supplies model-specific start G-code, filament declarations, and plate metadata. Renaming a geometry-only `.3mf` to `.gcode.3mf` does not create those contents. An incorrectly prepared project may fail AMS validation, be rejected by firmware, or stop after heating.

Use an exported sliced project, or let the configured CLI finish successfully before upload. A `.gcode.md5` checksum entry is not printable G-code.

## The right input file

After slicing in your chosen GUI, export the **sliced plate** (in Bambu Studio, **File → Export → Export plate sliced file**, or "Export all sliced files"). Menu labels vary in FULU/Orca builds. A typical `.gcode.3mf` contains the following; the required printable content is a `Metadata/plate_<n>.gcode` entry, while the available metadata depends on the exporter:

```
Metadata/
  plate_1.gcode               ← the actual machine instructions
  plate_1.json                ← { "filament_ids": [...], ... }
  slice_info.config           ← <filament id="..."> declarations
  filament_sequence.json      ← per-plate filament order
```

If no `Metadata/plate_<n>.gcode` exists, `print_3mf` attempts auto-slicing. If the prepared output is still not printable, it stops with:

> 3MF does not contain any Metadata/plate_<n>.gcode entries. Re-slice and export a printable 3MF.

Check that you exported the sliced plate, not the geometry project. Inspection and slicing errors stop before upload.

<a id="slicing-recipe-bambu-studio"></a>

## Slicing recipe (FULU, OrcaSlicer, or Bambu Studio)

1. Open FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio and load the mesh.
2. Pick the **printer profile that matches the target machine** (H2S, H2D, H2C, X1C, P1S, A1, ...). The start g-code differs per series; a plate sliced for X1 will heat-soak wrong on H2, and an H2C should not be treated as H2D.
3. Pick the **filament** in the slot you actually have it loaded in (AMS unit + tray). The plate's `filament_ids` is the lookup the MCP uses to build `ams_mapping`.
4. Slice the plate.
5. Export the sliced plate as `something.gcode.3mf` (Bambu Studio: **File → Export → Export plate sliced file**).
6. Hand that path to the MCP `print_3mf` tool.

> ⚠️ Avoid re-using an old `Cube.gcode.3mf` from a different printer/AMS setup.
> Stale multi-filament declarations in the file will fight the AMS mapping at
> print time. When in doubt, re-slice fresh.

## Firmware routing (handled internally)

For the default direct LAN path, the MCP selects the upload location and command for a pre-sliced `.gcode.3mf` by model:

| Model | Upload location | Command |
|---|---|---|
| P1P / P1S / X1 family / A1 mini | `/cache/<file>` | `gcode_file` |
| Full-size A1 | SD root `/<file>` | `project_file`, `file:///sdcard/<file>` |
| P2S | `/cache/<file>` | `project_file`, `ftp:///cache/<file>` |
| H2S / H2D / H2C | SD root `/<file>` | `project_file`, `ftp:///<file>` |
| X2D | Native, to the SD card/USB stick or eMMC, on macOS or Linux | `print_3mf` uses a locally built helper and installed plug-in; legacy FTPS/remote-file starts are rejected |

The filename suffix is significant for the legacy route: the code recognizes `.gcode.3mf` for `gcode_file`, while other `.3mf` names use project-file handling. Keep the slicer's sliced-file export name when using the legacy path. Do not rename unsliced content to force routing.

These routes are implemented in [`src/printers/bambu.ts`](../src/printers/bambu.ts). The [FULU BambuNetwork bridge](./FULU.md#print-through-the-bridge) is separately selected and has its own runtime parameters; this table does not establish bridge compatibility.

## AMS mapping (auto-derived from the 3MF)

The MCP reads `Metadata/plate_<n>.json.filament_ids` plus the
`; filament_ids = …` header in `plate_<n>.gcode` to build `ams_mapping` /
`ams_mapping2` automatically. The caller only specifies which AMS tray each
project-level filament should pull from. You no longer need to hand-compute
`[-1, 1, -1, -1]`.

For a dry run, call `resolve_3mf_ams_slots` on the sliced 3MF. It reads
`Metadata/slice_info.config` for each required `tray_info_idx` and compares
those RFID-style filament ids against the live AMS inventory. If all required
filaments are loaded, it returns the `ams_slots` array that `print_3mf` will
accept. For printing, pass `auto_match_ams: true` to let `print_3mf` apply the
same match automatically; explicit `ams_slots` or `ams_mapping` still take
precedence.

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `3MF does not contain any Metadata/plate_<n>.gcode` | File is a mesh `.3mf`, not a sliced one | Re-slice and export the sliced file |
| `405004002` on a legacy P1/X1/A1 mini route | Unexpected container/command combination | Check model, firmware, and sliced-file suffix against the routing table; full-size A1 uses a different route |
| `0700-8012 032015` | AMS-map length mismatches plate's filament count | Re-slice; don't hand-edit the file. Confirm AMS slot matches loaded filament |
| Print starts, heats, no extrusion | Stale start-g-code from different printer profile | Re-slice with the correct printer profile |
| CLI slicing fails | Missing profiles, unsupported flags, or slicer-version failure | Preserve the error; use matching presets or GUI-export a sliced `.gcode.3mf`. Do not upload the unsliced input |
