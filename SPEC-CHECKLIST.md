# Bambu MCP Spec Checklist

Updated: 2026-04-27

This checklist maps the intended MCP surface to the current patched state of this `bambu-printer-mcp` clone, with emphasis on modern Bambu local-network workflows and H2-series compatibility.

Status meanings:

- `implemented`: usable now
- `partial`: some of the behavior exists, but not as a clean dedicated tool yet
- `missing`: not implemented in this clone
- `deferred`: intentionally postponed or tracked separately

## 1. Printer Status And Control

| Spec Function | Status | Current Reality | Next Step |
|---|---|---|---|
| `get_printer_status` | implemented | Exists and returns temperatures, state, progress, current file, and raw AMS/status data. | Add more fields only if the printer payload reports them consistently. |
| `list_printers` | missing | Current model assumes machine-local config or one MCP entry per printer. | Add a fleet/config abstraction first, then a `list_printers` tool. |
| `start_print` | partial | `upload_file`, `start_print_job`, and `print_3mf` cover the underlying behavior, but there is no single unified `start_print` tool. | Add a wrapper tool that dispatches to `.3mf` and `.gcode(.3mf)` correctly. |
| `pause_print` | implemented | Sends the Bambu MQTT `UpdateStateCommand` pause path. | Live validation still needed during a safe print. |
| `resume_print` | implemented | Sends the Bambu MQTT `UpdateStateCommand` resume path. | Live validation still needed during a safe paused print. |
| `stop_print` | partial | `cancel_print` already exists and stops the current job. | Alias or rename to `stop_print` if spec naming matters. |
| `get_camera_snapshot` | missing | No camera/thumbnail fetch path yet. | Implement FTPS thumbnail reads and return a temp image path. |
| `set_light` | implemented | Sends the Bambu MQTT LED command. Live H2D smoke returned success. | Validate node names across printer models. |
| `set_fan_speed` | implemented | Sends the Bambu MQTT fan command for part, auxiliary, or chamber fan. Live H2D chamber fan smoke returned success. | Validate fan IDs across printer models. |
| `printer://{host}/hms` | implemented | Read-only diagnostics resource over the existing status path. Live H2D/H2S status reads returned HMS/error summaries. | Add richer decoding if a stable HMS code table is added. |

## 2. File Management

| Spec Function | Status | Current Reality | Next Step |
|---|---|---|---|
| `list_files` | partial | `list_printer_files` exists. | Alias if the shorter name is useful. |
| `delete_file` | missing | No delete tool yet. | Add FTPS delete support. |
| `upload_file` | implemented | Exists now. | None. |

## 3. AMS Management

| Spec Function | Status | Current Reality | Next Step |
|---|---|---|---|
| `get_ams_status` | implemented | `get_printer_filaments` returns normalized slot data, tray type, color, remaining percentage, and slicer profile hints. | None. |
| `get_ams_mapping` | implemented | `resolve_3mf_ams_slots` inspects a sliced 3MF and matches required `tray_info_idx` values against live AMS inventory. | Live print validation still needed for `auto_match_ams`. |
| `set_ams_mapping` | missing | No explicit setter exists. Current flow sets mapping only inside the print payload. | Decide whether this should be persistent state or just a print-job override. |
| `switch_ams_slot` | missing | No tool exists. | Confirm the correct live-switch MQTT command and safety rules. |

Notes:

- Treat live MQTT tray state as the source of truth.
- For H2-class printers, project-length AMS mapping plus `ams_mapping2` is the important compatibility behavior.
- `auto_match_ams` is intentionally opt-in and refuses to print when required `tray_info_idx` values are missing from live AMS inventory.

## 4. Slicer Integration

| Spec Function | Status | Current Reality | Next Step |
|---|---|---|---|
| `slice_stl` | implemented | Exists now. Also supports `template_3mf_path` and `use_printer_filaments`, including combining template-derived process settings with live filament selection. | Keep adding regression checks for template-driven and multi-object jobs. |
| `slice_3mf` | partial | `slice_stl` already accepts 3MF input, but there is no dedicated `slice_3mf` tool name. | Alias or split only if agents benefit from explicit naming. |
| `get_slice_settings` | implemented | Inspects a 3MF template or JSON/config profile and returns a compact settings summary plus extracted config path. | Add richer output only if agents need it. |
| `set_slice_settings` | missing | No dedicated mutation tool exists. | Decide whether this means editing a profile JSON, a template 3MF, or runtime overrides. |
| `list_3mf_plate_objects` | implemented | Lists Bambu object IDs from `Metadata/plate_<n>.json` so callers can target `skip_objects` safely. | Live print validation still needed. |
| `skip_objects` | implemented | Sends a `print.skip_objects` MQTT payload using explicit object IDs. | Validate during a safe multi-object print. |

