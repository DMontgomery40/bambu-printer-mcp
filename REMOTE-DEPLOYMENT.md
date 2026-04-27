# Remote Deployment Notes

Updated: 2026-04-27

This document summarizes the deployment-relevant changes in this patched `bambu-printer-mcp` clone without including operator-specific hosts, printer names, serials, or secrets.

## Scope

This branch extends the previously dormant project so it can work reliably with newer Bambu hardware, especially:

- H2D
- H2S
- AMS-backed `.gcode.3mf` and project-based `3mf` print flows
- template-driven slicing workflows
- read-only diagnostics and basic live controls

## Deployment-Relevant Changes

### MQTT status handling

Files:

- `src/printers/bambu.ts`
- `dist/printers/bambu.js`

Changes:

- Added a tolerant Bambu MQTT client path that does not depend on the legacy `get_version` ACK.
- Added a small report cache keyed by printer connection identity.
- Waits for the first real `push_status` report instead of assuming the printer object is populated immediately after connect.
- Keeps a fire-and-settle helper for commands that do not ACK reliably on newer firmware.

Why it matters:

- Some newer Bambu firmware builds stream valid status while never answering the older handshake path expected by the original library.
- Without this patch, printers could appear disconnected even when status and control were actually available.

### Environment variable compatibility

Files:

- `src/index.ts`
- `dist/index.js`

Changes:

- Added support for:
  - `BAMBU_PRINTER_HOST`
  - `BAMBU_PRINTER_SERIAL`
  - `BAMBU_PRINTER_ACCESS_TOKEN`
  - `BAMBU_PRINTER_MODEL`
  - `BAMBU_STUDIO_PATH`
- Kept compatibility with the original names:
  - `PRINTER_HOST`
  - `BAMBU_SERIAL`
  - `BAMBU_TOKEN`
  - `BAMBU_MODEL`
  - `SLICER_PATH`

Why it matters:

- Existing machine-local configs often already use the `BAMBU_PRINTER_*` naming pattern.
- Accepting both schemes reduces migration friction.

### H2 printer support

Files:

- `src/index.ts`
- `dist/index.js`
- `README.md`

Changes:

- Added `h2s` to model validation.
- Added H2-series slicer preset mapping.
- Extended tool schema enums and validation so H2D/H2S can be used directly in slicing and print calls.

Why it matters:

- The original project did not fully support these newer Bambu models in the local MCP workflow.

### FTPS and project-file print path hardening

Files:

- `src/printers/bambu.ts`
- `dist/printers/bambu.js`

Changes:

- Hardened FTPS upload behavior to survive the TLS session reuse quirk that blocks some Bambu file uploads.
- Added the H2-safe `.gcode.3mf` / `project_file` print path handling needed by newer H2 firmware.
- Expanded AMS mapping behavior so project-length mappings and `ams_mapping2` are emitted for H2-class printers.

Why it matters:

- This is the core fix that allows local FTPS + MQTT printing to work reliably on H2D/H2S with AMS.

### Live filament inventory resolution

Files:

- `src/index.ts`
- `dist/index.js`

Changes:

- Added `get_printer_filaments` to normalize live AMS tray data from MQTT.
- Resolves printer-reported tray identifiers to slicer-ready filament profile paths.
- Added a simple single-material slicing fallback so `slice_stl` can reuse the active printer filament when the caller does not provide an explicit slicer profile or `load_filaments`.
- Template-driven slicing and live MQTT filament selection now work together.

Why it matters:

- Agents can now move from “what is loaded right now?” to “slice with the correct material” without manual lookup glue.

### BambuStudio CLI flattening

Files:

- `src/slicer/profile-flatten.ts`
- `src/stl/stl-manipulator.ts`
- `dist/slicer/profile-flatten.js`
- `dist/stl/stl-manipulator.js`

Changes:

- Added an opt-in BBL profile flattener behind `BAMBU_CLI_FLATTEN=true`.
- Flattens bundled BambuStudio `inherits` chains before CLI slicing.
- Applies BambuStudio CLI machine-limit overlays and derives required H2/P/X profile fields.

Why it matters:

- This works around current BambuStudio CLI profile-resolution failures without making CLI slicing the default production path.

### Diagnostics and controls

Files:

- `src/index.ts`
- `src/printers/bambu.ts`
- `dist/index.js`
- `dist/printers/bambu.js`

Changes:

- Added `printer://{host}/hms` for read-only HMS/error diagnostics.
- Added `pause_print` and `resume_print`.
- Added `set_light` and `set_fan_speed`.
- Added `list_3mf_plate_objects` and `skip_objects`.
- Added `resolve_3mf_ams_slots` plus opt-in `print_3mf auto_match_ams`.

Why it matters:

- Agents can inspect common failure state, resolve AMS slot requirements, and perform basic controls without hand-crafting MQTT payloads.

## What Was Verified

This branch has been verified locally for:

- `npm run build`
- `npm test` (19/19 passing)
- BambuStudio CLI smoke slicing for H2S, H2D, X1C, and P1S
- MCP stdio `slice_stl` with `BAMBU_CLI_FLATTEN=true`
- H2-class AMS mapping behavior through regression tests
- local H2 print dispatch logic for project-based prints
- template-aware slicing and print-path integration

Live checks on 2026-04-27 verified:

- H2D status and `printer://{host}/hms`
- H2S status and `printer://{host}/hms`
- X1C status connectivity
- `set_light` on the H2D, then restored to off
- `set_fan_speed` on the H2D chamber fan, restored to 0
- `list_3mf_plate_objects` against the local sliced sample
- `resolve_3mf_ams_slots` against H2D/H2S; it correctly reported the sample's required PLA `tray_info_idx` was not loaded

Still not live-validated:

- `print_3mf auto_match_ams`
- `skip_objects`
- a full physical H2S/H2D print from this branch after the latest feature additions

## Safe Deployment Guidance

Recommended deployment shape:

1. Copy this patched repo to the target machine.
2. Install runtime dependencies:
   - `npm install --omit=dev`
3. Point your MCP host or wrapper at:
   - `node /path/to/bambu-printer-mcp/dist/index.js`
4. Keep printer secrets in machine-local config, not in synced repo files.
5. Smoke test in this order:
   - `get_printer_status`
   - `printer://{host}/hms`
   - `get_printer_filaments`
   - `list_printer_files`
   - `resolve_3mf_ams_slots` on the intended sliced file
   - a non-critical print or upload flow

## Operational Notes

- This repo currently checks in both `src/` and built `dist/` artifacts, so deployment can use the committed runtime directly.
- Certificate-based auth research is separate from the currently working local access-code FTPS + MQTT path.
- If you maintain multiple printers, prefer one machine-local config entry per device instead of baking printer identities into the repo.
