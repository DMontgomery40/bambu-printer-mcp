import { COUNTERPART_CONTRACT } from "./schemas.js";
/** One loaded spool as a client shows it. `feed` groups the spools that can feed one print together. */
export type ProposalTray = {
    slot: number;
    label: string;
    name: string;
    colour: string;
    material: string;
    filamentId: string;
    feed: string;
    /** This server can slice with it (a filament profile is resolved for it). */
    sliceable: boolean;
    /** The resolved slicer filament profile (absolute path), the one slice_stl takes in load_filaments. */
    profile?: string;
};
export type ProposalFilament = {
    index: number;
    name?: string;
    colour?: string;
    material?: string;
};
/** A filament slot no part names (a painted region): it follows the chosen spools' feed. `prints` false: not on this plate. */
export type PaintedFilament = {
    index: number;
    colour?: string;
    material?: string;
    prints?: boolean;
};
export type ChosenSpool = {
    index: number;
    slot: number;
    colour?: string;
    material?: string;
    filamentId?: string;
};
export type Verdict = "same-colour" | "closest" | "no-colour" | "none";
export type ProposalRow = {
    index: number;
    slot?: number;
    verdict: Verdict;
    distance?: number;
    materialMismatch?: boolean;
    /** What the person should know about this suggestion, in their words. */
    note?: string;
};
export type ProposalProblem = {
    code: string;
    message: string;
    index?: number;
};
export type FilamentProposal = {
    contract: typeof COUNTERPART_CONTRACT;
    /** The spools a person may choose from: every loaded one for a sliced file, the sliceable ones otherwise. */
    trays: ProposalTray[];
    proposal: ProposalRow[];
    /** Every filament slot (parts and painted) to its spool, when the proposal or the person's choice is printable. */
    mapping?: Array<{
        index: number;
        slot: number;
    }>;
    problems: ProposalProblem[];
};
/** A colour this close (OKLab) to the asked-for one is the same colour to a person. */
export declare const SAME_COLOUR = 0.08;
/** Perceptual distance between two `#RRGGBB` colours (0 identical, about 1 black to white). Alpha is ignored. */
export declare function colourDistance(a: string, b: string): number;
type Match = {
    slot: number;
    distance?: number;
    materialMismatch?: boolean;
    guessed?: boolean;
};
/**
 * One match per filament, in order; undefined where nothing can serve it. Several filaments of one colour may share a
 * spool. With `requireMaterial` (an already-sliced file) only spools of the asked-for material qualify. Automatic matches
 * never mix feeds: the first feed listed (the AMS) is preferred, another feed only when it alone serves every colour.
 */
export declare function matchColours(model: Array<{
    colour?: string;
    material?: string;
}>, trays: ProposalTray[], options?: {
    requireMaterial?: boolean;
}): (Match | undefined)[];
/** The colour names Bambu Studio itself uses for its filaments (profiles/BBL/filament/filaments_color_codes.json). */
export type ColourNames = {
    spool(filamentId: string, colour: string): string | undefined;
    colour(colour: string): string | undefined;
};
export declare const NO_COLOUR_NAMES: ColourNames;
export declare function loadColourNames(filamentProfileDir: string | undefined): ColourNames;
/** Where a Bambu tray sits, as Bambu Studio labels it: AMS units A–D with trays 1–4, AMS HT units by letter. */
export declare function bambuTrayLabel(amsId: number, trayId: number): string;
/** A spool's name: its colour name (when Bambu names it) and product ("Sunflower Yellow PLA Basic"), else the product. */
export declare function spoolName(product: string, colourName: string | undefined): string;
export declare function proposeFilaments(input: {
    trays: ProposalTray[];
    filaments: ProposalFilament[];
    painted?: PaintedFilament[];
    chosen?: ChosenSpool[];
    sliced?: boolean;
    names?: ColourNames;
}): FilamentProposal;
export declare const PROPOSE_FILAMENTS_INPUT_PROPERTIES: {
    readonly filaments: {
        readonly type: "array";
        readonly maxItems: 64;
        readonly description: "The model's filaments a person sees, in project order: 1-based index, part name, the colour it belongs in and its material when known.";
        readonly items: {
            readonly type: "object";
            readonly properties: {
                readonly index: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: 64;
                };
                readonly name: {
                    readonly type: "string";
                    readonly maxLength: 256;
                };
                readonly colour: {
                    type: string;
                    pattern: string;
                };
                readonly material: {
                    readonly type: "string";
                    readonly maxLength: 64;
                };
            };
            readonly required: readonly ["index"];
            readonly additionalProperties: false;
        };
    };
    readonly painted: {
        readonly type: "array";
        readonly maxItems: 64;
        readonly description: "Filament slots no part names (painted regions). Each follows the chosen spools' feed; prints false when the selected plate never uses it.";
        readonly items: {
            readonly type: "object";
            readonly properties: {
                readonly index: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: 64;
                };
                readonly colour: {
                    type: string;
                    pattern: string;
                };
                readonly material: {
                    readonly type: "string";
                    readonly maxLength: 64;
                };
                readonly prints: {
                    readonly type: "boolean";
                };
            };
            readonly required: readonly ["index"];
            readonly additionalProperties: false;
        };
    };
    readonly chosen: {
        readonly type: "array";
        readonly maxItems: 64;
        readonly description: "The person's spool for each filament, in the same order: checked against what is loaded now. Omit for the proposal alone.";
        readonly items: {
            readonly type: "object";
            readonly properties: {
                readonly index: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: 64;
                };
                readonly slot: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: 4095;
                };
                readonly colour: {
                    type: string;
                    pattern: string;
                };
                readonly material: {
                    readonly type: "string";
                    readonly maxLength: 128;
                };
                readonly filamentId: {
                    readonly type: "string";
                    readonly maxLength: 128;
                };
            };
            readonly required: readonly ["index", "slot"];
            readonly additionalProperties: false;
        };
    };
    readonly sliced: {
        readonly type: "boolean";
        readonly description: "The file is already sliced: its materials are fixed, so only spools of the same material qualify.";
    };
};
export declare const PROPOSE_FILAMENTS_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        trays: {
            type: string;
            items: {
                type: string;
                properties: {
                    slot: {
                        type: string;
                    };
                    label: {
                        type: string;
                    };
                    name: {
                        type: string;
                    };
                    colour: {
                        type: string;
                    };
                    material: {
                        type: string;
                    };
                    filamentId: {
                        type: string;
                    };
                    feed: {
                        type: string;
                    };
                    sliceable: {
                        type: string;
                    };
                    profile: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        proposal: {
            type: string;
            items: {
                type: string;
                properties: {
                    index: {
                        type: string;
                    };
                    slot: {
                        type: string;
                    };
                    verdict: {
                        type: string;
                        enum: string[];
                    };
                    distance: {
                        type: string;
                    };
                    materialMismatch: {
                        type: string;
                    };
                    note: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        mapping: {
            type: string;
            items: {
                type: string;
                properties: {
                    index: {
                        type: string;
                    };
                    slot: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        problems: {
            type: string;
            items: {
                type: string;
                properties: {
                    code: {
                        type: string;
                    };
                    message: {
                        type: string;
                    };
                    index: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
export {};
