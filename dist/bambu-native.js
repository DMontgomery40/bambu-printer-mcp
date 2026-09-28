import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
function firstExistingExecutable(candidates) {
    return candidates.find((candidate) => {
        try {
            return fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0;
        }
        catch {
            return false;
        }
    });
}
export function assertBambuNativeAvailable() {
    if (process.platform !== "darwin")
        throw new Error("Bambu native X2D transport requires macOS and the installed Bambu Studio networking plug-in.");
    resolveNativeHelper();
}
function resolveNativeHelper() {
    const configured = process.env.BAMBU_NATIVE_HELPER?.trim();
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const candidates = [
        configured,
        path.resolve(packageRoot, "native/bambu-native-print"),
    ].filter((value) => Boolean(value));
    const helper = firstExistingExecutable(candidates);
    if (!helper) {
        throw new Error("Bambu native helper is not installed. Build native/bambu-native-print with clang++ or set BAMBU_NATIVE_HELPER.");
    }
    return helper;
}
function boolEnv(value, fallback) {
    return String(value === undefined ? fallback : value);
}
function tail(value, maxLength = 4000) {
    return value.length > maxLength ? value.slice(-maxLength) : value;
}
function runNativeHelper(mode, env, timeoutMs, onUpdate) {
    assertBambuNativeAvailable();
    const helper = resolveNativeHelper();
    return new Promise((resolve, reject) => {
        const child = spawn(helper, [mode], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const updates = [];
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`Bambu native helper timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            const lines = stdout.split(/\r?\n/);
            stdout = lines.pop() || "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    updates.push(trimmed);
                    onUpdate?.(trimmed);
                }
            }
        });
        child.stderr.on("data", (chunk) => {
            stderr = tail(stderr + chunk.toString("utf8"));
        });
        child.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const trailing = stdout.trim();
            if (trailing) {
                updates.push(trailing);
                onUpdate?.(trailing);
            }
            resolve({ resultCode: code ?? (signal ? 1 : 0), updates, stderr });
        });
    });
}
const X2D_NATIVE_PRINT_COMMANDS = new Set([
    "ams_change_filament",
    "ams_control",
    "ams_filament_drying",
    "ams_filament_setting",
    "ams_get_rfid",
    "ams_reset",
    "ams_user_setting",
    "auto_stop_ams_dry",
    "back_to_center",
    "buzzer_ctrl",
    "calibration",
    "clean_print_error",
    "close_air_filt",
    "extrusion_cali",
    "extrusion_cali_del",
    "extrusion_cali_get",
    "extrusion_cali_get_result",
    "extrusion_cali_sel",
    "extrusion_cali_set",
    "flowrate_cali",
    "flowrate_get_result",
    "get_auto_nozzle_mapping",
    "holder_nozzle_refresh",
    "idle_ignore",
    "ignore",
    "nozzle_holder_ctrl",
    "nozzle_info_confirm",
    "pause",
    "print_speed",
    "refresh_nozzle",
    "resume",
    "select_extruder",
    "set_against_continued_heating_mode",
    "set_airduct",
    "set_ctt",
    "set_extrusion_length",
    "skip_objects",
    "stop",
    "xyz_ctrl",
]);
const X2D_NATIVE_SYSTEM_COMMANDS = new Set(["ledctrl", "print_cache_set", "set_door_stat", "uiop"]);
const X2D_NATIVE_CAMERA_COMMANDS = new Set([
    "ipcam_cap_pic_set",
    "ipcam_delete_oldest_timelapse",
    "ipcam_get_media_info",
    "ipcam_record_set",
    "ipcam_resolution_set",
    "ipcam_timelapse",
]);
const X2D_NATIVE_XCAM_COMMANDS = new Set(["xcam_control_set"]);
export function buildBambuNativeFanCommand(fan, speed, sequenceId = String(Date.now())) {
    const normalized = String(fan).trim().toLowerCase();
    const fanConfig = normalized === "1" || normalized === "part" || normalized === "part_cooling"
        ? { fan: "part", fanIndex: 1 }
        : normalized === "2" || normalized === "aux" || normalized === "auxiliary" || normalized === "left_auxiliary"
            ? { fan: "auxiliary", fanIndex: 2 }
            : normalized === "10" || normalized === "right_aux" || normalized === "right_auxiliary"
                ? { fan: "right_auxiliary", fanIndex: 10 }
                : normalized === "3" || normalized === "chamber" || normalized === "exhaust"
                    ? { fan: "chamber", fanIndex: 3 }
                    : undefined;
    if (!fanConfig) {
        throw new Error("Unsupported X2D fan. Use part, auxiliary, right_auxiliary, chamber, 1, 2, 3, or 10.");
    }
    if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
        throw new Error("Fan speed must be between 0 and 100 percent.");
    }
    // Preserve the public tool's existing 10% step semantics while sending the
    // command through the signed native network plug-in instead of UI scripting.
    const roundedSpeed = Math.round(speed / 10) * 10;
    return {
        ...fanConfig,
        requestedSpeed: speed,
        speed: roundedSpeed,
        messageJson: JSON.stringify({
            print: {
                command: "set_fan",
                sequence_id: sequenceId,
                fan_index: fanConfig.fanIndex,
                speed: roundedSpeed,
            },
        }),
    };
}
export function buildBambuNativeTemperatureCommand(component, temperature, sequenceId = String(Date.now())) {
    const normalized = component.trim().toLowerCase();
    const normalizedComponent = normalized === "bed"
        ? "bed"
        : ["extruder", "nozzle", "tool", "tool0"].includes(normalized)
            ? "nozzle"
            : undefined;
    if (!normalizedComponent) {
        throw new Error("Unsupported X2D temperature component. Use bed, nozzle, extruder, tool, or tool0.");
    }
    const roundedTemperature = Math.round(temperature);
    const maximum = normalizedComponent === "bed" ? 120 : 300;
    if (!Number.isFinite(temperature) || roundedTemperature < 0 || roundedTemperature > maximum) {
        throw new Error(`X2D ${normalizedComponent} temperature must be between 0 and ${maximum}°C.`);
    }
    return {
        component: normalizedComponent,
        requestedTemperature: temperature,
        temperature: roundedTemperature,
        messageJson: JSON.stringify({
            print: normalizedComponent === "bed"
                ? {
                    command: "set_bed_temp",
                    sequence_id: sequenceId,
                    temp: roundedTemperature,
                }
                : {
                    command: "set_nozzle_temp",
                    sequence_id: sequenceId,
                    extruder_index: 0,
                    target_temp: roundedTemperature,
                },
        }),
    };
}
export function validateBambuNativeControlMessage(messageJson) {
    let parsed;
    try {
        parsed = JSON.parse(messageJson);
    }
    catch {
        throw new Error("X2D native control message_json must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("X2D native control message_json must be a JSON object.");
    }
    const envelope = parsed;
    if (Object.keys(envelope).length !== 1) {
        throw new Error("X2D native control accepts exactly one command envelope.");
    }
    const section = Object.keys(envelope)[0];
    const payload = envelope[section];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("X2D native control command envelope must contain an object.");
    }
    const print = payload;
    const command = typeof print.command === "string" ? print.command : "";
    if (section === "system" && X2D_NATIVE_SYSTEM_COMMANDS.has(command)) {
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (section === "camera" && X2D_NATIVE_CAMERA_COMMANDS.has(command)) {
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (section === "xcam" && X2D_NATIVE_XCAM_COMMANDS.has(command)) {
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (section !== "print") {
        throw new Error(`X2D native control command is not allowed: ${section}.${command || "<missing>"}.`);
    }
    if (command === "set_bed_temp" || command === "set_nozzle_temp") {
        const allowedKeys = command === "set_bed_temp"
            ? new Set(["command", "sequence_id", "temp"])
            : new Set(["command", "sequence_id", "extruder_index", "target_temp"]);
        if (Object.keys(print).some((key) => !allowedKeys.has(key))) {
            throw new Error(`X2D native ${command} contains unsupported fields.`);
        }
        if (typeof print.sequence_id !== "string" || print.sequence_id.length === 0) {
            throw new Error(`X2D native ${command} requires a sequence_id string.`);
        }
        const temperature = Number(command === "set_bed_temp" ? print.temp : print.target_temp);
        const maximum = command === "set_bed_temp" ? 120 : 300;
        if (!Number.isInteger(temperature) || temperature < 0 || temperature > maximum) {
            throw new Error(`X2D native ${command} temperature must be an integer from 0 to ${maximum}°C.`);
        }
        if (command === "set_nozzle_temp" && (!Number.isInteger(print.extruder_index) || Number(print.extruder_index) < 0 || Number(print.extruder_index) > 1)) {
            throw new Error("X2D native set_nozzle_temp extruder_index must be 0 or 1.");
        }
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (command === "gcode_file") {
        if (print.param !== "/usr/etc/print/auto_cali_for_user.gcode") {
            throw new Error("X2D native gcode_file is limited to the built-in user calibration file.");
        }
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (X2D_NATIVE_PRINT_COMMANDS.has(command)) {
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (command === "set_fan") {
        const allowedKeys = new Set(["command", "sequence_id", "fan_index", "speed"]);
        if (Object.keys(print).some((key) => !allowedKeys.has(key))) {
            throw new Error("X2D native set_fan contains unsupported fields.");
        }
        if (typeof print.sequence_id !== "string" || print.sequence_id.length === 0) {
            throw new Error("X2D native set_fan requires a sequence_id string.");
        }
        if (![1, 2, 3, 10].includes(Number(print.fan_index)) || !Number.isInteger(print.fan_index)) {
            throw new Error("X2D native set_fan fan_index must be 1, 2, 3, or 10.");
        }
        if (!Number.isInteger(print.speed) || Number(print.speed) < 0 || Number(print.speed) > 100 || Number(print.speed) % 10 !== 0) {
            throw new Error("X2D native set_fan speed must be an integer from 0 to 100 in 10% steps.");
        }
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (command === "print_option") {
        const optionKeys = [
            "air_print_detect", "air_purification", "auto_recovery", "auto_switch_filament",
            "filament_tangle_detect", "nozzle_blob_detect", "nozzle_blob_detect_v2",
            "option", "sound_enable",
        ];
        const allowedKeys = new Set(["command", "sequence_id", ...optionKeys]);
        if (!optionKeys.some((key) => key in print) || Object.keys(print).some((key) => !allowedKeys.has(key))) {
            throw new Error("X2D native print_option contains no supported option or has unsupported fields.");
        }
        return { messageJson: JSON.stringify(parsed), command };
    }
    if (command === "gcode_line") {
        const param = typeof print.param === "string" ? print.param.trim() : "";
        if (!/^M620\s+[CRP]\d+\s*$/i.test(param)) {
            throw new Error("X2D native gcode_line is limited to AMS M620 C/R/P commands.");
        }
        return { messageJson: JSON.stringify(parsed), command };
    }
    throw new Error(`X2D native control command is not allowed: ${command || "<missing>"}.`);
}
export async function sendCommandWithBambuNative(options) {
    const validated = validateBambuNativeControlMessage(options.messageJson);
    const qos = options.qos === undefined ? 0 : Math.trunc(options.qos);
    const flag = options.flag === undefined ? 0 : Math.trunc(options.flag);
    if (!Number.isFinite(qos) || !Number.isFinite(flag) || qos < 0 || qos > 1 || flag < 0 || flag > 1) {
        throw new Error("X2D native control qos and flag must be 0 or 1.");
    }
    const result = await runNativeHelper("--command", {
        ...process.env,
        BAMBU_NATIVE_COMMAND_CONFIRM: "1",
        BAMBU_NATIVE_HOST: options.host,
        BAMBU_NATIVE_SERIAL: options.serial,
        BAMBU_NATIVE_ACCESS_CODE: options.token,
        BAMBU_NATIVE_COMMAND_JSON: validated.messageJson,
        BAMBU_NATIVE_COMMAND_QOS: String(qos),
        BAMBU_NATIVE_COMMAND_FLAG: String(flag),
    }, 30000);
    if (result.resultCode !== 0) {
        const detail = [
            ...result.updates,
            ...(result.stderr ? [result.stderr.trim()] : []),
        ]
            .filter((line) => line.startsWith("native_error=") || line.startsWith("native_command result=") || line.startsWith("local MQTT connection"))
            .join("; ");
        throw new Error(`Bambu native X2D control failed (${result.resultCode})${detail ? `: ${detail}` : "."}`);
    }
    return {
        status: "success",
        route: "bambu:///local",
        command: validated.command,
        updates: result.updates,
    };
}
export async function probeBambuNative(host, token) {
    const result = await runNativeHelper("--probe", {
        ...process.env,
        BAMBU_NATIVE_HOST: host,
        BAMBU_NATIVE_ACCESS_CODE: token,
    }, 20000);
    if (result.resultCode !== 0) {
        throw new Error(`Bambu native local tunnel probe failed (${result.resultCode}).`);
    }
    return { status: "ok", route: "bambu:///local", updates: result.updates };
}
export async function printWithBambuNative(options, onUpdate) {
    const result = await runNativeHelper("--print", {
        ...process.env,
        BAMBU_NATIVE_CONFIRM: "1",
        BAMBU_NATIVE_HOST: options.host,
        BAMBU_NATIVE_SERIAL: options.serial,
        BAMBU_NATIVE_ACCESS_CODE: options.token,
        BAMBU_NATIVE_FILE: options.filePath,
        BAMBU_NATIVE_CONFIG_FILE: options.filePath,
        BAMBU_NATIVE_TASK_NAME: options.projectName,
        BAMBU_NATIVE_DST_FILE: options.remoteName || path.basename(options.filePath),
        BAMBU_NATIVE_PROJECT_NAME: options.projectName,
        BAMBU_NATIVE_PRESET_NAME: options.presetName,
        BAMBU_NATIVE_PLATE_INDEX: String(options.plateIndex + 1),
        BAMBU_NATIVE_BED_TYPE: options.bedType,
        BAMBU_NATIVE_USE_AMS: String(options.useAMS),
        BAMBU_NATIVE_AMS_MAPPING: options.amsMapping || "",
        BAMBU_NATIVE_AMS_MAPPING2: options.amsMapping2 || "",
        BAMBU_NATIVE_AMS_MAPPING_INFO: options.amsMappingInfo || "",
        BAMBU_NATIVE_NOZZLE_MAPPING: options.nozzleMapping || "",
        BAMBU_NATIVE_NOZZLES_INFO: options.nozzlesInfo || "",
        BAMBU_NATIVE_BED_LEVELING: boolEnv(options.bedLeveling, true),
        BAMBU_NATIVE_FLOW_CALIBRATION: boolEnv(options.flowCalibration, true),
        BAMBU_NATIVE_VIBRATION_CALIBRATION: boolEnv(options.vibrationCalibration, true),
        BAMBU_NATIVE_LAYER_INSPECT: boolEnv(options.layerInspect, false),
        BAMBU_NATIVE_TIMELAPSE: boolEnv(options.timelapse, false),
    }, 300000, onUpdate);
    if (result.resultCode !== 0) {
        const detail = [
            ...result.updates,
            ...(result.stderr ? [result.stderr.trim()] : []),
        ]
            .filter((line) => line.startsWith("native_error=") || line.startsWith("native_print result=") || line.startsWith("local MQTT connection"))
            .join("; ");
        throw new Error(`Bambu native local print failed (${result.resultCode})${detail ? `: ${detail}` : "."}`);
    }
    return {
        status: "success",
        route: "bambu:///local",
        updates: result.updates,
    };
}
export async function uploadWithBambuNative(options, onUpdate) {
    const result = await runNativeHelper("--upload", {
        ...process.env,
        BAMBU_NATIVE_UPLOAD_CONFIRM: "1",
        BAMBU_NATIVE_HOST: options.host,
        BAMBU_NATIVE_SERIAL: options.serial,
        BAMBU_NATIVE_ACCESS_CODE: options.token,
        BAMBU_NATIVE_FILE: options.filePath,
        BAMBU_NATIVE_CONFIG_FILE: options.filePath,
        BAMBU_NATIVE_TASK_NAME: options.projectName,
        BAMBU_NATIVE_DST_FILE: options.remoteName || path.basename(options.filePath),
        BAMBU_NATIVE_PROJECT_NAME: options.projectName,
        BAMBU_NATIVE_PRESET_NAME: options.presetName,
        BAMBU_NATIVE_PLATE_INDEX: String(options.plateIndex + 1),
        BAMBU_NATIVE_BED_TYPE: options.bedType,
        BAMBU_NATIVE_USE_AMS: String(options.useAMS),
        BAMBU_NATIVE_AMS_MAPPING: options.amsMapping || "",
        BAMBU_NATIVE_AMS_MAPPING2: options.amsMapping2 || "",
        BAMBU_NATIVE_AMS_MAPPING_INFO: options.amsMappingInfo || "",
        BAMBU_NATIVE_NOZZLE_MAPPING: options.nozzleMapping || "",
        BAMBU_NATIVE_NOZZLES_INFO: options.nozzlesInfo || "",
        BAMBU_NATIVE_BED_LEVELING: boolEnv(options.bedLeveling, true),
        BAMBU_NATIVE_FLOW_CALIBRATION: boolEnv(options.flowCalibration, true),
        BAMBU_NATIVE_VIBRATION_CALIBRATION: boolEnv(options.vibrationCalibration, true),
        BAMBU_NATIVE_LAYER_INSPECT: boolEnv(options.layerInspect, false),
        BAMBU_NATIVE_TIMELAPSE: boolEnv(options.timelapse, false),
    }, 300000, onUpdate);
    if (result.resultCode !== 0) {
        const detail = [
            ...result.updates,
            ...(result.stderr ? [result.stderr.trim()] : []),
        ]
            .filter((line) => line.startsWith("native_error=") || line.startsWith("native_upload result=") || line.startsWith("local MQTT connection"))
            .join("; ");
        throw new Error(`Bambu native local upload failed (${result.resultCode})${detail ? `: ${detail}` : "."}`);
    }
    return {
        status: "success",
        route: "bambu:///local",
        updates: result.updates,
    };
}
