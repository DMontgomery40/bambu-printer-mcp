const hints = (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
/** Reads the printer or another outside system; changes nothing. */
const READ_OUTSIDE = hints(true, false, true, true);
/** Reads local files or this server's configuration only. */
const READ_LOCAL = hints(true, false, true, false);
/** Writes a fixed-name output into this server's temporary directory, replacing an earlier output of that name; inputs untouched. */
const LOCAL_OUTPUT = hints(false, true, true, false);
/** Sets a printer setting to a given value; setting it again changes nothing. */
const SET_PRINTER = hints(false, false, true, true);
/** Starts a print job: adds a job, removes nothing, but a repeat would start another. */
const START_PRINT = hints(false, false, false, true);
/** Starts a print, auto-slicing an unsliced project first, which replaces an earlier slice output of that name. */
const SLICE_AND_PRINT = hints(false, true, false, true);
export const TOOL_ANNOTATIONS = {
    // Printer and cloud reads
    get_printer_status: READ_OUTSIDE,
    get_printer_filaments: READ_OUTSIDE,
    resolve_3mf_ams_slots: READ_OUTSIDE, // reads the live AMS inventory
    list_printer_files: READ_OUTSIDE,
    counterpart_print_progress: READ_OUTSIDE,
    counterpart_discover_printers: READ_OUTSIDE, // listens for the printers' own SSDP announcements
    counterpart_propose_filaments: READ_OUTSIDE, // reads the live AMS inventory
    // connect: true starts the bridge agent, which writes its configuration and device identity and can replace certificates.
    bambu_network_bridge_status: hints(false, true, true, true),
    camera_frame: READ_OUTSIDE,
    // Open (or renew) and close the one camera connection all viewers of this printer share; no printer motion or commands.
    camera_stream_start: hints(false, false, true, true),
    camera_stream_stop: hints(false, false, true, true),
    // Writes save_path, overwriting an existing file there; every call takes a new frame.
    camera_snapshot: hints(false, true, false, true),
    // Local reads
    inspect_print_file: READ_LOCAL,
    list_3mf_plate_objects: READ_LOCAL,
    list_3mf_plates: READ_LOCAL,
    get_stl_info: READ_LOCAL,
    list_templates: READ_LOCAL,
    get_slice_settings: LOCAL_OUTPUT, // a 3MF's settings are extracted to a fixed file in the temporary directory
    counterpart_printer_info: READ_LOCAL, // configuration and capabilities; sends nothing to the printer
    counterpart_setup_fields: READ_LOCAL, // the settings this server reads; no configured values
    // Local outputs in the server's temporary directory
    extend_stl_base: LOCAL_OUTPUT,
    scale_stl: LOCAL_OUTPUT,
    rotate_stl: LOCAL_OUTPUT,
    merge_vertices: LOCAL_OUTPUT,
    center_model: LOCAL_OUTPUT,
    lay_flat: LOCAL_OUTPUT,
    // Same, but a configured orca-slicer-api slices on a remote service, a new job and output each call.
    slice_stl: hints(false, true, false, true),
    slice_with_template: hints(false, true, false, true),
    // New 3MF at a caller-chosen path; never overwrites, so a repeat fails and changes nothing.
    counterpart_make_3mf: hints(false, false, true, false),
    // Copies into the template registry, replacing a template of the same name.
    save_template: hints(false, true, true, false),
    // Replaces BAMBU_DEFAULT_CONNECTION_MODE/TYPE in .env and in this process.
    counterpart_print_route: hints(false, true, true, false),
    // Print starts
    start_print: START_PRINT,
    start_print_job: START_PRINT,
    print_3mf: SLICE_AND_PRINT,
    print_3mf_bambu_network: SLICE_AND_PRINT,
    print_collar_charm: SLICE_AND_PRINT,
    upload_file: START_PRINT, // print: true starts the uploaded G-code; uploads never overwrite (unique names)
    upload_gcode: hints(false, false, false, true), // a uniquely named new copy per call
    // Print controls
    pause_print: SET_PRINTER,
    resume_print: SET_PRINTER,
    cancel_print: hints(false, true, true, true), // ends the job; it cannot be resumed
    skip_objects: hints(false, true, true, true), // skipped objects are not printed and cannot be restored
    // Printer settings
    set_print_speed: SET_PRINTER,
    set_airduct_mode: SET_PRINTER,
    set_temperature: SET_PRINTER,
    set_fan_speed: SET_PRINTER,
    set_light: SET_PRINTER,
    set_ams_drying: SET_PRINTER,
    reread_ams_rfid: hints(false, false, false, true), // moves AMS filament on every call
    // Replaces stored AMS metadata or the calibration selection on an X2D.
    x2d_native_control: hints(false, true, true, true),
    clear_hms_errors: hints(false, true, true, true), // clears the printer's error record
    delete_printer_file: hints(false, true, true, true),
    // Only handshake and sign-in reads are allowed, but with_agent (the default) starts the bridge agent like the status probe.
    bambu_network_call: hints(false, true, true, true),
    // Opens the file in the Bambu Connect app; does not print.
    bambu_connect_import_file: hints(false, false, false, true),
    // Blender and Fusion
    blender_mcp_status: READ_OUTSIDE, // connects and lists tools; edits nothing
    blender_mcp_call: hints(false, true, false, true), // any Blender tool, including execute_blender_code
    // The standard route preserves scene objects and needs a new output path; a configured legacy bridge promises neither.
    blender_mcp_edit_model: hints(false, true, false, true),
    fusion_mcp_status: hints(false, false, true, true), // launch: true starts Fusion on this computer
    // Install add-ons into the person's own Blender or Fusion: the add-on file is replaced (kept as a backup), and
    // the Fusion add-in folder, a login item and this server's .env are written. Repeating finds them current.
    blender_mcp_setup: hints(false, true, true, true),
    fusion_mcp_setup: hints(false, true, true, true),
    fusion_mcp_call: hints(false, true, false, true), // any Fusion tool, including execute_code
    fusion_mcp_new_design: hints(false, false, false, true), // opens another new document
    fusion_mcp_export: hints(false, false, true, true), // never overwrites; a repeat fails and changes nothing
};
/** Assumed for a tool missing from the table (a bug the tests catch): the least a client should trust it. */
const UNKNOWN = hints(false, true, false, true);
/** The tool with its annotations. */
export function withAnnotations(tool) {
    return { ...tool, annotations: TOOL_ANNOTATIONS[tool.name] ?? UNKNOWN };
}
