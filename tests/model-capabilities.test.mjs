import assert from "node:assert/strict";
import test from "node:test";
import { usesRootFtpPrintPath } from "../dist/printers/model-capabilities.js";

test("legacy X1/P1/A1 use sdcard path", () => {
  for (const model of ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini"]) {
    assert.equal(usesRootFtpPrintPath(model), false);
  }
  assert.equal(usesRootFtpPrintPath(undefined, "01P00A123"), false);
});

test("P2/H2/X2 use root FTP path", () => {
  for (const model of ["p2s", "h2d", "h2s", "h2c", "x2d"]) {
    assert.equal(usesRootFtpPrintPath(model), true);
  }
  assert.equal(usesRootFtpPrintPath(undefined, "22E8AJ631603724"), true);
  assert.equal(usesRootFtpPrintPath(undefined, "0938TEST"), true);
  assert.equal(usesRootFtpPrintPath(undefined, "20PTEST"), true);
});
