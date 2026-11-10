/**
 * Signed distance field (SDF) nodes: the solid representation of the kernel.
 *
 * Convention: f(p) < 0 inside the solid, > 0 outside, |f| is (a lower bound of) the Euclidean distance
 * to the surface. Every node also carries a Lipschitz constant L (|f(p)-f(q)| <= L |p-q|) and an
 * axis-aligned bounding box of its solid, so the mesher can cull space and prune the expression tree.
 *
 * Pruning (`prune`) is the interval idea from Duff 1992 ("Interval arithmetic and recursive subdivision
 * for implicit functions and constructive solid geometry") and Keeter's libfive/Fidget tape
 * simplification, done here with Lipschitz bounds instead of interval arithmetic: inside a ball of
 * radius r around c, a child's value stays within v(c) +- L r, so a union child whose lower bound is
 * above another child's upper bound can never be the minimum there and is dropped. The pruned tree
 * evaluates bit-identically to the full tree everywhere in the ball.
 *
 * Distance formulas for boxes, capped cones, extrusions and revolutions follow Inigo Quilez's published
 * derivations (iquilezles.org, "distance functions"), re-derived and written here.
 */
export class AABB {
    minX;
    minY;
    minZ;
    maxX;
    maxY;
    maxZ;
    constructor(minX, minY, minZ, maxX, maxY, maxZ) {
        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.maxX = maxX;
        this.maxY = maxY;
        this.maxZ = maxZ;
    }
    static empty() { return new AABB(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity); }
    static infinite() { return new AABB(-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity); }
    isEmpty() { return this.minX > this.maxX || this.minY > this.maxY || this.minZ > this.maxZ; }
    isFinite() {
        return Number.isFinite(this.minX) && Number.isFinite(this.maxX) && Number.isFinite(this.minY) &&
            Number.isFinite(this.maxY) && Number.isFinite(this.minZ) && Number.isFinite(this.maxZ);
    }
    union(b) {
        return new AABB(Math.min(this.minX, b.minX), Math.min(this.minY, b.minY), Math.min(this.minZ, b.minZ), Math.max(this.maxX, b.maxX), Math.max(this.maxY, b.maxY), Math.max(this.maxZ, b.maxZ));
    }
    intersect(b) {
        return new AABB(Math.max(this.minX, b.minX), Math.max(this.minY, b.minY), Math.max(this.minZ, b.minZ), Math.min(this.maxX, b.maxX), Math.min(this.maxY, b.maxY), Math.min(this.maxZ, b.maxZ));
    }
    expand(d) {
        return new AABB(this.minX - d, this.minY - d, this.minZ - d, this.maxX + d, this.maxY + d, this.maxZ + d);
    }
    translate(x, y, z) {
        return new AABB(this.minX + x, this.minY + y, this.minZ + z, this.maxX + x, this.maxY + y, this.maxZ + z);
    }
    size() { return [this.maxX - this.minX, this.maxY - this.minY, this.maxZ - this.minZ]; }
    center() { return [(this.minX + this.maxX) / 2, (this.minY + this.maxY) / 2, (this.minZ + this.maxZ) / 2]; }
    /** Distance from point to box (0 inside). */
    distance(x, y, z) {
        const dx = Math.max(this.minX - x, 0, x - this.maxX);
        const dy = Math.max(this.minY - y, 0, y - this.maxY);
        const dz = Math.max(this.minZ - z, 0, z - this.maxZ);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
}
/** Value of the most recent `prune` call at the cell centre (avoids allocating tuples in the hot path). */
export const PRUNED = { v: 0 };
export class SDF {
    /** Lipschitz bound of f. */
    L = 1;
    /** Smallest feature size this node introduces (mm), used to choose a default meshing resolution. */
    minFeature = Infinity;
    /** Returns a node equal to this one inside the ball (c, r) and sets PRUNED.v = f(c). */
    prune(cx, cy, cz, _r) {
        PRUNED.v = this.f(cx, cy, cz);
        return this;
    }
    /** Number of nodes (for diagnostics). */
    size() { return 1; }
}
/** Constant field: the whole cell is inside (negative) or outside (positive). */
export class Const extends SDF {
    value;
    bounds;
    constructor(value) {
        super();
        this.value = value;
        this.L = 0;
        this.bounds = value < 0 ? AABB.infinite() : AABB.empty();
    }
    f() { return this.value; }
    prune() { PRUNED.v = this.value; return this; }
}
// ---------------------------------------------------------------------------------------------------
// Primitives (exact Euclidean distance)
/** Axis-aligned box given by its centre and half extents. Exact SDF. */
export class BoxNode extends SDF {
    cx;
    cy;
    cz;
    hx;
    hy;
    hz;
    bounds;
    constructor(cx, cy, cz, hx, hy, hz) {
        super();
        this.cx = cx;
        this.cy = cy;
        this.cz = cz;
        this.hx = hx;
        this.hy = hy;
        this.hz = hz;
        this.bounds = new AABB(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz);
        this.minFeature = 2 * Math.min(hx, hy, hz);
    }
    f(x, y, z) {
        const qx = Math.abs(x - this.cx) - this.hx;
        const qy = Math.abs(y - this.cy) - this.hy;
        const qz = Math.abs(z - this.cz) - this.hz;
        const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
        const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        return outside + inside;
    }
}
export class SphereNode extends SDF {
    cx;
    cy;
    cz;
    r;
    bounds;
    constructor(cx, cy, cz, r) {
        super();
        this.cx = cx;
        this.cy = cy;
        this.cz = cz;
        this.r = r;
        this.bounds = new AABB(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r);
        this.minFeature = 2 * r;
    }
    f(x, y, z) {
        const dx = x - this.cx, dy = y - this.cy, dz = z - this.cz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) - this.r;
    }
}
/** Half-space n.p <= d (n unit). Unbounded. */
export class HalfSpace extends SDF {
    nx;
    ny;
    nz;
    d;
    bounds = AABB.infinite();
    constructor(nx, ny, nz, d) {
        super();
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.d = d;
    }
    f(x, y, z) { return this.nx * x + this.ny * y + this.nz * z - this.d; }
}
/** Combine a 2D signed distance `a` with an axial interval distance `b` into an exact 3D distance. */
export function combine2(a, b) {
    const ox = a > 0 ? a : 0, oy = b > 0 ? b : 0;
    return Math.min(Math.max(a, b), 0) + Math.sqrt(ox * ox + oy * oy);
}
/** Cylinder along Z: radius r, from z0 to z1, centred at (cx, cy). Exact SDF. */
export class CylinderNode extends SDF {
    cx;
    cy;
    r;
    z0;
    z1;
    bounds;
    constructor(cx, cy, r, z0, z1) {
        super();
        this.cx = cx;
        this.cy = cy;
        this.r = r;
        this.z0 = z0;
        this.z1 = z1;
        this.bounds = new AABB(cx - r, cy - r, z0, cx + r, cy + r, z1);
        this.minFeature = Math.min(2 * r, z1 - z0);
    }
    f(x, y, z) {
        const dx = x - this.cx, dy = y - this.cy;
        const a = Math.sqrt(dx * dx + dy * dy) - this.r;
        const b = Math.max(this.z0 - z, z - this.z1);
        return combine2(a, b);
    }
}
/**
 * Capped cone (frustum) along Z: radius r0 at z0, r1 at z1. Exact SDF (2D distance to the trapezoid in
 * the (radius, z) half-plane, after Quilez's sdCappedCone derivation).
 */
