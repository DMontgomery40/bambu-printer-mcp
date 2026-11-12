/**
 * Merging Bambu MQTT reports. P1/A1 printers push only what changed, so a merged report keeps every field until the
 * printer sends it again. A new job's first pushes can carry its name and layer count before its layer number, and the
 * previous job's last layer then read against the new total ("315/150"). Until the new job reports its own progress,
 * its report has none.
 */
/** True when update describes a different job than the report merged before it. */
export declare function startsNewJob(previous: Record<string, any> | undefined, update: Record<string, any>): boolean;
/** The previous job's progress fields to leave out when update starts a new job without reporting them. */
export declare function newJobResets(previous: Record<string, any> | undefined, update: Record<string, any>): string[];
/** previous merged with update, without the previous job's progress when update starts a new one (newJobResets). */
export declare function mergeBambuReport(previous: Record<string, any> | undefined, update: Record<string, any>): Record<string, any>;
