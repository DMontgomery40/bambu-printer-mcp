# Progress

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
- Verified end-to-end on H2S, H2D, X1C, P1S with stock BBL profiles.
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
