# Draft Upstream Comment: BambuStudio CLI Profile Flattening

Target issue: https://github.com/bambulab/BambuStudio/issues/9636

Related issue: https://github.com/bambulab/BambuStudio/issues/9968

## Comment Draft

I hit what looks like the same root class of failures while driving
BambuStudio from CLI mode for BBL profiles.

Short version: the GUI appears to slice with fully resolved preset state, but
the CLI path accepts leaf profile JSONs that still depend on BBL `inherits`
chains. In CLI mode those leaf files do not appear to get normalized the same
way the GUI-normalized project does, so required derived fields can be missing
or internally inconsistent by the time slicing starts.

I worked around this externally by flattening the BBL profile inheritance chain
before invoking the CLI:

1. Index every bundled profile JSON under `Resources/profiles/BBL/{machine,process,filament}` by its `name`.
2. Walk each requested leaf profile's `inherits` chain recursively.
3. Deep-merge parent to child so child values win.
4. Set CLI-facing identity fields so validation still resolves against the
   original system preset:
   - machine: `from: "User"`, `inherits: <leaf machine name>`
   - process/filament: `from: "User"`, `inherits: <original inherited preset name>`
   - `printer_settings_id`, `print_settings_id`, `filament_settings_id`
5. Derive missing machine fields that the GUI-saved project has but the CLI
   leaf input may not, especially `nozzle_volume_type`.
6. Apply the relevant `BBL/cli_config.json` machine-limit overlay before
   writing the temporary flattened configs.

With that preprocessing in place, the same BambuStudio CLI path generated
valid sliced `.3mf` output for:

- H2S 0.4 nozzle
- H2D 0.4 nozzle
- X1C 0.4 nozzle
- P1S 0.4 nozzle

The output archives contained `Metadata/plate_1.gcode` with non-empty gcode in
each case. This also resolved the specific class of missing
`nozzle_volume_type` failures for the H2/P/X profiles I tested.

The practical implementation is here:

- `src/slicer/profile-flatten.ts`
- `src/stl/stl-manipulator.ts` behind `BAMBU_CLI_FLATTEN=true`
- tests: `tests/slicer/profile-flatten.test.mjs`

Repo branch:

- https://github.com/rowbotik/bambu-printer-mcp/tree/codex/collar-charm-h2-cleanup

This is probably not the ideal long-term fix because the CLI should not require
external callers to reconstruct BambuStudio's preset resolver. But it suggests
a small upstream direction: add an internal `--auto-flatten` / `--resolve-presets`
step, or run the existing GUI preset normalization code before CLI slicing when
`--load-settings` / `--load-filaments` point at BBL system profiles.

I can turn the workaround into a smaller upstream patch if maintainers can point
me at the preferred preset-resolution path for CLI mode.

## Local Evidence

Verified locally in this branch:

```bash
npm test
for m in h2s h2d x1c p1s; do
  node scripts/test-cli-slice.mjs --model "$m"
done
```

Current result:

- `npm test`: 19/19 passing
- H2S smoke: `Metadata/plate_1.gcode` present, 110,970 bytes
- H2D smoke: `Metadata/plate_1.gcode` present, 116,704 bytes
- X1C smoke: `Metadata/plate_1.gcode` present, 111,415 bytes
- P1S smoke: `Metadata/plate_1.gcode` present, 111,313 bytes
