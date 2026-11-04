/** counterpart_printer_info for Bambu printers (PRD §8.4). Pure: no printer traffic. */
import { RTSP_CAMERA_MODELS, TCP_CAMERA_MODELS } from "../printers/camera-models.js";
import { normalizeModel } from "../safety/limits.js";
import { SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT } from "./schemas.js";
/** Bambu's display names ("P1S", "A1 Mini", "H2D Pro"), keyed by normalized model. */
const DISPLAY_NAMES = new Map(Object.values(SERIAL_MODELS).map(name => [normalizeModel(name), name]));
/** What slice_stl applies on each backend: the local slicer CLIs take all three; orca-slicer-api refuses repetitions. */
export function bambuSliceCapabilities(slicerType) {
    return slicerType === "orca-slicer-api" ? { supports: true, copies: false, orient: true } : { supports: true, copies: true, orient: true };
}
export function bambuPrinterInfo(options) {
    const model = normalizeModel(options.model);
    const serial = options.serial?.trim();
    return {
        contract: COUNTERPART_CONTRACT,
        server: options.server,
        printer: {
            kind: "bambu",
            ...(model ? { model: DISPLAY_NAMES.get(model) ?? model.toUpperCase() } : {}),
            ...(serial ? { serial } : {}),
            host: options.host,
        },
        capabilities: {
            progress: true,
            layers: true,
            // camera_snapshot needs the model to choose its transport.
            camera: model && TCP_CAMERA_MODELS.has(model) ? "bambu-tcp" : model && RTSP_CAMERA_MODELS.has(model) ? "rtsp" : "none",
            cameraStream: !!model && (TCP_CAMERA_MODELS.has(model) || RTSP_CAMERA_MODELS.has(model)),
            filaments: "ams",
            pause: true,
            resume: true,
            cancel: true,
            print3mf: true,
            // X2D jobs go through its native route; FTPS/remote-file G-code starts stay blocked there.
            gcode: model !== "x2d",
            // From the configured slicer backend, as slice_stl uses it (remote orca-slicer-api makes no copies).
            slicing: bambuSliceCapabilities(options.slicerType),
        },
    };
}
