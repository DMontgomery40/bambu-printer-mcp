/**
 * What a client shows about a sliced file, read here so it never parses slicer formats itself (Counterpart PRD
 * §8.0 item 9): the selected plate's estimate and slice settings, and how many printable plates the file has.
 * Bambu Studio and OrcaSlicer 3MFs carry them in Metadata/slice_info.config, project_settings.config and the
 * plate's G-code header; a G-code file in its own header and footer comments. Anything not found is left out.
 */
export interface SlicedFileFacts {
    plate_count?: number;
    estimate?: {
        seconds?: number;
        grams?: number;
    };
    settings: {
        layer_height_mm?: number;
        sparse_infill_percent?: number;
        wall_loops?: number;
        layer_count?: number;
    };
}
/** The facts of a sliced 3MF or G-code file for one zero-based plate; what can't be read is left out, never an error. */
export declare function slicedFileFacts(filePath: string, plateIndex?: number): Promise<SlicedFileFacts>;
/**
 * Bambu Studio's (or OrcaSlicer's) verdict on a slice, from its result.json: whether it failed, what a person is
 * told (`message`: a plain sentence for a refusal, src/slicer/slicer-messages.ts; the plates' warnings for a slice
 * that worked), the slicer's own words for the log (`slicer_message`: the error and every plate's warning,
 * verbatim), and how many plates it sliced.
 */
export interface SlicerReport {
    failed: boolean;
    message?: string;
    slicer_message?: string;
    plate_count?: number;
}
/** A refusal's report: the plain sentence, and the slicer's words kept beside it. */
export declare function refusalReport(words: string): SlicerReport;
export declare function slicerReport(result: unknown): SlicerReport | undefined;
