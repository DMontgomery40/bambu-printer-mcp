/**
 * Merging Bambu MQTT reports. P1/A1 printers push only what changed, so a merged report keeps every field until the
 * printer sends it again. A new job's first pushes can carry its name and layer count before its layer number, and the
 * previous job's last layer then read against the new total ("315/150").
 */
/** True when update describes a different job than the report merged before it. */
export declare function startsNewJob(previous: Record<string, any> | undefined, update: Record<string, any>): boolean;
/**
 * The fields to set when update merges into previous: for a new job, the layer and percentage it did not send start
 * at 0, and a remaining time it did not send is dropped. Nothing for the same job.
 */
export declare function newJobResets(previous: Record<string, any> | undefined, update: Record<string, any>): Record<string, number | undefined>;
/** previous merged with update, restarting a new job's progress (newJobResets). */
export declare function mergeBambuReport(previous: Record<string, any> | undefined, update: Record<string, any>): Record<string, any>;
