import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { colourDistance, matchColours, proposeFilaments, loadColourNames, bambuTrayLabel, spoolName, PROPOSE_FILAMENTS_OUTPUT_SCHEMA } from "../dist/counterpart/filaments.js";
import { parseBambuAdvert, modelFromSerial, modelFromDevModel, DISCOVER_OUTPUT_SCHEMA } from "../dist/counterpart/discovery.js";
import { bambuSetupFields, SETUP_FIELDS_OUTPUT_SCHEMA } from "../dist/counterpart/setup.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = new AjvJsonSchemaValidator();
const validate = (schema, value) => { const result = validator.getValidator(schema)(value); assert.ok(result.valid, result.errorMessage); return value; };
const tray = (slot, colour, material, extra = {}) => ({ slot, label: `S${slot}`, name: `${material} spool`, colour, material, filamentId: "GFA00", feed: slot >= 254 ? "external" : "ams", sliceable: true, ...extra });
// PETG black, PLA Bambu yellow, external PLA white: the trays the companion's colour tests used.
const TRAYS = [tray(0, "#000000", "PETG"), tray(1, "#FEC600", "PLA"), tray(254, "#FFFFFF", "PLA")];

test("OKLab distance: identical is zero, black to white is about one, near colours are near", () => {
  assert.equal(colourDistance("#FEC600", "#FEC600"), 0);
  const blackWhite = colourDistance("#000000", "#FFFFFF");
  assert.ok(blackWhite > 0.9 && blackWhite < 1.1, `black-white ${blackWhite}`);
  assert.ok(colourDistance("#FFD200", "#FEC600") < 0.1);
  assert.ok(colourDistance("#FFD200", "#0000FF") > 0.5);
  assert.equal(colourDistance("#fec600ff", "#FEC600"), 0);
});

test("matching keeps the companion's behaviour: nearest spool, shared colours, material preference and the one-feed rule", () => {
  const pick = matchColours([{ colour: "#111111" }, { colour: "#FFD200" }], TRAYS);
  assert.deepEqual(pick.map(match => match.slot), [0, 1]);
  assert.deepEqual(matchColours([{ colour: "#FEFEFE" }, { colour: "#FFFFFF" }], TRAYS).map(m => m.slot), [254, 254]);
  const [black] = matchColours([{ colour: "#000000", material: "PLA" }], TRAYS);
  assert.equal(black.slot, 0); assert.equal(black.materialMismatch, true);
  const [same] = matchColours([{ colour: "#000000", material: "PLA" }], [tray(0, "#000000", "PETG"), tray(2, "#010101", "PLA")]);
  assert.equal(same.slot, 2);
  const guesses = matchColours([{ material: "PLA" }, {}], TRAYS);
  assert.equal(guesses[0].slot, 1); assert.equal(guesses[0].guessed, true); assert.notEqual(guesses[1].slot, guesses[0].slot);
  assert.deepEqual(matchColours([{ colour: "#000000" }, {}], []), [undefined, undefined]);
  const [sliced] = matchColours([{ colour: "#000000", material: "PLA" }], TRAYS, { requireMaterial: true });
  assert.notEqual(sliced.slot, 0);
  assert.deepEqual(matchColours([{ colour: "#000000", material: "ASA" }], TRAYS, { requireMaterial: true }), [undefined]);
  assert.deepEqual(matchColours([{ colour: "#000000" }, { colour: "#404040" }], [tray(0, "#101010", "PLA"), tray(1, "#202020", "PLA")]).map(m => m.slot), [0, 1]);
  const mixed = matchColours([{ colour: "#111111" }, { colour: "#FFFFFF" }], TRAYS).map(m => m.slot);
  assert.deepEqual(mixed, [0, 1], "white follows the nearest AMS spool rather than the external one");
  assert.deepEqual(matchColours([{ colour: "#111111" }], [TRAYS[2]]).map(m => m.slot), [254]);
  assert.equal(matchColours([{ colour: "yellow" }], TRAYS)[0].guessed, true);
});

// The live AMS on the P1S and the caliper card's filaments, read from the Mac companion on 2026-11-05.
const P1S = [
  tray(0, "#000000", "PLA", { label: "A1", name: "Black PLA Basic" }), tray(1, "#FEC600", "PLA", { label: "A2", name: "Sunflower Yellow PLA Basic" }),
  tray(2, "#77EDD7", "PETG", { label: "A3", name: "Translucent Teal PETG Translucent", filamentId: "GFG01" }), tray(3, "#5B6579", "PLA", { label: "A4", name: "Blue Gray PLA Basic" }),
];
const names = { spool: () => undefined, colour: hex => ({ "#FFFFFF": "White", "#000000": "Black" })[hex.toUpperCase()] };