export class ConeNode extends SDF {
    cx;
    cy;
    r0;
    r1;
    z0;
    z1;
    bounds;
    h;
    zc;
    constructor(cx, cy, r0, r1, z0, z1) {
        super();
        this.cx = cx;
        this.cy = cy;
        this.r0 = r0;
        this.r1 = r1;
        this.z0 = z0;
        this.z1 = z1;
        const R = Math.max(r0, r1);
        this.bounds = new AABB(cx - R, cy - R, z0, cx + R, cy + R, z1);
        this.h = (z1 - z0) / 2;
        this.zc = (z0 + z1) / 2;
        this.minFeature = Math.min(z1 - z0, 2 * Math.min(r0, r1) || Infinity);
    }
    f(x, y, z) {
        const dx = x - this.cx, dy = y - this.cy;
        const qx = Math.sqrt(dx * dx + dy * dy), qy = z - this.zc;
        const h = this.h, r1 = this.r0, r2 = this.r1; // r1 at bottom (-h), r2 at top (+h)
        const k1x = r2, k1y = h;
        const k2x = r2 - r1, k2y = 2 * h;
        const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
        const k2len2 = k2x * k2x + k2y * k2y;
        let t = ((k1x - qx) * k2x + (k1y - qy) * k2y) / k2len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
        const s = cbx < 0 && cay < 0 ? -1 : 1;
        return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
    }
}
/** Extrusion of a 2D shape along an axis between a and b. Exact SDF. Axis 2 = Z (u=x, v=y). */
export class ExtrudeNode extends SDF {
    shape;
    axis;
    a;
    b;
    bounds;
    constructor(shape, axis, a, b) {
        super();
        this.shape = shape;
        this.axis = axis;
        this.a = a;
        this.b = b;
        const [u0, v0, u1, v1] = shape.bounds2;
        this.bounds = axis === 2 ? new AABB(u0, v0, a, u1, v1, b)
            : axis === 0 ? new AABB(a, u0, v0, b, u1, v1)
                : new AABB(u0, a, v0, u1, b, v1);
        this.minFeature = Math.min(shape.minFeature, b - a);
    }
    f(x, y, z) {
        let u, v, w;
        // sketch plane: along z -> (x, y); along y -> (x, z) (front view); along x -> (y, z) (side view)
        if (this.axis === 2) {
            u = x;
            v = y;
            w = z;
        }
        else if (this.axis === 0) {
            u = y;
            v = z;
            w = x;
        }
        else {
            u = x;
            v = z;
            w = y;
        }
        return combine2(this.shape.d(u, v), Math.max(this.a - w, w - this.b));
    }
}
/** Maps a world point to (sketch u, sketch v, axial w) for an extrusion axis. */
export function sketchCoords(axis, x, y, z, out) {
    if (axis === 2) {
        out[0] = x;
        out[1] = y;
        out[2] = z;
    }
    else if (axis === 0) {
        out[0] = y;
        out[1] = z;
        out[2] = x;
    }
    else {
        out[0] = x;
        out[1] = z;
        out[2] = y;
    }
}
/**
 * Extrusion with treated end edges: chamfer (45-degree bevel inward), round (fillet of radius r,
 * exact: offset of a shrunken extrusion, after the Minkowski-sum identity) or flare (45-degree lead-in
 * that grows the section towards that end, for pocket mouths). Values divided by the operator's
 * Lipschitz bound where the formula is not an exact distance.
 */
