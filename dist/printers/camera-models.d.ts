/**
 * Which camera transport each model uses, keyed by the lowercased model name
 * with spaces removed. camera_snapshot routes by these sets and
 * counterpart_printer_info reports them, so the two always agree.
 */
export declare const TCP_CAMERA_MODELS: ReadonlySet<string>;
export declare const RTSP_CAMERA_MODELS: ReadonlySet<string>;
