import assert from "node:assert/strict";
import test from "node:test";
import { plainSlicerError, UNKNOWN_SLICER_ERROR } from "../dist/slicer/slicer-messages.js";
import { slicerReport } from "../dist/counterpart/sliced-file.js";

// The slicers' own strings (Bambu Studio 02.09 and OrcaSlicer binaries, PrusaSlicer 2.9.2 and CuraEngine source).
test("slicer refusals map to plain sentences, and unknown words to a plain fallback", () => {
  const empty = plainSlicerError("One of the plate is empty or has no object fully inside it. Please check that the 3mf contains no empty plate in Bambu Studio before uploading.");
  assert.match(empty, /^Nothing on this plate can be printed/);
  for (const words of [
    "Cannot send the print job for empty plate",
    ": Nothing to be sliced, Either the print is empty or no object is fully inside the print volume before apply.",
    "Found no objects in print volume to slice.",
    "All objects are outside of the print volume.",
    "Nothing to print for a.gcode . Either the print is empty or no object is fully inside the print volume.",
  ]) assert.equal(plainSlicerError(words), empty, words);
  const off = plainSlicerError("An object is laid over the boundary of plate or exceeds the height limit.");
  assert.match(off, /across the edge of the plate/);
  assert.equal(plainSlicerError("Following objects are laid over the boundary of plate or exceeds the height limit:\nPart 1"), off);
  assert.equal(plainSlicerError("An object is laid over the plate boundaries."), off);
  assert.match(plainSlicerError("Object too large"), /larger than the printer's bed/);
  assert.match(plainSlicerError("The object exceeds the maximum build volume height."), /taller than the printer can print/);
  assert.match(plainSlicerError("Found G-code outside of the printable area. The issue may be caused by support, wipe tower, brim, or skirt."), /outside the area the printer can reach/);
  assert.match(plainSlicerError("[warning] Stopping process because there are no non-empty layers."), /would print nothing/);
  assert.match(plainSlicerError("The supplied settings will cause an empty print."), /would print nothing/);
  assert.equal(plainSlicerError("Failed slicing the model."), undefined);
  // slicer_report: the sentence for the person, the slicer's words for the log.
  const words = "One of the plate is empty or has no object fully inside it. Please check that the 3mf contains no empty plate in Bambu Studio before uploading.";
  assert.deepEqual(slicerReport({ return_code: -50, error_string: words, sliced_plates: [] }), { failed: true, message: empty, slicer_message: words });
  assert.deepEqual(slicerReport({ return_code: -100, error_string: "Failed slicing the model." }), { failed: true, message: UNKNOWN_SLICER_ERROR, slicer_message: "Failed slicing the model." });
  assert.deepEqual(slicerReport({ return_code: -100 }), { failed: true, message: UNKNOWN_SLICER_ERROR, slicer_message: "return code -100" });
});
