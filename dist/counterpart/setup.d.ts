import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./schemas.js";
export declare const SETUP_FIELD_NAMES: readonly ["host", "port", "serial", "model", "secret", "slicer", "slicer-path", "profiles"];
export type SetupField = {
    /** The client's form field this is: an address, a port, a serial number, a model choice or a secret. */
    name: typeof SETUP_FIELD_NAMES[number];
    /** The variable to write. */
    env: string;
    /** Older names for it that this server reads before `env`: a client writing `env` removes these lines, or the old value wins. */
    aliases?: string[];
    label: string;
    hint?: string;
    required: boolean;
    /** A path on this computer (a slicer app, a profiles folder): a client may offer a file chooser. */
    input?: "path";
    /** Written as typed, or upper-cased (Bambu serial numbers). */
    transform?: "uppercase";
    choices?: Array<{
        value: string;
        label: string;
    }>;
    /** A model field: the model a serial number names, by its first `prefixLength` characters. */
    fromSerial?: {
        prefixLength: number;
        models: Record<string, string>;
    };
};
export type SetupKind = {
    kind: typeof PRINTER_KINDS[number];
    label: string;
    /** Values this server needs for the kind whatever the person enters (MCP_TRANSPORT, PRINTER_TYPE). */
    env: Record<string, string>;
    /**
     * Whether camera_snapshot reads this kind's camera with only the settings these fields write, so a client's setup
     * check can ask for a picture as well as the status. What else the computer needs (ffmpeg for RTSP models) is
     * reported in camera_snapshot's own error. Every kind declares it; a client reads it missing as an older server.
     */
    cameraSnapshot: boolean;
    fields: SetupField[];
};
/** The slicer this server runs, as it resolves it now, and the settings that choose it (for every printer). */
export type SlicerSetup = {
    type: string;
    /** The slicer app it would run, and whether that app is there. */
    path?: string;
    found: boolean;
    /** The Bambu profiles folder it would read (Bambu Studio and Orca), and whether it has BBL's profiles. */
    profilesRoot?: string;
    profilesFound?: boolean;
    fields: SetupField[];
};
export type SetupFields = {
    contract: typeof COUNTERPART_CONTRACT;
    server: {
        name: string;
        version: string;
    };
    kinds: SetupKind[];
    model?: string;
    slicer?: SlicerSetup;
};
/**
 * The slicer settings, with what this server resolves now: a client shows "Bambu Studio isn't installed" or asks for
 * its location instead of the person editing SLICER_PATH by hand. A setting is required only when what it would
 * default to isn't there.
 */
export declare function slicerSetup(options: {
    types: readonly string[];
    type: string;
    path?: string;
    found: boolean;
    profilesRoot?: string;
    profilesFound?: boolean;
    remote?: boolean;
}): SlicerSetup;
/** Each serial prefix's model in this server's values (bambu_model), where it has one. */
export declare function serialModelValues(valid: readonly string[]): Record<string, string>;
/** Bambu's display names for this server's model values ("a1mini" → "A1 Mini"). */
export declare function modelChoices(valid: readonly string[]): Array<{
    value: string;
    label: string;
}>;
export declare function bambuSetupFields(options: {
    server: {
        name: string;
        version: string;
    };
    models: readonly string[];
    serial?: string;
    slicer?: SlicerSetup;
}): SetupFields;
export declare const SETUP_FIELDS_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        server: {
            type: string;
            properties: {
                name: {
                    type: string;
                };
                version: {
                    type: string;
                };
            };
            required: string[];
        };
        kinds: {
            type: string;
            items: {
                type: string;
                properties: {
                    kind: {
                        type: string;
                        enum: ("bambu" | "octoprint" | "klipper" | "prusa" | "duet" | "repetier" | "creality")[];
                    };
                    label: {
                        type: string;
                    };
                    env: {
                        type: string;
                        additionalProperties: {
                            type: string;
                        };
                    };
                    cameraSnapshot: {
                        type: string;
                        description: string;
                    };
                    fields: {
                        type: string;
                        items: {
                            type: string;
                            properties: {
                                name: {
                                    type: string;
                                    enum: ("model" | "host" | "slicer" | "port" | "profiles" | "serial" | "secret" | "slicer-path")[];
                                };
                                env: {
                                    type: string;
                                };
                                aliases: {
                                    type: string;
                                    items: {
                                        type: string;
                                    };
                                    description: string;
                                };
                                label: {
                                    type: string;
                                };
                                hint: {
                                    type: string;
                                };
                                required: {
                                    type: string;
                                };
                                input: {
                                    type: string;
                                    enum: string[];
                                };
                                transform: {
                                    type: string;
                                    enum: string[];
                                };
                                choices: {
                                    type: string;
                                    items: {
                                        type: string;
                                        properties: {
                                            value: {
                                                type: string;
                                            };
                                            label: {
                                                type: string;
                                            };
                                        };
                                        required: string[];
                                    };
                                };
                                fromSerial: {
                                    type: string;
                                    properties: {
                                        prefixLength: {
                                            type: string;
                                        };
                                        models: {
                                            type: string;
                                            additionalProperties: {
                                                type: string;
                                            };
                                        };
                                    };
                                    required: string[];
                                };
                            };
                            required: string[];
                        };
                    };
                };
                required: string[];
            };
        };
        model: {
            type: string;
        };
        slicer: {
            type: string;
            properties: {
                type: {
                    type: string;
                };
                path: {
                    type: string;
                };
                found: {
                    type: string;
                };
                profilesRoot: {
                    type: string;
                };
                profilesFound: {
                    type: string;
                };
                fields: {
                    type: string;
                    items: {
                        type: string;
                        properties: {
                            name: {
                                type: string;
                                enum: ("model" | "host" | "slicer" | "port" | "profiles" | "serial" | "secret" | "slicer-path")[];
                            };
                            env: {
                                type: string;
                            };
                            aliases: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                            label: {
                                type: string;
                            };
                            hint: {
                                type: string;
                            };
                            required: {
                                type: string;
                            };
                            input: {
                                type: string;
                                enum: string[];
                            };
                            transform: {
                                type: string;
                                enum: string[];
                            };
                            choices: {
                                type: string;
                                items: {
                                    type: string;
                                    properties: {
                                        value: {
                                            type: string;
                                        };
                                        label: {
                                            type: string;
                                        };
                                    };
                                    required: string[];
                                };
                            };
                            fromSerial: {
                                type: string;
                                properties: {
                                    prefixLength: {
                                        type: string;
                                    };
                                    models: {
                                        type: string;
                                        additionalProperties: {
                                            type: string;
                                        };
                                    };
                                };
                                required: string[];
                            };
                        };
                        required: string[];
                    };
                };
            };
            required: string[];
        };
    };
    required: string[];
};
