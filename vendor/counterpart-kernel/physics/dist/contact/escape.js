import { sampleSurface, massProperties } from "./statics.js";
const mul = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
            C[3 * i + j] += A[3 * i + k] * B[3 * k + j]; return C; };
const rot = (axis, deg) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), [x, y, z] = axis;
    return [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s, y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s, z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)];
};
const apply = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
export function escapeSearch(o) {
    const t0 = performance.now();
    const step = o.step ?? 0.25, turn = o.turn ?? 1, tol = o.tol ?? 0.02, maxSteps = o.maxSteps ?? 1500;
    const cg0 = massProperties(o.object, 1).cg;
    // surface samples, relative to the cg; only those that can meet the part matter, but all decide "out"
    const pts = sampleSurface(o.object, o.spacing ?? 2.5).map((s) => [s.p[0] - cg0[0], s.p[1] - cg0[1], s.p[2] - cg0[2]]);
    const b = o.bounds, topZ = b.max[2];
    let evals = 0;
    // pose: rotation R (about the cg) and cg position
    const edges = o.partEdges && o.objectDistance ? o.partEdges : [];
    const ob = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < o.object.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
            ob.min[a] = Math.min(ob.min[a], o.object.positions[i + a]);
            ob.max[a] = Math.max(ob.max[a], o.object.positions[i + a]);
        }
    const clearance = (R, c, stopBelow = -Infinity) => {
        let m = Infinity;
        // part edges in the object's frame: p_obj = R^T (x - c) + cg0 (those outside the object's own box, padded by
        // the tolerance, cannot touch it and are skipped without a distance query)
        for (const x of edges) {
            const d0 = [x[0] - c[0], x[1] - c[1], x[2] - c[2]];
            const q = [R[0] * d0[0] + R[3] * d0[1] + R[6] * d0[2] + cg0[0], R[1] * d0[0] + R[4] * d0[1] + R[7] * d0[2] + cg0[1], R[2] * d0[0] + R[5] * d0[1] + R[8] * d0[2] + cg0[2]];
            if (q[0] < ob.min[0] - 0.5 || q[0] > ob.max[0] + 0.5 || q[1] < ob.min[1] - 0.5 || q[1] > ob.max[1] + 0.5 || q[2] < ob.min[2] - 0.5 || q[2] > ob.max[2] + 0.5)
                continue;
            const d = o.objectDistance(q[0], q[1], q[2]);
            evals++;
            if (d < m) {
                m = d;
                if (m < stopBelow)
                    return m;
            }
        }
        for (const p of pts) {
            const q = apply(R, p), x = q[0] + c[0], y = q[1] + c[1], z = q[2] + c[2];
            if (x < b.min[0] - 1 || x > b.max[0] + 1 || y < b.min[1] - 1 || y > b.max[1] + 1 || z < b.min[2] - 1 || z > b.max[2] + 1)
                continue;
            const d = o.distance(x, y, z);
            evals++;
            if (d < m) {
                m = d;
                if (m < stopBelow)
                    return m;
            }
        }
        return m;
    };
    const lowest = (R, c) => { let m = Infinity; for (const p of pts) {
        const z = apply(R, p)[2] + c[2];
        if (z < m)
            m = z;
    } return m; };
    const isOut = (R, c) => {
        // out: no sample inside the part's box footprint below its top, i.e. lifted above it, or moved off it sideways
        if (lowest(R, c) > topZ + 0.5)
            return true;
        for (const p of pts) {
            const q = apply(R, p), x = q[0] + c[0], y = q[1] + c[1], z = q[2] + c[2];
            if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2])
                return false;
        }
        return true;
    };
    const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const start0 = clearance(I3, cg0);
    // the seated pose may touch (clearance ~0); allow what it starts with
    const floorTol = Math.min(-tol, start0 - tol);
    const moves = [];
    const axes = [["x", [1, 0, 0]], ["y", [0, 1, 0]], ["z", [0, 0, 1]]];
    for (const [n, a] of axes)
        for (const sg of [1, -1])
            moves.push({ name: `${sg > 0 ? "+" : "-"}${n}`, f: (p) => ({ R: p.R, c: [p.c[0] + sg * step * a[0], p.c[1] + sg * step * a[1], p.c[2] + sg * step * a[2]], move: `slide ${sg > 0 ? "+" : "-"}${n}` }) });
    // rotations about axes through the cg, and about horizontal axes through the object's lowest edge on each
    // side (tipping over it) and through its highest point on each side (leaning on a rim)
    for (const [n, a] of axes)
        for (const sg of [1, -1])
            moves.push({ name: `turn ${sg > 0 ? "+" : "-"}${n}`, f: (p) => ({ R: mul(rot(a, sg * turn), p.R), c: p.c, move: `turn ${sg > 0 ? "+" : "-"}${n} about the centre of mass` }) });
    for (const [n, a] of axes.slice(0, 2))
        for (const sg of [1, -1])
            for (const side of [1, -1])
                for (const which of ["low", "high"]) {
                    moves.push({ name: `tip ${n}${sg > 0 ? "+" : "-"} ${which}${side}`, f: (p) => {
                            // pivot: the object's extreme sample on the given side across the axis, lowest or highest
                            const perp = n === "x" ? [0, side, 0] : [side, 0, 0];
                            let best = null, bs = -Infinity;
                            for (const s of pts) {
                                const q = apply(p.R, s);
                                const sc = (q[0] * perp[0] + q[1] * perp[1]) * 4 + (which === "low" ? -q[2] : q[2]);
                                if (sc > bs) {
                                    bs = sc;
                                    best = q;
                                }
                            }
                            const piv = [best[0] + p.c[0], best[1] + p.c[1], best[2] + p.c[2]];
                            const Rr = rot(a, sg * turn);
                            const rc = apply(Rr, [p.c[0] - piv[0], p.c[1] - piv[1], p.c[2] - piv[2]]);
                            return { R: mul(Rr, p.R), c: [piv[0] + rc[0], piv[1] + rc[1], piv[2] + rc[2]], move: `tip ${sg > 0 ? "+" : "-"}${n} about ${which === "low" ? "its lower" : "its upper"} ${n === "x" ? (side > 0 ? "+y" : "-y") : side > 0 ? "+x" : "-x"} edge` };
                        } });
                }
    // rotations about the points where the object currently touches the part (a rim edge it leans on, a floor
    // corner it stands on): found per pose, the samples within 0.15 mm of the part, a few far apart
    const contactsOf = (p) => {
        const cs = [];
        for (const s0 of pts) {
            const q = apply(p.R, s0), x = q[0] + p.c[0], y = q[1] + p.c[1], z = q[2] + p.c[2];
            if (x < b.min[0] - 1 || x > b.max[0] + 1 || y < b.min[1] - 1 || y > b.max[1] + 1 || z < b.min[2] - 1 || z > b.max[2] + 1)
                continue;
            if (o.distance(x, y, z) < 0.15 && !cs.some((c0) => Math.hypot(c0[0] - x, c0[1] - y, c0[2] - z) < 6))
                cs.push([x, y, z]);
            if (cs.length >= 8)
                break;
        }
        return cs;
    };
    const pivotMoves = (p) => {
        const out = [];
        for (const piv of contactsOf(p))
            for (const [n, a] of axes)
                for (const sg of [1, -1]) {
                    const Rr = rot(a, sg * turn), rc = apply(Rr, [p.c[0] - piv[0], p.c[1] - piv[1], p.c[2] - piv[2]]);
                    out.push({ R: mul(Rr, p.R), c: [piv[0] + rc[0], piv[1] + rc[1], piv[2] + rc[2]], move: `turn ${sg > 0 ? "+" : "-"}${n} about where it touches (${piv.map((v) => v.toFixed(0)).join(", ")})` });
                }
        return out;
    };
    const gradD = (x) => { const e = 1e-3, d = o.distance; const v = [d(x[0] + e, x[1], x[2]) - d(x[0] - e, x[1], x[2]), d(x[0], x[1] + e, x[2]) - d(x[0], x[1] - e, x[2]), d(x[0], x[1], x[2] + e) - d(x[0], x[1], x[2] - e)]; const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
    const settle = (q) => {
        let c = q.c, moved = 0;
        for (let k = 0; k < 6; k++) {
            let worst = Infinity, wx = [0, 0, 0];
            for (const s0 of pts) {
                const a = apply(q.R, s0), x = [a[0] + c[0], a[1] + c[1], a[2] + c[2]];
                if (x[0] < b.min[0] - 1 || x[0] > b.max[0] + 1 || x[1] < b.min[1] - 1 || x[1] > b.max[1] + 1 || x[2] < b.min[2] - 1 || x[2] > b.max[2] + 1)
                    continue;
                const d = o.distance(x[0], x[1], x[2]);
                evals++;
                if (d < worst) {
                    worst = d;
                    wx = x;
                }
            }
            if (worst >= floorTol)
                return clearance(q.R, c, floorTol) >= floorTol ? { ...q, c } : null;
            const n = gradD(wx), push = floorTol - worst + 0.005;
            c = [c[0] + push * n[0], c[1] + push * n[1], c[2] + push * n[2]];
            moved += push;
            if (moved > 0.5)
                return null;
        }
        return null;
    };
    // progress: how far out the object is
    const score = (p) => { const lo = lowest(p.R, p.c); return Math.min(lo, topZ + 1) + 0.25 * p.c[2]; };
    const key = (p) => `${Math.round(p.c[0] / (step * 0.99))},${Math.round(p.c[1] / (step * 0.99))},${Math.round(p.c[2] / (step * 0.99))},${p.R.map((v) => Math.round(v * 120)).join(",")}`;
    // Without gravity: best-first, most out first (the way a hand would take it out).
    // With gravity: a frictionless quasi-static fall, steepest descent of the centre of mass's energy among the
    // clear moves; it gets out or settles in a local minimum (held). Friction would only hold it more.
    const g = o.gravity, E = (c) => (g ? -(g[0] * c[0] + g[1] * c[1] + g[2] * c[2]) : 0);
    const startP = { R: I3, c: cg0, move: "seated" };
    const seen = new Set([key(startP)]);
    const parent = new Map([[startP, null]]);
    let found = null, bestPose = startP, bestScore = score(startP), stall = 0;
    if (g) {
        let p = startP;
        for (let it = 0; it < maxSteps; it++) {
            if (isOut(p.R, p.c)) {
                found = p;
                break;
            }
            let best = null, bestE = E(p.c) - 1e-6;
            for (const q0 of [...moves.map((mv) => mv.f(p)), ...pivotMoves(p)]) {
                // a move that runs into the part is pushed back out along the part's normal where it is deepest (so a
                // turn becomes a turn-and-slide along the wall), up to half a millimetre
                const q = settle(q0);
                if (!q)
                    continue;
                const k = key(q);
                if (seen.has(k))
                    continue;
                if (E(q.c) >= bestE)
                    continue;
                best = q;
                bestE = E(q.c);
            }
            if (!best)
                break;
            seen.add(key(best));
            parent.set(best, p);
            p = best;
        }
        bestPose = p;
    }
    else {
        // greedy: the clear move that takes it farthest out, each step
        let p = startP;
        for (let it = 0; it < maxSteps; it++) {
            if (isOut(p.R, p.c)) {
                found = p;
                break;
            }
            let best = null, bs = score(p) - 1e-9;
            for (const q of [...moves.map((mv) => mv.f(p)), ...pivotMoves(p)]) {
                const k = key(q);
                if (seen.has(k))
                    continue;
                const sc = score(q);
                if (sc <= bs)
                    continue;
                if (clearance(q.R, q.c, floorTol) < floorTol)
                    continue;
                best = q;
                bs = sc;
            }
            if (!best)
                break;
            seen.add(key(best));
            parent.set(best, p);
            p = best;
        }
        bestPose = p;
        void bestScore;
        void stall;
    }
    const end = found ?? bestPose;
    const chain = [];
    for (let p = end; p; p = parent.get(p))
        chain.push(p);
    chain.reverse();
    // the cg's rise and the steepest rise per mm along the path (over windows of 1 mm of travel)
    let travel = 0, steepest = 0, rise = 0;
    const tr = [[0, chain[0].c[2]]];
    for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1].c, c = chain[i].c;
        travel += Math.max(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), 0.01);
        tr.push([travel, c[2]]);
        rise = Math.max(rise, c[2] - chain[0].c[2]);
    }
    for (let i = 0; i < tr.length; i++)
        for (let j = i + 1; j < tr.length; j++) {
            const ds = tr[j][0] - tr[i][0];
            if (ds >= 1) {
                steepest = Math.max(steepest, (tr[j][1] - tr[i][1]) / ds);
                break;
            }
        }
    if (chain.length > 1 && travel < 1)
        steepest = Math.max(steepest, (chain[chain.length - 1].c[2] - chain[0].c[2]) / Math.max(travel, 1e-9));
    let minCl = Infinity;
    for (const p of chain)
        minCl = Math.min(minCl, clearance(p.R, p.c));
    const segments = [];
    for (const p of chain.slice(1)) {
        const last = segments[segments.length - 1];
        const unit = p.move.startsWith("slide") ? "mm" : "deg", amt = unit === "mm" ? step : turn;
        if (last && last.move === p.move)
            last.amount += amt;
        else
            segments.push({ move: p.move, amount: amt, unit });
    }
    const res = { out: !!found, path: chain.map((p) => ({ R: p.R, t: [p.c[0] - cg0[0], p.c[1] - cg0[1], p.c[2] - cg0[2]], cg: p.c, move: p.move })), segments, steepest, rise,
        pushN: o.weightN * steepest, tiltDeg: (Math.atan(steepest) * 180) / Math.PI, minClearance: minCl, evaluations: evals, ms: performance.now() - t0 };
    if (!found)
        res.jam = { pose: end.c, reason: `no clear move gets it farther out after ${chain.length - 1} moves (cg rose ${rise.toFixed(2)} mm)` };
    return res;
}
/** The smallest tilt (deg, about `axis`) at which the object falls out of the part, frictionless; 90+ if none. */
export function escapeTilt(o) {
    const t0 = performance.now();
    const maxDeg = o.maxDeg ?? 90;
    const run = (deg) => escapeSearch({ ...o, gravity: o.tiltedGravity(deg, o.axis) });
    let hi = run(maxDeg);
    if (!hi.out)
        return { tilt: Infinity, at: null, held: hi, ms: performance.now() - t0 };
    let lo = 0, heldRes = null, hiDeg = maxDeg;
    const r0 = run(0);
    if (r0.out)
        return { tilt: 0, at: r0, held: null, ms: performance.now() - t0 };
    heldRes = r0;
    for (let i = 0; i < 6; i++) {
        const m = (lo + hiDeg) / 2, r = run(m);
        if (r.out) {
            hiDeg = m;
            hi = r;
        }
        else {
            lo = m;
            heldRes = r;
        }
    }
    return { tilt: hiDeg, at: hi, held: heldRes, ms: performance.now() - t0 };
}
/**
 * A frictionless quasi-static fall under gravity g, contacts kept by first-order kinematics: at each pose the
 * twist (v, w) that lowers the centre of mass fastest, subject to every touching contact not closing
 * (n . (v + w x r) >= 0) and a step bound, is a small linear program (the dual of round 1's equilibrium LP);
 * the object takes a small step along it, so it slides along walls and rolls over rims as one motion. It gets
 * out (falls out at this tilt) or stops where no twist lowers it (held, to first order, without friction).
 */
