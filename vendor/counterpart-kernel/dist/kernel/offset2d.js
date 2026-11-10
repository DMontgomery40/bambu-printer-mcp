/**
 * Exact offsets of closed outlines made of lines and circular arcs (the classical construction used by
 * CNC tool-path generators, e.g. Held, "On the Computational Geometry of Pocket Machining", 1991):
 * each line moves along its normal, each arc keeps its centre and changes radius; at convex corners the
 * gap is closed by a round join (an arc about the original vertex), at concave corners the two offset
 * pieces are trimmed to their intersection. Only local trimming is done: if a piece reverses or vanishes,
 * or the result self-intersects, the offset throws and the caller falls back to the distance field.
 *
 * Every output piece remembers the original geometry it came from, so two offsets of the same outline
 * can be lofted with matching vertices (flared pocket mouths, chamfers on curved outlines).
 */
import { KernelError } from "./profile.js";
const pt = (s, end) => s.kind === "line" ? (end ? [s.x1, s.y1] : [s.x0, s.y0]) : [s.cx + s.r * Math.cos(end ? s.a1 : s.a0), s.cy + s.r * Math.sin(end ? s.a1 : s.a0)];
function tangent(s, end) {
    if (s.kind === "line") {
        const l = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
        return [(s.x1 - s.x0) / l, (s.y1 - s.y0) / l];
    }
    const a = end ? s.a1 : s.a0, dir = s.a1 > s.a0 ? 1 : -1;
    return [-Math.sin(a) * dir, Math.cos(a) * dir];
}
/** Signed area of the outline (positive = counter-clockwise). */
export function outlineArea(segs) {
    let a = 0;
    for (const s of segs) {
        const [x0, y0] = pt(s, 0), [x1, y1] = pt(s, 1);
        a += (x0 * y1 - x1 * y0) / 2;
        if (s.kind === "arc") {
            const t = s.a1 - s.a0;
            a += s.r * s.r * (t - Math.sin(t)) / 2;
        }
    }
    return a;
}
function intersect(a, b, near) {
    const cands = [];
    const lineLine = (p, q) => {
        const d1x = p.x1 - p.x0, d1y = p.y1 - p.y0, d2x = q.x1 - q.x0, d2y = q.y1 - q.y0;
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-14)
            return;
        const t = ((q.x0 - p.x0) * d2y - (q.y0 - p.y0) * d2x) / den;
        cands.push([p.x0 + t * d1x, p.y0 + t * d1y]);
    };
    const lineCircle = (p, c) => {
        const dx = p.x1 - p.x0, dy = p.y1 - p.y0, fx = p.x0 - c.cx, fy = p.y0 - c.cy;
        const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - c.r * c.r;
        const disc = B * B - 4 * A * C;
        if (disc < 0)
            return;
        for (const sg of [-1, 1]) {
            const t = (-B + sg * Math.sqrt(disc)) / (2 * A);
            cands.push([p.x0 + t * dx, p.y0 + t * dy]);
        }
    };
    if (a.kind === "line" && b.kind === "line")
        lineLine(a, b);
    else if (a.kind === "line" && b.kind === "arc")
        lineCircle(a, b);
    else if (a.kind === "arc" && b.kind === "line")
        lineCircle(b, a);
    else if (a.kind === "arc" && b.kind === "arc") {
        const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
        if (d < 1e-14 || d > a.r + b.r || d < Math.abs(a.r - b.r))
            return null;
        const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h = Math.sqrt(Math.max(a.r * a.r - l * l, 0));
        const mx = a.cx + (l * dx) / d, my = a.cy + (l * dy) / d;
        cands.push([mx + (h * dy) / d, my - (h * dx) / d], [mx - (h * dy) / d, my + (h * dx) / d]);
    }
    let best = null, bd = Infinity;
    for (const c of cands) {
        const dd = Math.hypot(c[0] - near[0], c[1] - near[1]);
        if (dd < bd) {
            bd = dd;
            best = c;
        }
    }
    return best;
}
function withEnd(s, end, p) {
    if (s.kind === "line")
        return end ? { ...s, x1: p[0], y1: p[1] } : { ...s, x0: p[0], y0: p[1] };
    let a = Math.atan2(p[1] - s.cy, p[0] - s.cx);
    const ref = end ? s.a1 : s.a0;
    while (a - ref > Math.PI)
        a -= 2 * Math.PI;
    while (ref - a > Math.PI)
        a += 2 * Math.PI;
    return end ? { ...s, a1: a } : { ...s, a0: a };
}
/** Offset a closed outline by d (> 0 grows the enclosed region). */
export function offsetOutline(segs, d) {
    if (d === 0)
        return segs.map((s) => ({ seg: s, src: s }));
    const orient = outlineArea(segs) >= 0 ? 1 : -1;
    // outward normal of a traversal direction t: orient * (t.y, -t.x)
    const nrm = (t) => [orient * t[1], -orient * t[0]];
    const moved = segs.map((s) => {
        if (s.kind === "line") {
            const [nx, ny] = nrm(tangent(s, 0));
            return { kind: "line", x0: s.x0 + d * nx, y0: s.y0 + d * ny, x1: s.x1 + d * nx, y1: s.y1 + d * ny };
        }
        const [nx, ny] = nrm(tangent(s, 0));
        const [px, py] = pt(s, 0);
        const r = s.r + d * ((px - s.cx) * nx + (py - s.cy) * ny) / s.r;
        if (!(r > 1e-9))
            throw new KernelError(`offset ${d}: an arc of radius ${s.r.toFixed(3)} vanishes`);
        return { ...s, r };
    });
    const n = segs.length;
    const pieces = moved.map((m, i) => ({ seg: m, src: segs[i] }));
    const out = [];
    // joins: process corner between i and i+1
    const joinAfter = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const P = pt(segs[i], 1);
        const tin = tangent(segs[i], 1), tout = tangent(segs[j], 0);
        const e = pt(pieces[i].seg, 1), s = pt(pieces[j].seg, 0);
        if (Math.hypot(e[0] - s[0], e[1] - s[1]) < 1e-9)
            continue;
        const cross = tin[0] * tout[1] - tin[1] * tout[0];
        if (orient * cross * Math.sign(d) > 0) {
            // gap: round join about the original vertex
            let a0 = Math.atan2(e[1] - P[1], e[0] - P[0]), a1 = Math.atan2(s[1] - P[1], s[0] - P[0]);
            const ccw = orient > 0;
            if (ccw) {
                while (a1 < a0)
                    a1 += 2 * Math.PI;
            }
            else {
                while (a1 > a0)
                    a1 -= 2 * Math.PI;
            }
            joinAfter[i] = { seg: { kind: "arc", cx: P[0], cy: P[1], r: Math.abs(d), a0, a1 }, src: { kind: "point", x: P[0], y: P[1] } };
        }
        else {
            const X = intersect(pieces[i].seg, pieces[j].seg, P);
            if (!X)
                throw new KernelError(`offset ${d}: cannot trim the corner at (${P[0].toFixed(3)}, ${P[1].toFixed(3)})`);
            pieces[i] = { ...pieces[i], seg: withEnd(pieces[i].seg, 1, X) };
            pieces[j] = { ...pieces[j], seg: withEnd(pieces[j].seg, 0, X) };
        }
    }
    for (let i = 0; i < n; i++) {
        // validity: trimmed pieces must keep their direction
        const o = pieces[i].seg, src = segs[i];
        if (o.kind === "line" && src.kind === "line") {
            const dot = (o.x1 - o.x0) * (src.x1 - src.x0) + (o.y1 - o.y0) * (src.y1 - src.y0);
            if (dot <= 0)
                throw new KernelError(`offset ${d}: a straight edge of the outline disappears`);
        }
        else if (o.kind === "arc" && src.kind === "arc") {
            if ((o.a1 - o.a0) * (src.a1 - src.a0) <= 0)
                throw new KernelError(`offset ${d}: an arc of the outline disappears`);
        }
        out.push(pieces[i]);
        if (joinAfter[i])
            out.push(joinAfter[i]);
    }
    const poly = tessellate(out.map((p) => p.seg), 0.01);
    if (selfIntersects(poly))
        throw new KernelError(`offset ${d}: the offset outline intersects itself`);
    return out;
}
export function segPoint(s, u) {
    if (s.kind === "point")
        return [s.x, s.y];
    if (s.kind === "line")
        return [s.x0 + (s.x1 - s.x0) * u, s.y0 + (s.y1 - s.y0) * u];
    const a = s.a0 + (s.a1 - s.a0) * u;
    return [s.cx + s.r * Math.cos(a), s.cy + s.r * Math.sin(a)];
}
export function segCount(s, tol) {
    if (s.kind === "line")
        return 1;
    return Math.max(1, Math.ceil(Math.abs(s.a1 - s.a0) / (2 * Math.acos(Math.max(-1, 1 - tol / s.r)))));
}
export function tessellate(segs, tol) {
    const out = [];
    for (const s of segs) {
        const n = segCount(s, tol);
        for (let i = 0; i < n; i++)
            out.push(segPoint(s, i / n));
    }
    return out.filter((p, i) => Math.hypot(p[0] - out[(i + out.length - 1) % out.length][0], p[1] - out[(i + out.length - 1) % out.length][1]) > 1e-9);
}
/** Matching rings for a loft between offsets d0 and d1 of the same outline (same piece structure). */
export function loftRings(segs, d0, d1, tol = 0.01) {
    const far = offsetOutline(segs, Math.abs(d1) > Math.abs(d0) ? d1 : d0);
    const nearD = Math.abs(d1) > Math.abs(d0) ? d0 : d1;
    if (nearD !== 0)
        throw new KernelError("loft: one end must be the outline itself");
    const rf = [], rn = [];
    for (const p of far) {
        const n = segCount(p.seg, tol);
        const src = p.src;
        for (let i = 0; i < n; i++) {
            const u = i / n;
            rf.push(segPoint(p.seg, u));
            rn.push(segPoint(src, u));
        }
    }
    return Math.abs(d1) > Math.abs(d0) ? { r0: rn, r1: rf } : { r0: rf, r1: rn };
}
function selfIntersects(p) {
    const n = p.length;
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (let i = 0; i < n; i++) {
        const a = p[i], b = p[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1)
                continue;
            const c = p[j], dd = p[(j + 1) % n];
            const d1 = cross(a, b, c), d2 = cross(a, b, dd), d3 = cross(c, dd, a), d4 = cross(c, dd, b);
            if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12)))
                return true;
        }
    }
    return false;
}
/**
 * Matching rings for several offsets of one outline (all deltas <= 0 or all >= 0, the extreme one first
 * decides the piece structure). Each piece is tessellated with the same count in every ring.
 */
export function multiRings(segs, deltas, tol = 0.01) {
    const ext = deltas.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0);
    if (ext === 0) {
        const r = tessellate(segs, tol);
        return deltas.map(() => r);
    }
    const far = offsetOutline(segs, ext);
    const counts = far.map((p) => Math.max(segCount(p.seg, tol), p.src.kind === "point" ? 1 : segCount(p.src, tol)));
    return deltas.map((d) => {
        const ring = [];
        if (d === 0) {
            far.forEach((p, k) => { for (let i = 0; i < counts[k]; i++)
                ring.push(segPoint(p.src, i / counts[k])); });
            return ring;
        }
        const pcs = offsetOutline(segs, d);
        if (pcs.length !== far.length)
            throw new KernelError(`offset ${d}: the outline changes structure between offsets`);
        pcs.forEach((p, k) => { for (let i = 0; i < counts[k]; i++)
            ring.push(segPoint(p.seg, i / counts[k])); });
        return ring;
    });
}
