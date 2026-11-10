import {trackedMkdtemp} from './support/temp.mjs';
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

// A 30 x 20 x 2 plate must rest on a 600 mm² face, regardless of its
// starting orientation. Excluding Z-aligned normals stands it on an edge.
for (const [name, rotation] of [
  ["horizontal", [0, 0, 0]],
  ["upside down", [Math.PI, 0, 0]],
  ["on its edge", [Math.PI / 2, 0, 0]],
  ["tilted", [0.4, 0.7, 0.2]],
]) {
  test(`lay_flat rests the ${name} plate on its largest face at Z=0`, async (t) => {
    const directory = await trackedMkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const geometry = new THREE.BoxGeometry(30, 20, 2);
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(13, -7, 42);
    const original = new STLExporter().parse(new THREE.Mesh(geometry));
    geometry.dispose();
    const input = path.join(directory, "plate.stl");
    await fs.writeFile(input, original);
    const manipulator = new STLManipulator(directory);

    const output = await manipulator.layFlat(input);
    const info = await manipulator.getSTLInfo(output);
    assert.ok(Math.abs(info.boundingBox.dimensions.z - 2) < 0.0001,
      `plate height should be 2 mm, got ${info.boundingBox.dimensions.z}`);
    assert.ok(Math.abs(info.boundingBox.min.z) < 0.0001,
      `plate should touch Z=0, got ${info.boundingBox.min.z}`);
    assert.equal(info.faceCount, 12);
    assert.notEqual(output, input);
    assert.equal(await fs.readFile(input, "utf8"), original, "input must remain unchanged");

    // Laying an already flattened output down again must not stand it up.
    const repeated = await manipulator.layFlat(output);
    const repeatedInfo = await manipulator.getSTLInfo(repeated);
    assert.ok(Math.abs(repeatedInfo.boundingBox.dimensions.z - 2) < 0.0001);
    assert.ok(Math.abs(repeatedInfo.boundingBox.min.z) < 0.0001);
    assert.notEqual(repeated, output);
  });
}

// A plate with a raised block has equal up- and down-facing areas, because
// faces are grouped by direction. A seated part must stay seated whichever
// order its faces appear in, instead of flipping onto the block.
for (const order of ["plate first", "block first"]) {
  test(`lay_flat keeps a seated plate with a raised block upright (${order})`, async (t) => {
    const directory = await trackedMkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const plate = new THREE.BoxGeometry(30, 20, 2).translate(0, 0, 1);
    const block = new THREE.BoxGeometry(10, 5, 1).translate(0, 0, 2.5);
    const geometry = mergeGeometries(order === "plate first" ? [plate, block] : [block, plate]);
    const input = path.join(directory, "embossed.stl");
    await fs.writeFile(input, new STLExporter().parse(new THREE.Mesh(geometry)));
    const manipulator = new STLManipulator(directory);

    const output = await manipulator.layFlat(input);
    const positions = new STLLoader().parse((await fs.readFile(output)).buffer).getAttribute("position");
    const top = [];
    let minZ = Infinity;
    for (let index = 0; index < positions.count; index++) minZ = Math.min(minZ, positions.getZ(index));
    for (let index = 0; index < positions.count; index++) {
      if (Math.abs(positions.getZ(index) - (minZ + 3)) < 0.0001) top.push(positions.getX(index));
    }
    assert.ok(Math.abs(minZ) < 0.0001, `part should touch Z=0, got ${minZ}`);
    assert.ok(top.length > 0, "part should be 3 mm tall");
    assert.ok(Math.max(...top) - Math.min(...top) < 10.0001, "the 10 mm block, not the 30 mm plate, should be on top");
  });
}

function readPositions(buffer) {
  return new STLLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)).getAttribute("position");
}

// Bed contact computed from the output vertices: the area of faces whose
// three corners all lie within `tolerance` of the lowest Z.
function bedContact(positions, tolerance) {
  let minZ = Infinity, maxZ = -Infinity;
  for (let index = 0; index < positions.count; index++) {
    minZ = Math.min(minZ, positions.getZ(index));
    maxZ = Math.max(maxZ, positions.getZ(index));
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let contactArea = 0;
  const contactFaces = [];
  for (let index = 0; index < positions.count; index += 3) {
    a.fromBufferAttribute(positions, index);
    b.fromBufferAttribute(positions, index + 1);
    c.fromBufferAttribute(positions, index + 2);
    if (Math.max(a.z, b.z, c.z) - minZ > tolerance) continue;
    contactArea += new THREE.Triangle(a, b, c).getArea();
    contactFaces.push(index / 3);
  }
  return { minZ, maxZ, contactArea, contactFaces };
}

async function layFlatShape(t, name, geometry) {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, `${name}.stl`);
  await fs.writeFile(input, new STLExporter().parse(new THREE.Mesh(geometry)));
  const result = await new STLManipulator(directory).layFlatWithResult(input);
  assert.equal(result.laid_flat, true, result.message);
  return { input, result, positions: readPositions(await fs.readFile(result.path)) };
}

// A profile in the XY plane extruded `depth` along +Z.
function extrude(points, depth) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).toNonIndexed();
}

// David's stove gap filler, as Scan to Make handed it to the printer server.
async function stoveGapFiller(t) {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "clean.stl");
  await fs.writeFile(input, zlib.gunzipSync(await fs.readFile(new URL("./fixtures/stove-gap-filler.stl.gz", import.meta.url))));
  return { directory, input };
}

