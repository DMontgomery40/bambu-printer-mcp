/**
 * Does the object stay in, and what does it take to pull it out: rigid-body statics with Coulomb friction
 * as a small linear program, not a time-stepping simulation.
 *
 * The object (a closed triangle mesh, e.g. the scan) gives its mass properties by the divergence theorem
 * and a set of surface sample points. The part gives a signed distance. Candidate contacts are the
 * sample points within `band` of the part's surface (the clearance band: the object can settle onto any
 * of them without turning appreciably). Each contact force lies in a friction pyramid with `edges` edges
 * (an inner approximation of the cone: friction is underestimated by at most 1 - cos(pi/edges), 1.9% for
 * 16 edges, and exactly zero in the planes of the edges). The object "stays" at a tilt if forces in the
 * pyramids can balance gravity in force and moment (an LP feasibility problem); the largest pull it
 * resists in a direction is the LP's maximum load multiplier. This is "possible equilibrium": for rigid
 * contacts with friction it is the standard statics criterion; it does not decide which of several
 * possible force distributions nature picks, and it ignores how the object got there.
 */
// ---------------------------------------------------------------- linear programming (dense, two-phase simplex)
/** maximize c.x subject to A x = b, x >= 0. A is m x n row-major. Returns null if infeasible; value Infinity if unbounded. */
export function simplex(A, b, c, maxIt = 20000) {
    const m = A.length, n = c.length;
    // tableau with artificials: rows m, columns n + m + 1 (rhs)
    const T = [];
    for (let i = 0; i < m; i++) {
        const sgn = b[i] < 0 ? -1 : 1;
        const row = new Array(n + m + 1).fill(0);
        for (let j = 0; j < n; j++)
            row[j] = sgn * A[i][j];
        row[n + i] = 1;
        row[n + m] = sgn * b[i];
        T.push(row);
    }
    const basis = Array.from({ length: m }, (_, i) => n + i);
    const pivot = (r, col) => {
        const pr = T[r], pv = pr[col];
        for (let j = 0; j <= n + m; j++)
            pr[j] /= pv;
        for (let i = 0; i < m; i++)
            if (i !== r) {
                const f = T[i][col];
                if (f !== 0) {
                    const ri = T[i];
                    for (let j = 0; j <= n + m; j++)
                        ri[j] -= f * pr[j];
                }
            }
        basis[r] = col;
    };
    const run = (cost, allowed) => {
        const inBasis = new Uint8Array(n + m);
        for (const j of basis)
            inBasis[j] = 1;
        let degenerate = 0;
        for (let it = 0; it < maxIt; it++) {
            // reduced costs for maximisation: r_j = cost_j - sum_i cost_basis_i T_ij ; Dantzig's rule, Bland's after a degenerate run
            const bland = degenerate > 30;
            let enter = -1, bestR = 1e-10;
            for (let j = 0; j < n + m; j++) {
                if (!allowed(j) || inBasis[j])
                    continue;
                let rj = cost[j];
                for (let i = 0; i < m; i++)
                    rj -= cost[basis[i]] * T[i][j];
                if (rj > bestR) {
                    enter = j;
                    bestR = rj;
                    if (bland)
                        break;
                }
            }
            if (enter < 0)
                return true;
            let leave = -1, best = Infinity;
            for (let i = 0; i < m; i++) {
                const a = T[i][enter];
                if (a > 1e-12) {
                    const ratio = T[i][n + m] / a;
                    if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && leave >= 0 && basis[i] < basis[leave])) {
                        best = ratio;
                        leave = i;
                    }
                }
            }
            if (leave < 0)
                return false; // unbounded
            degenerate = best < 1e-12 ? degenerate + 1 : 0;
            inBasis[basis[leave]] = 0;
            inBasis[enter] = 1;
            pivot(leave, enter);
        }
        throw new Error("simplex: iteration limit");
    };
    // phase 1: maximize -sum(artificials)
    const c1 = new Array(n + m).fill(0);
    for (let i = 0; i < m; i++)
        c1[n + i] = -1;
    run(c1, () => true);
    let infeas = 0;
    for (let i = 0; i < m; i++)
        if (basis[i] >= n)
            infeas += T[i][n + m];
    const scale = Math.max(1, ...b.map(Math.abs));
    if (infeas > 1e-9 * scale)
        return null;
    // drive remaining artificials out of the basis where possible
    for (let i = 0; i < m; i++)
        if (basis[i] >= n) {
            for (let j = 0; j < n; j++)
                if (Math.abs(T[i][j]) > 1e-10) {
                    pivot(i, j);
                    break;
                }
        }
    const c2 = [...c, ...new Array(m).fill(0)];
    const bounded = run(c2, (j) => j < n);
    const x = new Array(n).fill(0);
    for (let i = 0; i < m; i++)
        if (basis[i] < n)
            x[basis[i]] = T[i][n + m];
    if (!bounded)
        return { x, value: Infinity };
    return { x, value: c.reduce((s, cj, j) => s + cj * x[j], 0) };
}
export function massProperties(m, density = 1) {
    const p = m.positions, idx = m.indices;
    let v6 = 0, cx = 0, cy = 0, cz = 0;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const d = p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
        v6 += d;
        cx += d * (p[a] + p[b] + p[c]);
        cy += d * (p[a + 1] + p[b + 1] + p[c + 1]);
        cz += d * (p[a + 2] + p[b + 2] + p[c + 2]);
    }
    const vol = v6 / 6;
    return { volume: vol, mass: vol * density, cg: [cx / (4 * v6), cy / (4 * v6), cz / (4 * v6)] };
}
/**
 * Surface samples with the object's outward normal: points inside every triangle on a grid of about
 * `spacing`, kept `inset` (relative) away from its edges, so every sample lies on one face and carries
 * that face's normal (an edge or corner of the object is represented by samples just inside its faces).
 */
