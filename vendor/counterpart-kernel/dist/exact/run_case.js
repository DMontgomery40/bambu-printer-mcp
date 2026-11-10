/** Child runner for the exact-plane spike: node dist/exact/run_case.js SCRIPT OUTDIR NAME [OVERRIDES] [REBUILD] */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const t0 = performance.now();
const { Part } = await import("./api.js");
const { writeSTL, write3MF } = await import("../kernel/io.js");
const { checkMesh, Mesh } = await import("../kernel/mesh.js");
const tImport = performance.now() - t0;
const [script, out, name, ov, rb] = process.argv.slice(2);
const res = { import_s: tImport / 1000 };
async function once(over, nm) {
    const mod = await import(pathToFileURL(script).href);
    const t = performance.now();
    const r = mod.build({ ...mod.P, ...over });
    const tb = performance.now();
    const parts = (Array.isArray(r) ? r : [r]);
    const meshes = parts.map((p) => p.solid.poly.toMesh());
    const tm = performance.now();
    mkdirSync(out, { recursive: true });
    const merged = Mesh.merge(meshes);
    writeFileSync(join(out, `${nm}.stl`), writeSTL(merged, nm));
    writeFileSync(join(out, `${nm}.3mf`), write3MF(parts.map((p, i) => ({ name: p.name, mesh: meshes[i] }))));
    const te = performance.now();
    const c = checkMesh(merged);
    return { build_s: (tb - t) / 1000, mesh_s: (tm - tb) / 1000, total_s: (te - t) / 1000, triangles: c.triangles, closed: c.closed, manifold: c.manifold,
        boundaryEdges: c.boundaryEdges, nonManifoldEdges: c.nonManifoldEdges, polygons: parts.reduce((s2, p) => s2 + p.solid.poly.polygons.length, 0) };
}
try {
    res.first = await once(ov ? JSON.parse(ov) : {}, name);
    if (rb)
        res.rebuild = await once({ ...(ov ? JSON.parse(ov) : {}), ...JSON.parse(rb) }, name + "_rebuilt");
    res.ok = true;
}
catch (e) {
    res.ok = false;
    res.error = String(e.stack);
}
res.wall_s = (performance.now() - t0) / 1000;
res.maxrss_kb = process.resourceUsage().maxRSS;
console.log(JSON.stringify(res));