export class TreatedExtrudeNode extends SDF {
    shape;
    axis;
    a;
    b;
    lo;
    hi;
    bounds;
    s = new Float64Array(3);
    constructor(shape, axis, a, b, lo, hi) {
        super();
        this.shape = shape;
        this.axis = axis;
        this.a = a;
        this.b = b;
        this.lo = lo;
        this.hi = hi;
        const [u0, v0, u1, v1] = shape.bounds2;
        const g = Math.max(lo?.kind === "flare" ? lo.size : 0, hi?.kind === "flare" ? hi.size : 0);
        const U0 = u0 - g, V0 = v0 - g, U1 = u1 + g, V1 = v1 + g;
        this.bounds = axis === 2 ? new AABB(U0, V0, a, U1, V1, b)
            : axis === 0 ? new AABB(a, U0, V0, b, U1, V1)
                : new AABB(U0, a, V0, U1, b, V1);
        this.minFeature = Math.min(shape.minFeature, b - a, lo?.size ?? Infinity, hi?.size ?? Infinity);
    }
    f(x, y, z) {
        const s = this.s;
        sketchCoords(this.axis, x, y, z, s);
        const d2 = this.shape.d(s[0], s[1]), w = s[2];
        const a = this.a, b = this.b, lo = this.lo, hi = this.hi;
        // rounded ends: Minkowski sum of a shrunken extrusion with a ball, clipped where only one end is rounded
        const rl = lo?.kind === "round" ? lo.size : 0, rh = hi?.kind === "round" ? hi.size : 0;
        let val;
        if (rl > 0 || rh > 0) {
            const r = Math.max(rl, rh);
            const aa = rl > 0 ? a + r : a - r, bb = rh > 0 ? b - r : b + r;
            val = combine2(d2 + r, Math.max(aa - w, w - bb)) - r;
            if (rl === 0)
                val = Math.max(val, a - w);
            if (rh === 0)
                val = Math.max(val, w - b);
        }
        else
            val = combine2(d2, Math.max(a - w, w - b));
        if (hi?.kind === "chamfer")
            val = Math.max(val, (d2 + w - b + hi.size) * Math.SQRT1_2);
        if (lo?.kind === "chamfer")
            val = Math.max(val, (d2 - w + a + lo.size) * Math.SQRT1_2);
        if (hi?.kind === "flare") {
            const c = hi.size;
            const fl = Math.max((d2 - (w - (b - c))) * Math.SQRT1_2, w - b, (b - c) - w);
            if (fl < val)
                val = fl;
        }
        if (lo?.kind === "flare") {
            const c = lo.size;
            const fl = Math.max((d2 - ((a + c) - w)) * Math.SQRT1_2, a - w, w - (a + c));
            if (fl < val)
                val = fl;
        }
        return val;
    }
}
/**
 * Extrusion along Z whose 2D section is offset by o(z) = o0 + (z - z0) * slope, i.e. a straight taper
 * (lead-in chamfers, draft). Not an exact distance (bounded by sqrt(1 + slope^2)), so the value is divided
 * by that factor to keep it 1-Lipschitz.
 */