test("the caliper card: white isn't loaded, and the proposal says so instead of quietly printing yellow", () => {
  const result = validate(PROPOSE_FILAMENTS_OUTPUT_SCHEMA, proposeFilaments({ trays: P1S, names, filaments: [
    { index: 1, name: "VERNIER-METRIC-BICOLOR-2.STEP", colour: "#000000", material: "PLA" }, { index: 2, colour: "#000000", material: "PLA" },
    { index: 3, colour: "#FFFFFF", material: "PLA" }, { index: 4, colour: "#2850E0", material: "PETG" }, { index: 5, colour: "#2850E0", material: "PETG" }] }));
  assert.deepEqual(result.proposal.map(row => [row.index, row.slot, row.verdict]),
    [[1, 0, "same-colour"], [2, 0, "same-colour"], [3, 1, "closest"], [4, 3, "closest"], [5, 3, "closest"]]);
  assert.equal(result.proposal[2].note, "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.");
  assert.match(result.proposal[3].note, /^#2850E0 isn’t loaded\. Closest loaded: A4 Blue Gray PLA Basic\. Prints in PLA, not PETG\.$/);
  assert.equal(result.proposal[0].note, undefined);
  assert.deepEqual(result.mapping, [1, 2, 3, 4, 5].map((index, i) => ({ index, slot: [0, 0, 1, 3, 3][i] })));
  assert.deepEqual(result.problems, []);
});

test("the accepted guitar pick (black body, yellow letters) maps exactly as on Nov 4", () => {
  const result = proposeFilaments({ trays: P1S, names, filaments: [{ index: 1, name: "body", colour: "#000000", material: "PLA" }, { index: 2, name: "letters", colour: "#FEC600", material: "PLA" }] });
  assert.deepEqual(result.proposal.map(row => [row.slot, row.verdict, row.distance]), [[0, "same-colour", 0], [1, "same-colour", 0]]);
  assert.deepEqual(result.mapping, [{ index: 1, slot: 0 }, { index: 2, slot: 1 }]);
});

test("the person's choices are checked against what's loaded now, and painted slots follow the chosen feed", () => {
  const filaments = [{ index: 1, colour: "#000000", material: "PLA" }, { index: 2, colour: "#FEC600", material: "PLA" }];
  const ok = proposeFilaments({ trays: P1S, filaments, painted: [{ index: 3, colour: "#5B6579" }, { index: 4 }], chosen: [{ index: 1, slot: 3 }, { index: 2, slot: 1, colour: "#FEC600", material: "PLA", filamentId: "GFA00" }] });
  assert.deepEqual(ok.mapping, [{ index: 1, slot: 3 }, { index: 2, slot: 1 }, { index: 3, slot: 3 }, { index: 4, slot: 0 }]);
  const changed = proposeFilaments({ trays: P1S, filaments, chosen: [{ index: 1, slot: 0 }, { index: 2, slot: 1, colour: "#FFFFFF" }] });
  assert.deepEqual(changed.problems.map(problem => problem.code), ["spool-changed"]); assert.equal(changed.mapping, undefined);
  assert.equal(proposeFilaments({ trays: P1S, filaments, chosen: [{ index: 1, slot: 0 }] }).problems[0].code, "choices-incomplete");
  assert.deepEqual(proposeFilaments({ trays: P1S, filaments, chosen: [{ index: 1, slot: 0, material: "pla" }, { index: 2, slot: 1, colour: "#fec600" }] }).problems, [], "case is not a change of spool");
  const sliced = proposeFilaments({ trays: P1S, filaments, sliced: true, chosen: [{ index: 1, slot: 2 }, { index: 2, slot: 1 }] });
  assert.equal(sliced.problems[0].code, "sliced-material");
  const mixed = proposeFilaments({ trays: [...P1S, tray(254, "#FFFFFF", "PLA", { label: "External", name: "PLA" })], filaments, chosen: [{ index: 1, slot: 0 }, { index: 2, slot: 254 }] });
  assert.equal(mixed.problems[0].code, "mixed-feeds");
  const unsliceable = proposeFilaments({ trays: [{ ...P1S[0], sliceable: false }, P1S[1]], filaments, chosen: [{ index: 1, slot: 0 }, { index: 2, slot: 1 }] });
  assert.equal(unsliceable.problems[0].code, "no-profile");
  assert.deepEqual(unsliceable.trays.map(item => item.slot), [1], "an unsliced model only offers spools that can slice it");
  const paintedSliced = proposeFilaments({ trays: P1S, filaments, sliced: true, painted: [{ index: 3, material: "ASA" }, { index: 4, material: "ASA", prints: false }] });
  assert.deepEqual(paintedSliced.problems.map(problem => [problem.code, problem.index]), [["painted-material", 3]]);
  assert.equal(proposeFilaments({ trays: [], filaments }).problems[0].code, "nothing-loaded");
  assert.equal(proposeFilaments({ trays: P1S, sliced: true, filaments: [{ index: 1, material: "ASA" }] }).problems[0].code, "material-not-loaded");
});

test("spool words: Bambu Studio's colour names, tray labels as Studio prints them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colour-names-"));
  try {
    fs.writeFileSync(path.join(dir, "filaments_color_codes.json"), JSON.stringify({ data: [
      { fila_id: "GFA00", fila_color: ["#FEC600FF"], fila_color_name: { en: "Sunflower Yellow" } },
      { fila_id: "GFA00", fila_color: ["#FFFFFFFF"], fila_color_name: { en: "Jade White" } },
      { fila_id: "GFA05", fila_color: ["#FFFFFFFF"], fila_color_name: { en: "White" } },
      { fila_id: "GFA00", fila_color: ["#9CDBD9FF", "#FFFFFFFF"], fila_color_name: { en: "Arctic Whisper" } },
      { fila_id: "GFG01", fila_color: ["#77EDD780"], fila_color_name: { en: "Translucent Teal" } },
    ] }));
    const loaded = loadColourNames(dir);
    assert.equal(loaded.spool("GFA00", "FEC600"), "Sunflower Yellow");
    assert.equal(loaded.spool("gfa00", "#fec600ff"), "Sunflower Yellow");
    assert.equal(loaded.spool("GFG01", "77EDD780"), "Translucent Teal");
    assert.equal(loaded.colour("#FFFFFF"), "White", "the shortest name for exactly that colour");
    assert.equal(loaded.colour("#9CDBD9"), undefined, "a gradient's colour is not a name");
    assert.equal(loaded.spool("GFA01", "FEC600"), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(loadColourNames(path.join(os.tmpdir(), "no-such-profiles")).spool("GFA00", "000000"), undefined);
  assert.deepEqual([bambuTrayLabel(0, 0), bambuTrayLabel(0, 1), bambuTrayLabel(1, 3), bambuTrayLabel(128, 0)], ["A1", "A2", "B4", "AMS HT A"]);
  assert.equal(spoolName("PLA Basic", "Black"), "Black PLA Basic");
  assert.equal(spoolName("PLA Basic", undefined), "PLA Basic");
});

