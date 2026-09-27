import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/blender-stl-validation.mjs", import.meta.url));

function binaryStl(filePath, triangles) {
  const header = Buffer.alloc(84);
  header.writeUInt32LE(triangles, 80);
  const triangle = Buffer.alloc(50);
  triangle.writeFloatLE(1, 8); // Normal and a nondegenerate triangle.
  triangle.writeFloatLE(1, 24);
  triangle.writeFloatLE(1, 40);
  const chunkTriangles = 20_000;
  const chunk = Buffer.alloc(50 * chunkTriangles);
  for (let offset = 0; offset < chunk.length; offset += 50) triangle.copy(chunk, offset);
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, header);
    for (let remaining = triangles; remaining > 0; remaining -= chunkTriangles) {
      fs.writeSync(fd, chunk, 0, Math.min(remaining, chunkTriangles) * 50);
    }
  } finally { fs.closeSync(fd); }
}

async function validate(input, output, expected = "valid") {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--max-old-space-size=64", fixture, input, output, expected], {
      timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(stdout.trim(), "validated");
  } catch (error) {
    assert.fail(`STL validation subprocess failed (${error.code ?? error.signal}): ${String(error.stderr ?? error.message).slice(0, 1500)}`);
  }
}

test("Blender validates a large binary STL within a 64 MiB Node heap", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-blender-memory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "large.stl");
  // 6.75 million coordinates: boxing them exceeds this heap; typed arrays fit.
  binaryStl(input, 750_000);
  assert.equal(fs.statSync(input).size, 37_500_084);
  await validate(input, path.join(directory, "output.stl"));
  assert.equal(fs.existsSync(path.join(directory, "output.stl")), false);
});

test("Blender rejects non-finite coordinates at the end of a binary STL", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-blender-finite-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const value of [NaN, Infinity, -Infinity]) {
    const input = path.join(directory, `${String(value)}.stl`);
    binaryStl(input, 3);
    const fd = fs.openSync(input, "r+");
    try {
      const coordinate = Buffer.alloc(4);
      coordinate.writeFloatLE(value);
      fs.writeSync(fd, coordinate, 0, 4, 84 + 2 * 50 + 44);
    } finally { fs.closeSync(fd); }
    await validate(input, path.join(directory, "output.stl"), "invalid");
  }
});
