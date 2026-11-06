/** counterpart_printer_info for Bambu printers (PRD §8.4). Pure: no printer traffic. */
import { RTSP_CAMERA_MODELS, TCP_CAMERA_MODELS } from "../printers/camera-models.js";
import { normalizeModel } from "../safety/limits.js";
import { SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, type PrinterInfo } from "./schemas.js";

/** Bambu's display names ("P1S", "A1 Mini", "H2D Pro"), keyed by normalized model. */
const DISPLAY_NAMES = new Map(Object.values(SERIAL_MODELS).map(name => [normalizeModel(name), name]));

/** Backends that slice through the Bambu Studio / OrcaSlicer CLI, where supports, copies and auto-orient all apply. */
export const BAMBU_CLI_SLICERS = ["bambustudio", "orcaslicer", "orcaslicer-bambulab"] as const;

/**
 * What slice_stl applies on each backend: the Bambu Studio / OrcaSlicer CLIs take all three; remote orca-slicer-api
 * takes supports and orient but refuses repetitions and doesn't split across plates; PrusaSlicer, Slic3r and Cura take none of them here.
 */
export function bambuSliceCapabilities(slicerType: string | undefined): { supports: boolean; copies: boolean; orient: boolean; plates: boolean } {
  // plates: slice_stl's split_to_plates, for a model bigger than the bed (src/slicer/bed-plates.ts).
  if (slicerType === undefined || (BAMBU_CLI_SLICERS as readonly string[]).includes(slicerType)) return { supports: true, copies: true, orient: true, plates: true };
  if (slicerType === "orca-slicer-api") return { supports: true, copies: false, orient: true, plates: false };
  return { supports: false, copies: false, orient: false, plates: false };
}

export function bambuPrinterInfo(options: { server: { name: string; version: string }; host: string; serial?: string; model?: string; slicerType?: string }): PrinterInfo {
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
