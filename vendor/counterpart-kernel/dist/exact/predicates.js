/**
 * Exact geometric predicates for the plane-based BSP (`pbsp.ts`).
 *
 * Coordinates live on an integer grid of GRID units per millimetre. Every plane has integer coefficients
 * (a, b, c, d): a x + b y + c z + d = 0 in grid units. Every vertex is either an explicit grid point
 * (integers) or the intersection of three planes, a rational point (X/W, Y/W, Z/W) with BigInt numerators.
 * Classification of a vertex against a plane is decided by, in order:
 *   1. combinatorics: the planes a vertex is known to lie on (its defining planes, its input faces);
 *   2. a floating-point filter: the double evaluation with a rigorous error bound (semi-static: the
 *      vertex carries an absolute error bound on its double coordinates);
 *   3. exact BigInt evaluation, only when the filter cannot decide.
 * After Bernstein & Fussell 2009 ("Fast, exact, linear booleans") and Campen & Kobbelt 2010 (plane-based
 * representation, no new numbers on splitting), with Shewchuk-style filtering.
 */
/** Grid units per millimetre (input vertices are snapped to multiples of 1/GRID mm). */
export const GRID = 2 ** 16;
export const INV_GRID = 2 ** -16;
const EPS = 2 ** -53;
const SAFE = 2 ** 53;
let nextPlaneId = 1;
/** Statistics, for the bench. */
export const STATS = { filter: 0, combinatorial: 0, exactSide: 0, exactZero: 0, exactVertex: 0, exactAtMeet: 0, vertices: 0, intFast: 0 };
/**
 * An oriented plane a x + b y + c z + d = 0 (normal (a, b, c) points to the front). The doubles are the
 * coefficients rounded to nearest; `ex` says they are exact (safe integers), in which case the BigInts are
 * made on demand.
 */
export class Plane {
    a;
    b;
    c;
    d;
    ex;
    id;
    flip;
    /** vertex cache for intersections with two other planes (only on the plane with the lowest id) */
    vc = null;
    _A = null;
    _B = null;
    _C = null;
    _D = null;
    constructor(a, b, c, d, ex, big, id, flip) {
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.ex = ex;
        if (big) {
            this._A = big[0];
            this._B = big[1];
            this._C = big[2];
            this._D = big[3];
        }
        this.id = id ?? nextPlaneId++;
        if (flip)
            this.flip = flip;
        else
            this.flip = new Plane(-a, -b, -c, -d, ex, big ? [-big[0], -big[1], -big[2], -big[3]] : undefined, this.id, this);
    }
    get A() { return this._A ??= BigInt(this.a); }
    get B() { return this._B ??= BigInt(this.b); }
    get C() { return this._C ??= BigInt(this.c); }
    get D() { return this._D ??= BigInt(this.d); }
    /** Plane from exact BigInt coefficients (reduced by their gcd); interned. */
    static fromBig(A, B, C, D) {
        const g = gcdBig(gcdBig(gcdBig(abs(A), abs(B)), abs(C)), abs(D));
        if (g > 1n) {
            A /= g;
            B /= g;
            C /= g;
            D /= g;
        }
        const a = Number(A), b = Number(B), c = Number(C), d = Number(D);
        const ex = Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(c) && Number.isSafeInteger(d);
        if (ex)
            return intern(a, b, c, d, null);
        return intern(a, b, c, d, [A, B, C, D]);
    }
    /** Plane from safe-integer coefficients (reduced by their gcd); interned. */
    static fromInts(a, b, c, d) {
        const g = gcdNum(gcdNum(gcdNum(Math.abs(a), Math.abs(b)), Math.abs(c)), Math.abs(d));
        if (g > 1) {
            a /= g;
            b /= g;
            c /= g;
            d /= g;
        }
        return intern(a + 0, b + 0, c + 0, d + 0, null);
    }
}
/**
 * Planes are interned by their reduced coefficients, so geometrically equal planes made by different
 * primitives are one object (one id): coincident faces are then recognised combinatorially. The table is
 * dropped when it grows large (that only loses sharing, never correctness).
 */
