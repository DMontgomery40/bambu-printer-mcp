/**
 * Split rings and split clamps as curved beams (polygonal co-rotational elements on the mean radius).
 *  - splitRingOpen: a ring of mean radius R with a slit at angle 0, opened by equal and opposite
 *    tangential forces at the two ends. Castigliano, thin ring: gap change = 3 pi F R^3 / (E I).
 *  - splitClamp: the same ring around a rigid pole (penalty contact on the bore face), closed by a pinch
 *    force or a pinch displacement at the ears; returns the contact normal forces, hence the grip
 *    (axial pull and torque it resists with friction mu).
 */
import { solveFrame, rectElem } from "./frame2d.js";
function ringModel(s) {
    const n = s.n ?? 72, slit = s.slit ?? 1e-3; // slit as an angle (rad) left open
    const nodes = [], elems = [];
    for (let k = 0; k <= n; k++) {
        const a = slit / 2 + (k / n) * (2 * Math.PI - slit);
        nodes.push([s.R * Math.cos(a), s.R * Math.sin(a)]);
    }
    for (let k = 0; k < n; k++)
        elems.push(rectElem(k, k + 1, s.b, s.h, s.E, undefined, s.shear));
    return { m: { nodes, elems, bcs: [] }, endA: 0, endB: n, mid: n / 2 };
}
/** Gap opening (mm) for tangential forces F (N) at the slit ends; fixed at the node opposite the slit. */
export function splitRingOpen(s, F) {
    const n = s.n ?? 72;
    if (n % 2)
        throw new Error("splitRingOpen: n must be even");
    const { m, endA, endB, mid } = ringModel(s);
    // symmetry about the x axis: the node opposite the slit has no y motion and no rotation; x is free
    m.bcs = [{ node: mid, dof: 1 }, { node: mid, dof: 2 }];
    // at the slit the tangent is +y at endA (angle ~0+) ; forces pull the ends apart: endA towards -y? the ends
    // sit at +slit/2 (endA, just above the x axis) and -slit/2 (endB); opening = endA moves +y, endB moves -y
    m.loads = [{ node: endA, f: [0, F, 0] }, { node: endB, f: [0, -F, 0] }];
    const st = solveFrame(m, { steps: 2 })[1];
    const opening = st.u[3 * endA + 1] - st.u[3 * endB + 1];
    const I = (s.b * s.h ** 3) / 12;
    return { opening, castigliano: (3 * Math.PI * F * s.R ** 3) / (s.E * I), maxStrain: Math.max(...st.elems.map((e) => e.strain)) };
}
/**
 * The split clamp: ring of mean radius R (bore radius R - h/2) around a pole of radius `pole`. Bore and
 * pole may differ (clearance > 0 or interference < 0). Ears are stiff levers at the slit ends.
 */
export function splitClamp(s) {
    const n = s.n ?? 96;
    const { m, endA, endB, mid } = ringModel({ ...s, n });
    const I = (s.b * s.h ** 3) / 12;
    const k = s.k ?? (1e4 * s.E * I) / s.R ** 3;
    m.circles = [{ c: [0, 0], r: s.pole, offset: s.h / 2, k, nodes: m.nodes.map((_, i) => i) }];
    // ears: stiff levers from each slit end radially outwards; pinch acts at their tips along y
    const ear = s.ear ?? 2 * s.h;
    let ea = endA, eb = endB;
    if (ear > 0) {
        ea = m.nodes.length;
        eb = ea + 1;
        const pa = m.nodes[endA], pb = m.nodes[endB];
        const out = s.h / 2 + ear / 2;
        m.nodes.push([pa[0] + out, pa[1]], [pb[0] + out, pb[1]]);
        m.elems.push(rectElem(endA, ea, s.b, 3 * s.h, s.E * 100), rectElem(endB, eb, s.b, 3 * s.h, s.E * 100));
    }
    // the pole holds the ring in place; remove the remaining rigid modes softly: the node opposite the slit
    // may slide around the pole but not drift (fix its tangential displacement and keep symmetry)
    // symmetry about the x axis: the node opposite the slit has no y motion and no rotation; x is free
    m.bcs = [{ node: mid, dof: 1 }, { node: mid, dof: 2 }];
    if (s.pinch.close !== undefined) {
        m.bcs.push({ node: ea, dof: 1, value: -s.pinch.close / 2 }, { node: eb, dof: 1, value: s.pinch.close / 2 });
    }
    else {
        const F = s.pinch.force;
        m.loads = [{ node: ea, f: [0, -F, 0] }, { node: eb, f: [0, F, 0] }];
        // without contact the ring floats in x until it touches; start it against the pole by fixing nothing else
    }
    const st = solveFrame(m, { steps: 10, maxCuts: 16 })[9];
    const normals = st.contact;
    const normalTotal = normals.reduce((a, b) => a + b, 0);
    const pinchForce = s.pinch.close !== undefined ? Math.abs(st.reaction[3 * ea + 1]) : s.pinch.force;
    const anchor = Math.hypot(st.reaction[3 * mid], st.reaction[3 * mid + 1]);
    return {
        anchor, normalTotal, contactNodes: normals.filter((x) => x > 0).length, pinchForce,
        gripAxial: s.mu * normalTotal, gripTorque: s.mu * normalTotal * s.pole,
        maxStrain: Math.max(...st.elems.slice(0, n).map((e) => e.strain)),
        penetration: Math.max(0, ...normals.map((x) => x / k)),
    };
}
/**
 * Split ring with crush ribs on a rigid pole, pinched by a screw across the ears: co-rotational ring on the
 * mean radius, smooth penalty contact at the rib tips (offset wall/2 + rib height) and on the plain bore,
 * pinch as equal and opposite ear forces. Ribs are rigid in this model; each rib's force is then compared
 * with a crush capacity (crushStrength x flattened width x height), and a crushed rib caps the grip.
 */
