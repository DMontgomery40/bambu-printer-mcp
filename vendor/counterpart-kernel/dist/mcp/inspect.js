/**
 * The printer MCP's trusted inspection of a counterpart-kernel export (no user code runs here): reads the STL the run
 * wrote, measures it and renders the six views and a contact sheet, in the shape cad_run returns for build123d.
 *   node dist/mcp/inspect.js PART.stl OUT_DIR NAME
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readSTL } from "../kernel/io.js";
import { checkMesh } from "../kernel/mesh.js";
import { renderSheet, VIEWS } from "../kernel/render.js";
export function inspectSTL(stl, outDir, name) {
    const m = readSTL(readFileSync(stl));
    const c = checkMesh(m);
    const folder = join(outDir, `${name}.renders`);
    mkdirSync(folder, { recursive: true });
    const { views, sheet } = renderSheet(m);
    const renders = {};
    for (const v of VIEWS) {
        const f = join(folder, `${v}.png`);
        writeFileSync(f, views[v]);
        renders[v] = f;
    }
    renders.contact = join(folder, "contact.png");
    writeFileSync(renders.contact, sheet);
    const checks = { watertight: c.closed, winding_consistent: c.consistentWinding, positive_volume: c.closed && c.outward && c.volume > 0, manifold: c.manifold, step_valid: null, stl_step_bounds_agree: null };
    return {
        valid: Object.values(checks).every((v) => v === null || v === true), units: "mm",
        bounds_mm: [c.bounds.min, c.bounds.max], size_mm: c.bounds.max.map((v, i) => v - c.bounds.min[i]),
        volume_mm3: checks.positive_volume ? c.volume : null, step_volume_mm3: null,
        solid_count: c.components, mesh_components: c.components, checks, renders,
    };
}
if (process.argv[1]?.endsWith(join("mcp", "inspect.js"))) {
    const [stl, out, name] = process.argv.slice(2);
    process.stdout.write(JSON.stringify(inspectSTL(stl, out, name)));
}
