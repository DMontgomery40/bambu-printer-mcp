import { mapFacts } from "./xform.js";
/** set by record.ts (it meshes analytic objects) to keep this module free of a cycle */
export const OBJECT_MESHER = { fn: null };
const mv = (p, d) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
const mvR = (r, d) => [[r[0][0] + d[0], r[0][1] + d[0]], [r[1][0] + d[1], r[1][1] + d[1]], [r[2][0] + d[2], r[2][1] + d[2]]];
function moveRegion(r, d) {
    if ("box" in r)
        return { box: mvR(r.box, d) };
    if ("near" in r)
        return { near: mv(r.near, d), radius: r.radius };
    if ("cylinder" in r)
        return { cylinder: { ...r.cylinder, at: mv(r.cylinder.at, d) } };
    return { plane: { point: mv(r.plane.point, d), normal: r.plane.normal }, within: r.within ? mvR(r.within, d) : undefined };
}
export function moveFacts(f, d) {
    const ax = { x: 0, y: 1, z: 2 };
    const o = f.object;
    let object = o;
    if (o) {
        object = { ...o };
        if (o.prism) {
            const a = ax[o.prism.axis], [u, v] = a === 2 ? [0, 1] : a === 1 ? [0, 2] : [1, 2];
            object.prism = { ...o.prism, outline: o.prism.outline.map(([p, q]) => [p + d[u], q + d[v]]), span: [o.prism.span[0] + d[a], o.prism.span[1] + d[a]] };
        }
        if (o.cylinder) {
            const a = ax[o.cylinder.axis];
            object.cylinder = { ...o.cylinder, at: mv(o.cylinder.at, d), span: [o.cylinder.span[0] + d[a], o.cylinder.span[1] + d[a]] };
        }
        if (o.mesh)
            object.mesh = { positions: o.mesh.positions.map((v, i) => v + d[i % 3]), indices: o.mesh.indices };
    }
    return {
        ...f, object,
        supports: f.supports?.map((s) => {
            const t = { ...s };
            if ("at" in s)
                t.at = mv(s.at, d);
            if ("point" in s)
                t.point = mv(s.point, d);
            if ("where" in s && s.where)
                t.where = moveRegion(s.where, d);
            return t;
        }),
        loads: f.loads?.map((l) => ("at" in l ? { ...l, at: moveRegion(l.at, d) } : l)),
        requirements: f.requirements?.map((r) => ("retains" in r && r.retains.at ? { ...r, retains: { ...r.retains, at: mv(r.retains.at, d) } } : r)),
    };
}
/** Attach physics facts to a solid: `solid.require(facts({...}))`. Not run as a mesh check. */
export function facts(f) {
    return {
        name: `facts${f.from ? `: ${f.from}` : ""}`, facts: f,
        run: () => ({ name: "facts", pass: true, measured: "stated for the physics check" }),
        moved: (x, y, z) => facts(moveFacts(f, [x, y, z])),
        mapped: (X) => { const r = mapFacts(f, X, (o) => OBJECT_MESHER.fn?.(o) ?? null); return "facts" in r ? facts(r.facts) : null; },
        whyNot: (X) => { const r = mapFacts(f, X, (o) => OBJECT_MESHER.fn?.(o) ?? null); return "dropped" in r ? r.dropped : ""; },
    };
}
export function isFacts(r) { return !!r.facts; }
/** Merge every fact requirement of a part; ids are made unique by suffixing. */
export function mergeFacts(list) {
    const out = { supports: [], loads: [], flexures: {}, requirements: [] };
    const used = new Set();
    const uniq = (id) => { let k = id, n = 2; while (used.has(k))
        k = `${id}.${n++}`; used.add(k); return k; };
    for (const f of list) {
        const ren = new Map();
        for (const [k, v] of Object.entries(f.flexures ?? {})) {
            const k2 = k in out.flexures ? `${k}.${Object.keys(out.flexures).length + 1}` : k;
            ren.set(k, k2);
            out.flexures[k2] = v;
        }
        for (const s of f.supports ?? [])
            out.supports.push({ ...s, id: uniq(s.id) });
        for (const l of f.loads ?? [])
            out.loads.push({ ...l, id: uniq(l.id) });
        for (const r of f.requirements ?? []) {
            const r2 = { ...r, id: uniq(r.id), from: r.from ?? f.from };
            for (const k of ["strain", "stop", "insertion", "retention", "grips", "relaxed"])
                if (r2[k])
                    r2[k] = { ...r2[k], flexure: ren.get(r2[k].flexure) ?? r2[k].flexure };
            out.requirements.push(r2);
        }
        if (f.object && !out.object)
            out.object = f.object;
        if (f.down)
            out.down = f.down;
    }
    return out;
}
