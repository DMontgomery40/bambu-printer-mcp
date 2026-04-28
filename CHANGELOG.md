# Changelog

## Unreleased

### Fixed
- **`auto_match_ams` now handles same-SKU different-color filaments.** Previously the matcher keyed only on `tray_info_idx`, so a 3MF needing two GFG02 (PETG HF) trays — one black, one white — would error out as "could not find loaded AMS trays for: GFG02, GFG02" even when both were present. The matcher now joins on `(tray_info_idx, tray_color)` (RGB-normalized; alpha bytes ignored) and tracks already-claimed slots so two requirements can't collapse onto the same physical slot. Falls back to SKU-only matching when the 3MF carries no color or only one tray of that SKU is loaded. Returns a structured `missing` report with reasons (`no_loaded_match` / `color_mismatch` / `exhausted` / `no_sku`) when resolution fails.

### Known issues
- **Multi-color CLI slicing is blocked upstream.** BambuStudio CLI 02.06.00.51 SIGSEGVs in `load_nozzle_infos_with_compatibility` for any H2D dual-extruder, multi-color project, regardless of input geometry. Verified via a two-cube minimal repro and filed as [bambulab/BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408). Workaround until upstream ships a fix: pre-slice in Bambu Studio GUI and hand the resulting `.gcode.3mf` to `print_3mf`. The dispatch path is fully functional. `scripts/build-charm-3mf.mjs` is ready to drive the CLI once #10408 lands.

### Added
- **`scripts/build-charm-3mf.mjs`** — constructs a multi-object source `.3mf` from two STLs (body + face/detail). Volume-based body/face detection (signed-tetrahedron sum, robust to OpenSCAD's uniform facet density). Inline meshes in `3D/3dmodel.model`, per-object `<metadata key="extruder" value="N"/>` in `Metadata/model_settings.config`, plate-level `filament_maps` for H2D dual-extruder routing. Carries `project_settings.config` from a known-good template 3MF. Output is a valid Bambu source project that the CLI parses cleanly; only the upstream slicer-setup SIGSEGV blocks it from being end-to-end useful today.

## [1.1.0] – 2026-04-27

### Added
- **BambuStudio CLI auto-flatten** (`BAMBU_CLI_FLATTEN=true`): walks the BBL profile `inherits` chain and emits CLI-ready configs, working around upstream BambuStudio issues [#9636](https://github.com/bambulab/BambuStudio/issues/9636) and [#9968](https://github.com/bambulab/BambuStudio/issues/9968). Verified on H2S, H2D, X1C, P1S.
- **pause_print / resume_print** tools — MQTT pause and resume alongside the existing cancel_print.
- **AMS RFID slot resolution** — `resolve_3mf_ams_slots` dry-run tool matches sliced 3MF filament requirements against live AMS inventory; opt-in `auto_match_ams` flag on `print_3mf`.
- **HMS diagnostics resource** — `printer://{host}/hms` MCP resource for read-only HMS error summary.
- **set_light / set_fan_speed** — MQTT wrappers for chamber light and fan speed control.
- **skip_objects** — list object IDs from a sliced 3MF plate (`list_3mf_plate_objects`) and skip them during a running print (`skip_objects`).
- **Utility controls** — `set_print_speed`, `set_airduct_mode`, `clear_hms_errors`, `reread_ams_rfid`.
- **Bed-aware slicing** — `bed_type` parameter on `slice_stl` and `print_3mf` maps to BambuStudio CLI `--bed-type`.
- **Collar charm wrapper** (`print_collar_charm`) — fixed tray policy for two-colour dog collar charm projects.
- **delete_printer_file** — destructive FTPS DELETE with `confirm:true` gate, allowlist on `cache/`, `timelapse/`, `logs/`, and explicit rejection of `..` segments.
- **camera_snapshot** — capture a single JPEG from the printer's chamber camera. Two transports wired in:
  - **TCP-on-6000** (per OpenBambuAPI `video.md`) for **A1, A1 mini, P1S, P1P**.
  - **RTSPS via ffmpeg** (`rtsps://bblp:<token>@<host>:322/streaming/live/1`) for **X1, X1 Carbon, X1E, P2S** and **H2, H2S, H2D, H2C, H2D Pro**. Verified live against Parker (H2S), Kingpin (H2D), and an X1C — all return real chamber JPEGs in ~1.5s. The H2 series wasn't documented upstream; root cause and fix recorded in `PROGRESS.md` ("H2 camera RESOLVED via RTSP").
  - Response includes a `transport` field so callers can tell which path produced the frame.
  - `experimental` flag from interim work is now a no-op (kept on the schema for compatibility).
  - Requires `ffmpeg` in `PATH` for the RTSP path; `ffmpeg_path` argument allows override.

### Fixed
- BambuStudio `--load-machine` flag replaced with the correct flag; 3MF inputs now accepted by `get_stl_info`.
- **H2/H2D mapping safety** — `print_3mf` now fails fast on H2 series pre-sliced jobs with declared filaments unless one of `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true` is provided. Avoids sending an under-specified `project_file` that the printer accepts but does not visibly start. For H2/H2D, the embedded `slicerConfig.ams_mapping` parsed from the 3MF is no longer trusted (stale-metadata risk). Regression test locks in the recovered working H2 mapping shape.
- **SuperTack on CLI slicing** — `supertack_plate` is accepted on the pre-sliced print path (the only verified case) but rejected fast on the BambuStudio CLI auto-slice path because the CLI bed identifier is unverified and earlier attempts produced gcode that fell back to Cool Plate.

## [1.0.5] – prior release

Initial public release with core print, upload, slice, and status tooling.
