export const REMOTE_META_KEY = "counterpart/remote";
export const REMOTE_SCOPES = {
    // read
    counterpart_discover_printers: "read",
    counterpart_setup_fields: "read",
    counterpart_propose_filaments: "read",
    get_printer_status: "read",
    get_printer_filaments: "read",
    resolve_3mf_ams_slots: "read",
    list_3mf_plate_objects: "read",
    list_3mf_plates: "read",
    get_stl_info: "read",
    list_templates: "read",
    list_printer_files: "read",
    camera_frame: "read",
    camera_snapshot: "read",
    inspect_print_file: "read",
    blender_mcp_status: "read",
    counterpart_printer_info: "read",
    counterpart_print_progress: "read",
    counterpart_print_record: "read",
    counterpart_print_assess: "control", // local evidence mutation, never a printer command
    cad_status: "read",
    cad_setup: "read",
    cad_run: "design",
    cad_check_fit: "design",
    fusion_mcp_status: "read",
    blender_mcp_setup: "read", // checks only; update raises it
    fusion_mcp_setup: "read", // checks only; install raises it
    // design
    slice_stl: "design",
    lay_flat: "design",
    counterpart_make_3mf: "design",
    // control
    bambu_connect_import_file: "control",
    camera_stream_start: "control",
    camera_stream_stop: "control",
    cancel_print: "control",
    pause_print: "control",
    resume_print: "control",
    clear_hms_errors: "control",
    set_print_speed: "control",
    set_airduct_mode: "control",
    reread_ams_rfid: "control",
    set_temperature: "control",
    set_fan_speed: "control",
    set_light: "control",
    set_ams_drying: "control",
    counterpart_print_route: "control",
    fusion_mcp_new_design: "control",
    fusion_mcp_export: "control",
    // print
    extend_stl_base: "print",
    scale_stl: "print",
    rotate_stl: "print",
    get_slice_settings: "print",
    slice_with_template: "print",
    bambu_network_bridge_status: "print",
    print_3mf_bambu_network: "print",
    delete_printer_file: "print",
    upload_file: "print",
    start_print: "print",
    start_print_job: "print",
    skip_objects: "print",
    print_3mf: "print",
    print_collar_charm: "print",
    merge_vertices: "print",
    center_model: "print",
    // raw
    save_template: "raw",
    bambu_network_call: "raw",
    upload_gcode: "raw",
    x2d_native_control: "raw",
    blender_mcp_call: "raw",
    blender_mcp_edit_model: "raw",
    fusion_mcp_call: "raw",
};
const RAISED_BY = {
    fusion_mcp_status: { launch: "design" }, // starts Fusion on this computer
    blender_mcp_status: { connect: "design" }, // connects to Blender
    blender_mcp_setup: { update: "raw" }, // replaces the add-on in the person's Blender
    cad_setup: { install: "raw" },
    fusion_mcp_setup: { install: "raw" }, // installs into the person's Fusion, a login item and this server's .env
};
/**
 * Overrides of a server's own configuration (both printer MCPs use the same names): the printer it targets, its
 * account and credentials, its hardware, and the programs it runs.
 */
export const CONFIG_ARGUMENTS = new Set([
    "host", "port", "api_key", "username", "password", "dev_ip", "dev_id", "bambu_serial", "bambu_token", "user_info",
    "country_code", "connection_type", "connection_mode", "route", "bambu_model", "nozzle_diameter", "nozzle_diameters",
    "bridge_command", "slicer_path", "slicer_type", "ffmpeg_path", "plugin_dir", "runtime_dir", "template_dir",
    "config_filename", "bambu_network_method", "use_ssl_for_mqtt", "use_ssl_for_ftp", "extra_options",
    "allow_mutating_method",
]);
/** Top-level only: the printer type (`type`); a nested `type` is a plain value. */
const TOP_LEVEL_CONFIG = new Set(["type"]);
/** Files read whose names don't end in path, dir or file. */
const FILE_ARGUMENTS = new Set(["filament_profile", "slicer_profile", "load_filaments", "source_f3d"]);
const isPath = (key) => /(?:path|dir|directory|_file)$/.test(key) || FILE_ARGUMENTS.has(key);
function kindOf(tool, key, depth) {
    if (tool === "cad_check_fit" && depth === 0 && ["model", "reference"].includes(key))
        return "path";
    // counterpart_print_route's own `route` is the connection the caller chooses.
    if ((CONFIG_ARGUMENTS.has(key) && !(key === "route" && tool === "counterpart_print_route")) || /config_dir$/.test(key))
        return "config";
    if (depth === 0 && TOP_LEVEL_CONFIG.has(key))
        return "config-top";
    if (!isPath(key))
        return undefined;
    return /^output_|^out_path$|^save_path$/.test(key) ? "output" : "path";
}
/** The argument kinds of one tool, read from its own input schema. */
export function remoteArguments(tool) {
    const kinds = {};
    let open = false;
    const visit = (schema, depth) => {
        if (!schema || typeof schema !== "object")
            return;
        const node = schema;
        // An object whose keys the schema doesn't name (beyond the top level) may carry any argument.
        if (depth > 0 && node.type === "object" && (node.additionalProperties === true || node.additionalProperties === undefined && !node.properties))
            open = true;
        if (depth > 0 && node.additionalProperties && typeof node.additionalProperties === "object")
            open = true;
        for (const [key, child] of Object.entries(node.properties ?? {})) {
            const kind = kindOf(tool.name, key, depth);
            if (kind && !(kinds[key] === "config" && kind === "config-top"))
                kinds[key] = kind;
            visit(child, depth + 1);
        }
        visit(node.items, depth);
        for (const option of [...(node.anyOf ?? []), ...(node.oneOf ?? [])])
            visit(option, depth);
    };
    visit(tool.inputSchema, 0);
    if (open)
        for (const key of CONFIG_ARGUMENTS)
            if (!(key === "route" && tool.name === "counterpart_print_route"))
                kinds[key] ?? (kinds[key] = "config");
    return kinds;
}
/** The declaration for one tool; a tool missing from REMOTE_SCOPES (a bug the tests catch) is raw. */
export function remoteDeclaration(tool) {
    const args = remoteArguments(tool);
    return {
        scope: REMOTE_SCOPES[tool.name] ?? "raw",
        ...(RAISED_BY[tool.name] ? { raisedBy: RAISED_BY[tool.name] } : {}),
        ...(Object.keys(args).length ? { arguments: args } : {}),
    };
}
/** The tool with its declaration in `_meta`. */
export function withRemote(tool) {
    return { ...tool, _meta: { ...(tool._meta ?? {}), [REMOTE_META_KEY]: remoteDeclaration(tool) } };
}