const TABLE = new Map();
/** exact-coefficient planes: numeric hash buckets (cheaper than string keys) */
const NTABLE = new Map();
let ncount = 0;
function intern(a, b, c, d, big) {
    // canonical orientation: first non-zero of (a, b, c) positive
    const neg = a < 0 || (a === 0 && (b < 0 || (b === 0 && c < 0)));
    if (!big) {
        if (neg) {
            a = -a + 0;
            b = -b + 0;
            c = -c + 0;
            d = -d + 0;
        }
        const h = a * 0.7071067811865476 + b * 1.4142135623730951 + c * 3.141592653589793 + d * 0.5772156649015329;
        let l = NTABLE.get(h);
        if (l)
            for (const p of l)
                if (p.a === a && p.b === b && p.c === c && p.d === d)
                    return neg ? p.flip : p;
        if (ncount > 100000) {
            NTABLE.clear();
            ncount = 0;
            l = undefined;
        }
        const p = new Plane(a, b, c, d, true);
        if (l)
            l.push(p);
        else
            NTABLE.set(h, [p]);
        ncount++;
        return neg ? p.flip : p;
    }
    const key = neg ? `${-big[0]},${-big[1]},${-big[2]},${-big[3]}` : `${big[0]},${big[1]},${big[2]},${big[3]}`;
    let p = TABLE.get(key);
    if (!p) {
        if (TABLE.size > 20000)
            TABLE.clear();
        p = neg ? new Plane(-a + 0, -b + 0, -c + 0, -d + 0, false, [-big[0], -big[1], -big[2], -big[3]]) : new Plane(a, b, c, d, false, big);
        TABLE.set(key, p);
    }
    return neg ? p.flip : p;
}
function abs(x) { return x < 0n ? -x : x; }
export function gcdBig(a, b) { while (b) {
    const t = a % b;
    a = b;
    b = t;
} return a; }
export function gcdNum(a, b) { while (b) {
    const t = a % b;
    a = b;
    b = t;
} return a; }
/**
 * A vertex: an explicit grid point (`int`) or the intersection of planes P, Q, R. (x, y, z) are doubles
 * within `e` (absolute, grid units) of the exact point; X, Y, Z, W (W > 0) are the exact homogeneous
 * coordinates, made on demand.
 */
