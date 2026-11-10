/**
 * Exact mesh booleans between a scan and a cutter: scan − cutter, scan ∪ cutter, scan ∩ cutter.
 *
 * The scan is a closed, manifold, outward-wound triangle mesh (any size; 100k-300k triangles is the target).
 * The cutter is a kernel solid (or a closed mesh) of a few hundred to a few thousand faces. Scan triangles the
 * cutter does not touch are kept bit-for-bit (same vertex coordinates, same triangles), so the result's
 * surface away from the cut moves by exactly 0.
 *
 * Method (a mesh arrangement restricted to the cutter's neighbourhood, after Attene 2014 / Cherchi et al.
 * 2020 "Fast and robust mesh arrangements using floating-point arithmetic", with indirect predicates):
 *   1. candidate pairs: scan triangles whose boxes meet the cutter's box, against a BVH of cutter triangles;
 *   2. exact triangle-triangle intersection: every sign comes from orientation predicates on the ORIGINAL
 *      double coordinates (float filter with Shewchuk's error bound, exact BigInt fallback). No coordinate is
 *      snapped. Intersection points are of two kinds, (edge of one mesh) ∩ (triangle of the other), and are
 *      named by that pair, so the two sides of a cut curve share their points by identity, not by distance;
 *   3. each touched triangle is re-triangulated in its own plane with the cut segments as constraints
 *      (incremental insertion, Sloan's constraint flips, constrained-Delaunay clean-up), with exact 2D
 *      orientation on the implicit points (homogeneous BigInt coordinates, made on demand behind a filter);
 *   4. classification: a piece next to a cut segment from face f of the other mesh is inside it exactly when
 *      its third vertex is behind f's plane (exact); labels then flood across uncut edges, and whole
 *      components never touched by a cut are classified by their winding number;
 *   5. the kept pieces are assembled; implicit points are rounded to doubles once, at output.
 * Degenerate contacts (a cutter face coplanar with a scan triangle, a vertex exactly on the other surface, an
 * edge exactly through an edge) are detected exactly and resolved by translating the cutter by about 1e-7 mm
 * along a fixed direction and starting again (reported in the stats).
 */