test("SSDP: only the printer's own announcement, in this server's model names", () => {
  const packet = (location, model = "C12", extra = "") => Buffer.from(`NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nLocation: ${location}\r\nUSN: 01P00A123456789\r\nDevModel.bambu.com: ${model}\r\nDevName.bambu.com: Workshop P1S\r\nDevConnect.bambu.com: lan\r\nDevVersion.bambu.com: 01.08.02.00\r\n${extra}\r\n`);
  assert.deepEqual(parseBambuAdvert(packet("192.168.1.40"), "192.168.1.40"),
    { kind: "bambu", source: "ssdp", host: "192.168.1.40", serial: "01P00A123456789", model: "p1s", name: "Workshop P1S", firmware: "01.08.02.00" });
  assert.equal(parseBambuAdvert(packet("192.168.1.41"), "192.168.1.40"), undefined, "Location must be the sender");
  assert.equal(parseBambuAdvert(packet("8.8.8.8"), "8.8.8.8"), undefined, "private addresses only");
  assert.equal(parseBambuAdvert(packet("192.168.1.40", "C12", "USN: other\r\n"), "192.168.1.40"), undefined, "a repeated header");
  assert.equal(parseBambuAdvert(packet("192.168.1.40", "ZZ9"), "192.168.1.40").model, "p1s", "an unknown DevModel falls back to the serial");
  assert.deepEqual(["N1", "N7", "N2S", "O1E", "BL-P001", "N9"].map(modelFromDevModel), ["a1mini", "p2s", "a1", "h2dpro", "x1c", undefined]);
  assert.deepEqual(["01P00A", "03900A", "03000A", "23900A", "00W00A", undefined].map(modelFromSerial), ["p1s", "a1", "a1mini", "h2dpro", "x1", undefined]);
});

test("setup fields: the .env names this server reads, its model choices, and the model a serial names", () => {
  const models = ["p1s", "p1p", "a1mini", "h2dpro", "x2d"];
  const result = validate(SETUP_FIELDS_OUTPUT_SCHEMA, bambuSetupFields({ server: { name: "bambu-printer-mcp", version: "9" }, models, serial: "01p00a" }));
  assert.equal(result.model, "p1s");
  const [kind] = result.kinds;
  assert.equal(kind.kind, "bambu");
  assert.deepEqual(kind.fields.map(field => [field.name, field.env, field.required]),
    [["host", "PRINTER_HOST", true], ["serial", "BAMBU_SERIAL", true], ["model", "BAMBU_MODEL", true], ["secret", "BAMBU_TOKEN", true]]);
  const model = kind.fields.find(field => field.name === "model");
  assert.deepEqual(model.choices, [{ value: "p1s", label: "P1S" }, { value: "p1p", label: "P1P" }, { value: "a1mini", label: "A1 Mini" }, { value: "h2dpro", label: "H2D Pro" }, { value: "x2d", label: "X2D" }]);
  assert.equal(model.fromSerial.models["01P"], "p1s");
  assert.equal(model.fromSerial.models["039"], undefined, "a model this server lists no choice for is left out");
  assert.equal(bambuSetupFields({ server: { name: "b", version: "1" }, models, serial: "ZZZ" }).model, undefined);
});