// The stove gap filler is six T strips in their installed pose: fins down to
// Z=-12, domed caps up to Z=2.4. The cap undersides' 23,838 mm² face down but
// sit 12 mm above the 4,094 mm² of fin tips, so resting on them stood the
// strips on their fins, upside down.
test("lay_flat turns the stove gap filler cap-down instead of standing it on its fins", async (t) => {
  const { directory, input } = await stoveGapFiller(t);
  const result = await new STLManipulator(directory).layFlatWithResult(input);
  assert.equal(result.laid_flat, true, result.message);

  const before = readPositions(await fs.readFile(input));
  const after = readPositions(await fs.readFile(result.path));
  assert.equal(after.count, before.count);
  // The flip keeps the 14.4 mm height and rests the domes within 0.5% of it.
  const { minZ, maxZ, contactArea, contactFaces } = bedContact(after, 0.072);
  assert.ok(Math.abs(minZ) < 1e-4, `the part should touch Z=0, got ${minZ}`);
  assert.ok(Math.abs(maxZ - 14.4) < 1e-3, `the part should stay 14.4 mm tall, got ${maxZ}`);
  assert.ok(contactArea > 4000, `the domed caps should rest on the bed, got ${contactArea} mm²`);
  for (const face of contactFaces) {
    for (let corner = face * 3; corner < face * 3 + 3; corner++) {
      assert.ok(before.getZ(corner) > 2.3, `bed contact must be the cap tops, not Z=${before.getZ(corner)} of the installed part`);
    }
  }
  let finTips = 0;
  for (let index = 0; index < before.count; index++) {
    if (Math.abs(before.getZ(index) + 12) > 1e-4) continue;
    finTips++;
    assert.ok(Math.abs(after.getZ(index) - maxZ) < 1e-3, `fin tips must point up, got Z=${after.getZ(index)}`);
  }
  assert.ok(finTips > 0, "the fixture's fin tips are at Z=-12");
});

// Each shape starts in a pose where the largest face group does not lie on
// the lowest plane. The part must rest on a face with nothing below it.
for (const { name, geometry, minimumContact, wrongContact } of [
  {
    // Upside down: the base on top, the leg hanging down onto its 3 x 20 mm end.
    name: "L-bracket",
    geometry: () => extrude([[0, 0], [60, 0], [60, 3], [3, 3], [3, 60], [0, 60]], 20).rotateX(-Math.PI / 2),
    minimumContact: 1199,
    wrongContact: 60,
  },
  {
    // Installed: stem down, chamfered cap up. The cap underside plus stem tip
    // (800 mm²) outweigh the 400 mm² cap top.
    name: "T",
    geometry: () => extrude([[-2, 0], [2, 0], [2, 26], [20, 26], [20, 27], [10, 30], [-10, 30], [-20, 27], [-20, 26], [-2, 26]], 20).rotateX(Math.PI / 2),
    minimumContact: 399,
    wrongContact: 80,
  },
  {
    // A V-bottomed shelf with a 6 mm tower: the shelf tops make the largest
    // group, but the tower rises 28 mm above them.
    name: "shelf with tower",
    geometry: () => extrude([[-25, 10], [0, 0], [25, 10], [25, 12], [3, 12], [3, 40], [-3, 40], [-3, 12], [-25, 12]], 30).rotateX(Math.PI / 2),
    minimumContact: 500,
    wrongContact: 180,
  },
]) {
  test(`lay_flat rests the ${name} on a face with nothing below it`, async (t) => {
    const { positions } = await layFlatShape(t, name.replaceAll(" ", "-"), geometry());
    const { minZ, contactArea } = bedContact(positions, 1e-3);
    assert.ok(Math.abs(minZ) < 1e-4, `the part should touch Z=0, got ${minZ}`);
    assert.ok(contactArea >= minimumContact, `expected at least ${minimumContact} mm² on the bed, got ${contactArea} (the wrong face gives ${wrongContact})`);
  });
}

test("lay_flat leaves a model unchanged and says so when no face can rest on the bed", async (t) => {
  // Two interpenetrating tetrahedra: every face has the other's tip beyond
  // its plane, and each axis-aligned lowest plane holds only two corners.
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tetrahedron = new THREE.TetrahedronGeometry(10);
  const geometry = mergeGeometries([tetrahedron, tetrahedron.clone().rotateZ(Math.PI / 2)]);
  const input = path.join(directory, "stella.stl");
  const original = new STLExporter().parse(new THREE.Mesh(geometry));
  await fs.writeFile(input, original);

  const result = await new STLManipulator(directory).layFlatWithResult(input);
  assert.equal(result.laid_flat, false);
  assert.equal(result.path, input);
  assert.match(result.message, /unchanged/);
  assert.equal(await fs.readFile(input, "utf8"), original, "input must remain unchanged");
});

// Acceptance on the real slicer: Bambu Studio warned "floating cantilever"
// for the fin-down pose. Skips where Studio is not installed, as in CI.
const studioCli = process.env.BAMBU_STUDIO_CLI || "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
test("Bambu Studio slices the laid-flat stove gap filler for a P1S with no warning", {
  skip: !existsSync(studioCli) && "Bambu Studio is not installed",
  timeout: 600_000,
}, async (t) => {
  const { directory, input } = await stoveGapFiller(t);
  const manipulator = new STLManipulator(directory);
  const flat = await manipulator.layFlat(input);

  const slice = await manipulator.sliceSTLWithResult(flat, "bambustudio", studioCli, undefined, undefined, "Bambu Lab P1S 0.4 nozzle", { bedType: "textured_plate" });
  const result = slice.slicer_result;
  assert.ok(result, "Bambu Studio should return its result.json for this slice");
  assert.equal(result.return_code, 0, result.error_string);
  assert.ok(result.sliced_plates.length > 0);
  for (const plate of result.sliced_plates) assert.equal(plate.warning_message, "", plate.warning_message);
});
