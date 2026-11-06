/** The plain sentence for a slicer's error, or undefined when the words aren't one this knows. */
export declare function plainSlicerError(words: string): string | undefined;
/** What a person is told when the slicer refused with words this doesn't know. */
export declare const UNKNOWN_SLICER_ERROR = "The slicer couldn't slice this model. Its own message is kept for the log.";
