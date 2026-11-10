/**
 * SPIKE: the same scripting surface as the SDF kernel (box, cylinder, cone, rect().extrude, part,
 * add/cut) on the exact-plane polyhedral backend, so a case script can run on either engine unchanged
 * apart from its import line. Curved surfaces are faceted at creation with chord tolerance TOL.
 */
import { Poly3, Polygon, beginPrimitive } from "./bsp.js";
import { KernelError } from "../kernel/profile.js";
import { textPolylines } from "../kernel/font.js";
export const TOL = 0.01;
function segmentsFor(r, sweep = 2 * Math.PI) {
    const step = 2 * Math.acos(Math.max(-1, 1 - TOL / r));
    return Math.max(3, Math.ceil(sweep / step));
}
export class Solid {
    poly;
    constructor(poly) {
        this.poly = poly;
    }
    add(...others) { let p = this.poly; for (const o of others)
        p = p.union(o.poly); return new Solid(p); }
    cut(...others) { let p = this.poly; for (const o of others)
        p = p.subtract(o.poly); return new Solid(p); }
    intersect(...others) { let p = this.poly; for (const o of others)
        p = p.intersect(o.poly); return new Solid(p); }
    move(x, y = 0, z = 0) { return new Solid(this.poly.transform([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z])); }
}
export class Part {
    name;
    solid;
    constructor(name, solid) {
        this.name = name;
        this.solid = solid;
    }
}
export function part(name, solid) { return new Part(name, solid); }
/** prism from a CCW 2D polygon between w=a and w=b along `axis` (sketch plane mapping as in the SDF API). */
export function prism(pts, axis, a, b) {
    beginPrimitive();
    const map = (u, v, w) => (axis === 2 ? [u, v, w] : axis === 0 ? [w, u, v] : [u, w, v]);
    // sketch (u, v, w) -> world is a proper rotation for axis 2 and 0, a reflection for axis 1
    const mirror = axis === 1;
    let poly = pts;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0)
        poly = [...poly].reverse();
    const n = poly.length;
    const polys = [];
    const orient = (vs) => (mirror ? vs.reverse() : vs);
    const top = poly.map(([u, v]) => map(u, v, b));
    const bot = poly.map(([u, v]) => map(u, v, a)).reverse();
    const convex = poly.every((_, i) => {
        const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= -1e-12;
    });
    const caps = convex ? [poly.map((_, i) => i)] : triangulate2(poly);
    for (const tri of caps) {
        polys.push(Polygon.input(orient(tri.map((i) => map(poly[i][0], poly[i][1], b)))));
        polys.push(Polygon.input(orient(tri.map((i) => map(poly[i][0], poly[i][1], a)).reverse())));
    }
    void top;
    void bot;
    for (let i = 0; i < n; i++) {
        const [u0, v0] = poly[i], [u1, v1] = poly[(i + 1) % n];
        polys.push(Polygon.input(orient([map(u0, v0, a), map(u1, v1, a), map(u1, v1, b), map(u0, v0, b)])));
    }
    return new Poly3(polys);
}
/** Ear clipping of a simple CCW polygon (Meisters 1975). Convex polygons give a fan. */
function triangulate2(p) {
    const idx = p.map((_, i) => i);
    const out = [];
    const cross = (a, b, c) => (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);
    const inside = (a, b, c, q) => cross(a, b, q) > 0 && cross(b, c, q) > 0 && cross(c, a, q) > 0;
    let guard = 0;
    while (idx.length > 3 && guard++ < 100000) {
        let found = false;
        for (let i = 0; i < idx.length; i++) {
            const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
            if (cross(a, b, c) <= 1e-12)
                continue;
            if (idx.some((q) => q !== a && q !== b && q !== c && inside(a, b, c, q)))
                continue;
            out.push([a, b, c]);
            idx.splice(i, 1);
            found = true;
            break;
        }
        if (!found)
            throw new KernelError("profile triangulation failed (self-intersecting outline?)");
    }
    out.push([idx[0], idx[1], idx[2]]);
    return out;
}
export class Profile {
    pts;
    rect;
    extra;
    /** pts: closed outline (CCW or CW); rect: analytic description when this is a (rounded) rectangle */
    constructor(pts, rect, extra = []) {
        this.pts = pts;
        this.rect = rect;
        this.extra = extra;
    }
    /** Offset: exact for rectangles (rounded ones keep concentric corners; corners go sharp below r = 0). */
    offset(d) {
        if (!this.rect)
            throw new KernelError("exact backend: offset() is only supported on rect() profiles (a general 2D offset is not implemented)");
        const r = this.rect;
        return rect({ size: [r.w + 2 * d, r.h + 2 * d], center: [r.cx, r.cy], r: Math.max(0, r.r + d) });
    }
    move(x, y) {
        const rr = this.rect ? { ...this.rect, cx: this.rect.cx + x, cy: this.rect.cy + y } : undefined;
        return new Profile(this.pts.map(([u, v]) => [u + x, v + y]), rr, this.extra.map((pl) => pl.map(([u, v]) => [u + x, v + y])));
    }
    extrude(o) {
        const k = ["x", "y", "z"].find((key) => o[key]);
        if (!k)
            throw new KernelError("extrude: give one axis range");
        const axis = ["x", "y", "z"].indexOf(k);
        const [a, b] = o[k];
        const outlines = [this.pts, ...this.extra];
        let solid = new Solid(prism(outlines[0], axis, a, b));
        for (const o2 of outlines.slice(1))
            solid = solid.add(new Solid(prism(o2, axis, a, b)));
        const c = o.top?.chamfer;
        if (c) {
            if (axis !== 2 || this.extra.length)
                throw new KernelError("exact backend: chamfer only on single Z extrusions");
            solid = solid.intersect(new Solid(chamferHull(this.pts, a, b, c)));
        }
        return solid;
    }
}
/** Convex polyhedron: the profile's prism with every edge's 45-degree chamfer plane (convex profiles). */
export function chamferHull(pts, a, b, c, atTop = true) {
    let poly = pts;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0)
        poly = [...poly].reverse();
    // start with a big box and clip by each chamfer half-space n.(x,y) + (z - (b - c)) <= n.p_i
    const big = 1e3;
    let hull = box({ x: [-big, big], y: [-big, big], z: [a - 1, b + 1] }).poly;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const ex = q[0] - p[0], ey = q[1] - p[1], L = Math.hypot(ex, ey);
        if (L < 1e-12)
            continue;
        const nx = ey / L, ny = -ex / L; // outward normal for CCW
        // plane through the edge at z = b - c (top) or a + c (bottom), tilted 45 degrees inwards towards that end
        const z0 = atTop ? b - c : a + c;
        const P0 = [p[0], p[1], z0], P1 = [q[0], q[1], z0], P2 = [q[0] - nx * c, q[1] - ny * c, b];
        const P3 = [p[0] - nx * c, p[1] - ny * c, b];
        // half-space solid: a large slab on the inner side of that plane
        const nzx = nx / Math.SQRT2, nzy = ny / Math.SQRT2, nzz = (atTop ? 1 : -1) / Math.SQRT2;
        void P0;
        void P1;
        void P2;
        void P3;
        const w = nzx * p[0] + nzy * p[1] + nzz * z0;
        hull = hull.intersect(halfSpace(nzx, nzy, nzz, w));
    }
    return hull;
}
/** A huge convex block {n.x <= w} built as a box oriented along n. */
function halfSpace(nx, ny, nz, w) {
    beginPrimitive();
    const n = [nx, ny, nz];
    const t = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    for (let i = 0; i < 3; i++)
        u[i] /= ul;
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const S = 2e3, D = 2e3;
    const o = [n[0] * w, n[1] * w, n[2] * w];
    const P = (a, b, c) => [o[0] + a * u[0] + b * v[0] + c * n[0], o[1] + a * u[1] + b * v[1] + c * n[1], o[2] + a * u[2] + b * v[2] + c * n[2]];
    const corners = [P(-S, -S, -D), P(S, -S, -D), P(S, S, -D), P(-S, S, -D), P(-S, -S, 0), P(S, -S, 0), P(S, S, 0), P(-S, S, 0)];
    const f = (i) => Polygon.input(i.map((k) => corners[k]));
    return new Poly3([f([4, 5, 6, 7]), f([3, 2, 1, 0]), f([0, 1, 5, 4]), f([1, 2, 6, 5]), f([2, 3, 7, 6]), f([3, 0, 4, 7])]);
}
/** Outline builder with lines and arcs (arcs tessellated to TOL). */
export class Path {
    pts = [];
    x = 0;
    y = 0;
    moveTo(x, y) { this.pts = [[x, y]]; this.x = x; this.y = y; return this; }
    lineTo(x, y) { this.pts.push([x, y]); this.x = x; this.y = y; return this; }
    arcTo(x, y, o) {
        const r = o.r, cw = !!o.clockwise, large = !!o.large;
        const dx = x - this.x, dy = y - this.y, chord = Math.hypot(dx, dy);
        const h = Math.sqrt(Math.max(r * r - chord * chord / 4, 0));
        const mx = (this.x + x) / 2, my = (this.y + y) / 2, nx = -dy / chord, ny = dx / chord;
        const side = (cw ? -1 : 1) * (large ? -1 : 1);
        const cx = mx + side * h * nx, cy = my + side * h * ny;
        let a0 = Math.atan2(this.y - cy, this.x - cx), a1 = Math.atan2(y - cy, x - cx);
        if (!cw) {
            while (a1 <= a0)
                a1 += 2 * Math.PI;
        }
        else {
            while (a1 >= a0)
                a1 -= 2 * Math.PI;
        }
        const n = segmentsFor(r, Math.abs(a1 - a0));
        for (let i = 1; i <= n; i++) {
            const a = a0 + (a1 - a0) * (i / n);
            this.pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        this.pts[this.pts.length - 1] = [x, y];
        this.x = x;
        this.y = y;
        return this;
    }
    close() {
        const p = this.pts;
        if (Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-9)
            p.pop();
        return new Profile(p);
    }
}
export function path() { return new Path(); }
/** Stroke text as a union of capsule prisms (same glyphs as the SDF kernel). */
export function text(s, o) {
    const stroke = o.stroke ?? Math.max(o.height * 0.14, 0.8);
    const { lines, width } = textPolylines(s, o.height, stroke);
    const [cx, cy] = o.center ?? [0, 0];
    const caps = [];
    const r = stroke / 2;
    for (const pl of lines) {
        const pts = pl.map(([x, y]) => [x - width / 2 + cx, y - o.height / 2 + cy]);
        if (pts.length === 1)
            pts.push([pts[0][0], pts[0][1]]);
        for (let i = 0; i + 1 < pts.length; i++)
            caps.push(capsule(pts[i], pts[i + 1], r));
    }
    return new Profile(caps[0], undefined, caps.slice(1));
}
function capsule(a, b, r) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const n = Math.max(2, Math.ceil(segmentsFor(r, Math.PI)));
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = ang - Math.PI / 2 - (Math.PI * i) / n;
        out.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
    }
    for (let i = 0; i <= n; i++) {
        const t = ang + Math.PI / 2 - (Math.PI * i) / n;
        out.push([b[0] + r * Math.cos(t), b[1] + r * Math.sin(t)]);
    }
    // a zero-length stroke (a dot) is a full circle
    return out.reverse();
}
export function rect(o) {
    const [w, h] = o.size, [cx, cy] = o.center ?? [0, 0], r = o.r ?? 0;
    const spec = { w, h, cx, cy, r };
    if (!r)
        return new Profile([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], spec);
    const pts = [];
    const n = segmentsFor(r, Math.PI / 2);
    const corners = [[cx + w / 2 - r, cy - h / 2 + r, -Math.PI / 2], [cx + w / 2 - r, cy + h / 2 - r, 0], [cx - w / 2 + r, cy + h / 2 - r, Math.PI / 2], [cx - w / 2 + r, cy - h / 2 + r, Math.PI]];
    for (const [ccx, ccy, a0] of corners)
        for (let i = 0; i <= n; i++) {
            const a = a0 + (Math.PI / 2) * (i / n);
            pts.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]);
        }
    // drop duplicates where corners meet straight edges of zero length
    return new Profile(pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9), spec);
}
export function circle(o) {
    const r = o.d / 2, [cx, cy] = o.center ?? [0, 0];
    const n = 4 * Math.ceil(segmentsFor(r) / 4); // quadrant points are vertices: exact extents
    return new Profile(Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]));
}
export function box(o) {
    return new Profile([[o.x[0], o.y[0]], [o.x[1], o.y[0]], [o.x[1], o.y[1]], [o.x[0], o.y[1]]]).extrude({ z: o.z });
}
function axial(o) {
    const ks = ["x", "y", "z"];
    const k = ks.find((key) => Array.isArray(o[key]));
    const axis = ks.indexOf(k);
    const others = ks.filter((key) => key !== k).map((key) => o[key] ?? 0);
    return { axis, r: o[k], u: others[0], v: others[1] };
}
export function cylinder(o) {
    const { axis, r, u, v } = axial(o);
    return circle({ d: o.d, center: [u, v] }).extrude(axis === 0 ? { x: r } : axis === 1 ? { y: r } : { z: r });
}
/** Frustum: d1 at the start of the range, d2 at the end. */
export function cone(o) {
    beginPrimitive();
    const { axis, r: [a, b], u, v } = axial(o);
    const n = 4 * Math.ceil(segmentsFor(Math.max(o.d1, o.d2) / 2) / 4);
    const map = (pu, pv, w) => (axis === 2 ? [pu, pv, w] : axis === 0 ? [w, pu, pv] : [pu, w, pv]);
    const ring = (d, w) => Array.from({ length: n }, (_, i) => map(u + (d / 2) * Math.cos((2 * Math.PI * i) / n), v + (d / 2) * Math.sin((2 * Math.PI * i) / n), w));
    const lo = ring(o.d1, a), hi = ring(o.d2, b);
    const polys = [];
    const mirror = axis === 1;
    const orient = (vs) => (mirror ? vs.reverse() : vs);
    polys.push(Polygon.input(orient([...hi])));
    polys.push(Polygon.input(orient([...lo].reverse())));
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        polys.push(Polygon.input(orient([lo[i], lo[j], hi[j], hi[i]])));
    }
    return new Solid(new Poly3(polys));
}
