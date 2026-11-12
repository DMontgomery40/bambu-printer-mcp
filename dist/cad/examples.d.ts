declare const FIELDS: {
    readonly "Use for": "use_for";
    readonly Pattern: "pattern";
    readonly "Modelled on": "modelled_on";
    readonly "Published sizes used": "published_sizes";
    readonly Concept: "concept";
    readonly "What makes this good": "what_makes_this_good";
};
type Field = (typeof FIELDS)[keyof typeof FIELDS];
export type CadExample = {
    name: string;
    title: string;
    script: string;
} & Record<Field, string>;
/** Simplest first: the order the list and the prompt present them in. */
export declare const CAD_EXAMPLE_ORDER: string[];
/** Every example on disk, in cookbook order (unlisted files last, by name). Empty when the folder is missing. */
export declare function cadExamples(): CadExample[];
/** One line per example for the cad_design prompt: "name: what it is for". */
export declare function cadExampleLines(): string;
/** cad_examples: without a name, the list; with one, that example's record and script. */
export declare function cadExamplesTool(args: Record<string, unknown>): Record<string, unknown>;
export {};
