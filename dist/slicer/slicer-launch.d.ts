import { type ChildProcess } from "node:child_process";
import { SlicerStalled } from "../refusal.js";
export interface SlicerLaunch {
    /** The environment for the slicer process (undefined: inherit this server's). */
    env?: NodeJS.ProcessEnv;
    /** Whether a slice that stalls is stopped and reported (see watchForStall). */
    watchStall: boolean;
    /** Removes this launch's home folder. */
    cleanup(): Promise<void>;
}
/**
 * The launch for one slice. On macOS a Bambu-compatible CLI gets its own empty home folder (always: an inherited
 * CFFIXED_USER_HOME is replaced, since a home that held a stalled slice may hold the history that stalled it).
 */
export declare function prepareSlicerLaunch(slicerType: string, tempDir: string, platform?: NodeJS.Platform): Promise<SlicerLaunch>;
/**
 * Seconds a slicer may use no CPU and write nothing before it is treated as waiting on a dialog
 * (SLICER_STALL_SECONDS, 1-3600; 0 turns the check off). A slice is never idle that long: it computes or writes.
 */
export declare function slicerStallSeconds(raw?: string | undefined): number;
/** "[[dd-]hh:]mm:ss[.cc]" from ps -o time= (macOS: m:ss.cc; Linux: [dd-]hh:mm:ss), in seconds. */
export declare function parseCpuTime(text: string): number | undefined;
/**
 * Calls onStall once when the child has used no CPU and written nothing to stdout or stderr for `seconds`, counted
 * in consecutive polls (so a Mac that sleeps meanwhile doesn't count the sleep). It starts counting only after the
 * child has shown it is running (output or CPU), and does nothing where CPU time can't be read. Returns a stop
 * function; it also stops when the child exits.
 */
export declare function watchForStall(child: ChildProcess, seconds: number, onStall: () => void): () => void;
/** The failure for a slicer stopped by watchForStall. */
export declare function slicerStalled(slicerType: string, seconds: number): SlicerStalled;
