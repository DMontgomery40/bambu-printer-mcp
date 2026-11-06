/**
 * Every error code the Bambu Studio CLI can exit with, from libslic3r/Utils.hpp:21-75 of Bambu Studio
 * 02.08.02.61 (OrcaSlicer's CLI shares them). The names and numbers are Studio's; the sentences are ours.
 * The process exits with the code's low byte (-50 exits as 206). The CLI's own result.json, when present and
 * fresh, is still the better reason; this table is for when it is missing or stale.
 *
 * tests/slicer/cli-exit-codes.test.mjs checks the names and numbers against Utils.hpp's list.
 */
export declare const BAMBU_CLI_EXIT_CODES: Record<number, {
    name: string;
    sentence: string;
}>;
/** The table's entry for a process exit status (the code's low byte) or a full negative code. */
export declare function bambuCliExitCode(exitCode: unknown): {
    code: number;
    name: string;
    sentence: string;
} | undefined;