export class TaperExtrudeNode extends SDF {
    shape;
    z0;
    z1;
    o0;
    slope;
    bounds;
    k;
    constructor(shape, z0, z1, o0, slope) {
        super();
        this.shape = shape;
        this.z0 = z0;
        this.z1 = z1;
        this.o0 = o0;
        this.slope = slope;
        const [u0, v0, u1, v1] = shape.bounds2;
        const om = Math.max(o0, o0 + slope * (z1 - z0), 0);
        this.bounds = new AABB(u0 - om, v0 - om, z0, u1 + om, v1 + om, z1);
        this.k = 1 / Math.sqrt(1 + slope * slope);
        this.minFeature = Math.min(shape.minFeature, z1 - z0);
    }
    f(x, y, z) {
        const o = this.o0 + (z - this.z0) * this.slope;
        const side = (this.shape.d(x, y) - o) * this.k;
        return Math.max(side, this.z0 - z, z - this.z1);
    }
}
/** Revolution of a 2D shape in the (r, z) half-plane about the Z axis through (cx, cy). Exact SDF. */
export class RevolveNode extends SDF {
    shape;
    cx;
    cy;
    bounds;
    constructor(shape, cx, cy) {
        super();
        this.shape = shape;
        this.cx = cx;
        this.cy = cy;
        const [, v0, u1, v1] = shape.bounds2;
        const R = Math.max(u1, 0);
        this.bounds = new AABB(cx - R, cy - R, v0, cx + R, cy + R, v1);
        this.minFeature = shape.minFeature;
    }
    f(x, y, z) {
        const dx = x - this.cx, dy = y - this.cy;
        return this.shape.d(Math.sqrt(dx * dx + dy * dy), z);
    }
}
// ---------------------------------------------------------------------------------------------------
// Combinators
export class UnionNode extends SDF {
    children;
    bounds;
    constructor(children) {
        super();
        this.children = children;
        let b = AABB.empty();
        let L = 0, mf = Infinity;
        for (const c of children) {
            b = b.union(c.bounds);
            L = Math.max(L, c.L);
            mf = Math.min(mf, c.minFeature);
        }
        this.bounds = b;
        this.L = L;
        this.minFeature = mf;
    }
    f(x, y, z) {
        const ch = this.children;
        let m = ch[0].f(x, y, z);
        for (let i = 1; i < ch.length; i++) {
            const v = ch[i].f(x, y, z);
            if (v < m)
                m = v;
        }
        return m;
    }
    prune(cx, cy, cz, r) {
        const ch = this.children, n = ch.length;
        const kids = new Array(n);
        const vals = new Float64Array(n);
        let upper = Infinity, best = Infinity;
        for (let i = 0; i < n; i++) {
            kids[i] = ch[i].prune(cx, cy, cz, r);
            const v = PRUNED.v;
            vals[i] = v;
            const u = v + kids[i].L * r;
            if (u < upper)
                upper = u;
            if (v < best)
                best = v;
        }
        const keep = [];
        for (let i = 0; i < n; i++)
            if (vals[i] - kids[i].L * r <= upper)
                keep.push(kids[i]);
        PRUNED.v = best;
        if (keep.length === 1)
            return keep[0];
        if (keep.length === n && keep.every((k, i) => k === ch[i]))
            return this;
        return new UnionNode(keep);
    }
    size() { return 1 + this.children.reduce((s, c) => s + c.size(), 0); }
}
export class IntersectNode extends SDF {
    children;
    bounds;
    constructor(children) {
        super();
        this.children = children;
        let b = AABB.infinite();
        let L = 0, mf = Infinity;
        for (const c of children) {
            b = b.intersect(c.bounds);
            L = Math.max(L, c.L);
            mf = Math.min(mf, c.minFeature);
        }
        this.bounds = b;
        this.L = L;
        this.minFeature = mf;
    }
    f(x, y, z) {
        const ch = this.children;
        let m = ch[0].f(x, y, z);
        for (let i = 1; i < ch.length; i++) {
            const v = ch[i].f(x, y, z);
            if (v > m)
                m = v;
        }
        return m;
    }
    prune(cx, cy, cz, r) {
        const ch = this.children, n = ch.length;
        const kids = new Array(n);
        const vals = new Float64Array(n);
        let lower = -Infinity, best = -Infinity;
        for (let i = 0; i < n; i++) {
            kids[i] = ch[i].prune(cx, cy, cz, r);
            const v = PRUNED.v;
            vals[i] = v;
            const l = v - kids[i].L * r;
            if (l > lower)
                lower = l;
            if (v > best)
                best = v;
        }
        const keep = [];
        for (let i = 0; i < n; i++)
            if (vals[i] + kids[i].L * r >= lower)
                keep.push(kids[i]);
        PRUNED.v = best;
        if (keep.length === 1)
            return keep[0];
        if (keep.length === n && keep.every((k, i) => k === ch[i]))
            return this;
        return new IntersectNode(keep);
    }
    size() { return 1 + this.children.reduce((s, c) => s + c.size(), 0); }
}
/** Complement (-f). Used for differences: a - b = max(a, -b). */
export class NegateNode extends SDF {
    child;
    bounds = AABB.infinite();
    constructor(child) {
        super();
        this.child = child;
        this.L = child.L;
        this.minFeature = child.minFeature;
    }
    f(x, y, z) { return -this.child.f(x, y, z); }
    prune(cx, cy, cz, r) {
        const k = this.child.prune(cx, cy, cz, r);
        PRUNED.v = -PRUNED.v;
        return k === this.child ? this : new NegateNode(k);
    }
    size() { return 1 + this.child.size(); }
}
/** f - d: grows the solid by d (shrinks for negative d). Exact for exact SDFs. */
export class OffsetNode extends SDF {
    child;
    d;
    bounds;
    constructor(child, d) {
        super();
        this.child = child;
        this.d = d;
        this.L = child.L;
        this.bounds = child.bounds.isFinite() ? child.bounds.expand(Math.max(d, 0)) : child.bounds;
        this.minFeature = d < 0 ? child.minFeature + 2 * d : child.minFeature;
    }
    f(x, y, z) { return this.child.f(x, y, z) - this.d; }
    prune(cx, cy, cz, r) {
        const k = this.child.prune(cx, cy, cz, r);
        PRUNED.v -= this.d;
        return k === this.child ? this : new OffsetNode(k, this.d);
    }
    size() { return 1 + this.child.size(); }
}
/** Thin shell |f| - t/2 around the surface (both sides). */
export class ShellNode extends SDF {
    child;
    t;
    bounds;
    constructor(child, t) {
        super();
        this.child = child;
        this.t = t;
        this.L = child.L;
        this.bounds = child.bounds.isFinite() ? child.bounds.expand(t / 2) : child.bounds;
        this.minFeature = Math.min(child.minFeature, t);
    }
    f(x, y, z) { return Math.abs(this.child.f(x, y, z)) - this.t / 2; }
    prune(cx, cy, cz, r) {
        const k = this.child.prune(cx, cy, cz, r);
        PRUNED.v = Math.abs(PRUNED.v) - this.t / 2;
        return k === this.child ? this : new ShellNode(k, this.t);
    }
    size() { return 1 + this.child.size(); }
}
/**
 * Rigid transform: the child is evaluated at M^-1 p. `inv` is the inverse transform as a row-major 3x4
 * matrix (rotation part orthonormal).
 */
