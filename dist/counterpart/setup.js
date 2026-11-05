/**
 * counterpart_setup_fields (counterpart/1): the printers this server drives and the settings it reads for each, by the
 * environment variable names it reads (`env`, and older `aliases` it reads first). A client renders these fields, writes the values
 * to this server's .env and never needs its own printer or model tables. Pure: no printer traffic, no secrets returned.
 */
import { normalizeModel } from "../safety/limits.js";
import { SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./schemas.js";
export const SETUP_FIELD_NAMES = ["host", "port", "serial", "model", "secret"];
/** Each serial prefix's model in this server's values (bambu_model), where it has one. */
export function serialModelValues(valid) {
    return Object.fromEntries(Object.entries(SERIAL_MODELS).flatMap(([prefix, name]) => {
        const model = normalizeModel(name);
        return model && valid.includes(model) ? [[prefix, model]] : [];
    }));
}
/** Bambu's display names for this server's model values ("a1mini" → "A1 Mini"). */
export function modelChoices(valid) {
    const names = new Map(Object.values(SERIAL_MODELS).map(name => [normalizeModel(name), name]));
    return valid.map(value => ({ value, label: names.get(value) ?? value.toUpperCase() }));
}
export function bambuSetupFields(options) {
    const fromSerial = { prefixLength: 3, models: serialModelValues(options.models) };
    const model = options.serial ? fromSerial.models[options.serial.trim().slice(0, 3).toUpperCase()] : undefined;
    return {
        contract: COUNTERPART_CONTRACT,
        server: options.server,
        kinds: [{
                kind: "bambu", label: "Bambu Lab", env: { MCP_TRANSPORT: "stdio" },
                fields: [
                    { name: "host", env: "PRINTER_HOST", aliases: ["BAMBU_PRINTER_HOST"], label: "Address", hint: "The printer's IP address: on the printer, Settings → WLAN", required: true },
                    { name: "serial", env: "BAMBU_SERIAL", aliases: ["BAMBU_PRINTER_SERIAL"], label: "Serial number", hint: "On the printer: Settings → Device", required: true, transform: "uppercase" },
                    { name: "model", env: "BAMBU_MODEL", aliases: ["BAMBU_PRINTER_MODEL"], label: "Model", required: true, choices: modelChoices(options.models), fromSerial },
                    { name: "secret", env: "BAMBU_TOKEN", aliases: ["BAMBU_PRINTER_ACCESS_TOKEN"], label: "Access code", hint: "On the printer: Settings → WLAN → Access Code", required: true },
                ],
            }],
        ...(model ? { model } : {}),
    };
}
const field = {
    type: "object",
    properties: {
        name: { type: "string", enum: [...SETUP_FIELD_NAMES] }, env: { type: "string" }, aliases: { type: "array", items: { type: "string" }, description: "Older names this server reads before env: a client writing env removes these, or the old value wins." },
        label: { type: "string" }, hint: { type: "string" }, required: { type: "boolean" }, transform: { type: "string", enum: ["uppercase"] },
        choices: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] } },
        fromSerial: { type: "object", properties: { prefixLength: { type: "integer" }, models: { type: "object", additionalProperties: { type: "string" } } }, required: ["prefixLength", "models"] },
    },
    required: ["name", "env", "label", "required"],
};
export const SETUP_FIELDS_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        contract: { type: "string", const: COUNTERPART_CONTRACT },
        server: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, required: ["name", "version"] },
        kinds: { type: "array", items: { type: "object", properties: {
                    kind: { type: "string", enum: [...PRINTER_KINDS] }, label: { type: "string" },
                    env: { type: "object", additionalProperties: { type: "string" } }, fields: { type: "array", items: field },
                }, required: ["kind", "label", "env", "fields"] } },
        model: { type: "string" },
    },
    required: ["contract", "server", "kinds"],
};