import { simplex } from "./statics.js";
export function fallOut(o) {
    const t0 = performance.now();
    const cg0 = massProperties(o.object, 1).cg;
    const pts = sampleSurface(o.object, o.spacing ?? 4).map((s) => [s.p[0] - cg0[0], s.p[1] - cg0[1], s.p[2] - cg0[2]]);
    const L = Math.max(...pts.map((p) => Math.hypot(...p)));
    const b = o.bounds, g = o.gravity, step = o.step ?? 0.25, band = 0.08;
    let R = [1, 0, 0, 0, 1, 0, 0, 0, 1], c = [...cg0];
    const path = [[...c]];
    const world = (p) => { const q = apply(R, p); return [q[0] + c[0], q[1] + c[1], q[2] + c[2]]; };
    const inBox = (x) => x[0] >= b.min[0] - 1 && x[0] <= b.max[0] + 1 && x[1] >= b.min[1] - 1 && x[1] <= b.max[1] + 1 && x[2] >= b.min[2] - 1 && x[2] <= b.max[2] + 1;
    const grad = (x) => { const e = 1e-3, d = o.distance; const v = [d(x[0] + e, x[1], x[2]) - d(x[0] - e, x[1], x[2]), d(x[0], x[1] + e, x[2]) - d(x[0], x[1] - e, x[2]), d(x[0], x[1], x[2] + e) - d(x[0], x[1], x[2] - e)]; const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
    const isOut = () => pts.every((p) => { const x = world(p); return !(x[0] >= b.min[0] && x[0] <= b.max[0] && x[1] >= b.min[1] && x[1] <= b.max[1] && x[2] >= b.min[2] && x[2] <= b.max[2]); }) || pts.every((p) => world(p)[2] > b.max[2] + 0.5);
    let steps = 0, stuck;
    for (; steps < (o.maxSteps ?? 3000); steps++) {
        if (isOut())
            return { out: true, steps, drop: -(g[0] * (c[0] - cg0[0]) + g[1] * (c[1] - cg0[1]) + g[2] * (c[2] - cg0[2])), path, ms: performance.now() - t0 };
        // contacts: samples within the band; the part's normal there pushes the object along +grad
        const rows = [], rhs = [];
        let minD = Infinity;
        const cell = new Set();
        for (const p of pts) {
            const x = world(p);
            if (!inBox(x))
                continue;
            const d = o.distance(x[0], x[1], x[2]);
            minD = Math.min(minD, d);
            if (d > band)
                continue;
            const n = grad(x), r = apply(R, p);
            // one contact per 4 mm cell and normal direction (the extreme points of each patch are what matter)
            const ck = `${Math.round(x[0] / 4)},${Math.round(x[1] / 4)},${Math.round(x[2] / 4)},${n.map((v) => Math.round(v * 2)).join(",")}`;
            if (cell.has(ck))
                continue;
            cell.add(ck);
            // n . (v + w x r) >= -(d) / step  (it may close what gap it has)
            const wxr = [r[1] * n[2] - r[2] * n[1], r[2] * n[0] - r[0] * n[2], r[0] * n[1] - r[1] * n[0]]; // r x n: n.(w x r) = w.(r x n)
            rows.push([n[0], n[1], n[2], wxr[0], wxr[1], wxr[2]]);
            rhs.push(-Math.max(0, d) / step);
        }
        // variables: twist = xp - xm (12 >= 0), slack per row; |v| <= 1, |w| <= 1/L per component
        const nv = 12, m = rows.length;
        const A = [], bb = [];
        rows.forEach((row, i) => { const a = new Array(nv + m + 12).fill(0); for (let k = 0; k < 6; k++) {
            a[k] = row[k];
            a[6 + k] = -row[k];
        } a[nv + i] = -1; A.push(a); bb.push(rhs[i]); });
        for (let k = 0; k < 6; k++) {
            const a = new Array(nv + m + 12).fill(0);
            a[k] = 1;
            a[6 + k] = 1;
            a[nv + m + k] = 1;
            A.push(a);
            bb.push(k < 3 ? 1 : 1 / L);
        }
        // objective: maximise g . v (the cg moves along gravity)
        const cost = new Array(nv + m + 12).fill(0);
        for (let k = 0; k < 3; k++) {
            cost[k] = g[k];
            cost[6 + k] = -g[k];
        }
        const sol = simplex(A, bb, cost);
        if (!sol || sol.value < 1e-6) {
            stuck = `no motion lowers it (best rate ${sol ? sol.value.toExponential(1) : "infeasible"})`;
            break;
        }
        const tw = [0, 1, 2, 3, 4, 5].map((k) => sol.x[k] - sol.x[6 + k]);
        // step size: translation `step` mm (more when far from everything)
        const sc = Math.max(step, Math.min(2, 0.5 * minD)) / Math.max(1e-9, Math.hypot(tw[0], tw[1], tw[2]) + L * Math.hypot(tw[3], tw[4], tw[5]));
        const w = [tw[3] * sc, tw[4] * sc, tw[5] * sc], wl = Math.hypot(...w);
        if (wl > 1e-12)
            R = mul(rot([w[0] / wl, w[1] / wl, w[2] / wl], (wl * 180) / Math.PI), R);
        c = [c[0] + tw[0] * sc, c[1] + tw[1] * sc, c[2] + tw[2] * sc];
        // push back out of any penetration along the part's normals (a few projection passes)
        for (let k = 0; k < 4; k++) {
            let worst = 0, wn = [0, 0, 0];
            for (const p of pts) {
                const x = world(p);
                if (!inBox(x))
                    continue;
                const d = o.distance(x[0], x[1], x[2]);
                if (d < worst) {
                    worst = d;
                    wn = grad(x);
                }
            }
            if (worst > -0.01)
                break;
            c = [c[0] - worst * wn[0], c[1] - worst * wn[1], c[2] - worst * wn[2]];
        }
        path.push([...c]);
    }
    return { out: false, steps, drop: -(g[0] * (c[0] - cg0[0]) + g[1] * (c[1] - cg0[1]) + g[2] * (c[2] - cg0[2])), path, ms: performance.now() - t0, stuck };
}
/** Along a found path, the smallest part tilt (about `axis`) at which the object's centre of mass never rises
 * in the world as it follows the path, i.e. gravity alone would carry it out along this path (frictionless).
 * 90+ means not by tilting up to 90 degrees. A bound for this path only: another path may need less. */
export function tiltAlongPath(path, axis, tiltedGravity) {
    const ok = (deg) => { const g = tiltedGravity(deg, axis); const E = (c) => -(g[0] * c[0] + g[1] * c[1] + g[2] * c[2]); const e0 = E(path[0].cg); return path.every((p) => E(p.cg) <= e0 + 1e-6); };
    if (!ok(90))
        return Infinity;
    let lo = 0, hi = 90;
    if (ok(0))
        return 0;
    for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (ok(m))
            hi = m;
        else
            lo = m;
    }
    return hi;
}
/**
 * Does the object fall out at this tilt (frictionless)? It does if some path out never lifts its centre of
 * mass above where it sits: the set of clear poses at or below the seated energy is flooded (breadth first, moves
 * of `step` mm and `turn` degrees, including turns about where it touches) until a pose is out (falls out) or
 * the set is exhausted (held: every way out climbs). Friction only adds to "held".
 */
