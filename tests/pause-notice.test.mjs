import test from "node:test";
import assert from "node:assert/strict";
import { isPauseNotice, PAUSE_NOTICE } from "../dist/safety/printer-state.js";

test("a paused job's own pause notice does not block Resume, and nothing else is excused", () => {
  assert.equal(isPauseNotice({ gcode_state: "PAUSE", print_error: PAUSE_NOTICE }, false), true);
  assert.equal(isPauseNotice({ gcode_state: "PAUSE", print_error: "50364435" }, false), true);
  assert.equal(isPauseNotice({ gcode_state: "PAUSE", print_error: PAUSE_NOTICE }, true), false, "starting a new job still needs no error");
  assert.equal(isPauseNotice({ gcode_state: "RUNNING", print_error: PAUSE_NOTICE }, false), false);
  assert.equal(isPauseNotice({ gcode_state: "PAUSE", print_error: 0x0300400c }, false), false, "a filament or hardware pause is still an error");
});