Supported printers:

- `H2D`: yes
- `H2S`: yes
- `X1C`: yes

Current real state:

- Printer model validation and preset mapping include `h2d`, `h2s`, and `x1c`.
- `template_3mf_path` is accepted by `slice_stl` and `print_3mf`.
- Template-aware slicing and live printer filament selection can now be combined cleanly.
- A lightweight named template registry exists and can back `list_templates`, `save_template`, `get_slice_settings`, `slice_with_template`, `slice_stl`, and `print_3mf`.
- `print_collar_charm` adds one specialized example of a higher-level project wrapper built on top of the generic slicing/printing path.
- BambuStudio CLI flattening is available behind `BAMBU_CLI_FLATTEN=true` and covered by H2S/H2D/X1C/P1S smoke tests.

## 5. Multi-Printer Support

| Spec Functionality | Status | Current Reality | Next Step |
|---|---|---|---|
| Configurable fleet | partial | Operationally handled outside the repo through machine-local config or separate MCP entries. | Add a fleet config abstraction only if one server truly needs to enumerate multiple printers itself. |
| Route jobs to correct printer | missing | Current model expects the caller or deployment to choose the correct target printer. | Define routing rules before adding a dispatcher layer. |
| H2D/H2S/X1C support | implemented | All three are supported in the patched local-network workflow. | None. |
| Unified config file | missing | Current setup is environment-driven rather than repo-owned. | Only add this if it improves deployment more than it increases secret-handling risk. |

Recommendation:

- Keep per-printer config machine-local.
- Only add unified fleet routing after the slice/template path is stable.

## 6. Template System

| Spec Function | Status | Current Reality | Next Step |
|---|---|---|---|
| `list_templates` | implemented | Lists named templates from the local registry. | Add richer metadata only if agents need it. |
| `apply_template` | implemented | `slice_with_template` wraps named-template slicing, while `template_name` also resolves in lower-level tools. | Add metadata if agents need richer selection than name/path/type. |
| `save_template` | implemented | Saves `.3mf`, `.json`, and `.config` files into the registry under a template name. | Add metadata sidecars only if needed. |

Recommended direction:

1. Treat a template as a saved 3MF project plus lightweight metadata.
2. Use the 3MF as the source of truth for process/profile defaults.
3. Keep AMS role defaults separate from live AMS inventory and per-print overrides.

## 7. Auth

| Spec Item | Status | Current Reality | Next Step |
|---|---|---|---|
| Access code auth | implemented | Working for current MQTT/FTPS flows. | None. |
| Certificate-based auth | deferred | Separate workstream. The current repo patch does not depend on the Bambu Connect certificate flow. | Revisit only if future firmware requires it for the local path you actually use. |

## Highest-Value Next Work

1. Live-validate `print_3mf auto_match_ams` with a file whose required filament is actually loaded.
2. Live-validate `pause_print`, `resume_print`, and `skip_objects` during safe test prints.
3. Add camera snapshot and file delete as low-risk utility tools.
4. Add more regression coverage around real multi-color template jobs.

## Recommended Agent-Facing Surface

If the goal is “what should agents use most,” the high-value tool set is:

- `get_printer_status`
- `get_printer_filaments`
- `list_printer_files`
- `upload_file`
- `slice_stl`
- `slice_with_template`
- `print_3mf`
- `resolve_3mf_ams_slots`
- `list_3mf_plate_objects`
- `cancel_print`
- `pause_print`
- `resume_print`
- `set_temperature`
- `set_light`
- `set_fan_speed`

That covers the real near-term workflow:

1. Produce or load geometry.
2. Read live filament inventory.
3. Slice with template/profile plus live filament-aware defaults.
4. Upload and print.