export class TransformNode extends SDF {
    child;
    inv;
    bounds;
    constructor(child, inv, fwd) {
        super();
        this.child = child;
        this.inv = inv;
        this.L = child.L;
        this.minFeature = child.minFeature;
        const b = child.bounds;
        if (!b.isFinite()) {
            this.bounds = b;
            return;
        }
        let out = AABB.empty();
        for (let i = 0; i < 8; i++) {
            const x = i & 1 ? b.maxX : b.minX, y = i & 2 ? b.maxY : b.minY, z = i & 4 ? b.maxZ : b.minZ;
            const X = fwd[0] * x + fwd[1] * y + fwd[2] * z + fwd[3];
            const Y = fwd[4] * x + fwd[5] * y + fwd[6] * z + fwd[7];
            const Z = fwd[8] * x + fwd[9] * y + fwd[10] * z + fwd[11];
            out = out.union(new AABB(X, Y, Z, X, Y, Z));
        }
        this.bounds = out;
    }
    f(x, y, z) {
        const m = this.inv;
        return this.child.f(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]);
    }
    prune(cx, cy, cz, r) {
        const m = this.inv;
        const k = this.child.prune(m[0] * cx + m[1] * cy + m[2] * cz + m[3], m[4] * cx + m[5] * cy + m[6] * cz + m[7], m[8] * cx + m[9] * cy + m[10] * cz + m[11], r);
        if (k === this.child)
            return this;
        if (k instanceof Const)
            return k;
        const t = Object.create(TransformNode.prototype);
        t.child = k;
        t.inv = this.inv;
        t.L = k.L;
        t.bounds = this.bounds;
        t.minFeature = this.minFeature;
        return t;
    }
    size() { return 1 + this.child.size(); }
}
/** Pure translation (cheaper than a general transform). */
export class TranslateNode extends SDF {
    child;
    tx;
    ty;
    tz;
    bounds;
    constructor(child, tx, ty, tz) {
        super();
        this.child = child;
        this.tx = tx;
        this.ty = ty;
        this.tz = tz;
        this.L = child.L;
        this.minFeature = child.minFeature;
        this.bounds = child.bounds.isFinite() ? child.bounds.translate(tx, ty, tz) : child.bounds;
    }
    f(x, y, z) { return this.child.f(x - this.tx, y - this.ty, z - this.tz); }
    prune(cx, cy, cz, r) {
        const k = this.child.prune(cx - this.tx, cy - this.ty, cz - this.tz, r);
        if (k === this.child)
            return this;
        if (k instanceof Const)
            return k;
        return new TranslateNode(k, this.tx, this.ty, this.tz);
    }
    size() { return 1 + this.child.size(); }
}
/**
 * Chamfer union / intersection after Hart's and the hg_sdf library's "chamfer" operators: the two
 * surfaces meet along a 45-degree bevel of size c. Lipschitz <= sqrt(2), corrected by dividing.
 */