export function sampleSurface(m, spacing, inset = 1e-4) {
    const p = m.positions, idx = m.indices, out = [];
    for (let t = 0; t < idx.length; t += 3) {
        const A = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]], B = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]], C = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
        const nrm = crossV(sub(B, A), sub(C, A)), area2 = Math.hypot(...nrm);
        if (area2 < 1e-14)
            continue;
        const n = [nrm[0] / area2, nrm[1] / area2, nrm[2] / area2];
        const L = Math.max(Math.hypot(...sub(B, A)), Math.hypot(...sub(C, B)), Math.hypot(...sub(A, C)));
        const k = Math.max(1, Math.ceil(L / spacing));
        for (let i = 0; i <= k; i++)
            for (let j = 0; i + j <= k; j++) {
                // barycentric grid including the corners, then pulled towards the centroid by `inset`
                let a = i / k, b = j / k, c = 1 - a - b;
                a = inset / 3 + (1 - inset) * a;
                b = inset / 3 + (1 - inset) * b;
                c = inset / 3 + (1 - inset) * c;
                out.push({ p: [a * A[0] + b * B[0] + c * C[0], a * A[1] + b * B[1] + c * C[1], a * A[2] + b * B[2] + c * C[2]], n });
            }
    }
    return out;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
function generators(P, mu) {
    const k = P.edges ?? 16;
    const cols = [];
    for (const c of P.contacts) {
        const cmu = Math.min(mu, c.mu ?? mu);
        const n = unit(c.n);
        const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const t1 = unit(crossV(ref, n)), t2 = crossV(n, t1);
        const r = sub(c.p, P.cg);
        const dirs = [];
        if (cmu <= 0)
            dirs.push(n);
        else
            for (let j = 0; j < k; j++) {
                const a = (2 * Math.PI * j) / k;
                dirs.push([n[0] + cmu * (Math.cos(a) * t1[0] + Math.sin(a) * t2[0]), n[1] + cmu * (Math.cos(a) * t1[1] + Math.sin(a) * t2[1]), n[2] + cmu * (Math.cos(a) * t1[2] + Math.sin(a) * t2[2])]);
            }
        for (const d0 of dirs) {
            const d = unit(d0);
            const m = crossV(r, d);
            cols.push([d[0], d[1], d[2], m[0], m[1], m[2]]);
        }
    }
    return { cols };
}
/** Can contact forces balance gravity acting along `g` (unit, world)? */
export function canBalance(P, g, mu = P.mu) {
    const { cols } = generators(P, mu);
    if (!cols.length)
        return false;
    const A = Array.from({ length: 6 }, (_, i) => cols.map((c) => c[i]));
    // sum f + W g = 0, sum r x f + 0 = 0 (gravity acts at the cg)
    const b = [-P.weight * g[0], -P.weight * g[1], -P.weight * g[2], 0, 0, 0];
    return simplex(A, b, new Array(cols.length).fill(0)) !== null;
}
/** Largest extra force s * dir (N) applied at `at` that contacts and gravity can still hold. */
export function maxHold(P, g, dir, at, mu = P.mu) {
    const { cols } = generators(P, mu);
    const r = sub(at, P.cg), d = unit(dir), m = crossV(r, d);
    const n = cols.length;
    // variables: lambda (n), s ; A [lambda; s] = b  where  sum f + s d = -W g, sum r x f + s (r x d) = 0
    const A = Array.from({ length: 6 }, (_, i) => [...cols.map((c) => c[i]), [d[0], d[1], d[2], m[0], m[1], m[2]][i]]);
    const b = [-P.weight * g[0], -P.weight * g[1], -P.weight * g[2], 0, 0, 0];
    const c = new Array(n + 1).fill(0);
    c[n] = 1;
    const r0 = simplex(A, b, c);
    if (!r0)
        return -1;
    return r0.value;
}
/** Gravity direction after tilting the part by `deg` about the horizontal axis `axis` (right-hand rule). */
export function tiltedGravity(deg, axis = [1, 0, 0]) {
    const a = (deg * Math.PI) / 180, k = unit(axis), v = [0, 0, -1];
    // Rodrigues: rotating the part by +a equals rotating gravity by -a in the part's frame
    const c = Math.cos(-a), s = Math.sin(-a), kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], kx = crossV(k, v);
    return [v[0] * c + kx[0] * s + k[0] * kv * (1 - c), v[1] * c + kx[1] * s + k[1] * kv * (1 - c), v[2] * c + kx[2] * s + k[2] * kv * (1 - c)];
}
/** Largest tilt (degrees, about `axis`) at which the object can still be held; mode of the first loss. */
export function tiltLimit(P, axis = [1, 0, 0], maxDeg = 180, step = 1) {
    let lo = 0, checked = 0;
    if (!canBalance(P, tiltedGravity(0, axis)))
        return { angle: 0, mode: "tips or falls out", checked: 1 };
    let hi = -1;
    for (let d = step; d <= maxDeg + 1e-9; d += step) {
        checked++;
        if (!canBalance(P, tiltedGravity(d, axis))) {
            hi = d;
            break;
        }
        lo = d;
    }
    if (hi < 0)
        return { angle: maxDeg, mode: "stays", checked };
    for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        checked++;
        if (canBalance(P, tiltedGravity(m, axis)))
            lo = m;
        else
            hi = m;
    }
    const g = tiltedGravity(hi + 1e-6, axis);
    const slides = canBalance(P, g, 50);
    return { angle: lo, mode: slides ? "slides" : "tips or falls out", checked };
}
/**
 * Contacts between object samples and a part given by its signed distance. The contact normal is the
 * part's surface normal (the distance gradient) where the part's surface is smooth; where the part has an
 * edge or corner there (the gradient is not of unit length, e.g. the top edge of a lip pressing on the
 * object's face) the object's face normal is used instead.
 */
