/**
 * Which camera transport each model uses, keyed by the lowercased model name
 * with spaces removed. camera_snapshot routes by these sets and
 * counterpart_printer_info reports them, so the two always agree.
 */
// P1/A1 series use the proprietary TCP-on-6000 framed JPEG path
// (per https://github.com/Doridian/OpenBambuAPI/blob/main/video.md).
export const TCP_CAMERA_MODELS: ReadonlySet<string> = new Set(["a1", "a1mini", "p1s", "p1p"]);
// X1, P2S, H2 (H2S/H2D/H2C), AND X2D all use RTSP on port 322. The
// OpenBambuAPI doc only mentions X1/P2S, but the HA bambulab
// integration's models.py shows the printer reports its own
// `ipcam.rtsp_url` for these models, and Parker (H2S) rejects the
// A1/P1 80-byte auth packet on port 6000 (verified 2026-04-27 --
// confirmed by local H2 camera transport probes).
export const RTSP_CAMERA_MODELS: ReadonlySet<string> = new Set([
  "x1", "x1c", "x1carbon", "x1e", "p2s",
  "h2", "h2s", "h2d", "h2c", "h2dpro", "x2d",
]);
