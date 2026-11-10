/**
 * The printer MCP's cad_check_fit on the counterpart engine: interference volume by the kernel's exact mesh boolean
 * (its own exact predicates on the meshes' coordinates, src/scanbool.ts) and the smallest surface gap by BVH distance
 * (every vertex and edge midpoint of each mesh against the other's surface), in the shape the MCP returns.
 *   node dist/mcp/fit.js REQUEST.json   ({ model, reference, transform: { rotation_deg, translation_mm }, clearance_mm })
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSTL } from "../kernel/io.js";
import { Mesh, checkMesh } from "../kernel/mesh.js";
import { BVH } from "../kernel/bvh.js";
import { scanBoolean } from "../scanbool.js";
function transformed(m, rotDeg, t) {
    // XYZ rotations about the origin in that order (static axes, as the build123d engine's sxyz), then the translation
    const [ax, ay, az] = rotDeg.map((d) => (d * Math.PI) / 180);
    const Rx = [1, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, Math.sin(ax), Math.cos(ax)];
    const Ry = [Math.cos(ay), 0, Math.sin(ay), 0, 1, 0, -Math.sin(ay), 0, Math.cos(ay)];
    const Rz = [Math.cos(az), -Math.sin(az), 0, Math.sin(az), Math.cos(az), 0, 0, 0, 1];
    const mul = (A, B) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]));
    const R = mul(Rz, mul(Ry, Rx));
    const p = m.positions, q = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3)
        for (let k = 0; k < 3; k++)
            q[i + k] = R[3 * k] * p[i] + R[3 * k + 1] * p[i + 1] + R[3 * k + 2] * p[i + 2] + t[k];
    return new Mesh(q, m.indices);
}
function minGap(a, b) {
    let best = Infinity;
    for (const [from, to] of [[a, b], [b, a]]) {
        const bvh = new BVH(to), p = from.positions, I = from.indices;
        for (let i = 0; i < p.length; i += 3)
            best = Math.min(best, bvh.closest(p[i], p[i + 1], p[i + 2], best));
        for (let t = 0; t < I.length; t += 3)
            for (let k = 0; k < 3; k++) {
                const u = 3 * I[t + k], v = 3 * I[t + (k + 1) % 3];
                best = Math.min(best, bvh.closest((p[u] + p[v]) / 2, (p[u + 1] + p[v + 1]) / 2, (p[u + 2] + p[v + 2]) / 2, best));
            }
    }
    return best;
}
export function fit(req) {
    const t = req.transform ?? {};
    if (Object.keys(t).some((k) => k !== "rotation_deg" && k !== "translation_mm"))
        throw new Error("transform supports only explicit rigid translation_mm and rotation_deg; scaling is never implicit.");
    const rot = t.rotation_deg ?? [0, 0, 0], tr = t.translation_mm ?? [0, 0, 0];
    if (rot.length !== 3 || tr.length !== 3 || ![...rot, ...tr].every(Number.isFinite))
        throw new Error("Transform requires finite three-number vectors.");
    const a = readSTL(readFileSync(req.model)), b = transformed(readSTL(readFileSync(req.reference)), rot, tr);
    for (const [m, n] of [[a, "model"], [b, "reference"]]) {
        const c = checkMesh(m);
        if (!c.closed || !c.manifold || !c.outward)
            throw new Error(`Fit checks require positively wound watertight manifold STL meshes; the ${n} is not (repair open scans explicitly before checking).`);
        if (m.triangleCount > 250_000)
            throw new Error(`The ${n} has ${m.triangleCount} triangles; fit checks take at most 250,000 per mesh.`);
    }
    const t0 = performance.now();
    const inter = scanBoolean(a, b, "intersect");
    const volume = inter.mesh.triangleCount ? Math.abs(checkMesh(inter.mesh).volume) : 0;
    const gap = volume > 1e-8 ? 0 : minGap(a, b);
    const clearance = req.clearance_mm ?? 0;
    return { units: "mm", interference_volume_mm3: volume, minimum_gap_mm: gap, clearance_mm: clearance, clear: volume <= 1e-8 && gap + 1e-8 >= clearance,
        transform: { translation_mm: tr, rotation_deg: rot },
        method: "counterpart-kernel exact mesh boolean (exact predicates on the meshes' own coordinates); BVH surface distance from every vertex and edge midpoint of each mesh",
        reference_rescaled: false, ms: Math.round(performance.now() - t0) };
}
if (process.argv[1]?.endsWith(join("mcp", "fit.js"))) {
    process.stdout.write(JSON.stringify(fit(JSON.parse(readFileSync(process.argv[2], "utf8")))));
}