export class Vtx {
    x;
    y;
    z;
    e;
    int;
    P;
    Q;
    R;
    X = null;
    Y = null;
    Z = null;
    W = null;
    /** planes this vertex is known to lie on (ids are shared by a plane and its flip) */
    on;
    /** scratch slots for meshing */
    stamp = 0;
    idx = -1;
    constructor(x, y, z, e, int, P = null, Q = null, R = null) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.e = e;
        this.int = int;
        this.P = P;
        this.Q = Q;
        this.R = R;
        this.on = P ? [P, Q, R] : [];
    }
    static grid(x, y, z) { return new Vtx(x, y, z, 0, true); }
}
export function addOn(v, p) {
    const on = v.on;
    for (let i = 0; i < on.length; i++)
        if (on[i].id === p.id)
            return;
    if (on.length < 24)
        on.push(p);
}
/** Exact homogeneous coordinates of v (W > 0); refines its doubles. */
export function exactify(v) {
    if (v.W !== null)
        return;
    if (v.int) {
        v.X = BigInt(v.x);
        v.Y = BigInt(v.y);
        v.Z = BigInt(v.z);
        v.W = 1n;
        return;
    }
    STATS.exactVertex++;
    const P = v.P, Q = v.Q, R = v.R;
    const r = meetBig(P, Q, R);
    if (!r)
        throw new Error("pbsp: vertex of parallel planes");
    [v.X, v.Y, v.Z, v.W] = r;
    const w = Number(v.W);
    v.x = Number(v.X) / w;
    v.y = Number(v.Y) / w;
    v.z = Number(v.Z) / w;
    v.e = 4 * EPS * Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
}
function meetBig(P, Q, R) {
    const qa = Q.A, qb = Q.B, qc = Q.C, ra = R.A, rb = R.B, rc = R.C, pa = P.A, pb = P.B, pc = P.C;
    // c23 = Q x R, c31 = R x P, c12 = P x Q
    const c23x = qb * rc - qc * rb, c23y = qc * ra - qa * rc, c23z = qa * rb - qb * ra;
    const c31x = rb * pc - rc * pb, c31y = rc * pa - ra * pc, c31z = ra * pb - rb * pa;
    const c12x = pb * qc - pc * qb, c12y = pc * qa - pa * qc, c12z = pa * qb - pb * qa;
    let W = pa * c23x + pb * c23y + pc * c23z;
    if (W === 0n)
        return null;
    const pd = P.D, qd = Q.D, rd = R.D;
    let X = -(pd * c23x + qd * c31x + rd * c12x);
    let Y = -(pd * c23y + qd * c31y + rd * c12y);
    let Z = -(pd * c23z + qd * c31z + rd * c12z);
    if (W < 0n) {
        W = -W;
        X = -X;
        Y = -Y;
        Z = -Z;
    }
    return [X, Y, Z, W];
}
/** The intersection of three planes (cached on the plane with the lowest id). */
export function meet(P, Q, R) {
    // order by id for the cache
    let p0 = P, p1 = Q, p2 = R, t;
    if (p1.id < p0.id) {
        t = p0;
        p0 = p1;
        p1 = t;
    }
    if (p2.id < p1.id) {
        t = p1;
        p1 = p2;
        p2 = t;
    }
    if (p1.id < p0.id) {
        t = p0;
        p0 = p1;
        p1 = t;
    }
    let m1 = p0.vc?.get(p1.id);
    const hit = m1?.get(p2.id);
    if (hit)
        return hit;
    const v = meetFloat(P, Q, R);
    if (!p0.vc)
        p0.vc = new Map();
    if (!m1) {
        m1 = new Map();
        p0.vc.set(p1.id, m1);
    }
    m1.set(p2.id, v);
    return v;
}
function meetFloat(P, Q, R) {
    STATS.vertices++;
    const qa = Q.a, qb = Q.b, qc = Q.c, ra = R.a, rb = R.b, rc = R.c, pa = P.a, pb = P.b, pc = P.c;
    const c23x = qb * rc - qc * rb, c23y = qc * ra - qa * rc, c23z = qa * rb - qb * ra;
    const c31x = rb * pc - rc * pb, c31y = rc * pa - ra * pc, c31z = ra * pb - rb * pa;
    const c12x = pb * qc - pc * qb, c12y = pc * qa - pa * qc, c12z = pa * qb - pb * qa;
    const m23x = Math.abs(qb * rc) + Math.abs(qc * rb), m23y = Math.abs(qc * ra) + Math.abs(qa * rc), m23z = Math.abs(qa * rb) + Math.abs(qb * ra);
    const m31x = Math.abs(rb * pc) + Math.abs(rc * pb), m31y = Math.abs(rc * pa) + Math.abs(ra * pc), m31z = Math.abs(ra * pb) + Math.abs(rb * pa);
    const m12x = Math.abs(pb * qc) + Math.abs(pc * qb), m12y = Math.abs(pc * qa) + Math.abs(pa * qc), m12z = Math.abs(pa * qb) + Math.abs(pb * qa);
    const W = pa * c23x + pb * c23y + pc * c23z;
    const mW = Math.abs(pa) * m23x + Math.abs(pb) * m23y + Math.abs(pc) * m23z;
    const pd = P.d, qd = Q.d, rd = R.d, apd = Math.abs(pd), aqd = Math.abs(qd), ard = Math.abs(rd);
    const Nx = -(pd * c23x + qd * c31x + rd * c12x), Ny = -(pd * c23y + qd * c31y + rd * c12y), Nz = -(pd * c23z + qd * c31z + rd * c12z);
    const mx = apd * m23x + aqd * m31x + ard * m12x, my = apd * m23y + aqd * m31y + ard * m12y, mz = apd * m23z + aqd * m31z + ard * m12z;
    const K = 16 * EPS;
    const eW = K * mW;
    const aW = Math.abs(W);
    const v = new Vtx(0, 0, 0, 0, false, P, Q, R);
    if (!(aW > 8 * eW) || !Number.isFinite(W)) {
        STATS.exactAtMeet++;
        exactify(v);
        return v;
    }
    const x = Nx / W, y = Ny / W, z = Nz / W;
    const den = aW - eW;
    const ex = (K * mx + Math.abs(x) * eW) / den, ey = (K * my + Math.abs(y) * eW) / den, ez = (K * mz + Math.abs(z) * eW) / den;
    v.x = x;
    v.y = y;
    v.z = z;
    v.e = (Math.max(ex, ey, ez) + 2 * EPS * Math.max(Math.abs(x), Math.abs(y), Math.abs(z))) * (1 + 1e-12);
    if (v.e > 1e-3) {
        STATS.exactAtMeet++;
        exactify(v);
    }
    return v;
}
/** Sign of the plane function at v: 1 front, -1 back, 0 on the plane. Exact. */
export function side(v, p) {
    const on = v.on, id = p.id;
    for (let i = 0; i < on.length; i++)
        if (on[i].id === id) {
            STATS.combinatorial++;
            return 0;
        }
    const ax = p.a * v.x, by = p.b * v.y, cz = p.c * v.z, d = p.d;
    const s = ax + by + cz + d;
    const m = Math.abs(ax) + Math.abs(by) + Math.abs(cz) + Math.abs(d);
    if (v.int && p.ex && m < SAFE) {
        // every product and partial sum is an integer below 2^53: the double result is exact
        STATS.intFast++;
        if (s === 0) {
            addOn(v, p);
            return 0;
        }
        return s > 0 ? 1 : -1;
    }
    const bound = (Math.abs(p.a) + Math.abs(p.b) + Math.abs(p.c)) * v.e * (1 + 1e-12) + 8 * EPS * m;
    if (s > bound) {
        STATS.filter++;
        return 1;
    }
    if (s < -bound) {
        STATS.filter++;
        return -1;
    }
    STATS.exactSide++;
    exactify(v);
    const r = p.A * v.X + p.B * v.Y + p.C * v.Z + p.D * v.W;
    if (r === 0n) {
        STATS.exactZero++;
        addOn(v, p);
        return 0;
    }
    return r > 0n ? 1 : -1;
}
function knownOn(v, p) { const on = v.on; for (let i = 0; i < on.length; i++)
    if (on[i].id === p.id)
        return true; return false; }
