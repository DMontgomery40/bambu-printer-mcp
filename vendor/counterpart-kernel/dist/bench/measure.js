/**
 * Section of the mesh by the plane {axis = value}. Returns closed loops in the plane's (u, v)
 * coordinates: axis z -> (x, y); axis y -> (x, z); axis x -> (y, z).
 */
export function section(mesh, axis, value) {
    const p = mesh.positions, idx = mesh.indices;
    const ua = axis === 0 ? 1 : 0, va = axis === 2 ? 1 : 2;
    // segment endpoints are identified by the mesh edge they lie on
    const next = new Map();
    const pts = new Map();
    const s = (v) => p[3 * v + axis] - value;
    for (let t = 0; t < idx.length; t += 3) {
        const vs = [idx[t], idx[t + 1], idx[t + 2]];
        const sv = vs.map(s).map((x) => (x === 0 ? 1e-12 : x));
        const cross = [];
        for (let e = 0; e < 3; e++) {
            const a = vs[e], b = vs[(e + 1) % 3], fa = sv[e], fb = sv[(e + 1) % 3];
            if ((fa < 0) === (fb < 0))
                continue;
            const tt = fa / (fa - fb);
            const pt = [p[3 * a + ua] + tt * (p[3 * b + ua] - p[3 * a + ua]), p[3 * a + va] + tt * (p[3 * b + va] - p[3 * a + va])];
            cross.push({ key: a < b ? `${a}_${b}` : `${b}_${a}`, pt });
        }
        if (cross.length !== 2)
            continue;
        // orient: entering then leaving is not needed for measurement; store both directions
        const [c0, c1] = cross;
        pts.set(c0.key, c0.pt);
        pts.set(c1.key, c1.pt);
        if (!next.has(c0.key))
            next.set(c0.key, c1);
        else
            next.set(c0.key + "#", c1);
        if (!next.has(c1.key))
            next.set(c1.key, c0);
        else
            next.set(c1.key + "#", c0);
    }
    const used = new Set();
    const loops = [];
    for (const start of pts.keys()) {
        if (used.has(start))
            continue;
        const loop = [];
        let prev = "", cur = start;
        for (let guard = 0; guard < 1e7; guard++) {
            used.add(cur);
            loop.push(pts.get(cur));
            const a = next.get(cur), b = next.get(cur + "#");
            let nxt = a && a.key !== prev ? a.key : b && b.key !== prev ? b.key : a?.key;
            if (!nxt || nxt === start || used.has(nxt))
                break;
            prev = cur;
            cur = nxt;
        }
        if (loop.length >= 3)
            loops.push(loop);
    }
    return loops;
}
export function loopBounds(l) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of l) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
export function loopArea(l) {
    let a = 0;
    for (let i = 0; i < l.length; i++) {
        const p = l[i], q = l[(i + 1) % l.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}
export function pointInLoop(l, x, y) {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const [xi, yi] = l[i], [xj, yj] = l[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
            c = !c;
    }
    return c;
}
/** Smallest loop (by area) that encloses the point: e.g. the hole or cavity around a known centre. */
export function loopAround(loops, x, y) {
    let best = null, ba = Infinity;
    for (const l of loops) {
        if (!pointInLoop(l, x, y))
            continue;
        const a = Math.abs(loopArea(l));
        if (a < ba) {
            ba = a;
            best = l;
        }
    }
    return best;
}
/** Least-squares circle: centre, radius, roundness (max - min radial distance of the loop points). */
export function fitCircle(pts) {
    // Kasa: minimise sum (x^2 + y^2 + D x + E y + F)^2
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
    const n = pts.length;
    for (const [x, y] of pts) {
        const z = x * x + y * y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sz += z;
        sxz += x * z;
        syz += y * z;
    }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const b = [-sxz, -syz, -sz];
    const [D, E, F] = solve3(A, b);
    let cx = -D / 2, cy = -E / 2, r = Math.sqrt(Math.max(cx * cx + cy * cy - F, 0));
    // Gauss-Newton on geometric distance
    for (let it = 0; it < 20; it++) {
        let j11 = 0, j12 = 0, j13 = 0, j22 = 0, j23 = 0, j33 = 0, g1 = 0, g2 = 0, g3 = 0;
        for (const [x, y] of pts) {
            const dx = x - cx, dy = y - cy, di = Math.hypot(dx, dy) || 1e-12;
            const res = di - r;
            const a1 = -dx / di, a2 = -dy / di, a3 = -1;
            j11 += a1 * a1;
            j12 += a1 * a2;
            j13 += a1 * a3;
            j22 += a2 * a2;
            j23 += a2 * a3;
            j33 += a3 * a3;
            g1 += a1 * res;
            g2 += a2 * res;
            g3 += a3 * res;
        }
        const [d1, d2, d3] = solve3([[j11, j12, j13], [j12, j22, j23], [j13, j23, j33]], [-g1, -g2, -g3]);
        cx += d1;
        cy += d2;
        r += d3;
        if (Math.abs(d1) + Math.abs(d2) + Math.abs(d3) < 1e-12)
            break;
    }
    let rmin = Infinity, rmax = -Infinity;
    for (const [x, y] of pts) {
        const di = Math.hypot(x - cx, y - cy);
        rmin = Math.min(rmin, di);
        rmax = Math.max(rmax, di);
    }
    return { cx, cy, r, d: 2 * r, roundness: rmax - rmin };
}
export function solve3(A, b) {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
        let piv = c;
        for (let r = c + 1; r < 3; r++)
            if (Math.abs(M[r][c]) > Math.abs(M[piv][c]))
                piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        const d = M[c][c] || 1e-300;
        for (let r = 0; r < 3; r++) {
            if (r === c)
                continue;
            const f = M[r][c] / d;
            for (let k = c; k < 4; k++)
                M[r][k] -= f * M[c][k];
        }
    }
    return [M[0][3] / (M[0][0] || 1e-300), M[1][3] / (M[1][1] || 1e-300), M[2][3] / (M[2][2] || 1e-300)];
}
/** Coordinates along `axis` where the line through (u, v) crosses the mesh (Moller-Trumbore style). */
export function rayCrossings(mesh, axis, u, v) {
    const p = mesh.positions, idx = mesh.indices;
    const ua = axis === 0 ? 1 : 0, va = axis === 2 ? 1 : 2;
    const out = [];
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        // 2D barycentric test in the (ua, va) plane
        const x1 = p[a + ua], y1 = p[a + va], x2 = p[b + ua], y2 = p[b + va], x3 = p[c + ua], y3 = p[c + va];
        const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (det === 0)
            continue;
        const l1 = ((y2 - y3) * (u - x3) + (x3 - x2) * (v - y3)) / det;
        const l2 = ((y3 - y1) * (u - x3) + (x1 - x3) * (v - y3)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0)
            continue;
        out.push(l1 * p[a + axis] + l2 * p[b + axis] + l3 * p[c + axis]);
    }
    out.sort((x, y) => x - y);
    // merge duplicates from shared edges
    const merged = [];
    for (const x of out)
        if (!merged.length || Math.abs(x - merged[merged.length - 1]) > 1e-7)
            merged.push(x);
    return merged;
}
/** Thickness of material along a ray: the length of the first solid interval containing or after `from`. */
export function thicknessAlong(mesh, axis, u, v, near) {
    const xs = rayCrossings(mesh, axis, u, v);
    // intervals [xs[0], xs[1]], [xs[2], xs[3]], ...
    for (let i = 0; i + 1 < xs.length; i += 2)
        if (near >= xs[i] - 1e-9 && near <= xs[i + 1] + 1e-9)
            return xs[i + 1] - xs[i];
    return null;
}
/** Length of the empty interval along the line that contains `near` (e.g. a pocket width or a gap). */
export function gapAlong(mesh, axis, u, v, near) {
    const xs = rayCrossings(mesh, axis, u, v);
    for (let i = 1; i + 1 < xs.length; i += 2)
        if (near >= xs[i] - 1e-9 && near <= xs[i + 1] + 1e-9)
            return xs[i + 1] - xs[i];
    return null;
}
/** Largest loop (by area) that encloses the point. */
export function outerLoopAround(loops, x, y) {
    let best = null, ba = -1;
    for (const l of loops) {
        if (!pointInLoop(l, x, y))
            continue;
        const a = Math.abs(loopArea(l));
        if (a > ba) {
            ba = a;
            best = l;
        }
    }
    return best;
}