export function contactsFromDistance(points, dist, band, touching = 0.05) {
    const out = [], e = 1e-4;
    for (const q of points) {
        const p = Array.isArray(q) ? q : q.p, no = Array.isArray(q) ? null : q.n;
        const d = dist(p[0], p[1], p[2]);
        if (d > band || d < -band)
            continue;
        const g = [(dist(p[0] + e, p[1], p[2]) - dist(p[0] - e, p[1], p[2])) / (2 * e), (dist(p[0], p[1] + e, p[2]) - dist(p[0], p[1] - e, p[2])) / (2 * e), (dist(p[0], p[1], p[2] + e) - dist(p[0], p[1], p[2] - e)) / (2 * e)];
        const l = Math.hypot(...g);
        // a contact that exists only inside the clearance band (the object could settle onto it) gets no friction:
        // the object cannot press both walls of a pocket at once, so friction there would be invented
        const extra = d > touching ? { gap: d, mu: 0 } : { gap: d };
        if (l > 0.95 && l < 1.05)
            out.push({ p, n: [g[0] / l, g[1] / l, g[2] / l], ...extra });
        else if (no)
            out.push({ p, n: [-no[0], -no[1], -no[2]], ...extra });
        else if (l > 1e-9)
            out.push({ p, n: [g[0] / l, g[1] / l, g[2] / l], ...extra });
    }
    return out;
}
/** A closed box mesh (outward triangles), for tests and simple objects. */
export function boxMesh(min, max) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const P = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
    const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    return { positions: P, indices: I };
}
/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection, 5.1.5). */
function closestOnTriangle(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const dt = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const d1 = dt(ab, ap), d2 = dt(ac, ap);
    if (d1 <= 0 && d2 <= 0)
        return a;
    const bp = sub(p, b), d3 = dt(ab, bp), d4 = dt(ac, bp);
    if (d3 >= 0 && d4 <= d3)
        return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
    }
    const cp = sub(p, c), d5 = dt(ab, cp), d6 = dt(ac, cp);
    if (d6 >= 0 && d5 <= d6)
        return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
    }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