export function ribClamp(s) {
    // ribs crush plastically at a contact pressure equal to crushStrength over their flattened width w:
    // F = S w L, w = 2 sqrt(2 r d - d^2). Fixed point: solve the ring with each rib shortened by its crush
    // depth d_i, recompute d_i from the rib's force, repeat.
    const nr = s.ribs?.count ?? 0;
    let crush = new Array(nr).fill(0);
    let res = null;
    for (let it = 0; it < 12; it++) {
        res = ribClampOnce(s, crush);
        const next = res.ribForces.map((F) => {
            const w = F / (s.crushStrength * s.height), r = s.ribs.r;
            if (w >= 2 * r)
                return s.ribs.height; // flattened to its full width: the rib is gone
            return Math.min(s.ribs.height, r - Math.sqrt(r * r - (w * w) / 4));
        });
        const change = Math.max(0, ...next.map((d, i) => Math.abs(d - crush[i])));
        crush = next.map((d, i) => 0.5 * d + 0.5 * crush[i]);
        if (change < 1e-4)
            break;
    }
    res.crushDepth = crush;
    res.ribsCrushed = crush.filter((d) => d > 0.02).length;
    return res;
}
function ribClampOnce(s, crush) {
    const n = s.n ?? 144;
    const R = s.bore / 2 + s.wall / 2;
    const slit = s.gap / R; // angle of the gap at the mean radius
    const nodes = [], elems = [];
    for (let k = 0; k <= n; k++) {
        const a = slit / 2 + (k / n) * (2 * Math.PI - slit);
        nodes.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    for (let k = 0; k < n; k++)
        elems.push(rectElem(k, k + 1, s.height, s.wall, s.E, undefined, true));
    const I = (s.height * s.wall ** 3) / 12;
    const kc = (1e3 * s.E * I) / R ** 3;
    const ribNodes = [];
    if (s.ribs)
        for (let j = 0; j < s.ribs.count; j++) {
            const a = (s.ribs.first ?? Math.PI / s.ribs.count) + (2 * Math.PI * j) / s.ribs.count;
            const k = Math.round(((a - slit / 2) / (2 * Math.PI - slit)) * n);
            if (k > 0 && k < n)
                ribNodes.push(k);
        }
    const others = nodes.map((_, i) => i).filter((i) => !ribNodes.includes(i));
    const circles = [{ c: [0, 0], r: s.pole / 2, offset: s.wall / 2, k: kc, nodes: others }];
    ribNodes.forEach((k, i) => circles.push({ c: [0, 0], r: s.pole / 2, offset: s.wall / 2 + s.ribs.height - (crush[i] ?? 0), k: kc, nodes: [k] }));
    // the pole is slid in from a size that touches nothing: its radius ramps with the load factor
    const free = Math.min(s.bore, s.ribs ? s.bore - 2 * s.ribs.height : s.bore) / 2 - 0.01;
    for (const c of circles)
        c.r0 = Math.min(free, s.pole / 2);
    const ear = s.ear ?? 2 * s.wall;
    const ea = nodes.length, eb = ea + 1;
    nodes.push([nodes[0][0] + s.wall / 2 + ear / 2, nodes[0][1]], [nodes[n][0] + s.wall / 2 + ear / 2, nodes[n][1]]);
    elems.push(rectElem(0, ea, s.height, 3 * s.wall, s.E * 100), rectElem(n, eb, s.height, 3 * s.wall, s.E * 100));
    const mid = Math.round(n / 2);
    const m = { nodes, elems, bcs: [{ node: mid, dof: 1 }, { node: mid, dof: 2 }], circles,
        loads: [{ node: ea, f: [0, -s.pinch, 0] }, { node: eb, f: [0, s.pinch, 0] }] };
    const st = solveFrame(m, { steps: 10, maxCuts: 20 })[9];
    const boreF = st.contact.slice(0, others.length), ribF = st.contact.slice(others.length);
    const boreContact = boreF.reduce((a, b) => a + b, 0);
    const ribCapacity = ribF.map(() => s.crushStrength * 2 * (s.ribs?.r ?? 0) * s.height); // fully flattened rib
    const ribsCrushed = 0;
    const normalTotal = boreContact + ribF.reduce((a, b) => a + b, 0);
    const gapNow = s.gap + (st.u[3 * 0 + 1] - st.u[3 * n + 1]);
    return {
        normalTotal, ribForces: ribF, boreContact, gripAxial: s.mu * normalTotal, gripTorque: s.mu * normalTotal * s.pole / 2,
        ribCapacity, ribsCrushed, ringStrain: Math.max(...st.elems.slice(0, n).map((e) => e.strain)), earGapClosed: s.gap - gapNow, bottomedOut: gapNow <= 0,
    };
}
