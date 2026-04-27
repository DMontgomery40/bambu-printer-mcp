import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { flattenForCli, detectProfilesRoot } from "../../dist/slicer/profile-flatten.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

/* --- Synthetic profile tree helpers -------------------------------------- */

async function makeSyntheticTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flatten-test-"));
  const bbl = path.join(root, "BBL");
  for (const sub of ["machine", "process", "filament"]) {
    await fs.mkdir(path.join(bbl, sub), { recursive: true });
  }
  return { root, bbl };
}

async function writeProfile(dir, kind, data) {
  const p = path.join(dir, kind, `${data.name}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
  return p;
}

/* --- Tests --------------------------------------------------------------- */

test("flattenForCli rejects non-BBL vendor explicitly", async () => {
  const { root } = await makeSyntheticTree();
  await assert.rejects(
    flattenForCli({
      machineLeaf: "x",
      processLeaf: "y",
      filamentLeaves: ["z"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
      vendor: "Voron",
    }),
    /only BBL vendor is supported/i
  );
});

test("flattenForCli errors clearly when profilesRoot is wrong", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "empty-"));
  await assert.rejects(
    flattenForCli({
      machineLeaf: "x",
      processLeaf: "y",
      filamentLeaves: ["z"],
      profilesRoot: empty,
      tempDir: os.tmpdir(),
    }),
    /does not contain "BBL\/machine"/
  );
});

test("inherits chain: child wins on key collision, root parent fills the rest", async () => {
  const { root, bbl } = await makeSyntheticTree();

  // Three-level chain: leaf -> mid -> root.
  await writeProfile(bbl, "machine", {
    name: "root_common",
    inherits: null,
    instantiation: "false",
    nozzle_diameter: ["0.4"],
    extruder_type: ["Direct Drive"],
    default_nozzle_volume_type: ["Standard"],
    only_in_root: "yes",
  });
  await writeProfile(bbl, "machine", {
    name: "mid_common",
    inherits: "root_common",
    instantiation: "false",
    only_in_mid: "mid_value",
    nozzle_diameter: ["0.4"], // identical -- merge no-op
  });
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: "mid_common",
    instantiation: "true",
    printer_model: "Bambu Lab TEST",
    printer_settings_id: "Bambu Lab TEST 0.4 nozzle",
    only_in_leaf: "leaf_value",
    extruder_type: ["Bowden"], // child wins
  });

  // Minimal process + filament so flattenForCli completes.
  await writeProfile(bbl, "process", {
    name: "0.20mm @TEST",
    inherits: null,
    layer_height: 0.2,
  });
  await writeProfile(bbl, "filament", {
    name: "PLA @TEST",
    inherits: null,
    filament_type: ["PLA"],
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-out-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PLA @TEST"],
    profilesRoot: root,
    tempDir,
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // Inheritance merging
  assert.equal(flat.only_in_root, "yes", "root key inherited");
  assert.equal(flat.only_in_mid, "mid_value", "mid key inherited");
  assert.equal(flat.only_in_leaf, "leaf_value", "leaf key kept");
  assert.deepEqual(flat.extruder_type, ["Bowden"], "child wins on collision");

  // GUI-only keys stripped (instantiation, setting_id) but inherits is
  // kept and rewritten to the leaf name -- the CLI's compat check uses
  // it as the system_name when from=="User".
  assert.equal(flat.inherits, "Bambu Lab TEST 0.4 nozzle", "inherits rewritten to leaf name");
  assert.ok(!("instantiation" in flat), "instantiation stripped");
  assert.equal(flat.from, "User", "from rewritten to User for CLI");
  assert.equal(flat.printer_settings_id, "Bambu Lab TEST 0.4 nozzle");

  // nozzle_volume_type derived as array from default_nozzle_volume_type
  assert.deepEqual(flat.nozzle_volume_type, ["Standard"]);
});

test("inherits cycle is detected and reported", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "A",
    inherits: "B",
    nozzle_diameter: ["0.4"],
  });
  await writeProfile(bbl, "machine", {
    name: "B",
    inherits: "A",
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "A",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /inheritance cycle detected/i
  );
});

test("missing parent name produces a useful error", async () => {
  const { root, bbl } = await makeSyntheticTree();
  await writeProfile(bbl, "machine", {
    name: "leaf",
    inherits: "ghost_parent",
    nozzle_diameter: ["0.4"],
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "leaf",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /Profile "ghost_parent" not found/
  );
});

test("nozzleVolumeType override produces matching-length array", async () => {
  const { root, bbl } = await makeSyntheticTree();

  // Dual-nozzle synthetic machine.
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TESTDUAL 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4", "0.4"],
    extruder_type: ["Direct Drive", "Direct Drive"],
    default_nozzle_volume_type: ["Standard", "Standard"],
    printer_model: "Bambu Lab TESTDUAL",
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-out-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TESTDUAL 0.4 nozzle",
    processLeaf: "p",
    filamentLeaves: ["f"],
    profilesRoot: root,
    tempDir,
    nozzleVolumeType: "High Flow",
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));
  assert.deepEqual(flat.nozzle_volume_type, ["High Flow", "High Flow"]);
});

test("bedType override stamps the flattened process profile", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4"],
    default_nozzle_volume_type: ["Standard"],
  });
  await writeProfile(bbl, "process", {
    name: "0.20mm @TEST",
    inherits: null,
    curr_bed_type: "Cool Plate",
  });
  await writeProfile(bbl, "filament", { name: "PETG @TEST", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-bed-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PETG @TEST"],
    profilesRoot: root,
    tempDir,
    bedType: "Textured PEI Plate",
  });

  const process = JSON.parse(await fs.readFile(result.processPath, "utf8"));
  assert.equal(process.curr_bed_type, "Textured PEI Plate");
});

test("machine-model bed metadata is copied onto flattened machine profile", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST",
    inherits: null,
    type: "machine_model",
    default_bed_type: "Textured PEI Plate",
    image_bed_type: "o",
    not_support_bed_type: "Cool Plate",
  });
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4"],
    default_nozzle_volume_type: ["Standard"],
    printer_model: "Bambu Lab TEST",
  });
  await writeProfile(bbl, "process", { name: "0.20mm @TEST", inherits: null });
  await writeProfile(bbl, "filament", { name: "PETG @TEST", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-bed-meta-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PETG @TEST"],
    profilesRoot: root,
    tempDir,
  });

  const machine = JSON.parse(await fs.readFile(result.machinePath, "utf8"));
  assert.equal(machine.default_bed_type, "Textured PEI Plate");
  assert.equal(machine.image_bed_type, "o");
  assert.equal(machine.not_support_bed_type, "Cool Plate");
});

test("mismatched nozzle_volume_type entries throw (hardware invariant)", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "bad",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4", "0.4"],
    nozzle_volume_type: ["Standard", "High Flow"], // illegal: must match
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "bad",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /must all match.*hardware invariant/i
  );
});

test("end-to-end against real BBL tree: H2S 0.4 nozzle flattens to a populated profile", async (t) => {
  const profilesRoot = detectProfilesRoot();
  // Skip if the BambuStudio install isn't present on this machine.
  try {
    await fs.access(path.join(profilesRoot, "BBL", "machine"));
  } catch {
    t.skip("BambuStudio profiles tree not present on this machine");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-h2s-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab H2S 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL H2S",
    filamentLeaves: ["Bambu PLA Basic @BBL H2S"],
    profilesRoot,
    tempDir,
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // Critical keys the CLI asserts on must be present and well-formed.
  assert.ok(Array.isArray(flat.nozzle_volume_type), "nozzle_volume_type must be an array");
  assert.ok(flat.nozzle_volume_type.length >= 1);
  assert.ok(typeof flat.nozzle_volume_type[0] === "string");
  assert.equal(
    flat.inherits,
    "Bambu Lab H2S 0.4 nozzle",
    "inherits should be rewritten to leaf name for CLI compat check"
  );

  // Sanity: should be richer than the leaf alone (~69 keys). After full
  // inheritance + cli overlay merge we expect well above 100.
  const keyCount = Object.keys(flat).length;
  assert.ok(
    keyCount > 100,
    `flattened machine profile should have >100 keys after inherits walk; got ${keyCount}`
  );
});

test("end-to-end: H2D matches GUI-sliced ground-truth shape for nozzle_volume_type", async (t) => {
  const profilesRoot = detectProfilesRoot();
  try {
    await fs.access(path.join(profilesRoot, "BBL", "machine"));
  } catch {
    t.skip("BambuStudio profiles tree not present on this machine");
    return;
  }

  const groundTruthPath = path.join(FIXTURES, "h2d_gui_sliced", "project_settings.config");
  let groundTruth;
  try {
    groundTruth = JSON.parse(await fs.readFile(groundTruthPath, "utf8"));
  } catch {
    t.skip("H2D ground-truth fixture not present");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-h2d-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab H2D 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL H2D",
    filamentLeaves: ["Bambu PETG HF @BBL H2D 0.4 nozzle"],
    profilesRoot,
    tempDir,
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // GUI ground truth has nozzle_volume_type length 2 (dual-nozzle).
  assert.ok(Array.isArray(flat.nozzle_volume_type));
  assert.equal(
    flat.nozzle_volume_type.length,
    groundTruth.nozzle_volume_type.length,
    "nozzle_volume_type length must match GUI output"
  );

  // Both entries identical (hardware invariant).
  assert.equal(
    new Set(flat.nozzle_volume_type).size,
    1,
    "all nozzles must have matching flow type"
  );

  // printer_model must agree.
  assert.equal(flat.printer_model, "Bambu Lab H2D");
});
