import { earClip2 } from "./kernel/meshops.js";
import { OBJECT_MESHER } from "./facts.js";
export const RECORD_SCHEMA = "counterpart/part-record@1";
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/** Triangulated prism of an outline in a sketch plane (axis z: (x,y); y: (x,z); x: (y,z)). */
export function prismMesh(outline, axis, span) {
    let pts = outline.slice();
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0)
        pts = pts.reverse();
    const n = pts.length;
    const map = (u, v, w) => (axis === "z" ? [u, v, w] : axis === "y" ? [u, w, v] : [w, u, v]);
    const flip = axis === "y"; // (x, z) sketch with extrusion along +y is a reflection
    const pos = [];
    for (const [u, v] of pts)
        pos.push(...map(u, v, span[0]));
    for (const [u, v] of pts)
        pos.push(...map(u, v, span[1]));
    const idx = [];
    const tri = (a, b, c) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
    for (const [a, b, c] of earClip2(pts)) {
        tri(n + a, n + b, n + c);
        tri(c, b, a);
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(i, j, n + j);
        tri(i, n + j, n + i);
    }
    return { positions: pos.map(r6), indices: idx };
}
export function cylinderMesh(d, at, axis, span, seg = 48) {
    const a = { x: 0, y: 1, z: 2 }[axis], [ui, vi] = a === 2 ? [0, 1] : a === 1 ? [0, 2] : [1, 2];
    const ring = Array.from({ length: seg }, (_, i) => [at[ui] + (d / 2) * Math.cos((2 * Math.PI * i) / seg), at[vi] + (d / 2) * Math.sin((2 * Math.PI * i) / seg)]);
    return prismMesh(ring, axis, span);
}
export function objectMesh(o) {
    if (o.mesh)
        return o.mesh;
    if (o.prism)
        return prismMesh(o.prism.outline, o.prism.axis, o.prism.span);
    if (o.cylinder)
        return cylinderMesh(o.cylinder.d, o.cylinder.at, o.cylinder.axis, o.cylinder.span);
    return null;
}
/**
 * A load stated on a face is a thin region; the engine finds surface in it only if it is at least about a voxel thick
 * across the face (round 2's adapter widened it at solve time; the engine's own record reader does not). Widen thin
 * box and plane-within ranges to 3 mm about their middle, and say so in the load's words.
 */
const MIN_REGION = 3;
function widenLoad(l) {
    if (!("at" in l) || !l.at)
        return l;
    const r = l.at;
    // and pad every side by 0.5 mm, so a face lying on the region's edge (a box from D - 3 to D on the face y = D) is inside it
    const widen = (b) => b.map(([a, c]) => (c - a < MIN_REGION ? [(a + c) / 2 - MIN_REGION / 2, (a + c) / 2 + MIN_REGION / 2] : [a - 0.5, c + 0.5]));
    if (r.box)
        return { ...l, at: { box: widen(r.box) } };
    if (r.plane && r.within)
        return { ...l, at: { ...r, within: widen(r.within) } };
    return l;
}
export function partRecord(name, mesh, f, interfaces, opts = {}) {
    const used = new Set(mesh.indices);
    const remap = new Map();
    const positions = [];
    for (const v of [...used].sort((a, b) => a - b)) {
        remap.set(v, positions.length / 3);
        positions.push(r6(mesh.positions[3 * v]), r6(mesh.positions[3 * v + 1]), r6(mesh.positions[3 * v + 2]));
    }
    const indices = Array.from(mesh.indices, (v) => remap.get(v));
    const om = f.object ? objectMesh(f.object) : null;
    const object = f.object && om ? { name: f.object.name, kg: f.object.kg, size: f.object.size, mesh: om } : undefined;
    return {
        schema: RECORD_SCHEMA, name,
        from: { engine: "counterpart-kernel", features: opts.features ?? [] },
        mesh: { positions, indices },
        material: { name: opts.material ?? "PLA", stated: !!opts.material },
        print: { up: [0, 0, 1], layer: 0.2, line: 0.42, printer: "Bambu P1S, 0.4 mm nozzle" },
        down: f.down ?? [0, 0, -1],
        supports: f.supports ?? [], object, loads: (f.loads ?? []).map(widenLoad), flexures: f.flexures ?? {}, requirements: f.requirements ?? [],
        interfaces, fidelity: opts.fidelity ?? "fast",
        // the script's named parameters, then the members the features chose (docs/part-record.md, parameters[])
        parameters: [
            ...Object.entries(opts.params ?? {}).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean").map(([k, v]) => ({ name: k, value: v, ...(opts.spec?.[k]?.unit ? { unit: opts.spec[k].unit } : {}), feature: "script" })),
            ...(f.parameters ?? []),
        ],
    };
}
OBJECT_MESHER.fn = objectMesh;