import { Mesh, checkMesh } from "./kernel/mesh.js";
import { KernelError } from "./kernel/profile.js";
import { exactMesh } from "./runner.js";
class Degenerate extends Error {
}
const EPS = 2 ** -53;
const O3B = (7 + 56 * EPS) * EPS;
const CCWB = (3 + 16 * EPS) * EPS;
let exactCount = 0;
// ------------------------------------------------------------------------------------------------
// exact arithmetic on doubles
function fracBits(x) {
    let k = 0;
    while (!Number.isInteger(x)) {
        x *= 2;
        k++;
    }
    return k;
}
function big(x, S) {
    let y = x, k = S;
    while (k > 0) {
        const s = Math.min(k, 400);
        y *= 2 ** s;
        k -= s;
    }
    return BigInt(y);
}
function scaleOf(xs) {
    let S = 0;
    for (let i = 0; i < xs.length; i++) {
        const f = fracBits(xs[i]);
        if (f > S)
            S = f;
    }
    if (S > 900)
        throw new KernelError("scan boolean: a coordinate is too close to zero to represent exactly");
    return S;
}
function toNum(x, shift) {
    let v = Number(x), k = shift;
    while (k > 0) {
        const s = Math.min(k, 400);
        v *= 2 ** -s;
        k -= s;
    }
    return v;
}
/** value and error bound of the last side3 call (for building implicit points) */
let GV = 0, GE = 0;
const SC = new Float64Array(12);
/** sign of ((b-a) x (c-a)) . (d-a): positive when d is in front of the triangle abc (CCW seen from the front). */
function side3(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const cax = cx - ax, cay = cy - ay, caz = cz - az;
    const dax = dx - ax, day = dy - ay, daz = dz - az;
    const t1 = bay * caz, t2 = baz * cay, t3 = baz * cax, t4 = bax * caz, t5 = bax * cay, t6 = bay * cax;
    const det = (t1 - t2) * dax + (t3 - t4) * day + (t5 - t6) * daz;
    const perm = (Math.abs(t1) + Math.abs(t2)) * Math.abs(dax) + (Math.abs(t3) + Math.abs(t4)) * Math.abs(day) + (Math.abs(t5) + Math.abs(t6)) * Math.abs(daz);
    const bound = O3B * perm;
    if (det > bound) {
        GV = det;
        GE = bound;
        return 1;
    }
    if (-det > bound) {
        GV = det;
        GE = bound;
        return -1;
    }
    exactCount++;
    SC[0] = ax;
    SC[1] = ay;
    SC[2] = az;
    SC[3] = bx;
    SC[4] = by;
    SC[5] = bz;
    SC[6] = cx;
    SC[7] = cy;
    SC[8] = cz;
    SC[9] = dx;
    SC[10] = dy;
    SC[11] = dz;
    const S = scaleOf(SC);
    const Ax = big(ax, S), Ay = big(ay, S), Az = big(az, S);
    const Bx = big(bx, S) - Ax, By = big(by, S) - Ay, Bz = big(bz, S) - Az;
    const Cx = big(cx, S) - Ax, Cy = big(cy, S) - Ay, Cz = big(cz, S) - Az;
    const Dx = big(dx, S) - Ax, Dy = big(dy, S) - Ay, Dz = big(dz, S) - Az;
    const D = (By * Cz - Bz * Cy) * Dx + (Bz * Cx - Bx * Cz) * Dy + (Bx * Cy - By * Cx) * Dz;
    GV = toNum(D, 3 * S);
    GE = Math.abs(GV) * 4 * EPS;
    return D > 0n ? 1 : D < 0n ? -1 : 0;
}
// ------------------------------------------------------------------------------------------------
// points: input vertices (exact doubles) and implicit points (edge ∩ plane of a triangle)
class Pt {
    x;
    y;
    z;
    e;
    X = null;
    Y = null;
    Z = null;
    W = null;
    /** for implicit points: the edge endpoints a, b and the triangle p, q, r (15 doubles) */
    g = null;
    constructor(x, y, z, e) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.e = e;
    }
}
function exactify(p) {
    if (p.W !== null)
        return;
    exactCount++;
    if (!p.g) {
        const S = Math.max(fracBits(p.x), fracBits(p.y), fracBits(p.z));
        p.X = big(p.x, S);
        p.Y = big(p.y, S);
        p.Z = big(p.z, S);
        p.W = 1n << BigInt(S);
        return;
    }
    const g = p.g, S = scaleOf(g);
    const v = Array.from(g, (x) => big(x, S));
    const [ax, ay, az, bx, by, bz, px, py, pz, qx, qy, qz, rx, ry, rz] = v;
    const ux = qx - px, uy = qy - py, uz = qz - pz, wx = rx - px, wy = ry - py, wz = rz - pz;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const Da = nx * (ax - px) + ny * (ay - py) + nz * (az - pz);
    const Db = nx * (bx - px) + ny * (by - py) + nz * (bz - pz);
    let X = bx * Da - ax * Db, Y = by * Da - ay * Db, Z = bz * Da - az * Db, W = (Da - Db) << BigInt(S);
    if (W < 0n) {
        X = -X;
        Y = -Y;
        Z = -Z;
        W = -W;
    }
    if (W === 0n)
        throw new Degenerate("implicit point at infinity");
    p.X = X;
    p.Y = Y;
    p.Z = Z;
    p.W = W;
}
/** The point where edge (a, b) crosses the plane of triangle (p, q, r) (a and b strictly on opposite sides). */
function implicitPoint(P, ia, ib, Q, ip, iq, ir) {
    const g = new Float64Array(15);
    g[0] = P[3 * ia];
    g[1] = P[3 * ia + 1];
    g[2] = P[3 * ia + 2];
    g[3] = P[3 * ib];
    g[4] = P[3 * ib + 1];
    g[5] = P[3 * ib + 2];
    g[6] = Q[3 * ip];
    g[7] = Q[3 * ip + 1];
    g[8] = Q[3 * ip + 2];
    g[9] = Q[3 * iq];
    g[10] = Q[3 * iq + 1];
    g[11] = Q[3 * iq + 2];
    g[12] = Q[3 * ir];
    g[13] = Q[3 * ir + 1];
    g[14] = Q[3 * ir + 2];
    side3(g[6], g[7], g[8], g[9], g[10], g[11], g[12], g[13], g[14], g[0], g[1], g[2]);
    const da = GV, ea = GE;
    side3(g[6], g[7], g[8], g[9], g[10], g[11], g[12], g[13], g[14], g[3], g[4], g[5]);
    const db = GV, eb = GE;
    const D = da - db;
    const s = da / D;
    const ds = (2 * (ea + eb)) / Math.max(Math.abs(D) - ea - eb, 1e-300) + 8 * EPS;
    const x = g[0] + s * (g[3] - g[0]), y = g[1] + s * (g[4] - g[1]), z = g[2] + s * (g[5] - g[2]);
    const span = Math.max(Math.abs(g[3] - g[0]), Math.abs(g[4] - g[1]), Math.abs(g[5] - g[2]));
    const mag = Math.max(Math.abs(g[0]), Math.abs(g[1]), Math.abs(g[2]), Math.abs(g[3]), Math.abs(g[4]), Math.abs(g[5]));
    let e = 2 * (ds * span + 8 * EPS * (mag + span));
    const p = new Pt(x, y, z, e);
    p.g = g;
    if (!(e < 1e-6 * (mag + 1)) || !Number.isFinite(x + y + z)) {
        exactify(p);
        p.x = Number(p.X) / Number(p.W);
        p.y = Number(p.Y) / Number(p.W);
        p.z = Number(p.Z) / Number(p.W);
        e = 8 * EPS * Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
        if (!Number.isFinite(p.x + p.y + p.z)) {
            p.x = toNum(p.X, 0) / toNum(p.W, 0);
        }
        p.e = e;
    }
    return p;
}
/** Exact sign of the point's side of the plane of triangle (f0, f1, f2) (positive in front). */
function sidePt(F, i0, i1, i2, r) {
    const ax = F[3 * i0], ay = F[3 * i0 + 1], az = F[3 * i0 + 2];
    if (r.e === 0)
        return side3(ax, ay, az, F[3 * i1], F[3 * i1 + 1], F[3 * i1 + 2], F[3 * i2], F[3 * i2 + 1], F[3 * i2 + 2], r.x, r.y, r.z);
    const bax = F[3 * i1] - ax, bay = F[3 * i1 + 1] - ay, baz = F[3 * i1 + 2] - az;
    const cax = F[3 * i2] - ax, cay = F[3 * i2 + 1] - ay, caz = F[3 * i2 + 2] - az;
    const dax = r.x - ax, day = r.y - ay, daz = r.z - az;
    const nx = bay * caz - baz * cay, ny = baz * cax - bax * caz, nz = bax * cay - bay * cax;
    const det = nx * dax + ny * day + nz * daz;
    const perm = (Math.abs(bay * caz) + Math.abs(baz * cay)) * Math.abs(dax) + (Math.abs(baz * cax) + Math.abs(bax * caz)) * Math.abs(day) + (Math.abs(bax * cay) + Math.abs(bay * cax)) * Math.abs(daz);
    const bound = O3B * perm * 1.01 + (Math.abs(nx) + Math.abs(ny) + Math.abs(nz)) * r.e * 1.01 + 1e-300;
    if (det > bound)
        return 1;
    if (-det > bound)
        return -1;
    exactCount++;
    exactify(r);
    const fs = [ax, ay, az, F[3 * i1], F[3 * i1 + 1], F[3 * i1 + 2], F[3 * i2], F[3 * i2 + 1], F[3 * i2 + 2]];
    const S = scaleOf(fs);
    const A = fs.map((x) => big(x, S));
    const ux = A[3] - A[0], uy = A[4] - A[1], uz = A[5] - A[2], wx = A[6] - A[0], wy = A[7] - A[1], wz = A[8] - A[2];
    const Nx = uy * wz - uz * wy, Ny = uz * wx - ux * wz, Nz = ux * wy - uy * wx;
    const sh = BigInt(S);
    const D = Nx * ((r.X << sh) - A[0] * r.W) + Ny * ((r.Y << sh) - A[1] * r.W) + Nz * ((r.Z << sh) - A[2] * r.W);
    return D > 0n ? 1 : D < 0n ? -1 : 0;
}
// ------------------------------------------------------------------------------------------------
// constrained triangulation of one triangle in its plane
/** 2D orientation of three points projected along `axis` (sigma makes the parent triangle positive). */
function orient2(p, q, r, axis, sigma) {
    const pu = axis === 0 ? p.y : axis === 1 ? p.z : p.x, pv = axis === 0 ? p.z : axis === 1 ? p.x : p.y;
    const qu = axis === 0 ? q.y : axis === 1 ? q.z : q.x, qv = axis === 0 ? q.z : axis === 1 ? q.x : q.y;
    const ru = axis === 0 ? r.y : axis === 1 ? r.z : r.x, rv = axis === 0 ? r.z : axis === 1 ? r.x : r.y;
    const a = qu - pu, b = rv - pv, c = qv - pv, d = ru - pu;
    const l = a * b, rr = c * d;
    const det = l - rr;
    const E = p.e + q.e + r.e;
    let bound = CCWB * (Math.abs(l) + Math.abs(rr));
    if (E > 0) {
        const L = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(ru - qu), Math.abs(rv - qv));
        bound = bound * 1.01 + 8 * L * E + 8 * E * E + 1e-300;
    }
    if (det > bound)
        return sigma;
    if (-det > bound)
        return -sigma;
    exactCount++;
    exactify(p);
    exactify(q);
    exactify(r);
    const U = (t) => (axis === 0 ? t.Y : axis === 1 ? t.Z : t.X), V = (t) => (axis === 0 ? t.Z : axis === 1 ? t.X : t.Y);
    const u1 = U(p), v1 = V(p), w1 = p.W, u2 = U(q), v2 = V(q), w2 = q.W, u3 = U(r), v3 = V(r), w3 = r.W;
    const D = u1 * (v2 * w3 - w2 * v3) - v1 * (u2 * w3 - w2 * u3) + w1 * (u2 * v3 - v2 * u3);
    const s = D > 0n ? 1 : D < 0n ? -1 : 0;
    return s * sigma;
}
function incircleF(p, q, r, s, axis, sigma) {
    const U = (t) => (axis === 0 ? t.y : axis === 1 ? t.z : t.x), V = (t) => (axis === 0 ? t.z : axis === 1 ? t.x : t.y);
    const su = U(s), sv = V(s);
    const adx = U(p) - su, ady = V(p) - sv, bdx = U(q) - su, bdy = V(q) - sv, cdx = U(r) - su, cdy = V(r) - sv;
    const al = adx * adx + ady * ady, bl = bdx * bdx + bdy * bdy, cl = cdx * cdx + cdy * cdy;
    return sigma * (adx * (bdy * cl - bl * cdy) - ady * (bdx * cl - bl * cdx) + al * (bdx * cdy - bdy * cdx));
}
/**
 * Triangulates the triangle (corners 0, 1, 2 of `pts`, CCW after sigma) with every other point inserted and
 * every segment present as an edge. Returns local triangles (CCW) as a flat array.
 */
