# Slicing Guide

## TL;DR

| Use case | Path | Status |
|---|---|---|
| Single-color slice (any BBL printer) | `BAMBU_CLI_FLATTEN=true` → MCP slices via CLI | ✅ Works (verified H2S, H2D, X1C, P1S) |
| Multi-color slice on H2D | None — **upstream BambuStudio CLI is blocked** | ❌ See "Multi-color CLI gap" below |
| Pre-sliced `.gcode.3mf` → printer | MCP `print_3mf` | ✅ Works (verified live on Kingpin H2D) |
| Anything else | Pre-slice in Bambu Studio GUI, hand to `print_3mf` | ✅ Works always |

There are two slicing paths. Pick the one that matches your situation.

**Path A — pre-slice in Bambu Studio (recommended, always works):**

```
Mesh ──► Bambu Studio (GUI) ──► sliced .gcode.3mf ──► MCP print_3mf
         slice + export
```

**Path B — let the MCP slice via BambuStudio CLI (opt-in, BBL printers only):**

```
STL/3MF ──► MCP slice_stl / print_3mf ──► (auto-flatten profiles) ──► BambuStudio CLI ──► sliced .gcode.3mf
            BAMBU_CLI_FLATTEN=true
```

Path B works because the MCP now flattens BBL profile inheritance before
calling the CLI — a workaround for several upstream bugs in BambuStudio's
CLI mode (issues
[#9636](https://github.com/bambulab/BambuStudio/issues/9636) and
[#9968](https://github.com/bambulab/BambuStudio/issues/9968)). Verified
on H2S, H2D, X1C, and P1S with stock BBL profiles.

To enable Path B, set `BAMBU_CLI_FLATTEN=true` in the environment that
runs the MCP. Default remains Path A so behavior is backward-compatible.

## Multi-color CLI gap (2026-04-27)

`BambuStudio --slice` SIGSEGVs in `load_nozzle_infos_with_compatibility` on
**any** H2D dual-extruder, multi-color project on version 02.06.00.51 — verified
upstream via a two-cube minimal repro. Filed as
[bambulab/BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408).

What this means in practice:

- **Single-color slicing works.** The `BAMBU_CLI_FLATTEN=true` path slices
  H2S/H2D/X1C/P1S models cleanly and produces printable `.gcode.3mf` output.
- **Multi-color slicing must use the GUI.** Open the model in Bambu Studio,
  paint or split-and-assign filaments, export the sliced `.gcode.3mf`, hand it
  to MCP `print_3mf` (or `print_collar_charm` for two-part charm projects).
- **The dispatch path is fine.** Once you have a sliced `.gcode.3mf`, the MCP
  uploads it via FTPS and starts the print correctly — verified live on H2S
  (Parker) and H2D (Kingpin).

The MCP includes `scripts/build-charm-3mf.mjs` which constructs valid
multi-object source 3MFs (per-object extruder assignment, plate filament_maps).
That tool is correct end-to-end; it produces input the BambuStudio CLI parses
without complaint. The crash is downstream, in BambuStudio's slicer setup
itself. The script is ready to use the moment upstream ships #10408.

## Why Path A is still the default

Path B only works when the MCP can auto-flatten BBL profiles (which is
why it's BBL-only). Custom user profiles, OrcaSlicer-shipped profiles,
and unusual printer/process combinations are best handled through the
GUI, where Bambu's full preset resolver and live filament-from-AMS
selection apply. Path A also gives you a chance to eyeball the slice
preview before committing to a print.

For agents and headless workflows, Path B is fine — but real prints with
new geometry deserve a human in the loop the first time.

## Path B mechanics (CLI auto-flatten)

When `BAMBU_CLI_FLATTEN=true`, the MCP:

1. Reads each leaf BBL profile JSON the slicer would have used.
2. Walks its `inherits` chain recursively, deep-merging parent into
   child (the GUI does this at runtime; the CLI doesn't).
3. Sets `from: "User"`, `inherits: <leaf machine name>`, and
   `printer_settings_id` / `print_settings_id` / `filament_settings_id`
   so the CLI's compatibility check passes.
4. Derives the scalar `nozzle_volume_type` from
   `default_nozzle_volume_type[]`. **Hardware invariant:** both nozzles
   on a Bambu printer always match (same diameter, same flow type), so
   the array always contains identical entries.
5. Auto-extends `compatible_printers` to include the chosen machine
   when the user picked a non-default printer/process combo.
6. Writes flattened temp configs and passes those paths to
   `--load-settings` / `--load-filaments`.

Implementation: [`src/slicer/profile-flatten.ts`](../src/slicer/profile-flatten.ts).
Smoke test: `node scripts/test-cli-slice.mjs --model h2s|h2d|x1c|p1s`.

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
2. Pick the **printer profile that matches the target machine** (H2S, H2D, X1C, P1S, A1, …). The start g-code differs per series — a plate sliced for X1 will heat-soak wrong on H2.
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
| H2S / H2D    | `project_file`       | `gcode_file` not supported; firmware reads `Metadata/plate_<n>.gcode` from the zip directly. |

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
