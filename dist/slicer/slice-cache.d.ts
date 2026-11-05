/**
 * Finished slices kept for reuse: slicing the same model the same way again (Print Again, or Print after a
 * client's estimate) restores the slicer's outputs instead of running it. A slicer run is identified by exactly
 * what it was given: the slicer executable (its path, size and modification time, so an update slices again),
 * this server's version, and its full argument list, with every input file replaced by its content hash and every
 * output location by a placeholder. Profiles, filament files, the model and generated override files are all
 * arguments, so editing any of them slices again. A run whose arguments name any other directory (its contents
 * can't be hashed) is never cached, nor is a failed slice. Presets the slicer finds by itself, not named in its
 * arguments (its own bundled system presets), count through the executable: a slicer update slices again.
 *
 * SLICE_CACHE=off turns it off; SLICE_CACHE_DIR moves it (default ~/.cache/<package name>/slices). The newest
 * SLICE_CACHE_ENTRIES (default 16) slices are kept.
 */
export interface SlicerRun {
    command: string;
    args: string[];
    /** What the slicer writes, kept and restored: files, or directories it fills. */
    outputs: string[];
    /** Folders it writes into that aren't kept as a whole (an --outputdir shared with other files). */
    locations?: string[];
}
export declare function sliceCacheRoot(): string;
/** The run's cache key, or undefined when it can't be identified exactly (then it is never cached). */
export declare function sliceCacheKey(run: SlicerRun): Promise<string | undefined>;
/** Puts a kept slice's outputs where this run would write them; false when there is none. */
export declare function restoreSlice(key: string, run: SlicerRun): Promise<boolean>;
/** Keeps a finished slice's outputs, whole or not at all; a failure to keep it never fails the slice. */
export declare function keepSlice(key: string, run: SlicerRun): Promise<void>;
