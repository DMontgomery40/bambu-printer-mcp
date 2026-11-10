export class KernelError extends Error {
    constructor(message) { super(message); this.name = "KernelError"; }
}
// kind 1 arc: counter-clockwise from angle a0 to a1 (a1 > a0, a1 - a0 <= 2pi); (x0,y0)=start, (x1,y1)=end
const TAU = Math.PI * 2;
function segBounds(s) {
    if (s.kind === 0)
        return [Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.max(s.x0, s.x1), Math.max(s.y0, s.y1)];
    let minX = Math.min(s.x0, s.x1), maxX = Math.max(s.x0, s.x1), minY = Math.min(s.y0, s.y1), maxY = Math.max(s.y0, s.y1);
    for (let k = -4; k <= 8; k++) {
        const a = k * Math.PI / 2;
        if (a > s.a0 && a < s.a1) {
            const x = s.cx + s.r * Math.cos(a), y = s.cy + s.r * Math.sin(a);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    }
    return [minX, minY, maxX, maxY];
}
function segDist2(s, px, py) {
    if (s.kind === 0) {
        const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - s.x0 - t * dx, ey = py - s.y0 - t * dy;
        return ex * ex + ey * ey;
    }
    const dx = px - s.cx, dy = py - s.cy;
    let a = Math.atan2(dy, dx);
    while (a < s.a0)
        a += TAU;
    while (a > s.a0 + TAU)
        a -= TAU;
    if (a <= s.a1) {
        const d = Math.sqrt(dx * dx + dy * dy) - s.r;
        return d * d;
    }
    const ax = px - s.x0, ay = py - s.y0, bx = px - s.x1, by = py - s.y1;
    return Math.min(ax * ax + ay * ay, bx * bx + by * by);
}
/** Crossings of the ray from (px, py) towards +u with a v-monotonic piece (half-open rule). */
function segCross(s, px, py) {
    const y0 = s.y0, y1 = s.y1;
    if ((y0 <= py) === (y1 <= py))
        return 0; // not straddling (half-open: [min, max))
    if (s.kind === 0) {
        const x = s.x0 + (py - y0) * (s.x1 - s.x0) / (y1 - y0);
        return x > px ? 1 : 0;
    }
    // monotonic arc piece: the crossing x is on the side of the centre given by the piece's mid angle
    const am = (s.a0 + s.a1) / 2;
    const side = Math.cos(am) >= 0 ? 1 : -1;
    const dy = py - s.cy;
    const h = Math.sqrt(Math.max(s.r * s.r - dy * dy, 0));
    const x = s.cx + side * h;
    return x > px ? 1 : 0;
}
/** Split a CCW arc at its extreme-v angles (pi/2 + k pi) so each piece is monotonic in v. */
function splitArc(cx, cy, r, a0, a1) {
    const cuts = [a0];
    // split at every quadrant angle: pieces are monotonic in v (for the crossing rule) and every
    // extreme point of the arc is a vertex of any tessellation (exact bounding boxes)
    for (let k = -12; k <= 20; k++) {
        const a = (k * Math.PI) / 2;
        if (a > a0 + 1e-12 && a < a1 - 1e-12)
            cuts.push(a);
    }
    cuts.push(a1);
    cuts.sort((p, q) => p - q);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
        const b0 = cuts[i], b1 = cuts[i + 1];
        out.push({ kind: 1, cx, cy, r, a0: b0, a1: b1,
            x0: cx + r * Math.cos(b0), y0: cy + r * Math.sin(b0), x1: cx + r * Math.cos(b1), y1: cy + r * Math.sin(b1) });
    }
    return out;
}
/** Closed outlines made of lines and arcs. Several contours combine by even-odd (outer + holes). */
export class Outline {
    bounds2;
    minFeature;
    segs;
    /** Contours as polygons, arcs tessellated to `tol` (vertices on the arcs), for the polyhedral path. */
    contours = [];
    gx0;
    gy0;
    cs;
    nx;
    ny;
    margin;
    cellSegs;
    bandSegs;
    /** Polylines of the contours (for display and area checks). */
    constructor(segs, minFeature) {
        if (segs.length === 0)
            throw new KernelError("An outline needs at least one segment.");
        this.segs = segs;
        let b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const s of segs) {
            const sb = segBounds(s);
            b = [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])];
        }
        this.bounds2 = b;
        this.minFeature = minFeature;
        const ext = Math.max(b[2] - b[0], b[3] - b[1]);
        this.cs = Math.min(Math.max(ext / 48, 0.4), 5);
        this.margin = Math.max(6, 3 * this.cs);
        const m = this.margin;
        this.gx0 = b[0] - m;
        this.gy0 = b[1] - m;
        this.nx = Math.max(1, Math.ceil((b[2] - b[0] + 2 * m) / this.cs));
        this.ny = Math.max(1, Math.ceil((b[3] - b[1] + 2 * m) / this.cs));
        const lists = Array.from({ length: this.nx * this.ny }, () => []);
        const bands = Array.from({ length: this.ny }, () => []);
        segs.forEach((s, idx) => {
            const sb = segBounds(s);
            const i0 = Math.max(0, Math.floor((sb[0] - m - this.gx0) / this.cs));
            const i1 = Math.min(this.nx - 1, Math.floor((sb[2] + m - this.gx0) / this.cs));
            const j0 = Math.max(0, Math.floor((sb[1] - m - this.gy0) / this.cs));
            const j1 = Math.min(this.ny - 1, Math.floor((sb[3] + m - this.gy0) / this.cs));
            for (let j = j0; j <= j1; j++)
                for (let i = i0; i <= i1; i++) {
                    // exact rectangle test: the segment is within m of the bucket rectangle
                    const rx0 = this.gx0 + i * this.cs, ry0 = this.gy0 + j * this.cs;
                    const cxr = rx0 + this.cs / 2, cyr = ry0 + this.cs / 2;
                    const halfDiag = this.cs * Math.SQRT1_2;
                    if (Math.sqrt(segDist2(s, cxr, cyr)) <= m + halfDiag)
                        lists[j * this.nx + i].push(idx);
                }
            const bj0 = Math.max(0, Math.floor((sb[1] - this.gy0) / this.cs));
            const bj1 = Math.min(this.ny - 1, Math.floor((sb[3] - this.gy0) / this.cs));
            for (let j = bj0; j <= bj1; j++)
                bands[j].push(idx);
        });
        this.cellSegs = lists.map((l) => Int32Array.from(l));
        this.bandSegs = bands.map((l) => Int32Array.from(l));
    }
    inside(px, py) {
        const j = Math.floor((py - this.gy0) / this.cs);
        if (j < 0 || j >= this.ny)
            return false;
        const band = this.bandSegs[j];
        let c = 0;
        for (let k = 0; k < band.length; k++)
            c += segCross(this.segs[band[k]], px, py);
        return (c & 1) === 1;
    }
    d(px, py) {
        const m = this.margin;
        const fi = (px - this.gx0) / this.cs, fj = (py - this.gy0) / this.cs;
        const i = Math.floor(fi), j = Math.floor(fj);
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) {
            // outside the grid: at least m from the shape; distance to the grid rectangle keeps it 1-Lipschitz
            const gx1 = this.gx0 + this.nx * this.cs, gy1 = this.gy0 + this.ny * this.cs;
            const dx = Math.max(this.gx0 - px, 0, px - gx1), dy = Math.max(this.gy0 - py, 0, py - gy1);
            return m + Math.sqrt(dx * dx + dy * dy);
        }
        const list = this.cellSegs[j * this.nx + i];
        let best = m * m;
        for (let k = 0; k < list.length; k++) {
            const d2 = segDist2(this.segs[list[k]], px, py);
            if (d2 < best)
                best = d2;
        }
        const dist = Math.sqrt(best);
        return this.inside(px, py) ? -dist : dist;
    }
    /** Signed area (even-odd regions counted with their orientation), by the shoelace formula plus arc caps. */
    area() {
        let a = 0;
        for (const s of this.segs) {
            a += (s.x0 * s.y1 - s.x1 * s.y0) / 2;
            if (s.kind === 1) {
                const t = s.a1 - s.a0;
                a += s.r * s.r * (t - Math.sin(t)) / 2;
            }
        }
        return a;
    }
}
// --- analytic shapes ---------------------------------------------------------------------------------
export class Circle2 {
    cx;
    cy;
    r;
    bounds2;
    minFeature;
    constructor(cx, cy, r) {
        this.cx = cx;
        this.cy = cy;
        this.r = r;
        if (!(r > 0))
            throw new KernelError(`circle: radius must be > 0 (got ${r}).`);
        this.bounds2 = [cx - r, cy - r, cx + r, cy + r];
        this.minFeature = 2 * r;
    }
    d(u, v) { const dx = u - this.cx, dy = v - this.cy; return Math.sqrt(dx * dx + dy * dy) - this.r; }
}
/** Rectangle centred at (cx, cy), half sizes hw, hh, corner radius r. Exact. */
export class Rect2 {
    cx;
    cy;
    hw;
    hh;
    r;
    bounds2;
    minFeature;
    constructor(cx, cy, hw, hh, r = 0) {
        this.cx = cx;
        this.cy = cy;
        this.hw = hw;
        this.hh = hh;
        this.r = r;
        if (!(hw > 0 && hh > 0))
            throw new KernelError(`rect: width and height must be > 0 (got ${2 * hw} x ${2 * hh}).`);
        if (r < 0 || r > Math.min(hw, hh) + 1e-9)
            throw new KernelError(`rect: corner radius ${r} must be between 0 and half the smaller side (${Math.min(hw, hh)}).`);
        this.r = Math.min(r, Math.min(hw, hh));
        this.bounds2 = [cx - hw, cy - hh, cx + hw, cy + hh];
        this.minFeature = 2 * Math.min(hw, hh);
    }
    d(u, v) {
        const r = this.r;
        const qx = Math.abs(u - this.cx) - this.hw + r, qy = Math.abs(v - this.cy) - this.hh + r;
        const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
        return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
    }
}
/** Union of capsules (polyline strokes of a given width): used for the built-in stroke font. */
export class Strokes2 {
    width;
    bounds2;
    minFeature;
    inner;
    segs;
    constructor(polylines, width) {
        this.width = width;
        const segs = [];
        for (const pl of polylines) {
            if (pl.length === 1)
                segs.push({ x0: pl[0][0], y0: pl[0][1], x1: pl[0][0], y1: pl[0][1] });
            for (let i = 0; i + 1 < pl.length; i++)
                segs.push({ x0: pl[i][0], y0: pl[i][1], x1: pl[i + 1][0], y1: pl[i + 1][1] });
        }
        this.segs = segs;
        // reuse the Outline bucket grid for nearest-segment queries (its inside() is not used)
        this.inner = new Outline(segs.map((s) => ({ kind: 0, ...s })), width);
        const b = this.inner.bounds2, w = width / 2;
        this.bounds2 = [b[0] - w, b[1] - w, b[2] + w, b[3] + w];
        this.minFeature = width;
    }
    d(u, v) {
        const d = this.inner.d(u, v);
        return Math.abs(d) - this.width / 2;
    }
}
export class Union2 {
    parts;
    bounds2;
    minFeature;
    constructor(parts) {
        this.parts = parts;
        this.bounds2 = parts.reduce((b, p) => [Math.min(b[0], p.bounds2[0]), Math.min(b[1], p.bounds2[1]), Math.max(b[2], p.bounds2[2]), Math.max(b[3], p.bounds2[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        this.minFeature = Math.min(...parts.map((p) => p.minFeature));
    }
    d(u, v) {
        let m = Infinity;
        for (const p of this.parts) {
            const x = p.d(u, v);
            if (x < m)
                m = x;
        }
        return m;
    }
}
export class Diff2 {
    a;
    cutters;
    bounds2;
    minFeature;
    constructor(a, cutters) {
        this.a = a;
        this.cutters = cutters;
        this.bounds2 = a.bounds2;
        this.minFeature = Math.min(a.minFeature, ...cutters.map((p) => p.minFeature));
    }
    d(u, v) {
        let m = this.a.d(u, v);
        for (const p of this.cutters) {
            const x = -p.d(u, v);
            if (x > m)
                m = x;
        }
        return m;
    }
}
export class Intersect2 {
    parts;
    bounds2;
    minFeature;
    constructor(parts) {
        this.parts = parts;
        this.bounds2 = parts.reduce((b, p) => [Math.max(b[0], p.bounds2[0]), Math.max(b[1], p.bounds2[1]), Math.min(b[2], p.bounds2[2]), Math.min(b[3], p.bounds2[3])], [-Infinity, -Infinity, Infinity, Infinity]);
        this.minFeature = Math.min(...parts.map((p) => p.minFeature));
    }
    d(u, v) {
        let m = -Infinity;
        for (const p of this.parts) {
            const x = p.d(u, v);
            if (x > m)
                m = x;
        }
        return m;
    }
}
/** Offset by r (grow for r > 0). Exact for exact 2D distances. */
export class Offset2 {
    s;
    r;
    bounds2;
    minFeature;
    constructor(s, r) {
        this.s = s;
        this.r = r;
        const g = Math.max(r, 0);
        this.bounds2 = [s.bounds2[0] - g, s.bounds2[1] - g, s.bounds2[2] + g, s.bounds2[3] + g];
        this.minFeature = r < 0 ? s.minFeature + 2 * r : s.minFeature;
    }
    d(u, v) { return this.s.d(u, v) - this.r; }
}
/** Rotate by `deg` about the origin, then translate. */
export class Move2 {
    shape;
    deg;
    tx;
    ty;
    bounds2;
    minFeature;
    c;
    s;
    constructor(shape, deg, tx, ty) {
        this.shape = shape;
        this.deg = deg;
        this.tx = tx;
        this.ty = ty;
        const a = deg * Math.PI / 180;
        this.c = Math.cos(a);
        this.s = Math.sin(a);
        const b = shape.bounds2;
        let out = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
            const X = this.c * x - this.s * y + tx, Y = this.s * x + this.c * y + ty;
            out = [Math.min(out[0], X), Math.min(out[1], Y), Math.max(out[2], X), Math.max(out[3], Y)];
        }
        this.bounds2 = out;
        this.minFeature = shape.minFeature;
    }
    d(u, v) {
        const x = u - this.tx, y = v - this.ty;
        return this.shape.d(this.c * x + this.s * y, -this.s * x + this.c * y);
    }
}
export class Mirror2 {
    shape;
    axis;
    bounds2;
    minFeature;
    constructor(shape, axis) {
        this.shape = shape;
        this.axis = axis;
        const b = shape.bounds2;
        this.bounds2 = axis === "x" ? [-b[2], b[1], -b[0], b[3]] : [b[0], -b[3], b[2], -b[1]];
        this.minFeature = shape.minFeature;
    }
    d(u, v) { return this.axis === "x" ? this.shape.d(-u, v) : this.shape.d(u, -v); }
}
// --- path builder -----------------------------------------------------------------------------------
/**
 * Builds closed outlines from lines and arcs. Coordinates in millimetres. Arcs:
 *  - arcTo(x, y, radius, {clockwise, large})  circular arc to (x, y) with the given radius
 *  - arcThrough(mx, my, x, y)                 arc through a middle point (three-point arc)
 *  - tangentArcTo(x, y)                        arc tangent to the previous segment
 */
export class PathBuilder {
    segs = [];
    contours = [];
    sx = 0;
    sy = 0;
    x = 0;
    y = 0;
    started = false;
    lastDir = null;
    minFeature = Infinity;
    moveTo(x, y) {
        this.finishContour();
        this.sx = this.x = x;
        this.sy = this.y = y;
        this.started = true;
        this.lastDir = null;
        return this;
    }
    lineTo(x, y) {
        this.need("lineTo");
        if (Math.hypot(x - this.x, y - this.y) < 1e-9)
            return this;
        this.segs.push({ kind: 0, x0: this.x, y0: this.y, x1: x, y1: y });
        const l = Math.hypot(x - this.x, y - this.y);
        this.lastDir = [(x - this.x) / l, (y - this.y) / l];
        this.x = x;
        this.y = y;
        return this;
    }
    /** Relative line. */
    line(dx, dy) { return this.lineTo(this.x + dx, this.y + dy); }
    arcTo(x, y, radius, opts = {}) {
        this.need("arcTo");
        const cw = !!opts.clockwise, large = !!opts.large;
        const dx = x - this.x, dy = y - this.y, chord = Math.hypot(dx, dy);
        if (radius < chord / 2 - 1e-9)
            throw new KernelError(`arcTo(${x}, ${y}): radius ${radius} is smaller than half the chord (${(chord / 2).toFixed(4)}) from (${this.x}, ${this.y}).`);
        const r = Math.max(radius, chord / 2);
        const h = Math.sqrt(Math.max(r * r - chord * chord / 4, 0));
        const mx = (this.x + x) / 2, my = (this.y + y) / 2;
        // centre on the left of the chord for a CCW minor arc
        const nx = -dy / chord, ny = dx / chord;
        const side = (cw ? -1 : 1) * (large ? -1 : 1);
        const cx = mx + side * h * nx, cy = my + side * h * ny;
        return this.addArc(cx, cy, r, x, y, cw);
    }
    arcThrough(mx, my, x, y) {
        this.need("arcThrough");
        const ax = this.x, ay = this.y;
        const d = 2 * (ax * (my - y) + mx * (y - ay) + x * (ay - my));
        if (Math.abs(d) < 1e-12)
            throw new KernelError(`arcThrough: the three points (${ax},${ay}), (${mx},${my}), (${x},${y}) are collinear.`);
        const a2 = ax * ax + ay * ay, m2 = mx * mx + my * my, e2 = x * x + y * y;
        const cx = (a2 * (my - y) + m2 * (y - ay) + e2 * (ay - my)) / d;
        const cy = (a2 * (x - mx) + m2 * (ax - x) + e2 * (mx - ax)) / d;
        const r = Math.hypot(ax - cx, ay - cy);
        // orientation: CCW if the middle point lies on the CCW path from start to end
        const cross = (mx - ax) * (y - ay) - (my - ay) * (x - ax);
        return this.addArc(cx, cy, r, x, y, cross < 0); // cross > 0: the middle point is left of the chord -> CCW
    }
    tangentArcTo(x, y) {
        this.need("tangentArcTo");
        if (!this.lastDir)
            throw new KernelError("tangentArcTo needs a previous segment to be tangent to.");
        const [tx, ty] = this.lastDir;
        const dx = x - this.x, dy = y - this.y;
        // centre c = p + n s where n is the normal of the tangent; |c - end| = |s|
        const nx = -ty, ny = tx;
        const denom = 2 * (dx * nx + dy * ny);
        if (Math.abs(denom) < 1e-12)
            return this.lineTo(x, y);
        const s = (dx * dx + dy * dy) / denom;
        const cx = this.x + nx * s, cy = this.y + ny * s;
        return this.addArc(cx, cy, Math.abs(s), x, y, s < 0);
    }
    close() {
        this.need("close");
        if (Math.hypot(this.sx - this.x, this.sy - this.y) > 1e-9)
            this.lineTo(this.sx, this.sy);
        this.finishContour();
        this.started = false;
        return this;
    }
    addArc(cx, cy, r, x, y, clockwise) {
        let a0 = Math.atan2(this.y - cy, this.x - cx), a1 = Math.atan2(y - cy, x - cx);
        // store as CCW from lo to hi
        let lo, hi;
        if (!clockwise) {
            while (a1 <= a0)
                a1 += TAU;
            lo = a0;
            hi = a1;
        }
        else {
            while (a0 <= a1)
                a0 += TAU;
            lo = a1;
            hi = a0;
        }
        const pieces = splitArc(cx, cy, r, lo, hi);
        if (clockwise) {
            pieces.reverse();
            for (const pc of pieces)
                pc.rev = true;
        }
        this.segs.push(...pieces);
        this.minFeature = Math.min(this.minFeature, r);
        // tangent direction at the end
        const ex = x - cx, ey = y - cy;
        this.lastDir = clockwise ? [ey / r, -ex / r] : [-ey / r, ex / r];
        this.x = x;
        this.y = y;
        return this;
    }
    need(op) {
        if (!this.started)
            throw new KernelError(`${op}: start the outline with moveTo(x, y) first.`);
    }
    finishContour() {
        if (this.segs.length) {
            const first = this.segs[0], last = this.segs[this.segs.length - 1];
            const fx = first.kind === 0 ? first.x0 : first.x0, fy = first.y0;
            void fx;
            void fy;
            void last;
            this.contours.push(this.segs);
            this.segs = [];
        }
    }
    /** Finish and return the shape (all contours, even-odd). */
    build() {
        if (this.started && this.segs.length) {
            throw new KernelError("The outline is not closed: call close() before using it.");
        }
        this.finishContour();
        const all = this.contours.flat();
        // minimum feature: shortest segment length is a reasonable proxy for straight outlines
        let mf = this.minFeature;
        const b = all.reduce((acc, s) => {
            const sb = segBounds(s);
            return [Math.min(acc[0], sb[0]), Math.min(acc[1], sb[1]), Math.max(acc[2], sb[2]), Math.max(acc[3], sb[3])];
        }, [Infinity, Infinity, -Infinity, -Infinity]);
        mf = Math.min(mf, b[2] - b[0], b[3] - b[1]);
        const o = new Outline(all, mf);
        o.contours = this.contours.map((c) => c.slice());
        return o;
    }
}
/** Polygon from points, optionally with every corner rounded to radius `fillet` (or per-corner radii). */
export function polygonOutline(points, fillet = 0) {
    const n = points.length;
    if (n < 3)
        throw new KernelError(`polygon needs at least 3 points (got ${n}).`);
    const radii = Array.isArray(fillet) ? fillet : new Array(n).fill(fillet);
    if (radii.length !== n)
        throw new KernelError(`polygon: ${n} points but ${radii.length} fillet radii.`);
    if (radii.every((r) => !r)) {
        const pb = new PathBuilder().moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < n; i++)
            pb.lineTo(points[i][0], points[i][1]);
        return pb.close().build();
    }
    // Tangent distance t = r / tan(theta/2) along both edges of each rounded corner.
    const corners = [];
    const lens = [];
    for (let i = 0; i < n; i++) {
        const p = points[(i + n - 1) % n], c = points[i], q = points[(i + 1) % n];
        const r = radii[i];
        const d1x = c[0] - p[0], d1y = c[1] - p[1], l1 = Math.hypot(d1x, d1y);
        const d2x = q[0] - c[0], d2y = q[1] - c[1], l2 = Math.hypot(d2x, d2y);
        lens.push(l2);
        if (l1 < 1e-9 || l2 < 1e-9)
            throw new KernelError(`polygon: points ${i} and its neighbour coincide at (${c[0]}, ${c[1]}).`);
        const ux = -d1x / l1, uy = -d1y / l1, vx = d2x / l2, vy = d2y / l2; // both pointing away from c
        const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
        if (!r || theta < 1e-6 || Math.PI - theta < 1e-6) {
            corners.push({ a: c, b: c, r: 0, cw: false, t: 0 });
            continue;
        }
        const t = r / Math.tan(theta / 2);
        const turn = d1x * d2y - d1y * d2x; // >0 left turn
        corners.push({ a: [c[0] + ux * t, c[1] + uy * t], b: [c[0] + vx * t, c[1] + vy * t], r, cw: turn < 0, t });
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (corners[i].t + corners[j].t > lens[i] + 1e-9)
            throw new KernelError(`polygon: fillets at corners ${i} and ${j} need ${(corners[i].t + corners[j].t).toFixed(3)} mm of the edge between them, which is only ${lens[i].toFixed(3)} mm long. Use smaller radii.`);
    }
    const pb = new PathBuilder().moveTo(corners[0].b[0], corners[0].b[1]);
    for (let k = 1; k <= n; k++) {
        const c = corners[k % n];
        pb.lineTo(c.a[0], c.a[1]);
        if (c.r)
            pb.arcTo(c.b[0], c.b[1], c.r, { clockwise: c.cw });
    }
    return pb.close().build();
}
/** Tessellate contours of lines and arcs into polygons with every vertex on the true outline. */
export function contoursToPolygons(contours, tol = 0.01) {
    return contours.map((c) => {
        const out = [];
        for (const s of c) {
            if (s.kind === 0) {
                out.push([s.x0, s.y0]);
                continue;
            }
            const rev = !!s.rev;
            out.push(rev ? [s.x1, s.y1] : [s.x0, s.y0]);
            const sweep = s.a1 - s.a0;
            const step = 2 * Math.acos(Math.max(-1, 1 - tol / s.r));
            const n = Math.max(1, Math.ceil(sweep / step));
            for (let i = 1; i < n; i++) {
                const a = rev ? s.a1 - (sweep * i) / n : s.a0 + (sweep * i) / n;
                out.push([s.cx + s.r * Math.cos(a), s.cy + s.r * Math.sin(a)]);
            }
        }
        // drop consecutive duplicates
        return out.filter((p, i) => Math.hypot(p[0] - out[(i + out.length - 1) % out.length][0], p[1] - out[(i + out.length - 1) % out.length][1]) > 1e-9);
    });
}