function triangulateConstrained(pts, segs, axis, sigma) {
    const n = pts.length;
    const T = [0, 1, 2];
    const o = (a, b, c) => orient2(pts[a], pts[b], pts[c], axis, sigma);
    for (let i = 3; i < n; i++) {
        let done = false;
        for (let k = 0; k < T.length && !done; k += 3) {
            const a = T[k], b = T[k + 1], c = T[k + 2];
            const o1 = o(a, b, i);
            if (o1 < 0)
                continue;
            const o2 = o(b, c, i);
            if (o2 < 0)
                continue;
            const o3 = o(c, a, i);
            if (o3 < 0)
                continue;
            const zeros = (o1 === 0 ? 1 : 0) + (o2 === 0 ? 1 : 0) + (o3 === 0 ? 1 : 0);
            if (zeros >= 2)
                throw new Degenerate("coincident points in a triangle");
            if (zeros === 0) {
                T[k + 2] = i;
                T.push(b, c, i, c, a, i);
            }
            else {
                // on edge (u, v) of this triangle, w opposite
                const [u, v, w] = o1 === 0 ? [a, b, c] : o2 === 0 ? [b, c, a] : [c, a, b];
                T[k] = u;
                T[k + 1] = i;
                T[k + 2] = w;
                T.push(i, v, w);
                // the triangle across (v, u), if any
                for (let m = 0; m < T.length; m += 3) {
                    const j = T[m] === v && T[m + 1] === u ? 0 : T[m + 1] === v && T[m + 2] === u ? 1 : T[m + 2] === v && T[m] === u ? 2 : -1;
                    if (j < 0)
                        continue;
                    const x = T[m + ((j + 2) % 3)];
                    T[m] = v;
                    T[m + 1] = i;
                    T[m + 2] = x;
                    T.push(i, u, x);
                    break;
                }
            }
            done = true;
        }
        if (!done)
            throw new Degenerate("point outside its triangle");
    }
    // directed edge -> triangle
    const M = n;
    const E = new Map();
    const setT = (k) => { E.set(T[k] * M + T[k + 1], k); E.set(T[k + 1] * M + T[k + 2], k); E.set(T[k + 2] * M + T[k], k); };
    for (let k = 0; k < T.length; k += 3)
        setT(k);
    const third = (k, a, b) => { for (let j = 0; j < 3; j++) {
        const x = T[k + j];
        if (x !== a && x !== b)
            return x;
    } return -1; };
    const cons = new Set();
    for (const [p, q] of segs) {
        cons.add(p * M + q);
        cons.add(q * M + p);
    }
    /** flip edge (u, v): triangles (u, v, c) and (v, u, d) become (u, d, c) and (v, c, d). */
    const flip = (u, v) => {
        const k1 = E.get(u * M + v), k2 = E.get(v * M + u);
        if (k1 === undefined || k2 === undefined)
            return false;
        const c = third(k1, u, v), d = third(k2, u, v);
        if (o(u, d, c) <= 0 || o(v, c, d) <= 0)
            return false;
        E.delete(u * M + v);
        E.delete(v * M + u);
        T[k1] = u;
        T[k1 + 1] = d;
        T[k1 + 2] = c;
        T[k2] = v;
        T[k2 + 1] = c;
        T[k2 + 2] = d;
        setT(k1);
        setT(k2);
        return true;
    };
    const lawson = () => {
        const stack = [];
        for (let k = 0; k < T.length; k += 3)
            for (let j = 0; j < 3; j++) {
                const a = T[k + j], b = T[k + (j + 1) % 3];
                if (a < b)
                    stack.push(a, b);
            }
        let guard = 0;
        while (stack.length && guard++ < 50 * n + 200) {
            const b = stack.pop(), a = stack.pop();
            if (cons.has(a * M + b))
                continue;
            const k1 = E.get(a * M + b), k2 = E.get(b * M + a);
            if (k1 === undefined || k2 === undefined)
                continue;
            const c = third(k1, a, b), d = third(k2, a, b);
            if (incircleF(pts[a], pts[b], pts[c], pts[d], axis, sigma) <= 0)
                continue;
            if (flip(a, b))
                stack.push(a, d, d, b, b, c, c, a);
        }
    };
    lawson();
    // segment crossing (u, v) strictly; a vertex strictly inside the segment is a degeneracy
    const between = (p, q, u) => {
        // u is on line pq: is it strictly between p and q? compare along the dominant 2D direction with the float coordinates
        const P = pts[p], Q = pts[q], X = pts[u];
        const du = Math.abs(P.x - Q.x) + Math.abs(P.y - Q.y) + Math.abs(P.z - Q.z);
        const t = ((X.x - P.x) * (Q.x - P.x) + (X.y - P.y) * (Q.y - P.y) + (X.z - P.z) * (Q.z - P.z)) / (du * du + 1e-300);
        return t > 0 && t < 1;
    };
    const crosses = (p, q, u, v) => {
        if (u === p || u === q || v === p || v === q)
            return false;
        const s1 = o(p, q, u), s2 = o(p, q, v);
        if (s1 === 0 && between(p, q, u))
            throw new Degenerate("vertex on a constraint");
        if (s2 === 0 && between(p, q, v))
            throw new Degenerate("vertex on a constraint");
        if (s1 * s2 >= 0)
            return false;
        const s3 = o(u, v, p), s4 = o(u, v, q);
        return s3 * s4 < 0;
    };
    for (const [p, q] of segs) {
        if (E.has(p * M + q) || E.has(q * M + p))
            continue;
        const queue = [];
        for (let k = 0; k < T.length; k += 3)
            for (let j = 0; j < 3; j++) {
                const a = T[k + j], b = T[k + (j + 1) % 3];
                if (a < b && crosses(p, q, a, b))
                    queue.push(a, b);
            }
        let guard = 0, head = 0;
        while (head < queue.length) {
            if (guard++ > 20000 + 50 * n * n)
                throw new Degenerate("constraint insertion did not converge");
            const u = queue[head++], v = queue[head++];
            const k1 = E.get(u * M + v);
            if (k1 === undefined) {
                if (E.get(v * M + u) === undefined)
                    continue; // edge was flipped away
                queue.push(v, u);
                continue;
            }
            const k2 = E.get(v * M + u);
            const c = third(k1, u, v), d = third(k2, u, v);
            if (flip(u, v)) {
                if (crosses(p, q, c, d))
                    queue.push(c, d);
            }
            else
                queue.push(u, v);
            if (head > 1 << 20) {
                queue.splice(0, head);
                head = 0;
            }
        }
        if (!E.has(p * M + q) && !E.has(q * M + p))
            throw new Degenerate("constraint missing after insertion");
    }
    lawson();
    return T;
}
// ------------------------------------------------------------------------------------------------
// a small BVH over the cutter's triangles
class TriBVH {
    box;
    lo;
    hi;
    left;
    right;
    start;
    count;
    order;
    nodes = 0;
    constructor(box, n) {
        this.box = box;
        const cap = 2 * n + 1;
        this.lo = new Float64Array(3 * cap);
        this.hi = new Float64Array(3 * cap);
        this.left = new Int32Array(cap);
        this.right = new Int32Array(cap);
        this.start = new Int32Array(cap);
        this.count = new Int32Array(cap);
        this.order = Int32Array.from({ length: n }, (_, i) => i);
        if (n)
            this.build(0, n);
    }
    build(s, e) {
        const id = this.nodes++;
        const { lo, hi, order, box } = this;
        for (let a = 0; a < 3; a++) {
            lo[3 * id + a] = Infinity;
            hi[3 * id + a] = -Infinity;
        }
        for (let i = s; i < e; i++) {
            const t = order[i];
            for (let a = 0; a < 3; a++) {
                lo[3 * id + a] = Math.min(lo[3 * id + a], box[6 * t + a]);
                hi[3 * id + a] = Math.max(hi[3 * id + a], box[6 * t + 3 + a]);
            }
        }
        if (e - s <= 4) {
            this.start[id] = s;
            this.count[id] = e - s;
            this.left[id] = -1;
            return id;
        }
        let ax = 0, ext = -1;
        for (let a = 0; a < 3; a++)
            if (hi[3 * id + a] - lo[3 * id + a] > ext) {
                ext = hi[3 * id + a] - lo[3 * id + a];
                ax = a;
            }
        const sub = Array.from(order.subarray(s, e)).sort((p, q) => (box[6 * p + ax] + box[6 * p + 3 + ax]) - (box[6 * q + ax] + box[6 * q + 3 + ax]));
        order.set(sub, s);
        const m = (s + e) >> 1;
        this.count[id] = 0;
        this.left[id] = this.build(s, m);
        this.right[id] = this.build(m, e);
        return id;
    }
    query(x0, y0, z0, x1, y1, z1, out) {
        if (!this.nodes)
            return;
        const stack = [0];
        const { lo, hi, box, order } = this;
        while (stack.length) {
            const id = stack.pop();
            if (lo[3 * id] > x1 || hi[3 * id] < x0 || lo[3 * id + 1] > y1 || hi[3 * id + 1] < y0 || lo[3 * id + 2] > z1 || hi[3 * id + 2] < z0)
                continue;
            if (this.left[id] < 0) {
                for (let i = this.start[id], e = i + this.count[id]; i < e; i++) {
                    const t = order[i];
                    if (box[6 * t] > x1 || box[6 * t + 3] < x0 || box[6 * t + 1] > y1 || box[6 * t + 4] < y0 || box[6 * t + 2] > z1 || box[6 * t + 5] < z0)
                        continue;
                    out.push(t);
                }
            }
            else {
                stack.push(this.left[id], this.right[id]);
            }
        }
    }
}
// ------------------------------------------------------------------------------------------------
// mesh topology helpers
/** Neighbour across each directed edge: nb[3t + j] is the triangle holding edge (v_{j+1}, v_j). */
function neighbours(I, nv) {
    const nt = I.length / 3;
    const cnt = new Int32Array(nv + 1);
    for (let i = 0; i < I.length; i++)
        cnt[I[i] + 1]++;
    for (let v = 0; v < nv; v++)
        cnt[v + 1] += cnt[v];
    const fill = cnt.slice(0, nv), list = new Int32Array(I.length);
    for (let i = 0; i < I.length; i++)
        list[fill[I[i]]++] = (i / 3) | 0;
    const nb = new Int32Array(I.length).fill(-1);
    for (let t = 0; t < nt; t++)
        for (let j = 0; j < 3; j++) {
            const u = I[3 * t + j], v = I[3 * t + (j + 1) % 3];
            for (let k = cnt[v]; k < cnt[v + 1]; k++) {
                const s = list[k];
                if (s === t)
                    continue;
                const a = I[3 * s], b = I[3 * s + 1], c = I[3 * s + 2];
                if ((a === v && b === u) || (b === v && c === u) || (c === v && a === u)) {
                    nb[3 * t + j] = s;
                    break;
                }
            }
        }
    return nb;
}
/** Generalised winding number of point (x, y, z) with respect to a closed mesh (solid angles). */
function winding(P, I, x, y, z) {
    let w = 0;
    for (let t = 0; t < I.length; t += 3) {
        const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
        const ax = P[a] - x, ay = P[a + 1] - y, az = P[a + 2] - z;
        const bx = P[b] - x, by = P[b + 1] - y, bz = P[b + 2] - z;
        const cx = P[c] - x, cy = P[c + 1] - y, cz = P[c + 2] - z;
        const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
        const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
        w += 2 * Math.atan2(det, den);
    }
    return w / (4 * Math.PI);
}
// ------------------------------------------------------------------------------------------------
// the boolean
function cutterMesh(c) {
    if (c instanceof Mesh)
        return c;
    const p = c.poly;
    if (!p)
        throw new KernelError("scan boolean: the cutter has no polyhedral form (blends, offsets and shells cannot cut a scan exactly)");
    const poly = typeof p === "function" ? p() : p;
    if (!poly || typeof poly.toMesh !== "function")
        throw new KernelError("scan boolean: the cutter must be a solid or a closed mesh");
    return exactMesh(poly);
}
function core(A, B, op, stats) {
    const PA = A.positions, IA = A.indices, PB = B.positions, IB = B.indices;
    const nA = PA.length / 3, nB = PB.length / 3, tA = IA.length / 3, tB = IB.length / 3;
    // cutter triangle boxes and BVH
    const boxB = new Float64Array(6 * tB);
    const gb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let t = 0; t < tB; t++)
        for (let a = 0; a < 3; a++) {
            const x0 = PB[3 * IB[3 * t] + a], x1 = PB[3 * IB[3 * t + 1] + a], x2 = PB[3 * IB[3 * t + 2] + a];
            const lo = Math.min(x0, x1, x2), hi = Math.max(x0, x1, x2);
            boxB[6 * t + a] = lo;
            boxB[6 * t + 3 + a] = hi;
            if (lo < gb[a])
                gb[a] = lo;
            if (hi > gb[3 + a])
                gb[3 + a] = hi;
        }
    const bvh = new TriBVH(boxB, tB);
    // points
    const pts = [];
    const pkey = new Map();
    const base = nA + nB;
    const inputPt = new Map();
    const ptOf = (g) => {
        if (g >= base)
            return pts[g - base];
        let p = inputPt.get(g);
        if (!p) {
            p = g < nA ? new Pt(PA[3 * g], PA[3 * g + 1], PA[3 * g + 2], 0) : new Pt(PB[3 * (g - nA)], PB[3 * (g - nA) + 1], PB[3 * (g - nA) + 2], 0);
            inputPt.set(g, p);
        }
        return p;
    };
    const SA = { P: PA, I: IA, nv: nA, base: 0, segs: new Map() };
    const SB = { P: PB, I: IB, nv: nB, base: nA, segs: new Map() };
    /** edge (u, v) of side X (local vertex ids) pierces triangle f of side Y? Returns the point id or -1. */
    const pierceCache = new Map();
    const pierce = (X, Y, u, v, f) => {
        if (u > v) {
            const t = u;
            u = v;
            v = t;
        }
        const key = `${X === SA ? "a" : "b"}${u},${v},${f}`;
        const hit = pierceCache.get(key);
        if (hit !== undefined)
            return hit;
        const P = X.P, Q = Y.P, J = Y.I;
        const p = J[3 * f], q = J[3 * f + 1], r = J[3 * f + 2];
        const ux = P[3 * u], uy = P[3 * u + 1], uz = P[3 * u + 2], vx = P[3 * v], vy = P[3 * v + 1], vz = P[3 * v + 2];
        const o1 = side3(ux, uy, uz, vx, vy, vz, Q[3 * p], Q[3 * p + 1], Q[3 * p + 2], Q[3 * q], Q[3 * q + 1], Q[3 * q + 2]);
        const o2 = side3(ux, uy, uz, vx, vy, vz, Q[3 * q], Q[3 * q + 1], Q[3 * q + 2], Q[3 * r], Q[3 * r + 1], Q[3 * r + 2]);
        const o3 = side3(ux, uy, uz, vx, vy, vz, Q[3 * r], Q[3 * r + 1], Q[3 * r + 2], Q[3 * p], Q[3 * p + 1], Q[3 * p + 2]);
        let id = -1;
        if ((o1 > 0 && o2 > 0 && o3 > 0) || (o1 < 0 && o2 < 0 && o3 < 0)) {
            const pt = implicitPoint(P, u, v, Q, p, q, r);
            id = base + pts.length;
            pts.push(pt);
            pkey.set(key, id);
        }
        else {
            const pos = (o1 > 0 ? 1 : 0) + (o2 > 0 ? 1 : 0) + (o3 > 0 ? 1 : 0), neg = (o1 < 0 ? 1 : 0) + (o2 < 0 ? 1 : 0) + (o3 < 0 ? 1 : 0);
            if ((pos === 0 || neg === 0) && pos + neg < 3)
                throw new Degenerate("edge through an edge or vertex");
        }
        pierceCache.set(key, id);
        return id;
    };
    const sa = [0, 0, 0], sb = [0, 0, 0];
    const cand = [];
    const [gx0, gy0, gz0, gx1, gy1, gz1] = gb;
    /** scan triangles whose boxes meet the cutter's box; every other scan triangle is outside the cutter */
    const nearA = new Uint8Array(tA);
    for (let t = 0; t < tA; t++) {
        const i0 = 3 * IA[3 * t], i1 = 3 * IA[3 * t + 1], i2 = 3 * IA[3 * t + 2];
        const x0 = Math.min(PA[i0], PA[i1], PA[i2]);
        if (x0 > gx1)
            continue;
        const x1 = Math.max(PA[i0], PA[i1], PA[i2]);
        if (x1 < gx0)
            continue;
        const y0 = Math.min(PA[i0 + 1], PA[i1 + 1], PA[i2 + 1]);
        if (y0 > gy1)
            continue;
        const y1 = Math.max(PA[i0 + 1], PA[i1 + 1], PA[i2 + 1]);
        if (y1 < gy0)
            continue;
        const z0 = Math.min(PA[i0 + 2], PA[i1 + 2], PA[i2 + 2]);
        if (z0 > gz1)
            continue;
        const z1 = Math.max(PA[i0 + 2], PA[i1 + 2], PA[i2 + 2]);
        if (z1 < gz0)
            continue;
        nearA[t] = 1;
        cand.length = 0;
        bvh.query(x0, y0, z0, x1, y1, z1, cand);
        for (const f of cand) {
            stats.candidatePairs++;
            const j0 = 3 * IB[3 * f], j1 = 3 * IB[3 * f + 1], j2 = 3 * IB[3 * f + 2];
            // A's vertices against f's plane
            for (let k = 0; k < 3; k++) {
                const i = 3 * IA[3 * t + k];
                sa[k] = side3(PB[j0], PB[j0 + 1], PB[j0 + 2], PB[j1], PB[j1 + 1], PB[j1 + 2], PB[j2], PB[j2 + 1], PB[j2 + 2], PA[i], PA[i + 1], PA[i + 2]);
            }
            if ((sa[0] > 0 && sa[1] > 0 && sa[2] > 0) || (sa[0] < 0 && sa[1] < 0 && sa[2] < 0))
                continue;
            for (let k = 0; k < 3; k++) {
                const j = 3 * IB[3 * f + k];
                sb[k] = side3(PA[i0], PA[i0 + 1], PA[i0 + 2], PA[i1], PA[i1 + 1], PA[i1 + 2], PA[i2], PA[i2 + 1], PA[i2 + 2], PB[j], PB[j + 1], PB[j + 2]);
            }
            if ((sb[0] > 0 && sb[1] > 0 && sb[2] > 0) || (sb[0] < 0 && sb[1] < 0 && sb[2] < 0))
                continue;
            if (sa[0] === 0 || sa[1] === 0 || sa[2] === 0 || sb[0] === 0 || sb[1] === 0 || sb[2] === 0)
                throw new Degenerate("vertex on the other surface's plane");
            const ends = [];
            for (let k = 0; k < 3; k++)
                if (sa[k] !== sa[(k + 1) % 3]) {
                    const id = pierce(SA, SB, IA[3 * t + k], IA[3 * t + (k + 1) % 3], f);
                    if (id >= 0)
                        ends.push(id);
                }
            for (let k = 0; k < 3; k++)
                if (sb[k] !== sb[(k + 1) % 3]) {
                    const id = pierce(SB, SA, IB[3 * f + k], IB[3 * f + (k + 1) % 3], t);
                    if (id >= 0)
                        ends.push(id);
                }
            if (ends.length === 0)
                continue;
            if (ends.length !== 2)
                throw new Degenerate(`triangle pair with ${ends.length} crossing points`);
            let la = SA.segs.get(t);
            if (!la)
                SA.segs.set(t, la = []);
            la.push(ends[0], ends[1], f);
            let lb = SB.segs.get(f);
            if (!lb)
                SB.segs.set(f, lb = []);
            lb.push(ends[0], ends[1], t);
            stats.segments++;
        }
    }
    stats.newPoints = pts.length;
    stats.touchedScanTriangles = SA.segs.size;
    stats.touchedCutterTriangles = SB.segs.size;
    // ---- re-triangulate touched triangles, label pieces next to the cuts
    const NT = base + pts.length;
    const subdivide = (X, Y) => {
        const sub = { tri: [], parent: [], lab: [], cons: new Set() };
        for (const [t, sl] of X.segs) {
            const g0 = X.base + X.I[3 * t], g1 = X.base + X.I[3 * t + 1], g2 = X.base + X.I[3 * t + 2];
            const gid = [g0, g1, g2];
            const loc = new Map([[g0, 0], [g1, 1], [g2, 2]]);
            const segs = [];
            for (let k = 0; k < sl.length; k += 3) {
                const pq = [];
                for (const g of [sl[k], sl[k + 1]]) {
                    let l = loc.get(g);
                    if (l === undefined) {
                        l = gid.length;
                        loc.set(g, l);
                        gid.push(g);
                    }
                    pq.push(l);
                }
                segs.push([pq[0], pq[1]]);
                sub.cons.add(Math.min(sl[k], sl[k + 1]) * NT + Math.max(sl[k], sl[k + 1]));
            }
            const lp = gid.map(ptOf);
            // projection axis: dominant normal component; sigma from the exact orientation of the corners
            const P = X.P, a = 3 * X.I[3 * t], b = 3 * X.I[3 * t + 1], c = 3 * X.I[3 * t + 2];
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
            const nx = Math.abs(uy * wz - uz * wy), ny = Math.abs(uz * wx - ux * wz), nz = Math.abs(ux * wy - uy * wx);
            const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
            const sigma = orient2(lp[0], lp[1], lp[2], axis, 1);
            if (sigma === 0)
                throw new KernelError("scan boolean: a degenerate (zero-area) triangle in the input");
            const T = triangulateConstrained(lp, segs, axis, sigma);
            const first = sub.lab.length;
            for (let k = 0; k < T.length; k += 3) {
                sub.tri.push(gid[T[k]], gid[T[k + 1]], gid[T[k + 2]]);
                sub.parent.push(t);
                sub.lab.push(0);
            }
            // label the pieces on both sides of each segment
            for (let k = 0; k < sl.length; k += 3) {
                const p = sl[k], q = sl[k + 1], f = sl[k + 2];
                const J = Y.I;
                for (let m = first; m < sub.lab.length; m++) {
                    const A0 = sub.tri[3 * m], A1 = sub.tri[3 * m + 1], A2 = sub.tri[3 * m + 2];
                    const hasP = A0 === p || A1 === p || A2 === p, hasQ = A0 === q || A1 === q || A2 === q;
                    if (!hasP || !hasQ)
                        continue;
                    const r = A0 !== p && A0 !== q ? A0 : A1 !== p && A1 !== q ? A1 : A2;
                    const s = sidePt(Y.P, J[3 * f], J[3 * f + 1], J[3 * f + 2], ptOf(r));
                    if (s === 0)
                        throw new Degenerate("piece flat against the other surface");
                    const lab = s < 0 ? 2 : 1;
                    if (sub.lab[m] && sub.lab[m] !== lab)
                        stats.classificationConflicts++;
                    sub.lab[m] = lab;
                }
            }
        }
        return sub;
    };
    const subA = subdivide(SA, SB);
    const subB = subdivide(SB, SA);
    // ---- flood labels: across uncut sub-edges, then over untouched triangles
    const classify = (X, Y, sub, near) => {
        const nt = X.I.length / 3;
        const ns = sub.lab.length;
        const dmap = new Map();
        for (let m = 0; m < ns; m++)
            for (let j = 0; j < 3; j++)
                dmap.set(sub.tri[3 * m + j] * NT + sub.tri[3 * m + (j + 1) % 3], m);
        const queue = [];
        for (let m = 0; m < ns; m++)
            if (sub.lab[m])
                queue.push(m);
        for (let h = 0; h < queue.length; h++) {
            const m = queue[h];
            for (let j = 0; j < 3; j++) {
                const a = sub.tri[3 * m + j], b = sub.tri[3 * m + (j + 1) % 3];
                if (sub.cons.has(Math.min(a, b) * NT + Math.max(a, b)))
                    continue;
                const nbr = dmap.get(b * NT + a);
                if (nbr === undefined)
                    continue;
                if (!sub.lab[nbr]) {
                    sub.lab[nbr] = sub.lab[m];
                    queue.push(nbr);
                }
                else if (sub.lab[nbr] !== sub.lab[m])
                    stats.classificationConflicts++;
            }
        }
        if (sub.lab.some((l) => l === 0))
            throw new Degenerate("unlabelled piece");
        const lab = new Int8Array(nt);
        // Triangles away from the other mesh's box are outside it (label 1). Adjacency is then needed only among
        // the near triangles: neighbour -2 means "a far triangle", which is outside.
        let nbr;
        if (near) {
            const I = X.I, nv = X.nv, emap = new Map();
            for (let t = 0; t < nt; t++) {
                if (!near[t]) {
                    lab[t] = 1;
                    continue;
                }
                for (let j = 0; j < 3; j++)
                    emap.set(I[3 * t + j] * nv + I[3 * t + (j + 1) % 3], t);
            }
            nbr = (t, j) => emap.get(I[3 * t + (j + 1) % 3] * nv + I[3 * t + j]) ?? -2;
        }
        else {
            const nb = neighbours(X.I, X.nv);
            nbr = (t, j) => nb[3 * t + j];
        }
        for (const t of X.segs.keys())
            lab[t] = 3;
        const q2 = [];
        for (const t of X.segs.keys())
            for (let j = 0; j < 3; j++) {
                const s = nbr(t, j);
                if (s === -1)
                    continue;
                const u = X.base + X.I[3 * t + j], v = X.base + X.I[3 * t + (j + 1) % 3];
                if (s >= 0 && lab[s])
                    continue;
                const m = dmap.get(u * NT + v);
                if (m === undefined)
                    throw new Degenerate("cut edge next to an untouched triangle");
                if (s === -2) {
                    if (sub.lab[m] !== 1)
                        stats.classificationConflicts++;
                    continue;
                }
                lab[s] = sub.lab[m];
                q2.push(s);
            }
        if (near)
            for (let t = 0; t < nt; t++) {
                if (!near[t] || lab[t])
                    continue;
                for (let j = 0; j < 3; j++)
                    if (nbr(t, j) === -2) {
                        lab[t] = 1;
                        q2.push(t);
                        break;
                    }
            }
        const flood = (start) => {
            for (let h = start; h < q2.length; h++) {
                const t = q2[h];
                for (let j = 0; j < 3; j++) {
                    const s = nbr(t, j);
                    if (s === -1)
                        continue;
                    if (s === -2) {
                        if (lab[t] !== 1)
                            stats.classificationConflicts++;
                        continue;
                    }
                    if (!lab[s]) {
                        lab[s] = lab[t];
                        q2.push(s);
                    }
                    else if (lab[s] !== 3 && lab[s] !== lab[t])
                        stats.classificationConflicts++;
                }
            }
        };
        flood(0);
        // components no cut reaches: winding number of one of their vertices against the other mesh
        for (let t = 0; t < nt; t++) {
            if (lab[t])
                continue;
            stats.windingTests++;
            let best = 0.5;
            for (let j = 0; j < 3 && Math.abs(best - 0.5) < 0.45; j++) {
                const v = X.I[3 * t + j];
                const w = winding(Y.P, Y.I, X.P[3 * v], X.P[3 * v + 1], X.P[3 * v + 2]);
                if (Math.abs(w - 0.5) > Math.abs(best - 0.5))
                    best = w;
            }
            lab[t] = best > 0.5 ? 2 : 1;
            const h0 = q2.length;
            q2.push(t);
            flood(h0);
        }
        return lab;
    };
    // near-only adjacency (a hash map) pays when few triangles are near the cutter; otherwise the full CSR pass is faster
    let nearCount = 0;
    for (let t = 0; t < tA; t++)
        nearCount += nearA[t];
    const labA = classify(SA, SB, subA, nearCount * 8 < tA ? nearA : null);
    const labB = classify(SB, SA, subB, null);
    // ---- assemble
    const keepA = op === "intersect" ? 2 : 1;
    const keepB = op === "union" ? 1 : 2;
    const flipB = op === "subtract";
    const out = [];
    const fate = new Uint8Array(tA);
    for (let t = 0; t < tA; t++) {
        if (labA[t] === 3) {
            fate[t] = 2;
            continue;
        }
        if (labA[t] === keepA) {
            fate[t] = 1;
            out.push(IA[3 * t], IA[3 * t + 1], IA[3 * t + 2]);
        }
    }
    // parent face of each re-triangulated output piece (side, triangle), for the rounding check
    const parentOf = [];
    const subOut = (sub, keep, flip, side) => {
        for (let m = 0; m < sub.lab.length; m++) {
            if (sub.lab[m] !== keep)
                continue;
            if (flip)
                out.push(sub.tri[3 * m], sub.tri[3 * m + 2], sub.tri[3 * m + 1]);
            else
                out.push(sub.tri[3 * m], sub.tri[3 * m + 1], sub.tri[3 * m + 2]);
            parentOf.push(side, sub.parent[m], flip ? 1 : 0);
        }
    };
    const firstSub = out.length;
    subOut(subA, keepA, false, 0);
    const firstSubA_end = out.length;
    for (let t = 0; t < tB; t++) {
        if (labB[t] !== keepB)
            continue;
        const a = nA + IB[3 * t], b = nA + IB[3 * t + 1], c = nA + IB[3 * t + 2];
        if (flipB)
            out.push(a, c, b);
        else
            out.push(a, b, c);
    }
    const firstSubB = out.length;
    subOut(subB, keepB, flipB, 1);
    // compact: original scan vertices keep their coordinates bit-for-bit
    const remap = new Int32Array(NT).fill(-1);
    const pos = new Float64Array(3 * NT);
    let nOut = 0;
    for (let i = 0; i < out.length; i++) {
        const g = out[i];
        let r = remap[g];
        if (r < 0) {
            r = remap[g] = nOut++;
            if (g < nA) {
                pos[3 * r] = PA[3 * g];
                pos[3 * r + 1] = PA[3 * g + 1];
                pos[3 * r + 2] = PA[3 * g + 2];
            }
            else if (g < base) {
                const h = g - nA;
                pos[3 * r] = PB[3 * h];
                pos[3 * r + 1] = PB[3 * h + 1];
                pos[3 * r + 2] = PB[3 * h + 2];
            }
            else {
                const p = pts[g - base];
                pos[3 * r] = p.x;
                pos[3 * r + 1] = p.y;
                pos[3 * r + 2] = p.z;
            }
        }
        out[i] = r;
    }
    const P = pos.slice(0, 3 * nOut);
    // rounding check on re-triangulated pieces: zero area, or a normal against the parent face, after rounding
    const pieces = [[firstSub, firstSubA_end], [firstSubB, out.length]];
    let k = 0;
    for (const [s0, s1] of pieces)
        for (let i = s0; i < s1; i += 3, k += 3) {
            const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
            const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
            const S = parentOf[k] === 0 ? SA : SB, t = parentOf[k + 1], sg = parentOf[k + 2] ? -1 : 1;
            const Q = S.P, J = S.I, p0 = 3 * J[3 * t], p1 = 3 * J[3 * t + 1], p2 = 3 * J[3 * t + 2];
            const qx = Q[p1] - Q[p0], qy = Q[p1 + 1] - Q[p0 + 1], qz = Q[p1 + 2] - Q[p0 + 2], rx = Q[p2] - Q[p0], ry = Q[p2 + 1] - Q[p0 + 1], rz = Q[p2 + 2] - Q[p0 + 2];
            const dot = sg * (nx * (qy * rz - qz * ry) + ny * (qz * rx - qx * rz) + nz * (qx * ry - qy * rx));
            if ((nx === 0 && ny === 0 && nz === 0) || dot <= 0)
                stats.roundingFlips++;
        }
    return { mesh: new Mesh(P, Uint32Array.from(out)), fate };
}
/** Fixed, irrational-ish directions for leaving an exact degeneracy. */
const NUDGE = [
    [0.5773, 0.6181, 0.5331], [-0.4472, 0.7071, 0.5477], [0.3090, -0.5878, 0.7454], [0.8090, 0.2361, -0.5385],
    [-0.6545, -0.4253, 0.6247], [0.1736, 0.9659, -0.1924], [-0.2588, 0.3420, -0.9033], [0.7071, -0.5000, 0.5000],
];
/**
 * Exact boolean of a closed scan mesh with a cutter solid. Untouched scan triangles are kept bit-for-bit.
 * `op`: "subtract" (scan − cutter), "union", "intersect".
 */
