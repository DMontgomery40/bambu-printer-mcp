import assert from "node:assert/strict";
import { BlenderMcpBridge } from "../../dist/blender-mcp-bridge.js";

// A preview validates the real STL without starting a Blender process.
process.env.BLENDER_MCP_COMMAND = "/never-start-blender-during-validation";
const [input, output, expected] = process.argv.slice(2);
const preview = new BlenderMcpBridge().edit({
  stl_path: input, output_path: output, operations: ["decimate:0.5"], execute: false,
});
if (expected === "invalid") {
  await assert.rejects(preview, /STL contains no valid finite triangle mesh/);
} else {
  assert.equal((await preview).status, "prepared");
}
console.log("validated");