/** Exact equality of two vertices. */
export function samePoint(u, v) {
    if (u === v)
        return true;
    const t = u.e + v.e + 1e-9;
    if (Math.abs(u.x - v.x) > t || Math.abs(u.y - v.y) > t || Math.abs(u.z - v.z) > t)
        return false;
    if (u.int && v.int)
        return u.x === v.x && u.y === v.y && u.z === v.z;
    // combinatorial: one lies on all three defining planes of the other
    if (v.P && knownOn(u, v.P) && knownOn(u, v.Q) && knownOn(u, v.R))
        return true;
    if (u.P && knownOn(v, u.P) && knownOn(v, u.Q) && knownOn(v, u.R))
        return true;
    exactify(u);
    exactify(v);
    return u.X * v.W === v.X * u.W && u.Y * v.W === v.Y * u.W && u.Z * v.W === v.Z * u.W;
}
/** Exact comparison of coordinate k (0, 1, 2) of two vertices: sign(u_k - v_k). */
export function cmpCoord(u, v, k) {
    const a = k === 0 ? u.x : k === 1 ? u.y : u.z, b = k === 0 ? v.x : k === 1 ? v.y : v.z;
    const t = u.e + v.e;
    if (a - b > t * (1 + 1e-12) + 1e-300)
        return 1;
    if (b - a > t * (1 + 1e-12) + 1e-300)
        return -1;
    if (u.int && v.int)
        return a > b ? 1 : a < b ? -1 : 0;
    exactify(u);
    exactify(v);
    const U = k === 0 ? u.X : k === 1 ? u.Y : u.Z, V = k === 0 ? v.X : k === 1 ? v.Y : v.Z;
    const r = U * v.W - V * u.W;
    return r > 0n ? 1 : r < 0n ? -1 : 0;
}
