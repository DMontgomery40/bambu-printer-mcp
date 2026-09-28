# Changelog

## Unreleased

### Fixed
- Keep heater-off on the selected printer transport after model elicitation, including an overridden non-X2D serial.
- Interrupt pending native helpers on MCP cancellation, stop, and heater-off; wait for process exit before releasing snapshots, with bounded SIGKILL escalation when SIGTERM is ignored.
- Route X2D controls from the selected serial when the print model was elicited, without applying the configured X2D transport to an overridden printer.
- Restrict public raw native controls to validated AMS metadata and calibration queries/selection; exclude motion, loading, heating, and safety-setting mutations.
- Add a macOS native build/test CI job while preserving the existing Linux test check.
- Remove machine-specific launchers and unused GUI automation from the upstream change and release archives.
- Resolve the model before selecting the X2D native route, including MCP model elicitation, and pass that resolved model through dispatch.
- Reject raw `ams_mapping2` overrides and missing/empty requested AMS mappings before dispatch; derive native mappings from checked structured tray assignments without silently selecting an external spool.
- Cover macOS and Linux control routing explicitly, and restrict native helper execution tests to supported hosts.
- Integrate X2D native prints, uploads, heaters, resume, and error clearing with the current shared file/state/confirmation checks. Preserve existing model routes and reject raw-control bypasses.
- Include only native source and build scripts in npm and desktop distributions; locate the optional compiled helper relative to the installed package and test fresh local, global, and npm-exec installations. Keep proprietary plug-ins and local binaries out of release archives.
- Resolve include-based installed templates and substitute current filament/hotend macro names in optional syntax regressions; do not assume a particular installed G383 variant.
- Retain VailElla's prior X2D eMMC/certificate investigation and hardware evidence. This follow-up uses mocked printer regressions and clean-install/build checks; it does not claim a new physical print.
- Include the printer host in FTPS TLS options so data connections resume the control session. basic-ftp wraps each data socket without a host, so Node can bind its resumable session to `localhost` instead of the printer host and printers requiring TLS session reuse replied `522 SSL connection failed: session reuse required` to every LIST, STOR and RETR. The contributor verifies successful upload, size check, and deletion on physical X2D USB storage; internal eMMC still refuses FTPS writes with `553`. Printing remains a separate check. `list_printer_files` still uses bambu-js's own FTP client and is not covered by this change.

## [1.1.13] – 2026-09-27

### Added
- Add shared print safety checks for declared model, nozzle, material, selected plate, and every supported heating command in the final printable file.
- Require fresh MQTT identity, nozzle configuration, ready state, and error checks before upload and dispatch; compare declared material with available mapped-spool reports.
- Preserve complete mixed dual-nozzle diameter metadata and accept explicit per-nozzle diameter requirements for pre-sliced direct and bridge jobs.
- Preserve the selected plate's used filament slots during all-nozzle warmup checks; temperature candidates do not create extra AMS mapping requirements.
- Apply independent printer/component and material temperature ceilings, reject nonfinite values before connecting, and require declared material for manual nozzle heating. Keep heater-off commands available.
- Inspect private file snapshots and use unique remote print names. Download and inspect remote G-code before starting a verified copy.
- Check the currently loaded material for manual heating and G-code-file dispatch, bind resume to an inspected paused job, and let stop/heater-off requests cancel pending operations before dispatch.
- Reject G-code-file starts and resumes when fresh telemetry explicitly reports an unloaded nozzle; preserve declared-material manual heating for loading filament.
- Register successful inspected BambuNetwork jobs for the same verified resume path, using unique submitted task identities.
- Reject ambiguous ZIP entries and bind the dispatched plate and checksum to inspected bytes; bound archive inspection and check every printable plate on upload-only requests, refusing noncanonical plate names and unrecognized G-code entries.
- Preserve existing remote files with unique upload names and destination collision checks; verify uploaded job model/nozzles against fresh printer reports.
- Add human print/heating preflight through MCP elicitation, mandatory finished-bed clearance, and confirmed hardware-error clearing with acknowledgment on the next print.
- Preserve cleared-error acknowledgment across failed print attempts until a checked dispatch succeeds. Release rejected bridge snapshots immediately and retain only files handed to an asynchronous upload.
- Validate H2D probing, wipe, and tool-change thermal commands and normalize GUI nozzle-variant tables. Apply a 260°C normal PLA ceiling with one narrowly bounded X1E startup-purge sequence; refuse explicit non-FFF jobs and recognized laser-enabling commands.
- Apply the checks to the optional BambuNetwork print wrapper and restrict raw bridge calls to named read-only probes. Require LAN telemetry even when the bridge submits through a cloud session.
- Require a single external-spool plate for legacy `.gcode.3mf` dispatch; use a `.3mf` project export when verified AMS mappings or plate selection are needed.
- Credit Boardy (@boardyai) for raising the nozzle-verification question and David Montgomery for the temperature and hardware-safety reports. Validation uses mocked printer boundaries; physical printer acceptance remains a separate check.
## [1.1.12] – 2026-09-27

