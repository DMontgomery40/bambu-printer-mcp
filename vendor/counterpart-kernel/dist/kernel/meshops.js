/**
 * Operations on scan meshes.
 * - planeCutCap: clips triangles by a plane (keeping the scan's own triangles elsewhere untouched),
 *   chains the cut edges into loops and closes them with ear-clipped caps (Meisters 1975).
 * - smoothRegion: Taubin lambda|mu smoothing (Taubin, SIGGRAPH 1995, "A signal processing approach to
 *   fair surface design") applied only to weighted vertices; weight 0 vertices are not touched at all.
 * - fitCylinder: least squares on |(p - c) x d| - r with Levenberg-Marquardt (Marquardt 1963) from a
 *   principal-axis start (eigenvectors of the covariance, cyclic Jacobi).
 * - minGap / interference: vertex-to-surface distances through the BVH both ways; interference volume
 *   by contouring max(fA, fB) of the two signed distance fields.
 */
import { Mesh } from "./mesh.js";
import { BVH } from "./bvh.js";
import { KernelError } from "./profile.js";
export function planeCutCap(mesh, n, d) {
    const p = mesh.positions, idx = mesh.indices, nv = p.length / 3;
    const s = new Float64Array(nv);
    for (let i = 0; i < nv; i++) {
        let v = n[0] * p[3 * i] + n[1] * p[3 * i + 1] + n[2] * p[3 * i + 2] - d;
        if (v === 0)
            v = 1e-12; // vertices exactly on the plane count as outside (removed side)
        s[i] = v;
    }
    const pos = Array.from(p);
    const out = [];
    const edgeVert = new Map();
    const cut = (a, b) => {
        const key = Math.min(a, b) * nv + Math.max(a, b);
        let id = edgeVert.get(key);
        if (id === undefined) {
            const t = s[a] / (s[a] - s[b]);
            id = pos.length / 3;
            pos.push(p[3 * a] + t * (p[3 * b] - p[3 * a]), p[3 * a + 1] + t * (p[3 * b + 1] - p[3 * a + 1]), p[3 * a + 2] + t * (p[3 * b + 2] - p[3 * a + 2]));
            edgeVert.set(key, id);
        }
        return id;
    };
    const boundary = new Map(); // directed cut edge start -> end (as used by kept triangles)
    for (let t = 0; t < idx.length; t += 3) {
        const v = [idx[t], idx[t + 1], idx[t + 2]];
        const inside = v.map((i) => s[i] < 0);
        const k = inside.filter(Boolean).length;
        if (k === 3) {
            out.push(v[0], v[1], v[2]);
            continue;
        }
        if (k === 0)
            continue;
        // rotate so the pattern starts at a distinguished vertex
        let r = 0;
        if (k === 1)
            r = inside.indexOf(true);
        else
            r = inside.indexOf(false);
        const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3];
        if (k === 1) {
            const ab = cut(a, b), ac = cut(a, c);
            out.push(a, ab, ac);
            boundary.set(ab, ac);
        }
        else {
            // a outside, b and c inside
            const ab = cut(a, b), ca = cut(c, a);
            out.push(ab, b, c, ab, c, ca);
            boundary.set(ca, ab);
        }
    }
    // chain loops
    const loops = [];
    const seen = new Set();
    for (const start of boundary.keys()) {
        if (seen.has(start))
            continue;
        const loop = [];
        let cur = start;
        while (!seen.has(cur)) {
            seen.add(cur);
            loop.push(cur);
            const nx = boundary.get(cur);
            if (nx === undefined)
                throw new KernelError("plane cut: the cut edges do not form closed loops (the input mesh is not closed).");
            cur = nx;
        }
        loops.push(loop);
    }
    // 2D frame in the plane
    const [ux, uy, uz] = Math.abs(n[0]) < 0.9 ? normalize(cross3(n, [1, 0, 0])) : normalize(cross3(n, [0, 1, 0]));
    const [vx, vy, vz] = cross3(n, [ux, uy, uz]);
    for (const loop of loops) {
        // cap must use each cut edge reversed: traverse the loop backwards
        const rev = [...loop].reverse();
        const pts = rev.map((i) => [pos[3 * i] * ux + pos[3 * i + 1] * uy + pos[3 * i + 2] * uz, pos[3 * i] * vx + pos[3 * i + 1] * vy + pos[3 * i + 2] * vz]);
        for (const [a, b, c] of earClip2(pts))
            out.push(rev[a], rev[b], rev[c]);
    }
    return compact(new Mesh(Float64Array.from(pos), Uint32Array.from(out)));
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
/** Ear clipping of a simple polygon given in either orientation; returns index triples in input order orientation. */
export function earClip2(pts) {
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        area += a[0] * b[1] - b[0] * a[1];
    }
    const sign = area >= 0 ? 1 : -1;
    const idx = Array.from({ length: n }, (_, i) => i);
    const cr = (a, b, c) => sign * ((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]));
    const out = [];
    let guard = 0;
    let i = 0;
    while (idx.length > 3 && guard < 4 * n * n) {
        guard++;
        const m = idx.length;
        const ia = idx[(i + m - 1) % m], ib = idx[i % m], ic = idx[(i + 1) % m];
        let ear = cr(ia, ib, ic) > 1e-14;
        if (ear)
            for (const q of idx) {
                if (q === ia || q === ib || q === ic)
                    continue;
                if (cr(ia, ib, q) >= 0 && cr(ib, ic, q) >= 0 && cr(ic, ia, q) >= 0) {
                    ear = false;
                    break;
                }
            }
        if (ear) {
            out.push([ia, ib, ic]);
            idx.splice(i % m, 1);
            i = Math.max(0, (i % m) - 1);
        }
        else
            i = (i + 1) % m;
    }
    if (idx.length === 3)
        out.push([idx[0], idx[1], idx[2]]);
    return out;
}
export function compact(m) {
    const nv = m.positions.length / 3;
    const remap = new Int32Array(nv).fill(-1);
    const pos = [];
    const idx = new Uint32Array(m.indices.length);
    for (let i = 0; i < m.indices.length; i++) {
        const v = m.indices[i];
        if (remap[v] < 0) {
            remap[v] = pos.length / 3;
            pos.push(m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]);
        }
        idx[i] = remap[v];
    }
    return new Mesh(Float64Array.from(pos), idx);
}
export function vertexNeighbours(m) {
    const nv = m.positions.length / 3;
    const nb = Array.from({ length: nv }, () => new Set());
    const idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        nb[a].add(b);
        nb[a].add(c);
        nb[b].add(a);
        nb[b].add(c);
        nb[c].add(a);
        nb[c].add(b);
    }
    return nb.map((s) => [...s]);
}
/** Taubin smoothing of the vertices with weight > 0 (weight scales the step: a soft region edge). */
export function smoothRegion(m, weight, iterations = 10, lambda = 0.5, mu = -0.53) {
    const nb = vertexNeighbours(m);
    const P = m.positions.slice();
    const tmp = new Float64Array(P.length);
    const active = [];
    for (let i = 0; i < weight.length; i++)
        if (weight[i] > 0)
            active.push(i);
    for (let it = 0; it < 2 * iterations; it++) {
        const f = it % 2 === 0 ? lambda : mu;
        for (const i of active) {
            const ns = nb[i];
            let sx = 0, sy = 0, sz = 0;
            for (const j of ns) {
                sx += P[3 * j];
                sy += P[3 * j + 1];
                sz += P[3 * j + 2];
            }
            const k = ns.length || 1, w = weight[i] * f;
            tmp[3 * i] = P[3 * i] + w * (sx / k - P[3 * i]);
            tmp[3 * i + 1] = P[3 * i + 1] + w * (sy / k - P[3 * i + 1]);
            tmp[3 * i + 2] = P[3 * i + 2] + w * (sz / k - P[3 * i + 2]);
        }
        for (const i of active) {
            P[3 * i] = tmp[3 * i];
            P[3 * i + 1] = tmp[3 * i + 1];
            P[3 * i + 2] = tmp[3 * i + 2];
        }
    }
    return new Mesh(P, m.indices.slice());
}
/** Least-squares cylinder through points (Levenberg-Marquardt on axis angles, axis point, radius). */
export function fitCylinder(pts) {
    const n = pts.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += pts[3 * i];
        cy += pts[3 * i + 1];
        cz += pts[3 * i + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;
    // principal axis: largest-variance direction (elongated region)
    const C = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
        const x = pts[3 * i] - cx, y = pts[3 * i + 1] - cy, z = pts[3 * i + 2] - cz;
        C[0] += x * x;
        C[1] += x * y;
        C[2] += x * z;
        C[3] += y * y;
        C[4] += y * z;
        C[5] += z * z;
    }
    const { vals, vecs } = eig3(C);
    let k = 0;
    for (let j = 1; j < 3; j++)
        if (vals[j] > vals[k])
            k = j;
    let d = [vecs[k], vecs[3 + k], vecs[6 + k]];
    if (d[2] < 0)
        d = d.map((x) => -x);
    // parameters: theta, phi (axis), a, b (axis point offsets in the plane normal to the start axis), r
    const th0 = Math.acos(Math.max(-1, Math.min(1, d[2]))), ph0 = Math.atan2(d[1], d[0]);
    let par = [th0, ph0, 0, 0, 0];
    const e1 = normalize(cross3(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), e2 = cross3(d, e1);
    const resid = (q, out) => {
        const ax = [Math.sin(q[0]) * Math.cos(q[1]), Math.sin(q[0]) * Math.sin(q[1]), Math.cos(q[0])];
        const px = cx + q[2] * e1[0] + q[3] * e2[0], py = cy + q[2] * e1[1] + q[3] * e2[1], pz = cz + q[2] * e1[2] + q[3] * e2[2];
        for (let i = 0; i < n; i++) {
            const x = pts[3 * i] - px, y = pts[3 * i + 1] - py, z = pts[3 * i + 2] - pz;
            const t = x * ax[0] + y * ax[1] + z * ax[2];
            const rx = x - t * ax[0], ry = y - t * ax[1], rz = z - t * ax[2];
            out[i] = Math.sqrt(rx * rx + ry * ry + rz * rz) - q[4];
        }
    };
    // initial radius: mean distance to the start axis
    const r0 = new Float64Array(n);
    resid(par, r0);
    par[4] = r0.reduce((s, v) => s + v, 0) / n;
    const res = new Float64Array(n), res2 = new Float64Array(n);
    let lam = 1e-3, it = 0;
    resid(par, res);
    let cost = res.reduce((s, v) => s + v * v, 0);
    for (; it < 100; it++) {
        // numeric Jacobian
        const J = [];
        for (let j = 0; j < 5; j++) {
            const h = j < 2 ? 1e-7 : 1e-6;
            const q = par.slice();
            q[j] += h;
            resid(q, res2);
            const col = new Float64Array(n);
            for (let i = 0; i < n; i++)
                col[i] = (res2[i] - res[i]) / h;
            J.push(col);
        }
        const A = Array.from({ length: 5 }, (_, a) => Array.from({ length: 5 }, (_, b) => { let s = 0; for (let i = 0; i < n; i++)
            s += J[a][i] * J[b][i]; return s; }));
        const g = Array.from({ length: 5 }, (_, a) => { let s = 0; for (let i = 0; i < n; i++)
            s += J[a][i] * res[i]; return -s; });
        let improved = false;
        for (let tries = 0; tries < 10; tries++) {
            const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lam) : v)));
            const step = solveN(M, g);
            const q = par.map((v, j) => v + step[j]);
            resid(q, res2);
            const c2 = res2.reduce((s, v) => s + v * v, 0);
            if (c2 < cost) {
                par = q;
                res.set(res2);
                const done = cost - c2 < 1e-14 * (1 + cost);
                cost = c2;
                lam /= 3;
                improved = true;
                if (done)
                    it = 1000;
                break;
            }
            lam *= 4;
        }
        if (!improved)
            break;
    }
    const ax = [Math.sin(par[0]) * Math.cos(par[1]), Math.sin(par[0]) * Math.sin(par[1]), Math.cos(par[0])];
    const pt = [cx + par[2] * e1[0] + par[3] * e2[0], cy + par[2] * e1[1] + par[3] * e2[1], cz + par[2] * e1[2] + par[3] * e2[2]];
    return { point: pt, axis: ax, r: Math.abs(par[4]), rms: Math.sqrt(cost / n), iterations: Math.min(it, 100) };
}
function solveN(A, b) {
    const n = b.length;
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++)
            if (Math.abs(M[r][c]) > Math.abs(M[p][c]))
                p = r;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = 0; r < n; r++) {
            if (r === c || M[c][c] === 0)
                continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++)
                M[r][k] -= f * M[c][k];
        }
    }
    return M.map((r, i) => (r[i] ? r[n] / r[i] : 0));
}
function eig3(c) {
    const m = [c[0], c[1], c[2], c[1], c[3], c[4], c[2], c[4], c[5]];
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let sweep = 0; sweep < 30; sweep++) {
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            const apq = m[3 * p + q];
            if (Math.abs(apq) < 1e-300)
                continue;
            const theta = (m[3 * q + q] - m[3 * p + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
            for (let k = 0; k < 3; k++) {
                const a = m[3 * k + p], b = m[3 * k + q];
                m[3 * k + p] = cs * a - sn * b;
                m[3 * k + q] = sn * a + cs * b;
            }
            for (let k = 0; k < 3; k++) {
                const a = m[3 * p + k], b = m[3 * q + k];
                m[3 * p + k] = cs * a - sn * b;
                m[3 * q + k] = sn * a + cs * b;
            }
            for (let k = 0; k < 3; k++) {
                const a = v[3 * k + p], b = v[3 * k + q];
                v[3 * k + p] = cs * a - sn * b;
                v[3 * k + q] = sn * a + cs * b;
            }
        }
    }
    return { vals: [m[0], m[4], m[8]], vecs: v };
}
/** Minimum vertex-to-surface distance between two meshes, both ways (unsigned; overlap is measured separately). */
export function minGap(a, b, bvhA = new BVH(a), bvhB = new BVH(b)) {
    let best = Infinity;
    const scan = (m, bvh) => {
        const p = m.positions;
        for (let i = 0; i < p.length; i += 3) {
            const d = bvh.closest(p[i], p[i + 1], p[i + 2], best);
            if (d < best)
                best = d;
        }
    };
    scan(a, bvhB);
    scan(b, bvhA);
    return best;
}
