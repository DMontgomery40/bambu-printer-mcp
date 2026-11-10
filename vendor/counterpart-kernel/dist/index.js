/** Public entry point: the script API, intent-level features, requirements and the runner. */
export * from "./api.js";
export * from "./intent.js";
export { decideFit, FUNCTION_RULES, SOURCE_UNCERTAINTY, PRINT_CORRECTION, FEEDBACK_CHOICES } from "./fit.js";
export { sectionFits, holeIs, thicknessIs, gapIs, minWall, printable } from "./checks.js";
export { runScript, meshPart, summarize } from "./runner.js";
export { holder, rack, bracket, spacer, shim, plate, clip, screwHole, derived } from "./family.js";
export { facts } from "./facts.js";
export { partRecord } from "./record.js";
export { prove } from "./prove.js";
export { sectionAt, fitCylinderZ, widthProfile, widestAndWaist } from "./scan.js";
export { scanBoolean, subtractFromScan, unionWithScan, intersectScan } from "./scanbool.js";
export { fingerBore, cradle, snapArm, strainLadder, designFingers, designCradle, designSnap, sector, STRAIN } from "./compliant.js";
export { ladderXY, ladderZ, testPin, ribBore, holeGauge, keyPin, slitGauge, keyStrip, bumps, notches } from "./coupons.js";
export { scanEnvelope, scanPocket, scanSizes, loadMesh, MeshSolid } from "./scanfit.js";
export { sprungHolder, hook, adapter, knob } from "./family3.js";
export { readSTL, writeSTL } from "./kernel/io.js";
