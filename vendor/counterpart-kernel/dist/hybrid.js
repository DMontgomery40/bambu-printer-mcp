/**
 * Exact (polyhedral) twin of a 2D profile, used by the hybrid kernel: profiles made of lines and arcs are
 * kept as polygons whose vertices lie on the true outline (arcs tessellated to 0.01 mm), combined by
 * even-odd nesting or by 3D booleans after extrusion. Offsets are exact only for rectangles and circles;
 * anything else marks the profile as field-only and the part falls back to the distance-field mesher.
 */
import { Poly3, Polygon, beginPrimitive } from "./exact/bsp.js";
import { prism, chamferHull } from "./exact/api.js";
import { offsetOutline, tessellate, loftRings, multiRings } from "./kernel/offset2d.js";
import { earClip2 } from "./kernel/meshops.js";
function pointIn(poly, x, y) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
            c = !c;
    }
    return c;
}
export class XP {
    contours;
    op;
    kids;
    rect;
    circle;
    tsegs;
    constructor(contours, op = null, kids = [], rect, circle, 
    /** exact outline pieces (lines and arcs) per contour, when known: enables exact offsets and lofts */
    tsegs) {
        this.contours = contours;
        this.op = op;
        this.kids = kids;
        this.rect = rect;
        this.circle = circle;
        this.tsegs = tsegs;
    }
    static leaf(contours, rect, circle, tsegs) { return new XP(contours, null, [], rect, circle, tsegs); }
    static fromSegs(tsegs) { return new XP(tsegs.map((c) => tessellate(c, TOL)), null, [], undefined, undefined, tsegs); }
    transform(m) {
        const f = (p) => [m[0] * p[0] + m[1] * p[1] + m[4], m[2] * p[0] + m[3] * p[1] + m[5]];
        const pureMove = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
        if (this.contours) {
            const rect = pureMove && this.rect ? { ...this.rect, cx: this.rect.cx + m[4], cy: this.rect.cy + m[5] } : undefined;
            const circle = this.circle ? (() => { const c = f([this.circle.cx, this.circle.cy]); return { cx: c[0], cy: c[1], r: this.circle.r }; })() : undefined;
            const det = m[0] * m[3] - m[1] * m[2];
            const ts = this.tsegs && Math.abs(Math.abs(det) - 1) < 1e-12 ? this.tsegs.map((c) => c.map((sg) => transformSeg(sg, m, det))) : undefined;
            return new XP(this.contours.map((c) => c.map(f)), null, [], rect, circle, ts);
        }
        return new XP(null, this.op, this.kids.map((k) => k.transform(m)));
    }
    /** Exact offset where it is representable (rectangles, circles); null otherwise. */
    offset(d) {
        if (this.rect) {
            const { w, h, cx, cy, r } = this.rect;
            const W = w + 2 * d, H = h + 2 * d, R = Math.max(0, r + d);
            if (!(W > 0 && H > 0))
                return null;
            return XP.leaf([rectPolygon(W, H, cx, cy, R)], { w: W, h: H, cx, cy, r: R });
        }
        if (this.circle) {
            const R = this.circle.r + d;
            if (!(R > 0))
                return null;
            return XP.leaf([circlePolygon(this.circle.cx, this.circle.cy, R)], undefined, { cx: this.circle.cx, cy: this.circle.cy, r: R });
        }
        if (this.tsegs && this.contours && !this.nested()) {
            try {
                return XP.fromSegs(this.tsegs.map((c) => offsetOutline(c, d).map((p) => p.seg)));
            }
            catch {
                return null;
            }
        }
        return null;
    }
    nested() {
        const cs = this.contours;
        return cs.some((c, i) => cs.some((d, j) => j !== i && pointIn(d, c[0][0], c[0][1])));
    }
    /** Outline pieces for a single-contour profile (from tsegs, or built for rects/circles). */
    pieces() {
        if (this.tsegs && this.tsegs.length === 1)
            return this.tsegs[0];
        if (this.rect)
            return rectSegs(this.rect);
        if (this.circle) {
            const { cx, cy, r } = this.circle;
            return [{ kind: "arc", cx, cy, r, a0: 0, a1: Math.PI }, { kind: "arc", cx, cy, r, a0: Math.PI, a1: 2 * Math.PI }];
        }
        return null;
    }
    /**
     * Extrusion whose last `size` mm towards one end is a loft to the outline offset by `delta`
     * (delta > 0: flare/lead-in, delta < 0: chamfer). Exact pieces, or null if not representable.
     */
    /** Revolution about the Z axis through (cx, cy): sketch x = radius, sketch y = z. Leaf profiles only. */
    lathe(cx, cy, tol = 0.01) {
        if (!this.contours)
            return null;
        const cs = this.contours;
        if (cs.some((c) => c.some((p) => p[0] < -1e-9)))
            return null;
        const rmax = Math.max(...cs.flat().map((p) => p[0]));
        const n = Math.max(12, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(-1, 1 - tol / rmax)))));
        const depth = cs.map((c, i) => cs.filter((d, j) => j !== i && pointIn(d, c[0][0], c[0][1])).length);
        let solid = null;
        cs.map((_, i) => i).sort((i, j) => depth[i] - depth[j]).forEach((i) => {
            const p = latheContour(cs[i], n, cx, cy);
            solid = !solid ? p : depth[i] % 2 === 0 ? solid.union(p) : solid.subtract(p);
        });
        return solid;
    }
    /** Extrusion with rounded ends (quarter-circle edge profile of radius r at the chosen ends). */
    rounded(axis, a, b, rLo, rHi, tol = 0.01) {
        const segs = this.pieces();
        if (!segs)
            return null;
        const r = Math.max(rLo, rHi);
        // angular steps so the chord error of the quarter circle stays within tol
        const steps = Math.max(2, Math.ceil((Math.PI / 2) / (2 * Math.acos(Math.max(-1, 1 - tol / r)))));
        const quarter = (rr) => Array.from({ length: steps + 1 }, (_, i) => (Math.PI / 2) * (i / steps)).map((t) => ({ delta: -rr * (1 - Math.sin(t)), dw: rr * (1 - Math.cos(t)) }));
        const levels = [];
        if (rLo > 0)
            for (const q of quarter(rLo))
                levels.push({ delta: q.delta, w: a + q.dw });
        else
            levels.push({ delta: 0, w: a });
        const top = rHi > 0 ? quarter(rHi).reverse().map((q) => ({ delta: q.delta, w: b - q.dw })) : [{ delta: 0, w: b }];
        levels.push(...top);
        // drop duplicate w levels (straight part shorter than nothing)
        const lv = levels.filter((l, i) => i === 0 || l.w > levels[i - 1].w + 1e-12);
        let rings;
        try {
            rings = multiRings(segs, lv.map((l) => l.delta), tol);
        }
        catch {
            return null;
        }
        return ringSolid(rings.map((rg, i) => [rg, lv[i].w]), axis);
    }
    lofted(axis, a, b, ends) {
        const segs = this.pieces();
        if (!segs)
            return null;
        const { lo, hi } = ends;
        if (lo && hi)
            return null; // one treated end per extrusion on this path (both ends: field mesher)
        const e = (hi ?? lo);
        let rings;
        try {
            rings = loftRings(segs, 0, e.delta, TOL);
        }
        catch {
            return null;
        }
        // one closed polyhedron through matching rings: no boolean, so no coplanar-face cases
        if (hi)
            return ringSolid([[rings.r0, a], [rings.r0, b - hi.size], [rings.r1, b]], axis);
        return ringSolid([[rings.r1, a], [rings.r0, a + lo.size], [rings.r0, b]], axis);
    }
    /** The single convex contour, if this profile is one (needed for exact chamfers). */
    singleConvex() {
        if (!this.contours || this.contours.length !== 1)
            return null;
        const p = this.contours[0], n = p.length;
        let sgn = 0;
        for (let i = 0; i < n; i++) {
            const a = p[i], b = p[(i + 1) % n], c = p[(i + 2) % n];
            const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (Math.abs(cr) < 1e-12)
                continue;
            if (sgn === 0)
                sgn = Math.sign(cr);
            else if (Math.sign(cr) !== sgn)
                return null;
        }
        return p;
    }
    prism(axis, a, b) {
        if (this.contours) {
            const cs = this.contours;
            const depth = cs.map((c, i) => cs.filter((d, j) => j !== i && pointIn(d, c[0][0], c[0][1])).length);
            const order = cs.map((_, i) => i).sort((i, j) => depth[i] - depth[j]);
            let solid = null;
            for (const i of order) {
                const p = prism(cs[i], axis, a, b);
                if (!solid)
                    solid = p;
                else
                    solid = depth[i] % 2 === 0 ? solid.union(p) : solid.subtract(p);
            }
            return solid;
        }
        let s = this.kids[0].prism(axis, a, b);
        for (const k of this.kids.slice(1)) {
            const p = k.prism(axis, a, b);
            s = this.op === "union" ? s.union(p) : this.op === "cut" ? s.subtract(p) : s.intersect(p);
        }
        return s;
    }
    chamfered(a, b, top, bottom) {
        const c = this.singleConvex();
        if (!c)
            return null;
        let s = prism(c, 2, a, b);
        if (top > 0)
            s = s.intersect(chamferHull(c, a, b, top, true));
        if (bottom > 0)
            s = s.intersect(chamferHull(c, a, b, bottom, false));
        return s;
    }
}
const TOL = 0.01;
function segs(r, sweep) { return Math.max(3, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - TOL / r))))); }
export function circlePolygon(cx, cy, r) {
    const n = 4 * Math.ceil(segs(r, 2 * Math.PI) / 4); // quadrant points are vertices: exact extents
    return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
}
export function rectPolygon(w, h, cx, cy, r) {
    if (!r)
        return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    const n = segs(r, Math.PI / 2);
    const pts = [];
    const corners = [[cx + w / 2 - r, cy - h / 2 + r, -Math.PI / 2], [cx + w / 2 - r, cy + h / 2 - r, 0], [cx - w / 2 + r, cy + h / 2 - r, Math.PI / 2], [cx - w / 2 + r, cy - h / 2 + r, Math.PI]];
    for (const [ccx, ccy, a0] of corners)
        for (let i = 0; i <= n; i++) {
            const a = a0 + (Math.PI / 2) * (i / n);
            pts.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]);
        }
    return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
}
function transformSeg(sg, m, det) {
    const f = (x, y) => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];
    if (sg.kind === "line") {
        const [x0, y0] = f(sg.x0, sg.y0), [x1, y1] = f(sg.x1, sg.y1);
        return { kind: "line", x0, y0, x1, y1 };
    }
    const [cx, cy] = f(sg.cx, sg.cy);
    const rot = Math.atan2(m[2], m[0]);
    if (det > 0)
        return { kind: "arc", cx, cy, r: sg.r, a0: sg.a0 + rot, a1: sg.a1 + rot };
    // reflection: angles mirror
    const ang = (a) => { const [x, y] = [Math.cos(a), Math.sin(a)]; return Math.atan2(m[2] * x + m[3] * y, m[0] * x + m[1] * y); };
    let a0 = ang(sg.a0), a1 = ang(sg.a1);
    const sweep = -(sg.a1 - sg.a0);
    a1 = a0 + sweep;
    return { kind: "arc", cx, cy, r: sg.r, a0, a1 };
}
function rectSegs(r) {
    const { w, h, cx, cy } = r, R = r.r;
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    if (!R)
        return [
            { kind: "line", x0, y0, x1, y1: y0 }, { kind: "line", x0: x1, y0, x1, y1 },
            { kind: "line", x0: x1, y0: y1, x1: x0, y1 }, { kind: "line", x0, y0: y1, x1: x0, y1: y0 }
        ];
    const segs = [];
    const add = (s) => { if (s.kind === "arc" || Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-12)
        segs.push(s); };
    add({ kind: "line", x0: x0 + R, y0, x1: x1 - R, y1: y0 });
    add({ kind: "arc", cx: x1 - R, cy: y0 + R, r: R, a0: -Math.PI / 2, a1: 0 });
    add({ kind: "line", x0: x1, y0: y0 + R, x1, y1: y1 - R });
    add({ kind: "arc", cx: x1 - R, cy: y1 - R, r: R, a0: 0, a1: Math.PI / 2 });
    add({ kind: "line", x0: x1 - R, y0: y1, x1: x0 + R, y1 });
    add({ kind: "arc", cx: x0 + R, cy: y1 - R, r: R, a0: Math.PI / 2, a1: Math.PI });
    add({ kind: "line", x0, y0: y1 - R, x1: x0, y1: y0 + R });
    add({ kind: "arc", cx: x0 + R, cy: y0 + R, r: R, a0: Math.PI, a1: 1.5 * Math.PI });
    return segs;
}
/** Closed solid through rings (matching vertices) at increasing w; triangulated sides, ear-clipped caps. */
function ringSolid(rings, axis) {
    beginPrimitive();
    const map = (p, w) => (axis === 2 ? [p[0], p[1], w] : axis === 0 ? [w, p[0], p[1]] : [p[0], w, p[1]]);
    // orientation from the largest ring
    const last = rings[rings.length - 1][0];
    let area = 0;
    for (let i = 0; i < last.length; i++) {
        const p = last[i], q = last[(i + 1) % last.length];
        area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0)
        rings = rings.map(([r, w]) => [[...r].reverse(), w]);
    const flip = axis === 1; // the (x, z) sketch plane with w = y is a reflection
    const polys = [];
    const push = (vs) => {
        const ux = vs[1][0] - vs[0][0], uy = vs[1][1] - vs[0][1], uz = vs[1][2] - vs[0][2];
        const vx = vs[2][0] - vs[0][0], vy = vs[2][1] - vs[0][1], vz = vs[2][2] - vs[0][2];
        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-12)
            return;
        polys.push(Polygon.input(flip ? [...vs].reverse() : vs));
    };
    for (let k = 0; k + 1 < rings.length; k++) {
        const [r0, w0] = rings[k], [r1, w1] = rings[k + 1];
        const n = r0.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const A = map(r0[i], w0), B = map(r0[j], w0), C = map(r1[j], w1), D = map(r1[i], w1);
            push([A, B, C]);
            push([A, C, D]);
        }
    }
    const cap = (ring, w, up) => {
        const pts = ring.filter((p, i) => Math.hypot(p[0] - ring[(i + ring.length - 1) % ring.length][0], p[1] - ring[(i + ring.length - 1) % ring.length][1]) > 1e-12);
        // a convex cap stays one polygon: a fan of long thin triangles makes slivers when the BSP splits them
        const n = pts.length;
        let convex = true;
        for (let i = 0; i < n && convex; i++) {
            const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
            if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < -1e-12)
                convex = false;
        }
        if (convex) {
            const poly = pts.map((p) => map(p, w));
            push(up ? poly : poly.reverse());
            return;
        }
        for (const [a, b, c] of earClip2(pts)) {
            const tri = [map(pts[a], w), map(pts[b], w), map(pts[c], w)];
            push(up ? tri : tri.reverse());
        }
    };
    cap(rings[0][0], rings[0][1], false);
    cap(rings[rings.length - 1][0], rings[rings.length - 1][1], true);
    return new Poly3(polys);
}
/** Surface of revolution of one closed (r, z) contour: quads between consecutive angles, outward wound. */
function latheContour(c, n, cx, cy) {
    beginPrimitive();
    let area = 0;
    for (let i = 0; i < c.length; i++) {
        const p = c[i], q = c[(i + 1) % c.length];
        area += p[0] * q[1] - q[0] * p[1];
    }
    const ring = area >= 0 ? c : [...c].reverse(); // CCW in (r, z)
    const P = (k, p) => { const a = (2 * Math.PI * k) / n; return [cx + p[0] * Math.cos(a), cy + p[0] * Math.sin(a), p[1]]; };
    const polys = [];
    const push = (vs) => {
        const ux = vs[1][0] - vs[0][0], uy = vs[1][1] - vs[0][1], uz = vs[1][2] - vs[0][2];
        const vx = vs[2][0] - vs[0][0], vy = vs[2][1] - vs[0][1], vz = vs[2][2] - vs[0][2];
        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-12)
            return;
        polys.push(Polygon.input(vs));
    };
    for (let k = 0; k < n; k++)
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            // CCW contour in (r, z) swept counter-clockwise about +z: (a,k) (a,k+1) (b,k+1) (b,k) is outward-wound
            const A = P(k, a), B = P(k + 1, a), C = P(k + 1, b), D = P(k, b);
            push([A, B, C]);
            push([A, C, D]);
        }
    return new Poly3(polys);
}
