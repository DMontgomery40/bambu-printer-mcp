# Slicing Guide

## TL;DR

| Use case | Path | Status |
|---|---|---|
| Single-color slice (any BBL printer) | MCP slices via CLI with automatic BBL profile resolution | ✅ Works (verified H2S, H2D, X1C, P1S on 02.06.01.55). H2C requires Bambu Studio 2.4.0+ and `BAMBU_MODEL=h2c`. |
| Multi-color CLI slicing | MCP prepares every filament slot's colour and a fallback tower position | Contributor-verified on Windows BambuStudio 02.08.02.60, including four-colour X2D slicing. See version limits below. |
| X2D status and slicing | `BAMBU_MODEL=x2d` with an installed X2D preset | Available. Direct X2D printing is deferred pending the native eMMC transport. |
| Pre-sliced `.gcode.3mf` → printer | MCP `print_3mf` | ✅ Works (verified live on Kingpin H2D) |
| Other slicing combinations | Pre-slice in the GUI, then use `print_3mf` for a supported printer | Inspect the preview and use the printer's supported transport. |

There are two slicing paths. Pick the one that matches your situation.

**Path A — pre-slice in Bambu Studio:**

```
Mesh ──► Bambu Studio (GUI) ──► sliced .gcode.3mf ──► MCP print_3mf
         slice + export
```

**Path B — let the MCP slice via BambuStudio CLI (BBL printers only):**

```
STL/3MF ──► MCP slice_stl / print_3mf ──► (auto-flatten profiles) ──► BambuStudio CLI ──► sliced .gcode.3mf
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
For BambuStudio CLI tools, `slicer_profile` supplies process settings; the
selected model's bundled machine preset must still be available. It is not a
replacement machine configuration or a way to bypass model validation.
Pre-sliced 3MF printing does not require running this CLI profile preparation.

Profile discovery follows the active executable: macOS app bundles, Windows
`resources/profiles`, and Linux `share/BambuStudio/profiles` layouts are
recognized. For AppImages or other layouts whose profiles are not accessible
beside the executable, set `BAMBU_PROFILES_ROOT` to the matching installation's
directory containing `BBL`. An unavailable tree produces an error rather than
using another installation's settings.

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

X2D has its own preset, status identification, and slicing support. Direct
X2D printing is deliberately rejected before slicing or upload because its
internal eMMC needs a native transport that has not shipped. Print through a
supported slicer; do not choose H2D as a substitute model. Existing H2S/H2D
print routes remain unchanged.

## Why Path A is still recommended

Path B only works when the MCP can auto-flatten BBL profiles (which is
why it's BBL-only). Custom user profiles, OrcaSlicer-shipped profiles,
and unusual printer/process combinations are best handled through the
GUI, where Bambu's full preset resolver and live filament-from-AMS
selection apply. Path A also gives you a chance to eyeball the slice
preview before committing to a print.

For agents and headless workflows, Path B is fine — but real prints with
new geometry deserve a human in the loop the first time.

## Path B mechanics (CLI auto-flatten)

Before BambuStudio CLI slicing, the MCP:

1. Reads each leaf BBL profile JSON the slicer would have used.
2. Resolves `inherits` and `include` recursively: inherited settings first,
   include templates in order, then the profile's own keys. Cycles and
   unresolved references are errors, including within templates.
3. Sets `from: "User"`, `inherits: <leaf machine name>`, and
   `printer_settings_id` / `print_settings_id` / `filament_settings_id`
   so the CLI's compatibility check passes.
4. Derives the `nozzle_volume_type` array from
   `default_nozzle_volume_type[]`. **Hardware invariant:** both nozzles
   on a Bambu printer always match (same diameter, same flow type), so
   the array always contains identical entries.
5. Auto-extends `compatible_printers` to include the chosen machine
   when the user picked a non-default printer/process combo.
6. Writes flattened temp configs and passes those paths to
   `--load-settings` / `--load-filaments`.

For project 3MF input, a single filament override is repeated across all
declared project slots. An explicit list preserves order and duplicate paths
and must provide one profile per slot. This prevents later slots from retaining
a foreign printer's filament settings; it does not change object assignments or
AMS tray mapping. A geometry-only 3MF without project settings has no embedded
slot list to replace.

Implementation: [`src/slicer/profile-flatten.ts`](../src/slicer/profile-flatten.ts).
Smoke test: `node scripts/test-cli-slice.mjs --model h2s|h2d|h2c|x1c|p1s`.

## Why we couldn't slice in-process before

Bambu's slicer (BambuStudio / orca CLI) is a heavy native binary with profile
state, calibration data, and printer-specific start g-code that the firmware
flag-checks at print time. Re-implementing it from scratch — or shelling out
to it from inside the MCP — was the original goose chase. Every attempted
shortcut (`gcode_file` upload of raw g-code, plain `.3mf` mesh upload, slicing
on the fly) hit one of:

- `405004002` — firmware doesn't recognise the container (P1/A1/X1 series rejecting `.gcode.3mf` over `project_file`).
- `0700-8012 032015` — slicer-command parser failing AMS-map validation because the input file's filament declarations didn't match the payload.
- Print starts, heats, and silently aborts because `Metadata/plate_1.gcode` is missing or malformed.

The fix that actually ships prints: **slice externally, send the sealed `.gcode.3mf`.**

## The right input file

After slicing in Bambu Studio, **File → Export → Export plate sliced file**
(or "Export all sliced files"). The export must be a `.gcode.3mf` that
contains, at minimum:

```
Metadata/
  plate_1.gcode               ← the actual machine instructions
  plate_1.json                ← { "filament_ids": [...], ... }
  slice_info.config           ← <filament id="..."> declarations
  filament_sequence.json      ← per-plate filament order
