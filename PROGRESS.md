# Progress

## Active TODO (source of truth)

Last updated: 2026-04-28 17:00 ET.

| Priority | Owner | Status | Item | Next action | Done when |
|---|---|---|---|---|---|
| P0 | Codex | In progress | Keep this TODO current | Update this table after every meaningful test, code change, upstream reply, or handoff | A new agent can answer "what next?" from this table alone |
| P0 | Upstream / Codex | Blocked upstream | H2D two-color CLI slicing for overlapping charm parts | Wait for BambuStudio fix or maintainer response on [#10408](https://github.com/bambulab/BambuStudio/issues/10408); retest any build newer than `02.06.01.55` | CLI produces a valid two-filament H2D `.gcode.3mf` from the bunny/charm workflow |
| P1 | Codex | Done | Preserve current progress log | Committed to `codex/collar-charm-h2-cleanup` at `ef6f2b9` | Commit exists on `codex/collar-charm-h2-cleanup` with only intentional docs/progress changes |
| P1 | DeepSeek | Done | GUI-export to CLI-slice comparison | Tested in session: GUI 3MF → CLI slice returns -100 "No valid nozzle found". Both the assemble-list code path AND the GUI-export path fail for H2D two-color CLI. Reported in deepseek-progress.md. | We know both paths fail — assemble-list crashes (SIGSEGV 139), GUI-export fails gracefully (-100 nozzle mismatch). |
| P1 | DeepSeek | Done | Source-level crash narrowing | Analyzed OrcaSlicer source: null dereference at `PrintObject.cpp:743` in `detect_overhangs_for_lift()`. Same file already has null guards at lines 2341 and 2445-2447 for the same pattern. Proposed fix: `if (layer.lower_layer == nullptr) continue;` before the dereference. Documented with exact code context and fix precedent in `deepseek-progress.md`. | Precise fix hypothesis exists: one-line null guard matching existing code patterns. No CLI workaround exists — the issue requires a source patch to BambuStudio. |
| P2 | Codex | Done | Make CLI failure clearer in MCP docs/tooling | README and `docs/SLICING.md` now explicitly say single-color CLI smoke works but H2D two-color CLI slicing is blocked by #10408 | `README.md` / `docs/SLICING.md` / tool descriptions do not imply headless H2D two-color slicing works today |
| P2 | Codex | Done | Retest generic CLI smoke on `02.06.01.55` | Ran `scripts/test-cli-slice.mjs` for `h2s`, `h2d`, `x1c`, `p1s`; all passed | We know single-color H2S/H2D/X1C/P1S CLI slicing still passes after the app upgrade |
| P2 | DeepSeek | Done | Tiny Z-offset overlap experiment | Tested in session: 0.22mm Z-offset between objects still crashes SIGSEGV 139. Crash is NOT about geometric overlap — it's about having two objects with different extruders on the same plate, regardless of spatial overlap. | Z-offset does not avoid the crash. The root cause is in the multi-extruder code path, not overlapping geometry. |
| P2 | DeepSeek | Optional diagnostic | Find an official CLI analog for GUI "Split to Parts" | Inspect source/UI actions for how GUI split-to-parts stores per-volume extruders and plate/model metadata, then compare to our generated 3MF/assemble-list output | We know whether our generated metadata differs from GUI-authored split-to-parts metadata in a way that explains #10408 |
| P3 | Codex | Done | HMS diagnostics resource | Validated live on Parker H2S and Kingpin H2D: MQTT connected, returned structured response. Resource now includes 1.5s settle-and-retry for the incremental HMS status push. Both printers showed `hms_errors: 1` (`code:131099`). | Resource returns current state plus HMS/error/warning fields without throwing |
| P3 | Codex | Done | Chamber light control | Validated live on Parker H2S and Kingpin H2D: `set_light` toggled chamber_light on/off; both returned `{status:"success"}`. | `set_light` visibly or statefully changes chamber light and returns success |
| P3 | Codex | Done | Fan control | Validated live on Parker H2S and Kingpin H2D: `set_fan_speed` set auxiliary fan to 30% then 0%; both returned `{status:"success"}` with correct fan/speed fields. | Command is accepted and status/UI reflects expected fan target |
| P3 | Codex | Implemented / needs active-print validation | Print speed mode | During a user-approved non-critical print, test `silent` then `standard`; do not use `sport`/`ludicrous` as first validation | Printer accepts speed mode changes and reports/behaves as expected |
| P3 | Codex | Done | Airduct mode | Validated live on Parker H2S and Kingpin H2D: `set_airduct_mode` toggled cooling then heating; both returned `{status:"success"}` with correct mode field. | Command is accepted and no persistent unwanted airduct state remains |
| P3 | Codex | Done | Clear HMS/errors | Validated live on Parker H2S and Kingpin H2D: found 1 active HMS error (`code:131099`) on each, `clear_hms_errors` returned `{status:"success"}`. Resource now has 1.5s settle-and-retry to catch incremental HMS push. | `clean_print_error` path clears or acknowledges the target error without masking real faults |
| P3 | Codex | Implemented / physical AMS validation required | AMS RFID reread | Only run with explicit user approval; select AMS/slot, observe any AMS movement, then verify inventory refresh | `reread_ams_rfid` refreshes the expected slot and does not disturb print state |
| P3 | Codex | Implemented / active-print validation required | Skip objects | During a user-approved test print with known object IDs, call `list_3mf_plate_objects`, then `skip_objects` for a harmless object | Printer skips only the requested object(s); command shape verified against firmware |
| P3 | Codex | Done | Better AMS inventory reporting | Added summary counts, display labels, profile resolution confidence, recommended `load_filaments`, README docs; `npm test` 35/35 | Output is easier to use for `auto_match_ams` decisions without reading raw status |
| P3 | User + Codex | Parked | Physical print validation | Do not start prints or move hardware unless the user explicitly asks | Any print test has explicit user approval and plate/material context |

Immediate next recommended action: All idle-printer P3 items validated on both Parker H2S and Kingpin H2D. Remaining P3 items: AMS RFID reread (physical movement, needs user approval), print speed mode (during active print), skip objects (during active print). First is ready to discuss; others need a test print.

### DeepSeek Sidecar Lane

Current handoff file:
`/Users/alexbuchan/Sync/bambu-printer-mcp/.claude/worktrees/upbeat-perlman-91e587/deepseek-progress.md`

What DeepSeek already proved:
- Single-object `--load-assemble-list` can slice and produce valid gcode.
- H2D PETG assemble-list needs `plate_params.curr_bed_type = "Textured PEI Plate"` or it can fall back to Cool Plate validation failure.
- Two-object/two-filament attempts still fail across all approaches, including after upgrading to BambuStudio 02.06.01.55.
- Z-offset (0.22mm) does NOT avoid the crash — it's not about geometric overlap.
- P1S also crashes but with a different signal (SIGTRAP 133 vs SIGSEGV 139).
- **Root cause confirmed:** null `lower_layer` dereference in `PrintObject::detect_overhangs_for_lift()` at line 743. The same file already null-guards `lower_layer` at lines 2341 and 2445-2447. The fix is a one-line `if (layer.lower_layer == nullptr) continue;` guard.
- GUI-export → CLI-slice path fails cleanly with -100 "No valid nozzle found" — different failure from the SIGSEGV.

Do not duplicate DeepSeek unless needed:
- Broad source spelunking in `/tmp/orca-src`.
- Reproving single-object assemble-list slicing.
- Retrying the already-failed no-support / no-prime-tower / no-overhang-speed matrix.

Good DeepSeek next prompts:
- (Deprecated — source-level crash narrowing is complete)
- (Deprecated — Z-offset diagnostic confirmed no effect)
- (Deprecated — GUI-export comparison done)

## Multi-object 2-color CLI slicing — partial / blocked (2026-04-28)

Goal: take a single charm STL (e.g. `EASTER_BUNNY_small.stl`) with multiple
connected components and produce a printable two-color H2D `.gcode.3mf`
without GUI involvement. Same workflow that produced the working
`POP_BARKSIDE_large.gcode.3mf`, but headless.

### Key insight

Codex tried 16 variants of `BambuStudio --load-filaments` flags with
two pre-split STLs and got `-50` (empty plate) or `-61` (filament
incompatible). Root cause: **per-object filament/extruder assignment
lives inside the 3MF (`Metadata/model_settings.config`), not in CLI
flags.** Verified by inspecting `huskies.3mf` (a real BBL multi-object
project) where each object carries `<metadata key="extruder" value="N"/>`.

### What's shipped

`scripts/build-charm-3mf.mjs` — assembles a multi-object source 3MF:
- Parses two STLs (ASCII or binary).
- Computes signed-tetrahedron volume → larger = body, smaller = face.
  Robust against OpenSCAD's uniform facet density.
- Preserves XYZ exactly as provided (caller orients the meshes; the
  charm pieces stay together).
- Emits inline `<mesh>` blocks in `3D/3dmodel.model` (single file,
  simpler than the Production-Extension multi-file layout).
- Writes `Metadata/model_settings.config` with per-object
  `<metadata key="extruder" value="N"/>` and plate-level
  `filament_maps` / `filament_volume_maps` so H2D's nozzle assignment
  doesn't fall through.
- Carries `Metadata/project_settings.config` from a known-good template
  3MF (`docs/H2D_barkside_2clr.3mf.gcode.3mf`).

### How far we got

| Stage | Result |
|---|---|
| 3MF parses, build refs match | ✅ |
| `model_settings.config` per-object extruder honored | ✅ |
| H2D `filament_maps` consumed without segfault | ✅ |
| `(extruder_type, nozzle_volume_type)` lookup with embedded settings | ❌ "could not found … nozzle_volume_type Standard" for all 8 filaments |
| Same lookup with our flattener via `--load-settings` | ✅ passed |
| Bed type validation (PETG vs Cool Plate) | ❌ first try, then ✅ with `--curr-bed-type "Textured PEI Plate"` |
| `--load-assemble-list` single-object slice | ✅ produced valid gcode; later thumbnail/GL hang is headless-macOS only |
| `--load-assemble-list` two-object/two-filament slice | ❌ SIGSEGV around support necessity / auto-lift overhang detection |
| Slicer kernel | ❌ SIGSEGV (exit 139) with no error log |

The final crash is in the slicing kernel itself, after all our
configuration parsing succeeds. Same family as upstream
[#9968](https://github.com/bambulab/BambuStudio/issues/9968) /
[#9636](https://github.com/bambulab/BambuStudio/issues/9636) — the
H2D multi-color CLI path appears to have additional segfault sites
beyond the ones PR #9941 fixed.

**Filed upstream:** [bambulab/BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408) (2026-04-27).
Requested repro files were uploaded in
[`rowbotik/bambustudio-10408-repro`](https://github.com/rowbotik/bambustudio-10408-repro)
and linked from
[issue comment 4336057068](https://github.com/bambulab/BambuStudio/issues/10408#issuecomment-4336057068).

**Confirmed upstream-only via two-cube minimal repro:** swapped the
bunny STLs for two trivial 8-vertex cubes (built inline in
`scripts/two-cubes.mjs` style), kept everything else identical.
Same SIGSEGV at the same place, same warning sequence. The crash is
fundamental to BambuStudio 02.06.00.51's H2D dual-extruder CLI path
and not a function of our input geometry, our 3MF construction, our
flattener output, or the bunny mesh's complexity.

**DeepSeek sidecar confirmation (2026-04-28):** a single-object
`--load-assemble-list` slice works when invoked with:

```bash
BambuStudio \
  --load-settings "machine.json;process.json" \
  --load-filaments "fila0.json;fila1.json" \
  --load-assemble-list assemble_list.json \
  --slice 0 \
  --outputdir ./output
```

The assemble-list needs plate-level
`"plate_params": {"curr_bed_type": "Textured PEI Plate"}` or H2D PETG
falls back to Cool Plate and fails validation. Two-object attempts crash
across merged `assemble_index`, separate objects, `--assemble` plus
`--load-filament-ids`, and OrcaSlicer 2.3.1. Disabling prime tower,
support, overhang speed/detection, `--no-check`, and `--allow-mix-temp`
did not avoid the crash. The strongest current suspicion is a null
`lower_layer` dereference in `PrintObject::detect_overhangs_for_lift()`
when processing overlapping volumes with different extruder assignments.

**BambuStudio 2.6.1 Public Beta check (2026-04-28):** installed
`02.06.01.55` and reran the #10408 repro. The exported-project CLI path
no longer SIGSEGVs, but still fails at the same auto-lift stage:

```text
Checking support necessity
Detect overhangs for auto-lift
No valid nozzle found. Please check nozzle count.
return_code=-100
```

The raw `--load-assemble-list` path, with temp-patched
`plate_params.curr_bed_type = "Textured PEI Plate"` and with/without
`--load-defaultfila`, still exits `139` immediately after
`Checking support necessity`. So 2.6.1 beta changes one failure mode but
does not unblock H2D two-object/two-filament CLI slicing.

**DeepSeek source-level analysis (2026-04-28):** confirmed the crash root
cause and proposed fix. The null dereference is at
`PrintObject.cpp:743`:

```cpp
Layer& lower_layer = *layer.lower_layer;  // null when lower_layer is nullptr
```

The same file already null-guards `lower_layer` in two other parallel-for
loops (lines 2341 and 2445-2447). The proposed fix:

```cpp
if (layer.lower_layer == nullptr)
    continue;
```

This is safe — skipping a layer with no lower layer means no overhang
data for auto-lift on that layer, which is harmless. Full analysis in
`deepseek-progress.md`.

**Z-offset tested:** 0.22mm Z-offset between color bodies still crashes
SIGSEGV 139. Confirmed: the crash is NOT about geometric overlap — it's
about having multiple objects with different extruders on the same plate,
regardless of spatial overlap.

Repro for upstream bug report:
```bash
# Two cubes 5mm × 5mm at the same XY, different Z
# Build a synthetic source 3MF with object 1 → extruder 1, object 2 → extruder 2
# Slice via:
BambuStudio --slice 0 --debug 2 \
  --curr-bed-type "Textured PEI Plate" \
  --load-settings "<flat-h2d-machine.json>;<flat-process.json>" \
  --load-filaments "<flat-petg-hf-1.json>;<flat-petg-hf-2.json>" \
  --export-3mf out.gcode.3mf input.3mf

# Result: SIGSEGV after "load_nozzle_infos_with_compatibility:
# building nozzle list from filament map and volume types"
```

### Repro commands

```bash
# Build the multi-object source 3MF
node scripts/build-charm-3mf.mjs \
  --stl-a body_white_facedown.stl \
  --stl-b face_black_facedown.stl \
  --template docs/H2D_barkside_2clr.3mf.gcode.3mf \
  --out /tmp/charm.3mf \
  --body-extruder 1 --face-extruder 2

# Slice via the verified flattener path
# (with --load-settings/--load-filaments instead of embedded settings)
BambuStudio \
  --slice 0 --debug 2 \
  --curr-bed-type "Textured PEI Plate" \
  --load-settings "<flat-machine.json>;<flat-process.json>" \
  --load-filaments "<flat-fil-1.json>;<flat-fil-2.json>" \
  --outputdir /tmp/out \
  --export-3mf out.gcode.3mf \
  /tmp/charm.3mf
```

### Workaround until upstream stabilizes

GUI-slice in BambuStudio (path A from `docs/SLICING.md`), feed the
resulting `.gcode.3mf` to `print_collar_charm` (or `print_3mf` with
explicit `ams_slots`).

### Next experiments worth trying

1. Watch for a BambuStudio build newer than `02.06.01.55`; the 2.6.1
   beta does not fix #10408.
2. Try GUI → 3MF export → CLI slice to see whether bypassing
   `--load-assemble-list` changes the failure point.
   DeepSeek result: -100 "No valid nozzle found" — both paths fail.
3. Try a tiny Z offset between color bodies to avoid exact overlapping
   volumes, only as a diagnostic. Do not use this as the default charm
   workflow without visual/print validation.
   DeepSeek result: SIGSEGV 139 still — crash is not about overlap.
4. Sniff the GUI's slice via `dtruss` to capture the exact internal
   sequence the GUI uses, then mimic.
5. **Apply the null-guard patch to OrcaSlicer and rebuild.** The fix
   is known (PrintObject.cpp:743), Patched OrcaSlicer would accept
   the same assembly list and produce valid multi-color gcode.

## Current status (2026-04-27)

Branch `codex/collar-charm-h2-cleanup` is pushed to
`rowbotik-fork/codex/collar-charm-h2-cleanup`.

Version: `1.1.0`, package name `@rowbotik/bambu-printer-mcp`.

Latest stack:

```
a14a117 docs(changelog): cover delete_printer_file, camera_snapshot, H2 mapping fixes
29b8ec4 chore: bump to 1.1.0 and add CHANGELOG
3bf954f feat(camera): RTSP path for X1/P2S/H2 series
b208eac chore: H2 camera probe scripts + diagnostic findings
5d473c5 feat(camera): add experimental:true opt-in for H2 series
2a42574 feat: add camera_snapshot MCP tool (A1/P1 only)
1838855 feat: add delete_printer_file MCP tool
12ae6b9 fix(h2): require explicit AMS mapping; reject SuperTack on CLI slicing
```

Verification:

- `npm test` passes: **35/35**.
- BambuStudio CLI slicing smoke passes for H2S, H2D, X1C, and P1S via
  `scripts/test-cli-slice.mjs`; each run produced a sliced 3MF with non-empty
  `Metadata/plate_1.gcode`.
- Two-filament CLI profile loading is not the same as verified two-color
  slicing. A temp-only H2S smoke with two cube STLs, two flattened PLA
  filament profiles, and `--load-filament-ids` accepted the profiles but still
  produced plate metadata with `filament_ids: [0]`; two-color CLI assignment
  needs more work before claiming support.
- Local ignored H2D fixture `docs/H2D_barkside_2clr.3mf.gcode.3mf` is a real
  sliced two-color H2D file: project declares 8 filaments, selected plate uses
  sparse project positions `[3,4]`, and gcode contains `T3`/`T4` changes.
  Added a synthetic regression for that metadata shape so `ams_slots: [1,2]`
  expands to `[-1,-1,-1,1,2,-1,-1,-1]` plus matching `ams_mapping2`.
- `npm pack --dry-run` passes: 21 files, 150.7 kB package.
- `npm publish --dry-run --access public` passes for
  `@rowbotik/bambu-printer-mcp@1.1.0`.
- `@rowbotik/bambu-printer-mcp@1.1.0` has been published to npm.
- Physical H2S/Parker SuperTack one-color print completed.
- Camera snapshot live probes succeeded on Parker (H2S), Kingpin (H2D), and
  X1C via RTSPS port 322.
- Changelog exists and covers the 1.1.0 stack.

Publish target: `@rowbotik/bambu-printer-mcp`. The unscoped
`bambu-printer-mcp` package belongs to upstream and should not be published
from this fork.

### Source of truth / next queue

1. Keep this file current after every meaningful change.
2. Optional live validations still useful later: `skip_objects`, light/fan,
   print speed, airduct, HMS clear, RFID reread.
3. Optional future features: two-color CLI slicing assignment verification,
   better live AMS inventory reporting for `auto_match_ams`, broader camera
   docs/examples, printer-file delete live validation on a harmless file.

---

### `camera_snapshot` — what shipped

- Implements the OpenBambuAPI TCP-on-6000 wire format (80-byte auth packet,
  16-byte frame header) for **A1 / A1 mini / P1S / P1P**.
- Routes **X1 / X1C / X1E / P2S** and **H2 / H2S / H2D / H2C / H2D Pro** to
  RTSPS port 322 via ffmpeg:
  `rtsps://bblp:<token>@<host>:322/streaming/live/1`.
- Returns `{ status, format, sizeBytes, base64, savedTo?, transport }`.
  Optional `save_path` writes the bytes to disk in addition to returning
  base64.
- Default 8s timeout for cold-start camera latency.

### H2 camera RESOLVED via RTSP (2026-04-27)

Live test against Parker (H2S, `192.168.68.93`): RTSP works.

```
sizeBytes: 125,321
JPEG SOI: true
transport: rtsps-322
saved to: /tmp/parker-probe.jpg (real chamber image)
roundtrip: ~1.5s
```

**Root cause of the earlier H2 failure:** the H2 series doesn't speak
the A1/P1 TCP-on-6000 protocol at all -- it uses RTSP, same as X1.
The OpenBambuAPI `video.md` doc just doesn't list H2. Confirmed by
reading HA bambulab's `models.py` Camera class, which derives
`rtsp_url` from the printer's own MQTT `ipcam` push, and by the live
probe.

**Fix shipped:** `cameraSnapshot` now routes X1/X1C/X1E/P2S AND
H2/H2S/H2D/H2C/H2D Pro through a new `fetchRtspCameraFrame()` that
shells out to ffmpeg with `rtsps://bblp:<token>@<host>:322/streaming/live/1
-frames:v 1`. The TCP-on-6000 path remains for A1/P1 series.

`experimental: true` on the tool schema is now a no-op; it stayed
on the type/schema for backward compat but the description marks it
deprecated. The fail-fast for unverified models still applies for
truly unknown strings.

### H2 probe results (2026-04-27, against Parker H2S `192.168.68.93`) -- historical

Fired `camera_snapshot` with `experimental:true` against Parker, then
the raw-byte probe (`scripts/probe-h2-raw.mjs`) for diagnostic data.

Findings:

- **TLS handshake succeeds** without a client certificate
  (`rejectUnauthorized: false`). mTLS is NOT the gate on port 6000.
- **A1/P1 16-byte frame header layout IS the H2 layout** — the printer
  responds with that exact structure.
- **The 80-byte A1/P1 auth packet (with the LAN access code as the
  password) is rejected by H2 firmware.** The printer replies with one
  framed error response and closes the connection:

  ```
  offset  bytes                                            interpretation
  0x00    08 00 00 00                                      payload_size = 8
  0x04    3f 01 03 a2                                      error_code  = 0xa203013f
  0x08    00 00 00 00 00 00 00 00                          reserved
  0x10    ff ff ff ff b8 e0 eb 9b                          8-byte error payload
  ```

- Round-trip is fast (~145ms total), so the printer is responsive on
  port 6000 — it just doesn't like our credential or packet shape.

This is a meaningful narrowing of the H2 mystery. Next experiments to
try (in increasing cost):

1. **Different credential.** Use the cloud-derived `dev_access_code`
   from `bambu certs/` instead of the LAN access code. If that succeeds,
   H2 simply gates camera behind cloud auth even in LAN mode.
2. **Read HA bambulab integration source.** They handle H2 cameras
   today; whatever they pass is the answer. Should be quick to find in
   `custom_components/bambu_lab/pybambu/`.
3. **Different packet format.** Try `type = 0x4000` (vs `0x3000`),
   longer packet, or look for a magic-bytes difference. Lowest-confidence
   path; only attempt if 1 + 2 don't pan out.

The diagnostic scripts (`scripts/probe-h2-camera.mjs` and
`scripts/probe-h2-raw.mjs`) are committed and reusable.

### Working state

Tracked local changes since `12ae6b9`:

- `README.md` — features bullet, new `delete_printer_file` section
- `PROGRESS.md` — this section
- `src/index.ts` — tool registration + dispatch case
- `src/printers/bambu.ts` — `deleteFile()` (public) and `ftpDelete()` (private)
- `tests/behavior.test.mjs` — 5 new tests:
  - `confirm:true` required, otherwise `status: "skipped"` with no FTP
  - path traversal rejected
  - paths outside `cache/`/`timelapse/`/`logs/` rejected
  - happy path: bare names normalize to `cache/`, ftpDelete called with absolute path
  - `timelapse/` and `logs/` paths accepted as-is
- rebuilt `dist/` (`dist/index.js`, `dist/printers/bambu.js`)

Suggested commit message:

```
feat: add delete_printer_file MCP tool

- New deleteFile() in BambuImplementation: FTPS DELETE via basic-ftp
  using the same TLS-session-ticket dance as ftpUpload.
- Confirm-gated (confirm:true required) so a default invocation can't
  destroy data; returns status:"skipped" otherwise without contacting
  the printer.
- Path safety: rejects ".." segments, restricts deletes to cache/,
  timelapse/, and logs/ to prevent walking the filesystem.
- Bare filenames default to cache/<name>; relative paths to other
  allowed dirs are honored as-is.
- README features bullet + delete_printer_file tool section updated.
- 5 new unit tests cover the gating, path safety, and happy path.

Total npm test: 28/28.
```

## Current handoff (2026-04-27)

Branch: `codex/collar-charm-h2-cleanup`.

This file is the source-of-truth handoff if the active assistant thread runs
out of context. Read this section first, then continue the queue below.

### Current worktree

Tracked local changes:

- `.gitignore`
- `README.md`
- `src/index.ts`
- `src/printers/bambu.ts`
- `src/stl/stl-manipulator.ts`
- `tests/behavior.test.mjs`
- rebuilt `dist/index.js`, `dist/printers/bambu.js`, `dist/stl/stl-manipulator.js`

Ignored/local-only artifacts:

- `.claude/worktrees/` — Claude Code nested worktree cache; do not commit.
- `docs/*.gcode.3mf` — private/generated sliced print artifacts; do not commit.

### Latest verified status

- `npm test` passes: **23/23**.
- H2S/Parker read-only status works.
- A pre-sliced one-color H2S SuperTack print completed on Parker.
- The successful physical print path used `print_3mf` with:
  - `bambu_model: "h2s"`
  - `bed_type: "supertack_plate"`
  - explicit `ams_slots: [0]`
  - `use_ams: true`
- Sends with `use_ams: false` were accepted by the MCP layer but did not
  visibly start the job.

### Decisions from the live H2S test

- SuperTack is valid for **pre-sliced** print jobs.
- BambuStudio CLI SuperTack slicing is **not verified**. Attempts to encode
  SuperTack in flattened CLI profiles produced G-code that fell back to Cool
  Plate. The MCP now fails fast for `supertack_plate` on CLI slicing and
  auto-slicing paths.
- On H2/H2D, do **not** trust embedded `slicerConfig.ams_mapping` parsed from
  the 3MF. It can be stale project metadata.
- H2 pre-sliced jobs with declared filaments must provide one of:
  - explicit `ams_slots`
  - raw project-level `ams_mapping`
  - `auto_match_ams: true`
- If none is provided, the server now fails before upload/send.
- `ams_slots` is still the preferred API: one physical tray per used filament
  in `plate_N.json.filament_ids` order. The printer layer expands that into
  project-level `ams_mapping` and `ams_mapping2`.

Recovered Claude evidence to preserve:

```text
G-code header project filaments:
; filament_ids    = GFG02;GFG01;GFL00;GFL03
; filament_colour = #FFFFFF;#FF911A80;#DCF478;#DCF478
; filament_type   = PETG;PETG;PLA;PLA

plate_1.json.filament_ids = [1]
physical tray = AMS 0 slot 1

Working H2 mapping:
ams_mapping:  [-1, 1, -1, -1]
ams_mapping2: [{255,255}, {0,1}, {255,255}, {255,255}]
```

Rule: `ams_mapping` length must match the project-level filament declaration
from the G-code header, and the populated position must match the
project-level filament index from `plate_N.json.filament_ids`.

### Tests added in current work

- H2 `print_3mf` rejects pre-sliced filament jobs without explicit mapping
  before FTP/network.
- H2 `ams_slots` expands into project-level `ams_mapping` and `ams_mapping2`;
  regression covers the recovered case where `plate_1.json.filament_ids = [1]`
  and `ams_slots = [1]` expands to `[-1, 1, -1, -1]`.

### CC side work

Claude Code created a nested worktree at:

```text
.claude/worktrees/cool-saha-810d33
```

It contains two commits on top of `08f6afe`:

- `ff42958 chore: bump to 1.1.0 and add CHANGELOG`
- `abcb47a docs: update PROGRESS for 1.1.0 publish attempt and next queue`

Do not blindly cherry-pick yet. Current H2/SuperTack behavior and regression
tests should land first. Then selectively port `CHANGELOG.md` / version bump if
we want to prepare `1.1.0`.

### Next queue

1. Review the current diff for scope.
2. Commit the H2/SuperTack/mapping fixes and tests once satisfied.
3. After that, decide whether to port CC's `CHANGELOG.md` and `1.1.0` version
   bump from `.claude/worktrees/cool-saha-810d33`.
4. Optional follow-up: improve `auto_match_ams` live behavior for Parker once
   we have a loaded AMS inventory snapshot that reports trays reliably.
5. Optional future features from prior queue: camera snapshot, printer-file
   delete, live validation for skip objects/light/fan/utility controls.

### Verification commands

```bash
cd /Users/alexbuchan/Sync/bambu-printer-mcp
npm test
git status --short --branch
```

Expected now: `npm test` passes 23/23. Status should show only the tracked
worktree changes listed above; `.claude/worktrees/` and private `.gcode.3mf`
files should be ignored.

---

Working state for the BambuStudio CLI auto-flatten + control-tool work.
Branch: `codex/collar-charm-h2-cleanup`. Committed as `235f224`
(`feat: BambuStudio CLI auto-flatten + pause/resume tools`); not pushed yet.

## Status snapshot (2026-04-26)

| Area | State |
|---|---|
| TypeScript build | ✅ clean (`npx tsc` exit 0) |
| Unit tests | ✅ 9/9 pass (`tests/slicer/profile-flatten.test.mjs`) |
| CLI smoke H2S | ✅ printable plate gcode (110,970 bytes) |
| CLI smoke H2D | ✅ printable plate gcode (116,704 bytes) |
| CLI smoke X1C | ✅ printable plate gcode (111,415 bytes) |
| CLI smoke P1S | ✅ printable plate gcode (111,313 bytes) |
| MCP `slice_stl` smoke | ✅ H2S via stdio with `BAMBU_CLI_FLATTEN=true` |
| AMS RFID auto-match | ✅ dry-run tool + opt-in `print_3mf` path; not live-print verified |
| HMS diagnostics resource | ✅ `printer://{host}/hms` read-only status summary |
| Light/fan controls | ✅ `set_light` and `set_fan_speed` wrappers; not live-device verified |
| Skip objects | ✅ object-id lister + `skip_objects` MQTT command; not live-print verified |
| Upstream comment draft | ✅ saved in `docs/BAMBUSTUDIO-CLI-UPSTREAM-COMMENT.md` |
| End-to-end on real printer | ⏳ not yet run |
| Upstream bug report | ⏳ drafted, not posted |

Post-commit verification rerun on 2026-04-26:

- `npm test` passed (`npm run build` + 9/9 flattener tests).
- `scripts/test-cli-slice.mjs` passed for `h2s`, `h2d`, `x1c`, and `p1s`.
- Direct MCP stdio `slice_stl` call with `BAMBU_CLI_FLATTEN=true` returned
  `temp/sample_cube_sliced.3mf`; verified it contains
  `Metadata/plate_1.gcode` (110,970 bytes), `project_settings.config`, and
  `slice_info.config`.

Follow-up verification:

- `npm test` now runs both root and nested test files and passed 18/18.
- Added parser coverage proving H2D `plate_1.json.filament_ids` maps to
  `slice_info.config` `tray_info_idx` (`GFG02` in the fixture).

## What's done

### 1. Profile flattener — `src/slicer/profile-flatten.ts`

Walks BBL `inherits` chain, deep-merges parent → child, and emits CLI-ready
temp configs that work around upstream BambuStudio CLI bugs
([#9636](https://github.com/bambulab/BambuStudio/issues/9636),
[#9968](https://github.com/bambulab/BambuStudio/issues/9968)).

Key behaviors:

- Indexes every `*.json` in `<profilesRoot>/BBL/{machine,process,filament}` by
  `name` field.
- Walks `inherits` recursively (with cycle + missing-parent detection).
- Sets `from: "User"`, `inherits: <leaf machine name>` so the CLI's
  `system_name` resolution lands on a value present in the leaves'
  `compatible_printers` lists. (Source: `BambuStudio.cpp` ~line 2222.)
- Derives `nozzle_volume_type` (array, one entry per nozzle) from
  `default_nozzle_volume_type[]`. Hardware invariant: both nozzles always
  match (validator throws on mismatched array).
- Applies per-printer overlay from `BBL/cli_config.json` (CLI safety
  machine_limits — accel/jerk/speed envelopes).
- Sets `printer_settings_id` / `print_settings_id` /
  `filament_settings_id` from the leaf names so the GUI's project shape is
  mirrored.
- Auto-extends `compatible_printers` to include the chosen machine when the
  user picked a non-default printer/process combo (mirrors GUI save behavior).
- BBL only — explicit error for other vendors.

Public API: `flattenForCli(opts)` and `detectProfilesRoot(slicerPath?)`.

### 2. MCP wire-up — `src/stl/stl-manipulator.ts`

New private method `maybeFlattenBundle()` post-processes the existing
`resolveBambuLikeSettingsBundle()` output. Gated by env var
`BAMBU_CLI_FLATTEN=true`. Default off; backward-compatible.

When enabled:

1. Reads each leaf JSON's `name` field from the bundle paths.
2. If all three (machine, process, filament) resolve to BBL leaves, calls
   `flattenForCli` and replaces the bundle paths with flattened temp paths.
3. On any failure, logs and falls back to the unflattened bundle.

Only affects the `bambustudio` slicer branch. Other slicers untouched.

### 3. Pause / resume MQTT tools

- `src/printers/bambu.ts`: `pauseJob()` and `resumeJob()` (mirror
  `cancelJob`'s `UpdateStateCommand` pattern with `state: "pause"` / `"resume"`).
- `src/index.ts`: `pause_print` and `resume_print` tools registered alongside
  `cancel_print`. Same arg shape (host/serial/token, all optional with env
  fallback).

### 4. Test fixtures — `tests/fixtures/h2d_gui_sliced/`

Saved from your freshly-sliced H2D `.gcode.3mf` so we have GUI ground truth
for any future flattener changes. Three files:

- `project_settings.config` (84 KB, 558 keys — the GUI's flattened output)
- `plate_1.json`
- `slice_info.config`

The original 3MF lives at `docs/mk2 collarID.gcode.3mf.3mf.gcode.3mf` — not
needed for tests (we extracted what we need), can stay un-tracked.

### 5. Smoke test — `scripts/test-cli-slice.mjs`

Standalone runner. Usage:

```bash
node scripts/test-cli-slice.mjs --model h2s|h2d|x1c|p1s [--filament NAME] [--keep-temp]
```

Asserts:

- CLI exits 0.
- Output 3MF exists.
- `Metadata/plate_<n>.gcode` is present and >1 KB.

### 6. Documentation

- `docs/SLICING.md`: rewrote into Path A (GUI, recommended) + Path B (CLI
  flatten, opt-in). Documents the mechanics of Path B and links upstream
  issues.
- `README.md`:
  - Features: pause/resume bullet; auto-slice bullet rewritten to point at
    `BAMBU_CLI_FLATTEN`.
  - Tools: added `pause_print` and `resume_print` sections after
    `cancel_print`.
  - Env var reference: added `BAMBU_CLI_FLATTEN` and `BAMBU_PROFILES_ROOT`.

## Files touched

```
A  PROGRESS.md
A  src/slicer/profile-flatten.ts
A  scripts/test-cli-slice.mjs
A  tests/slicer/profile-flatten.test.mjs
A  tests/fixtures/h2d_gui_sliced/{project_settings.config,plate_1.json,slice_info.config}
A  docs/SLICING.md  (existed before this session, rewritten this session)
M  src/stl/stl-manipulator.ts
M  src/printers/bambu.ts
M  src/index.ts
M  README.md
```

Pre-existing modifications carried over from before this session:
`REMOTE-DEPLOYMENT.md`, `SPEC-CHECKLIST.md`, and the small README cleanup
(Kingpin de-branding, hardcoded path removal). Untouched.

## Don't commit

```
bambu certs/                                # local creds
docs/mk2 collarID.gcode.3mf.3mf.gcode.3mf   # 1.5 MB private artifact
```

Add to `.gitignore` before committing or just stage explicitly.

## Suggested commit message

```
feat: BambuStudio CLI auto-flatten + pause/resume tools

- New src/slicer/profile-flatten.ts: walks BBL inherits chain, derives
  nozzle_volume_type, applies cli_config overlay, sets
  from/inherits/settings_id so the CLI accepts flattened profiles.
  Workaround for upstream BambuStudio issues #9636 / #9968.
- Verified single-color CLI smoke on H2S, H2D, X1C, P1S with stock BBL profiles.
- Wired into stl-manipulator behind BAMBU_CLI_FLATTEN=true (default off).
- New pause_print / resume_print MQTT tools alongside cancel_print.
- Docs: SLICING.md split into Path A (GUI) and Path B (CLI flatten),
  README features + tool docs + env var reference updated.
- Test fixtures from a real H2D GUI slice for ground-truth comparison.
- 9 unit tests for the flattener (chain resolution, cycle detection,
  nozzle_volume_type shape, hardware invariant, end-to-end against the
  installed BBL tree).
```

## Queue (not yet started)

### High priority

- **End-to-end test through the actual MCP tool surface.** `slice_stl` via
  MCP stdio is verified with `BAMBU_CLI_FLATTEN=true`; still need a live
  `print_3mf` run against H2S/H2D when it is safe to start a physical print.
- **Post upstream comment on bambulab/BambuStudio#9636.** ✅ Posted:
  https://github.com/bambulab/BambuStudio/issues/9636#issuecomment-4323987647.
  Dossier is saved at `docs/BAMBUSTUDIO-CLI-UPSTREAM-COMMENT.md`. Includes:
  - Root-cause walkthrough with line numbers from `BambuStudio.cpp`.
  - Three independent breakages reproduced and resolved.
  - Userland workaround (link to this PR/repo).
  - Offer to upstream a `--auto-flatten` flag.

### Bambuddy-inspired features (per user prioritization)

- **MUST HAVE:** ✅ pause / resume — done.
- **VERY MUCH WANT:** ✅ AMS auto-match by RFID — implemented as
  `resolve_3mf_ams_slots` dry run plus opt-in `print_3mf auto_match_ams`.
  Still needs live H2S/H2D print validation before calling it production-safe.
- **Future versions:** ✅ AMS RFID re-read tool and airduct control are
  implemented as MCP command surfaces. AMS dryer start/stop remains future work.
  RFID re-read can move AMS filament and needs live validation when physical
  testing is allowed.
- **HMS error resource:** ✅ `printer://{host}/hms` is implemented as a
  read-only diagnostics summary over the existing status path.
- **Light/fan control:** ✅ `set_light` and `set_fan_speed` are implemented
  through the existing `bambu-node` MQTT commands. They still need live-device
  validation.
- **Bambuddy-inspired utility controls:** ✅ `set_print_speed`,
  `set_airduct_mode`, `clear_hms_errors`, and `reread_ams_rfid` are implemented
  with schema coverage. They still need live-device validation.
- **Skip objects:** ✅ `list_3mf_plate_objects` and `skip_objects` are
  implemented. They still need live-print validation.

## How to verify

```bash
cd ~/Sync/bambu-printer-mcp

# Build + unit tests
npx tsc
node --test tests/slicer/profile-flatten.test.mjs

# Smoke test all four printers
for m in h2s h2d x1c p1s; do
  printf "%-5s " $m
  node scripts/test-cli-slice.mjs --model $m | grep -E "(PASS|OK:|FAIL)"
done
```

Expected: 9/9 unit tests pass, all four smoke tests print "OK: ... bytes of
gcode" and "PASS".