export function scanBoolean(scan, cutter, op = "subtract", opts = {}) {
    const t0 = performance.now();
    if (!(scan instanceof Mesh))
        throw new KernelError("scan boolean: the scan must be a Mesh");
    if (op !== "subtract" && op !== "union" && op !== "intersect")
        throw new KernelError(`scan boolean: op must be "subtract", "union" or "intersect" (got ${JSON.stringify(op)})`);
    const B0 = cutterMesh(cutter);
    const cb = checkMesh(B0);
    if (!(cb.closed && cb.manifold && cb.consistentWinding))
        throw new KernelError(`scan boolean: the cutter is not a closed manifold (boundary ${cb.boundaryEdges}, non-manifold ${cb.nonManifoldEdges}/${cb.nonManifoldVertices})`);
    if (cb.volume < 0)
        throw new KernelError("scan boolean: the cutter is wound inside out");
    if (scan.volume() < 0)
        throw new KernelError("scan boolean: the scan is wound inside out (negative volume)");
    exactCount = 0;
    const attempts = opts.maxAttempts ?? NUDGE.length + 1;
    let last = null;
    for (let k = 0; k < attempts; k++) {
        const stats = { ms: 0, candidatePairs: 0, segments: 0, newPoints: 0, touchedScanTriangles: 0, touchedCutterTriangles: 0, attempts: k + 1,
            perturbation: [0, 0, 0], exactFallbacks: 0, classificationConflicts: 0, roundingFlips: 0, windingTests: 0 };
        let B = B0;
        if (k > 0) {
            const d = NUDGE[(k - 1) % NUDGE.length], s = 1e-7 * k;
            stats.perturbation = [d[0] * s, d[1] * s, d[2] * s];
            B = B0.transformed([1, 0, 0, d[0] * s, 0, 1, 0, d[1] * s, 0, 0, 1, d[2] * s]);
        }
        try {
            const r = core(scan, B, op, stats);
            stats.exactFallbacks = exactCount;
            stats.ms = performance.now() - t0;
            return { mesh: r.mesh, stats, scanTriangleFate: r.fate };
        }
        catch (e) {
            if (!(e instanceof Degenerate))
                throw e;
            last = e;
            if (process.env.SCANBOOL_DEBUG)
                console.error(`scanbool attempt ${k + 1}: ${e.message}`);
        }
    }
    throw new KernelError(`scan boolean: could not leave a degenerate contact after ${attempts} attempts (${last?.message})`);
}
/** scan − cutter (pockets, holes, slots, cuts). Untouched scan triangles are kept bit-for-bit. */
export function subtractFromScan(scan, cutter) { return scanBoolean(scan, cutter, "subtract").mesh; }
/** scan ∪ solid (bosses, tabs, mounts). */
export function unionWithScan(scan, solid) { return scanBoolean(scan, solid, "union").mesh; }
/** scan ∩ solid (keep the part of the scan inside a box, etc.). */
export function intersectScan(scan, solid) { return scanBoolean(scan, solid, "intersect").mesh; }