test("with no printer configured, the server lists the three tools and answers setup and discovery without a prompt", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "counterpart-setup-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/index.js")], cwd: directory,
    env: { PATH: process.env.PATH ?? "", HOME: directory, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", PRINTER_HOST: "", BAMBU_SERIAL: "", BAMBU_TOKEN: "" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "counterpart-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ["counterpart_discover_printers", "counterpart_setup_fields", "counterpart_propose_filaments"]) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool?.outputSchema, name);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} is read-only`);
  }
  const setup = await client.callTool({ name: "counterpart_setup_fields", arguments: { serial: "01P00C4B2500106" } });
  assert.equal(setup.isError, undefined);
  assert.equal(setup.structuredContent.model, "p1s");
  assert.equal(setup.structuredContent.server.name, "bambu-printer-mcp");
  const found = await client.callTool({ name: "counterpart_discover_printers", arguments: { duration_ms: 500 } });
  validate(DISCOVER_OUTPUT_SCHEMA, found.structuredContent);
  assert.ok(["complete", "unavailable"].includes(found.structuredContent.network));
});

test("each spool carries the filament profile slice_stl takes, so the mapping and its profiles come from one read", () => {
  const result = validate(PROPOSE_FILAMENTS_OUTPUT_SCHEMA, proposeFilaments({ trays: [tray(0, "#000000", "PLA", { profile: "/profiles/Bambu PLA Basic @BBL P1P.json" }), tray(1, "#FEC600", "PLA", { sliceable: false })],
    filaments: [{ index: 1, colour: "#000000", material: "PLA" }] }));
  assert.deepEqual(result.trays.map(item => [item.slot, item.profile]), [[0, "/profiles/Bambu PLA Basic @BBL P1P.json"]]);
  assert.deepEqual(result.mapping, [{ index: 1, slot: 0 }]);
});

test("a colour loaded only on the other feed says where it is instead of 'isn't loaded'", () => {
  const result = proposeFilaments({ trays: [...P1S, tray(254, "#FFFFFF", "PLA", { label: "External", name: "White PLA Basic" })], names,
    filaments: [{ index: 1, colour: "#000000", material: "PLA" }, { index: 2, colour: "#FFFFFF", material: "PLA" }] });
  assert.deepEqual(result.proposal.map(row => row.slot), [0, 1], "the AMS prints both: one print feeds from one source");
  assert.equal(result.proposal[1].note, "White is loaded on External, but one print feeds from one source. Closest here: A2 Sunflower Yellow PLA Basic.");
});

test("a colour that is loaded but not chosen says why, never that it isn't loaded (Codex, PR #110)", () => {
  const near = [tray(0, "#101010", "PLA", { label: "A1", name: "Charcoal PLA" }), tray(1, "#242424", "PLA", { label: "A2", name: "Dark Gray PLA" })];
  const shared = proposeFilaments({ trays: near, filaments: [{ index: 1, colour: "#000000" }, { index: 2, colour: "#101010" }] });
  assert.deepEqual(shared.proposal.map(row => row.slot), [0, 1]);
  assert.equal(shared.proposal[1].note, "#101010 is on A1, which another colour of this model already prints from. Closest other spool: A2 Dark Gray PLA.");
  const material = proposeFilaments({ trays: [tray(0, "#FFFFFF", "PETG", { label: "A1", name: "White PETG" }), tray(1, "#FEC600", "PLA", { label: "A2", name: "Yellow PLA" })],
    names, filaments: [{ index: 1, colour: "#FFFFFF", material: "PLA" }] });
  assert.equal(material.proposal[0].slot, 0, "colour still outweighs a material penalty this large a gap");
  const sliced = proposeFilaments({ trays: [tray(0, "#FFFFFF", "PETG", { label: "A1", name: "White PETG" }), tray(1, "#FEC600", "PLA", { label: "A2", name: "Yellow PLA" })],
    names, sliced: true, filaments: [{ index: 1, colour: "#FFFFFF", material: "PLA" }] });
  assert.equal(sliced.proposal[0].note, "White is loaded on A1 in PETG, not PLA. Closest in PLA: A2 Yellow PLA.");
});