/**
 * Contacts where the part's sharp edges (a lip's top edge, a cup's rim) touch the object's faces: each
 * edge sample within `band` of the object's surface gives a contact at the closest point on the object,
 * with the object's face normal (reversed). Object samples alone place such a pivot only to within the
 * sample spacing.
 */
export function contactsFromPartEdges(edgePoints, object, band) {
    const p = object.positions, idx = object.indices, out = [];
    for (const q of edgePoints) {
        let best = Infinity, bp = null, bn = [0, 0, 0];
        for (let t = 0; t < idx.length; t += 3) {
            const a = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]], b = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]], c = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
            const cp = closestOnTriangle(q, a, b, c), d = Math.hypot(...sub(q, cp));
            if (d < best) {
                best = d;
                bp = cp;
                bn = unit(crossV(sub(b, a), sub(c, a)));
            }
        }
        if (bp && best <= band)
            out.push({ p: bp, n: [-bn[0], -bn[1], -bn[2]], gap: best, ...(best > 0.05 ? { mu: 0 } : {}) });
    }
    return out;
}
/** Feature edges of a part mesh (dihedral angle above `deg`), sampled every `spacing` mm. */
export function featureEdgeSamples(m, deg = 30, spacing = 1) {
    const p = m.positions, idx = m.indices;
    const fn = [];
    for (let t = 0; t < idx.length; t += 3) {
        const a = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]], b = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]], c = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
        fn.push(unit(crossV(sub(b, a), sub(c, a))));
    }
    const edges = new Map();
    for (let t = 0; t < idx.length; t += 3)
        for (let e = 0; e < 3; e++) {
            const i = idx[t + e], j = idx[t + ((e + 1) % 3)], k = i < j ? `${i},${j}` : `${j},${i}`;
            (edges.get(k) ?? edges.set(k, []).get(k)).push(t / 3);
        }
    const cosT = Math.cos((deg * Math.PI) / 180), out = [];
    for (const [k, fs] of edges) {
        if (fs.length === 2) {
            const a = fn[fs[0]], b = fn[fs[1]];
            if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > cosT)
                continue;
        }
        const [i, j] = k.split(",").map(Number);
        const A = [p[3 * i], p[3 * i + 1], p[3 * i + 2]], B = [p[3 * j], p[3 * j + 1], p[3 * j + 2]];
        const n = Math.max(1, Math.ceil(Math.hypot(...sub(B, A)) / spacing));
        for (let s = 0; s <= n; s++)
            out.push([A[0] + (s / n) * (B[0] - A[0]), A[1] + (s / n) * (B[1] - A[1]), A[2] + (s / n) * (B[2] - A[2])]);
    }
    return out;
}
/** A closed prism mesh from a convex outline (counter-clockwise, x-y) between z0 and z1: a simple object stand-in. */
export function prismMesh(outline, z0, z1) {
    const n = outline.length, P = [], I = [];
    for (const [x, y] of outline)
        P.push(x, y, z0);
    for (const [x, y] of outline)
        P.push(x, y, z1);
    for (let i = 1; i + 1 < n; i++) {
        I.push(0, i + 1, i);
        I.push(n, n + i, n + i + 1);
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        I.push(i, j, n + j, i, n + j, n + i);
    }
    return { positions: P, indices: I };
}
/** Rounded rectangle outline centred at (cx, cy), size w x d, corner radius r, `seg` segments per corner. */
export function roundedRect(w, d, r, cx = 0, cy = 0, seg = 8) {
    const out = [];
    const cs = [[w / 2 - r, -d / 2 + r, -90], [w / 2 - r, d / 2 - r, 0], [-w / 2 + r, d / 2 - r, 90], [-w / 2 + r, -d / 2 + r, 180]];
    for (const [x, y, a0] of cs)
        for (let k = 0; k <= seg; k++) {
            const a = ((a0 + (90 * k) / seg) * Math.PI) / 180;
            out.push([cx + x + r * Math.cos(a), cy + y + r * Math.sin(a)]);
        }
    return out;
}