### Documentation
- Publish a searchable documentation site on GitHub Pages at https://dmontgomery40.github.io/bambu-printer-mcp/. Pages are generated from the README, setup, slicing, and FULU guides, changelog, and contributor credits at build time, so the repository Markdown remains the single source.
- Keep README deep links working on the site with GitHub-compatible heading anchors. The site build fails on broken links, unknown anchors, or README content that no page publishes; pull requests build it without deploying.
- Add a large-image social card and per-page link-preview titles, descriptions, and canonical URLs for the site.
- Replace the outdated example commands with outcome-first requests: adapting a MakerWorld model, printing from a photo, and checking on a print by messaging an always-on agent from anywhere. Clarify which abilities come from the agent and which from this server.

## [1.1.11] – 2026-09-27

### Fixed
- Require the exact model/nozzle machine preset for FULU and Orca CLI slicing, including aliases and automatic slicing before printing. Reject missing or malformed presets before launching the slicer; process overrides cannot bypass the gate.
- Resolve FULU/Orca BBL inheritance and include templates, validate model CLI configuration, and preserve custom process settings and complete filament-slot mappings through the same preparation path as BambuStudio.
- Resolve inherited machine defaults before selecting process and filament profiles, including FULU's P1S family defaults.
- Preserve configured user directories for custom process/filament dependencies while keeping machine inheritance confined to the selected installation.
- Discover matching Orca/FULU profile trees beside the active executable and prevent fallback to another installation's bundled presets. Keep Orca extrusion normalization after inheritance resolution.
- Update agent setup guidance for the shared safety gate. Regression checks cover preparation and side-effect prevention; live FULU/Orca slicing and physical printing remain separate validation.

## [1.1.10] – 2026-09-27

### Documentation
- Restore prominent thanks to FULU Foundation, Louis Rossmann, and the OrcaSlicer-bambulab community, including the project's commitment to open-source software and cloud-free local printing.
- Add a dedicated FULU setup guide covering slicer/export and CLI use, Linux/WSL/macOS bridge configuration, cloud authentication, shared paths, probes, and validation limits.
- Replace manual README onboarding with one copy-and-paste agent setup request; move installation, environment variables, and LAN instructions into a linked setup reference. Treat code mode as optional.
- Document the existing FULU/Orca CLI missing-machine-preset safety limitation and direct users and setup agents to GUI-exported sliced projects until an equivalent validation gate ships.
- Make the README's major reference sections collapsible while keeping the FULU acknowledgment and agent setup request visible.
- Reorganize README navigation and correct stale client configuration, LAN/account requirements, firmware routing, AMS mapping, and bridge capability descriptions.

## [1.1.9] – 2026-09-27