export function fallsOut(o) {
    const t0 = performance.now();
    // reuse escapeSearch's machinery through a tiny wrapper: rebuild what is needed locally
    const step = o.step ?? 0.25, turn = o.turn ?? 1, tol = o.tol ?? 0.02;
    const cg0 = massProperties(o.object, 1).cg;
    const pts = sampleSurface(o.object, o.spacing ?? 3).map((s) => [s.p[0] - cg0[0], s.p[1] - cg0[1], s.p[2] - cg0[2]]);
    const b = o.bounds, g = o.gravity, topZ = b.max[2];
    const edges = o.partEdges && o.objectDistance ? o.partEdges : [];
    const ob = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < o.object.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
            ob.min[a] = Math.min(ob.min[a], o.object.positions[i + a]);
            ob.max[a] = Math.max(ob.max[a], o.object.positions[i + a]);
        }
    const clear = (R, c, floor) => {
        for (const x of edges) {
            const d0 = [x[0] - c[0], x[1] - c[1], x[2] - c[2]];
            const q = [R[0] * d0[0] + R[3] * d0[1] + R[6] * d0[2] + cg0[0], R[1] * d0[0] + R[4] * d0[1] + R[7] * d0[2] + cg0[1], R[2] * d0[0] + R[5] * d0[1] + R[8] * d0[2] + cg0[2]];
            if (q[0] < ob.min[0] - 0.5 || q[0] > ob.max[0] + 0.5 || q[1] < ob.min[1] - 0.5 || q[1] > ob.max[1] + 0.5 || q[2] < ob.min[2] - 0.5 || q[2] > ob.max[2] + 0.5)
                continue;
            if (o.objectDistance(q[0], q[1], q[2]) < floor)
                return false;
        }
        for (const p of pts) {
            const a = apply(R, p), x = a[0] + c[0], y = a[1] + c[1], z = a[2] + c[2];
            if (x < b.min[0] - 1 || x > b.max[0] + 1 || y < b.min[1] - 1 || y > b.max[1] + 1 || z < b.min[2] - 1 || z > b.max[2] + 1)
                continue;
            if (o.distance(x, y, z) < floor)
                return false;
        }
        return true;
    };
    const isOut = (R, c) => {
        let low = Infinity;
        for (const p of pts)
            low = Math.min(low, apply(R, p)[2] + c[2]);
        if (low > topZ + 0.5)
            return true;
        for (const p of pts) {
            const a = apply(R, p), x = a[0] + c[0], y = a[1] + c[1], z = a[2] + c[2];
            if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2])
                return false;
        }
        return true;
    };
    const E = (c) => -(g[0] * c[0] + g[1] * c[1] + g[2] * c[2]);
    const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const floor0 = -tol;
    const key = (R, c) => `${Math.round(c[0] / step)},${Math.round(c[1] / step)},${Math.round(c[2] / step)},${R.map((v) => Math.round((v * 180) / Math.PI / turn)).join(",")}`;
    const movesOf = (p) => {
        const cand = [];
        for (const a of [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
            for (const s of [1, -1])
                cand.push({ R: p.R, c: [p.c[0] + s * step * a[0], p.c[1] + s * step * a[1], p.c[2] + s * step * a[2]] });
        const pivots = [p.c];
        // the part's sharp edges the object touches (a rim it can tip over) first, then its own touching points
        for (const x of edges) {
            const d0 = [x[0] - p.c[0], x[1] - p.c[1], x[2] - p.c[2]], R = p.R;
            const q = [R[0] * d0[0] + R[3] * d0[1] + R[6] * d0[2] + cg0[0], R[1] * d0[0] + R[4] * d0[1] + R[7] * d0[2] + cg0[1], R[2] * d0[0] + R[5] * d0[1] + R[8] * d0[2] + cg0[2]];
            if (q[0] < ob.min[0] - 0.5 || q[0] > ob.max[0] + 0.5 || q[1] < ob.min[1] - 0.5 || q[1] > ob.max[1] + 0.5 || q[2] < ob.min[2] - 0.5 || q[2] > ob.max[2] + 0.5)
                continue;
            if (o.objectDistance(q[0], q[1], q[2]) < 0.15 && !pivots.some((v) => Math.hypot(v[0] - x[0], v[1] - x[1], v[2] - x[2]) < 6))
                pivots.push(x);
            if (pivots.length > 6)
                break;
        }
        for (const s0 of pts) {
            const a = apply(p.R, s0), x = [a[0] + p.c[0], a[1] + p.c[1], a[2] + p.c[2]];
            if (x[0] < b.min[0] - 1 || x[0] > b.max[0] + 1 || x[1] < b.min[1] - 1 || x[1] > b.max[1] + 1 || x[2] < b.min[2] - 1 || x[2] > b.max[2] + 1)
                continue;
            if (o.distance(x[0], x[1], x[2]) < 0.15 && !pivots.some((q) => Math.hypot(q[0] - x[0], q[1] - x[1], q[2] - x[2]) < 6))
                pivots.push(x);
            if (pivots.length > 10)
                break;
        }
        for (const piv of pivots)
            for (const a of [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
                for (const s of [1, -1]) {
                    const Rr = rot(a, s * turn), rc = apply(Rr, [p.c[0] - piv[0], p.c[1] - piv[1], p.c[2] - piv[2]]);
                    cand.push({ R: mul(Rr, p.R), c: [piv[0] + rc[0], piv[1] + rc[1], piv[2] + rc[2]] });
                }
        return cand;
    };
    // first let it settle: steepest descent to the local minimum it falls into at this tilt
    let cur = { R: I3, c: [...cg0] };
    for (let it = 0; it < 400; it++) {
        let best = null, be = E(cur.c) - 1e-6;
        for (const q of movesOf(cur)) {
            const e = E(q.c);
            if (e < be && clear(q.R, q.c, floor0)) {
                best = q;
                be = e;
            }
        }
        if (!best)
            break;
        cur = best;
    }
    // then: can it get out without climbing above that minimum? (a 0.02 mm allowance for the sampled contact)
    const E0 = E(cur.c) + (o.allowance ?? 0.02);
    const start = { R: cur.R, c: cur.c, prev: null };
    const seen = new Set([key(start.R, start.c)]);
    const queue = [start];
    let n = 0;
    // lowest energy first (it goes where gravity takes it first), then how far out (the lowest point's height)
    const prio = (q) => E(q.c) - 0.05 * q.c[2];
    while (queue.length && n < (o.maxPoses ?? 3000)) {
        let bi = 0;
        for (let i = 1; i < queue.length; i++)
            if (prio(queue[i]) < prio(queue[bi]))
                bi = i;
        const p = queue.splice(bi, 1)[0];
        n++;
        if (isOut(p.R, p.c)) {
            const path = [], poseList = [];
            for (let q = p; q; q = q.prev) {
                path.push(q.c);
                poseList.push({ R: q.R, c: q.c });
            }
            return { out: true, poses: n, ms: performance.now() - t0, path: path.reverse(), poseList: poseList.reverse() };
        }
        for (const q of movesOf(p)) {
            if (E(q.c) > E0)
                continue;
            const k = key(q.R, q.c);
            if (seen.has(k))
                continue;
            seen.add(k);
            if (!clear(q.R, q.c, floor0))
                continue;
            queue.push({ ...q, prev: p });
        }
    }
    return { out: false, poses: n, ms: performance.now() - t0 };
}
/** The way in: the way out reversed, each move with its sign flipped (slide +z out is slide -z in). */
export function reversePath(segments) {
    return [...segments].reverse().map((s) => ({ ...s, move: s.move.replace(/^(slide|turn|tip) ([+-])/, (_m, v, sg) => `${v} ${sg === "+" ? "-" : "+"}`) }));
}
