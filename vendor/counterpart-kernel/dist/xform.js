const AX = ["x", "y", "z"];
export function xform(R, about, op) {
    const t = [0, 1, 2].map((i) => about[i] - (R[3 * i] * about[0] + R[3 * i + 1] * about[1] + R[3 * i + 2] * about[2]));
    // snap near-integers (cos 90 = 6e-17): a quarter-turn is exact
    const Rs = R.map((v) => (Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v));
    let axes = [];
    for (let j = 0; j < 3; j++) {
        const col = [Rs[j], Rs[3 + j], Rs[6 + j]], i = col.findIndex((v) => Math.abs(v) === 1);
        if (i < 0 || col.filter((v) => v !== 0).length !== 1) {
            axes = null;
            break;
        }
        axes.push({ to: i, sign: col[i] });
    }
    const det = Rs[0] * (Rs[4] * Rs[8] - Rs[5] * Rs[7]) - Rs[1] * (Rs[3] * Rs[8] - Rs[5] * Rs[6]) + Rs[2] * (Rs[3] * Rs[7] - Rs[4] * Rs[6]);
    return { R: Rs, t, axes, det, op };
}
export const pt = (X, p) => [0, 1, 2].map((i) => X.R[3 * i] * p[0] + X.R[3 * i + 1] * p[1] + X.R[3 * i + 2] * p[2] + X.t[i]);
export const vec = (X, v) => [0, 1, 2].map((i) => X.R[3 * i] * v[0] + X.R[3 * i + 1] * v[1] + X.R[3 * i + 2] * v[2]);
export const axisOf = (X, a) => (X.axes ? AX[X.axes[AX.indexOf(a)].to] : null);
function box(X, b) {
    if (!X.axes)
        return null;
    const lo = pt(X, [b[0][0], b[1][0], b[2][0]]), hi = pt(X, [b[0][1], b[1][1], b[2][1]]);
    return [0, 1, 2].map((i) => [Math.min(lo[i], hi[i]), Math.max(lo[i], hi[i])]);
}
function region(X, r) {
    if ("box" in r) {
        const b = box(X, r.box);
        return b ? { box: b } : null;
    }
    if ("near" in r)
        return { near: pt(X, r.near), radius: r.radius };
    if ("cylinder" in r)
        return { cylinder: { ...r.cylinder, at: pt(X, r.cylinder.at), axis: vec(X, r.cylinder.axis) } };
    const w = r.within ? box(X, r.within) : undefined;
    if (r.within && !w)
        return null;
    return { plane: { point: pt(X, r.plane.point), normal: vec(X, r.plane.normal) }, within: w ?? undefined };
}
/** Facts mapped through the transform, or the reason they cannot be. */
export function mapFacts(f, X, meshOf) {
    const fail = (what) => ({ dropped: `${what} is a box region, which a ${X.op} by an angle that is not a multiple of 90 degrees does not keep` });
    const supports = [];
    for (const s of f.supports ?? []) {
        const t = { ...s };
        if ("at" in s)
            t.at = pt(X, s.at);
        if ("point" in s)
            t.point = pt(X, s.point);
        if ("axis" in s)
            t.axis = vec(X, s.axis);
        if ("normal" in s)
            t.normal = vec(X, s.normal);
        if ("where" in s && s.where) {
            const w = region(X, s.where);
            if (!w)
                return fail(`support ${s.id}`);
            t.where = w;
        }
        if (s.kind === "pole" && s.span) { /* span is along its own axis: unchanged */ }
        supports.push(t);
    }
    const loads = [];
    for (const l of f.loads ?? []) {
        const t = { ...l };
        if ("at" in l) {
            const w = region(X, l.at);
            if (!w)
                return fail(`load ${l.id}`);
            t.at = w;
        }
        if ("dir" in l && l.dir)
            t.dir = vec(X, l.dir);
        if ("along" in l)
            t.along = vec(X, l.along);
        loads.push(t);
    }
    let object = f.object;
    if (object) {
        const m = object.mesh ?? meshOf(object);
        if (m) {
            const p = m.positions, q = new Array(p.length);
            for (let i = 0; i < p.length; i += 3) {
                const v = pt(X, [p[i], p[i + 1], p[i + 2]]);
                q[i] = v[0];
                q[i + 1] = v[1];
                q[i + 2] = v[2];
            }
            const idx = X.det > 0 ? m.indices : m.indices.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]);
            object = { name: object.name, kg: object.kg, size: object.size, mesh: { positions: q, indices: idx } };
        }
    }
    // gravity in use turns with the part; flexures stay in the layers only if z still maps to z
    const down = vec(X, f.down ?? [0, 0, -1]);
    const zStays = !!X.axes && X.axes[2].to === 2;
    const flexures = {};
    for (const [k, v] of Object.entries(f.flexures ?? {})) {
        const fx = JSON.parse(JSON.stringify(v));
        if (!zStays) {
            for (const c of [fx, fx.finger, fx.arm].filter(Boolean))
                if (c.plane === "xy") {
                    c.plane = "z";
                    c.why = `${c.why ?? ""} (the ${X.op} took it out of the print plane: judged across the layers)`.trim();
                }
        }
        flexures[k] = fx;
    }
    const requirements = (f.requirements ?? []).map((r) => ("retains" in r && r.retains.at ? { ...r, retains: { ...r.retains, at: pt(X, r.retains.at), dir: vec(X, r.retains.dir) } } : "staysIn" in r && r.staysIn.axis ? { ...r, staysIn: { ...r.staysIn, axis: vec(X, r.staysIn.axis) } } : "liftsOut" in r && r.liftsOut.along ? { ...r, liftsOut: { ...r.liftsOut, along: vec(X, r.liftsOut.along) } } : r));
    return { facts: { ...f, supports, loads, object, down, flexures, requirements } };
}