### Added
- Recognize X2D (`N6`, serial prefix `20P`) for status, camera routing, and slicing with its own installed BambuStudio preset. Direct X2D printing remains deferred pending the native eMMC transport and stops before printer side effects. Contribution and hardware/status/slicing evidence: [#18](https://github.com/DMontgomery40/bambu-printer-mcp/pull/18), by Sebastian (@sebas1986).

### Fixed
- Give every CLI filament slot its own colour to address the multi-filament access violation reproduced by the contributor on Windows BambuStudio 02.08.02.60. Preserve explicit colours, input-project colours, and custom profile settings.
- Place an unset prime tower within the area shared by all nozzles, while retaining saved project positions and explicit process overrides.
- Apply required colour and tower overlays to standalone custom profiles without replacing unrelated settings.
- Correct the desktop-release workflow's Node setup cache option so extension packaging can run automatically.

## [1.1.8] – 2026-09-27

### Changed
- Consolidate shared agent rules for local and GitHub review, retain public documentation, and keep scratch plans, progress logs, and handoff notes out of Git.

### Added
- Connect to standard Blender MCP servers with tool discovery, schema-checked calls, timeouts/cancellation, and verified STL import/edit/export. Keep the custom-executable bridge available with explicit verification status.
- Package a Claude Desktop extension with prompted printer settings, safe staging, and synchronized release versions ([#11](https://github.com/DMontgomery40/bambu-printer-mcp/pull/11)).

### Fixed
- Validate large Blender STL meshes without boxing coordinate arrays, keeping finite-geometry checks within a bounded JavaScript heap.
- Preserve the selected bundled process preset identity through generated settings, and remove automatically created temporary roots on shutdown while retaining explicitly configured TEMP_DIR contents.
- Stop before printer uploads when automatic slicing or required profile preparation fails, preserving the original diagnostic. Validate model CLI configuration before flattening and advertise the required output path for standard Blender MCP edits.
- Apply the required printer dependency patch to the resolved installed package, including hoisted npm installations, and fail installation if it cannot be applied.
- Resolve CLI profile dependencies automatically and stop before slicing on incomplete profiles. Preserve custom overrides and filament-slot order, replace every declared 3MF slot for a single-profile override, discover platform-specific profile trees, and isolate concurrent config files.
- Point installation examples at `bambu-printer-mcp` and report the installed npm version in the MCP handshake.
- Create a private temporary directory per server instance, so desktop-extension startup does not depend on a writable working directory and concurrent printers cannot overwrite each other's default outputs.
- Resolve Bambu profile include templates so CLI slicing retains machine-specific G-code ([#16](https://github.com/DMontgomery40/bambu-printer-mcp/pull/16), reported in [#12](https://github.com/DMontgomery40/bambu-printer-mcp/issues/12)).
- Use the P2S project-file payload with its cache upload path while retaining legacy P1/X1 routes ([#15](https://github.com/DMontgomery40/bambu-printer-mcp/pull/15)).
- Start full-size A1 pre-sliced projects from the SD root via `project_file`, preserving other models' routes and all project filament mapping positions ([#14](https://github.com/DMontgomery40/bambu-printer-mcp/pull/14)).
- Keep H2C/H2D/H2S status connections alive when delayed OTA version messages arrive; recognize H2 serial prefixes, preserve unknown model identities, and accept unexpected status transitions without terminating the MQTT listener ([#7](https://github.com/DMontgomery40/bambu-printer-mcp/issues/7)).

### Security
- Refresh compatible transitive dependencies to resolve the nine npm audit findings in the previous lockfile; retain the pinned printer dependency patch.
- Per-call `slicer_path`, `ffmpeg_path`, and `bridge_command` executable selectors are now rejected by default. Trusted server-side environment configuration remains available, including `FFMPEG_PATH` for RTSP camera snapshots; set `MCP_ALLOW_EXECUTABLE_ARG=1` only when intentional per-call overrides are required. `MCP_ALLOW_BRIDGE_COMMAND_ARG` remains a compatibility alias for `bridge_command` only.

### Added
- **X2D model support** — `BAMBU_MODEL=x2d` is accepted by validation, elicitation, tool schemas, BambuStudio preset mapping, filament profile resolution, RTSP camera routing, and the dual-nozzle H2-family `project_file`/`ams_mapping2` print path. The X2D model ID `N6` is recognized when reported by the printer.

## [1.1.3] – 2026-05-31

### Added
- **H2C model support** — `BAMBU_MODEL=h2c` is now accepted by validation, elicitation, tool schemas, BambuStudio preset mapping, filament profile resolution, and the H2 project-file print path. H2C should not use `h2d` as a fallback; the explicit model is required for safe slicer preset selection and H2 AMS mapping behavior.

## [1.1.1] – 2026-04-29

### Fixed
- **`auto_match_ams` now handles same-SKU different-color filaments.** Previously the matcher keyed only on `tray_info_idx`, so a 3MF needing two GFG02 (PETG HF) trays — one black, one white — would error out as "could not find loaded AMS trays for: GFG02, GFG02" even when both were present. The matcher now joins on `(tray_info_idx, tray_color)` (RGB-normalized; alpha bytes ignored) and tracks already-claimed slots so two requirements can't collapse onto the same physical slot. Falls back to SKU-only matching when the 3MF carries no color or only one tray of that SKU is loaded. Returns a structured `missing` report with reasons (`no_loaded_match` / `color_mismatch` / `exhausted` / `no_sku`) when resolution fails.
- **`get_printer_filaments` retries when AMS data hasn't arrived yet.** The first MQTT push from an idle printer is sparse (model/modules only); AMS data arrives on a second push that often misses the 500ms settle window in `waitForInitialReport()`. Adds a 1.5s retry in `getResolvedPrinterFilamentInventory()` when trays are empty, matching the same retry pattern already used by the HMS resource handler. Validated on Parker H2S (4 loaded trays, all profiles resolved) and Kingpin H2D (no AMS connected — accepted gracefully).
- **HMS resource retries when first status push has no HMS data.** Same root cause — the first MQTT push is sparse (model/modules only); HMS/error fields arrive on a subsequent push. Added 1.5s settle-and-retry in the `printer://{host}/hms` resource handler. Validated on Parker H2S and Kingpin H2D: both returned `hms_errors: 1` (`code: 131099`).

### Added
- **`set_ams_drying` tool** — start or stop the AMS filament drying cycle on heated AMS units (AMS Pro / AMS-HT). Sends `print.ams_control` MQTT command with `start_drying`/`stop_drying` param. Includes input validation (action must be start/stop, ams_id must be 0-3) and 4 new unit tests covering validation and correct command payload shape.
- **`scripts/validate-printer.mjs`** — reusable MCP-over-stdio validation harness that tests HMS resource, set_light, set_fan_speed, set_airduct_mode, clear_hms_errors, get_printer_status, and get_printer_filaments against a live printer. Spawns the MCP server as a child process, sends JSON-RPC messages over stdin/stdout, reports pass/fail per test.
- **`PrinterFilamentInventory` now includes `summary`, `profile_resolution`, `match_confidence`, and `display_name`.** Each tray entry carries a resolution tier (`exact-model-nozzle` / `model` / `generic` / `unresolved`) and a human-readable display name combining sub-brand, type, and color. Top-level `summary` object reports loaded/resolved/empty slot counts and a recommended slot with a human-readable reason. Helps callers make informed `auto_match_ams` decisions without reading raw MQTT status.
- **`scripts/build-charm-3mf.mjs`** — constructs a multi-object source `.3mf` from two STLs (body + face/detail). Volume-based body/face detection (signed-tetrahedron sum, robust to OpenSCAD's uniform facet density). Inline meshes in `3D/3dmodel.model`, per-object `<metadata key="extruder" value="N"/>` in `Metadata/model_settings.config`, plate-level `filament_maps` for H2D dual-extruder routing. Carries `project_settings.config` from a known-good template 3MF. Output is a valid Bambu source project that the CLI parses cleanly; only the upstream slicer-setup SIGSEGV blocks it from being end-to-end useful today.

### Changed
- **Validation script now tests `get_printer_filaments`.** `scripts/validate-printer.mjs` added as test 8 with live tray output. Also fixed the AMS inspection in the `get_printer_status` test to read the correct raw structure (`data.ams.ams` array) instead of the nonexistent `.trays` path. Accepts "no AMS connected" as a valid printer state.

### Known issues
- **Multi-color CLI slicing is blocked upstream.** BambuStudio CLI 02.06.00.51 SIGSEGVs in `load_nozzle_infos_with_compatibility` for any H2D dual-extruder, multi-color project, regardless of input geometry. Verified via a two-cube minimal repro and filed as [bambulab/BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408). Workaround until upstream ships a fix: pre-slice in Bambu Studio GUI and hand the resulting `.gcode.3mf` to `print_3mf`. The dispatch path is fully functional. `scripts/build-charm-3mf.mjs` is ready to drive the CLI once #10408 lands.

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
  - **RTSPS via ffmpeg** (`rtsps://bblp:<token>@<host>:322/streaming/live/1`) for **X1, X1 Carbon, X1E, P2S** and **H2, H2S, H2D, H2C, H2D Pro**. Verified live against Parker (H2S), Kingpin (H2D), and an X1C — all return real chamber JPEGs in ~1.5s. The H2 series was not documented upstream; local investigation established the RTSP path.
  - Response includes a `transport` field so callers can tell which path produced the frame.
  - `experimental` flag from interim work is now a no-op (kept on the schema for compatibility).
  - Requires `ffmpeg` in `PATH` for the RTSP path; `ffmpeg_path` argument allows override.

### Fixed
- BambuStudio `--load-machine` flag replaced with the correct flag; 3MF inputs now accepted by `get_stl_info`.
- **H2/H2D mapping safety** — `print_3mf` now fails fast on H2 series pre-sliced jobs with declared filaments unless one of `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true` is provided. Avoids sending an under-specified `project_file` that the printer accepts but does not visibly start. For H2/H2D, the embedded `slicerConfig.ams_mapping` parsed from the 3MF is no longer trusted (stale-metadata risk). Regression test locks in the recovered working H2 mapping shape.
- **SuperTack on CLI slicing** — `supertack_plate` is accepted on the pre-sliced print path (the only verified case) but rejected fast on the BambuStudio CLI auto-slice path because the CLI bed identifier is unverified and earlier attempts produced gcode that fell back to Cool Plate.

## [1.0.5] – prior release

Initial public release with core print, upload, slice, and status tooling.

[1.1.3]: https://github.com/DMontgomery40/bambu-printer-mcp/commit/d9742202bd931bf8ca39a348713efa6ef05f784c
[1.1.1]: https://github.com/DMontgomery40/bambu-printer-mcp/tree/v1.1.1
[1.1.0]: https://github.com/DMontgomery40/bambu-printer-mcp/commit/29b8ec4565ec4dd0858e14441b4fe1cd1d4d45a0
[1.0.5]: https://github.com/DMontgomery40/bambu-printer-mcp/tree/v1.0.5

[1.1.9]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.9
[1.1.8]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.8
[1.1.10]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.10
[1.1.12]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.12
