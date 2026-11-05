import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./schemas.js";
export declare const SETUP_FIELD_NAMES: readonly ["host", "port", "serial", "model", "secret"];
export type SetupField = {
    /** The client's form field this is: an address, a port, a serial number, a model choice or a secret. */
    name: typeof SETUP_FIELD_NAMES[number];
    env: string;
    aliases?: string[];
    label: string;
    hint?: string;
    required: boolean;
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
};
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
                    fields: {
                        type: string;
                        items: {
                            type: string;
                            properties: {
                                name: {
                                    type: string;
                                    enum: ("model" | "host" | "port" | "serial" | "secret")[];
                                };
                                env: {
                                    type: string;
                                };
                                aliases: {
                                    type: string;
                                    items: {
                                        type: string;
                                    };
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
    };
    required: string[];
};