export class ChamferUnionNode extends SDF {
    a;
    b;
    c;
    bounds;
    constructor(a, b, c) {
        super();
        this.a = a;
        this.b = b;
        this.c = c;
        this.bounds = a.bounds.union(b.bounds).expand(c);
        this.L = Math.max(a.L, b.L);
        this.minFeature = Math.min(a.minFeature, b.minFeature, c);
    }
    f(x, y, z) {
        const va = this.a.f(x, y, z), vb = this.b.f(x, y, z);
        return Math.min(va, vb, (va + vb - this.c) * Math.SQRT1_2);
    }
}
/** Round (fillet) union with radius k: circular blend in the (fa, fb) plane (hg_sdf fOpUnionRound). */
export class RoundUnionNode extends SDF {
    a;
    b;
    k;
    bounds;
    constructor(a, b, k) {
        super();
        this.a = a;
        this.b = b;
        this.k = k;
        this.bounds = a.bounds.union(b.bounds).expand(k);
        this.L = Math.max(a.L, b.L);
        this.minFeature = Math.min(a.minFeature, b.minFeature, k);
    }
    f(x, y, z) {
        const va = this.a.f(x, y, z), vb = this.b.f(x, y, z), k = this.k;
        const ux = Math.max(k - va, 0), uy = Math.max(k - vb, 0);
        return Math.max(k, Math.min(va, vb)) - Math.sqrt(ux * ux + uy * uy);
    }
    prune(cx, cy, cz, r) {
        const pa = this.a.prune(cx, cy, cz, r);
        const va = PRUNED.v;
        const pb = this.b.prune(cx, cy, cz, r);
        const vb = PRUNED.v;
        const k = this.k;
        // Outside the blend band both inputs exceed k or one dominates: becomes a plain min.
        const ux = Math.max(k - va, 0), uy = Math.max(k - vb, 0);
        PRUNED.v = Math.max(k, Math.min(va, vb)) - Math.sqrt(ux * ux + uy * uy);
        if (va - pa.L * r > k + 1e-12 && vb - pb.L * r > k + 1e-12) {
            // both > k in the whole cell: value = min(va, vb) exactly
            return new UnionNode([pa, pb]).prune(cx, cy, cz, r);
        }
        if (pa === this.a && pb === this.b)
            return this;
        return new RoundUnionNode(pa, pb, k);
    }
}
/** Mesh-backed distance field (scans): delegates to a callback built on a BVH (see meshdist.ts). */
export class FieldNode extends SDF {
    fn;
    bounds;
    constructor(fn, bounds, minFeature) {
        super();
        this.fn = fn;
        this.bounds = bounds;
        this.minFeature = minFeature;
    }
    f(x, y, z) { return this.fn(x, y, z); }
}
export function unionOf(nodes) {
    const flat = [];
    for (const n of nodes) {
        if (n instanceof UnionNode)
            flat.push(...n.children);
        else
            flat.push(n);
    }
    return flat.length === 1 ? flat[0] : new UnionNode(flat);
}
export function intersectOf(nodes) {
    const flat = [];
    for (const n of nodes) {
        if (n instanceof IntersectNode)
            flat.push(...n.children);
        else
            flat.push(n);
    }
    return flat.length === 1 ? flat[0] : new IntersectNode(flat);
}
export function differenceOf(a, cutters) {
    if (cutters.length === 0)
        return a;
    const cut = cutters.length === 1 ? cutters[0] : unionOf(cutters);
    const parts = a instanceof IntersectNode ? [...a.children] : [a];
    // Keep a's bounds: an IntersectNode of (a, -cut) gets the finite bounds of a.
    return new IntersectNode([...parts, new NegateNode(cut)]);
}