```

If `Metadata/plate_<n>.gcode` is missing, the MCP throws:

> 3MF does not contain any Metadata/plate_<n>.gcode entries. Re-slice and export a printable 3MF.

That's the signal: the file is a model `.3mf`, not a sliced `.gcode.3mf`. Re-slice.

## Slicing recipe (Bambu Studio)

1. Open Bambu Studio, load the mesh.
2. Pick the **printer profile that matches the target machine** (H2S, H2D, H2C, X1C, P1S, A1, ...). The start g-code differs per series; a plate sliced for X1 will heat-soak wrong on H2, and an H2C should not be treated as H2D.
3. Pick the **filament** in the slot you actually have it loaded in (AMS unit + tray). The plate's `filament_ids` is the lookup the MCP uses to build `ams_mapping`.
4. Slice the plate.
5. **File → Export → Export plate sliced file** → save as `something.gcode.3mf`.
6. Hand that path to the MCP `print_3mf` tool.

> ⚠️ Avoid re-using an old `Cube.gcode.3mf` from a different printer/AMS setup.
> Stale multi-filament declarations in the file will fight the AMS mapping at
> print time. When in doubt, re-slice fresh.

## Firmware routing (handled internally)

The MCP picks the right MQTT command based on printer model:

| Series  | Command for `.gcode.3mf` | Notes |
|---------|--------------------------|-------|
| P1 / A1 / X1 | `gcode_file`         | `project_file` returns `405004002` on these firmwares for `.gcode.3mf`. |
| H2S / H2D / H2C | `project_file`    | `gcode_file` not supported; firmware reads `Metadata/plate_<n>.gcode` from the zip directly. |

You don't need to do anything for this — `print3mf()` branches on model. It
matters only when debugging: if you see `405004002`, you're on P1/A1/X1 and
the file got dispatched via `project_file` by mistake.

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
| `405004002` on P1/A1/X1 | Wrong dispatch path | Update MCP; routing should pick `gcode_file` |
| `0700-8012 032015` | AMS-map length mismatches plate's filament count | Re-slice; don't hand-edit the file. Confirm AMS slot matches loaded filament |
| Print starts, heats, no extrusion | Stale start-g-code from different printer profile | Re-slice with the correct printer profile |
| Agent tries to slice and fails | Agent assumed in-process slicing exists | Point it at this doc; require pre-sliced `.gcode.3mf` input |
