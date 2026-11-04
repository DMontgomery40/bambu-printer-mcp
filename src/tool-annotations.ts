/**
 * MCP tool annotations (spec 2025-03-26 and later), one entry per tool, chosen from
 * what the tool's handler actually does. Clients and Counterpart's remote endpoint
 * read them to decide which tools a device may call, so every listed tool must have
 * one (tests/tool-annotations.test.mjs).
 *
 * readOnlyHint: changes nothing outside this server (printer, files, other apps).
 * destructiveHint: may delete, overwrite, end or irreversibly change something.
 * idempotentHint: repeating the call with the same arguments has no further effect.
 * openWorldHint: reaches something outside this server and its files: the printer,
 *   Bambu Cloud, a remote slicer, or another application (Blender, Fusion, Bambu Connect).
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const hints = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolAnnotations =>
  ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

/** Reads the printer or another outside system; changes nothing. */
const READ_OUTSIDE = hints(true, false, true, true);
/** Reads local files or this server's configuration only. */
const READ_LOCAL = hints(true, false, true, false);
/** Writes a new output into this server's private temporary directory; inputs untouched. */
const LOCAL_OUTPUT = hints(false, false, true, false);
/** Sets a printer setting to a given value; setting it again changes nothing. */
const SET_PRINTER = hints(false, false, true, true);
/** Starts a print job: adds a job, removes nothing, but a repeat would start another. */
const START_PRINT = hints(false, false, false, true);

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Printer and cloud reads
  get_printer_status: READ_OUTSIDE,
  get_printer_filaments: READ_OUTSIDE,
  resolve_3mf_ams_slots: READ_OUTSIDE, // reads the live AMS inventory
  list_printer_files: READ_OUTSIDE,
  counterpart_print_progress: READ_OUTSIDE,
  bambu_network_bridge_status: READ_OUTSIDE, // connect: true starts the bridge helper and signs in; changes no printer or file
  camera_frame: READ_OUTSIDE,
  camera_stream_start: READ_OUTSIDE, // opens this server's own camera connection; no printer motion or commands
  camera_stream_stop: READ_OUTSIDE, // closes that connection
  // Writes save_path, overwriting an existing file there; every call takes a new frame.
  camera_snapshot: hints(false, true, false, true),

  // Local reads
  inspect_print_file: READ_LOCAL,
  list_3mf_plate_objects: READ_LOCAL,
  get_stl_info: READ_LOCAL,
  list_templates: READ_LOCAL,
  get_slice_settings: READ_LOCAL,
  counterpart_printer_info: READ_LOCAL, // configuration and capabilities; sends nothing to the printer

  // Local outputs in the server's temporary directory
  extend_stl_base: LOCAL_OUTPUT,
  scale_stl: LOCAL_OUTPUT,
  rotate_stl: LOCAL_OUTPUT,
  merge_vertices: LOCAL_OUTPUT,
  center_model: LOCAL_OUTPUT,
  lay_flat: LOCAL_OUTPUT,
  // Same, but a configured orca-slicer-api slices on a remote service.
  slice_stl: hints(false, false, true, true),
  slice_with_template: hints(false, false, true, true),
  // New 3MF at a caller-chosen path; never overwrites, so a repeat fails instead of replacing.
  counterpart_make_3mf: hints(false, false, false, false),
  // Copies into the template registry, replacing a template of the same name.
  save_template: hints(false, true, true, false),
  // Rewrites BAMBU_DEFAULT_CONNECTION_MODE/TYPE in .env and in this process; choosing a route back undoes it.
  counterpart_print_route: hints(false, false, true, false),

  // Print starts
  start_print: START_PRINT,
  start_print_job: START_PRINT,
  print_3mf: START_PRINT,
  print_3mf_bambu_network: START_PRINT,
  print_collar_charm: START_PRINT,
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
  // Raw bridge methods can do anything the bridge can, including printer commands.
  bambu_network_call: hints(false, true, false, true),
  // Opens the file in the Bambu Connect app; does not print.
  bambu_connect_import_file: hints(false, false, false, true),

  // Blender and Fusion
  blender_mcp_status: READ_OUTSIDE, // connects and lists tools; edits nothing
  blender_mcp_call: hints(false, true, false, true), // any Blender tool, including execute_blender_code
  blender_mcp_edit_model: hints(false, false, false, true), // scene objects preserved; the output path must be new
  fusion_mcp_status: hints(false, false, true, true), // launch: true starts Fusion on this computer
  fusion_mcp_call: hints(false, true, false, true), // any Fusion tool, including execute_code
  fusion_mcp_new_design: hints(false, false, false, true), // opens another new document
  fusion_mcp_export: hints(false, false, false, true), // never overwrites; a repeat fails
};

/** The tool with its annotations. A tool missing from the table is a bug caught by the tests. */
export function withAnnotations<T extends { name: string }>(tool: T): T & { annotations?: ToolAnnotations } {
  const annotations = TOOL_ANNOTATIONS[tool.name];
  return annotations ? { ...tool, annotations } : tool;
}
