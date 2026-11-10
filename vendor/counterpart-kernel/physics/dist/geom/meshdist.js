export function meshDistance(m) {
    const P = Float64Array.from(m.positions), I = Uint32Array.from(m.indices);
    const nT = I.length / 3, nV = P.length / 3;
    const fn = new Float64Array(3 * nT);
    const vn = new Float64Array(3 * nV);
    const edgeN = new Map();
    const ekey = (a, b) => (a < b ? a * nV + b : b * nV + a);
    for (let t = 0; t < nT; t++) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2];
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        fn[3 * t] = nx;
        fn[3 * t + 1] = ny;
        fn[3 * t + 2] = nz;
        const vs = [a, b, c];
        for (let k = 0; k < 3; k++) {
            const p = vs[k], q = vs[(k + 1) % 3], r = vs[(k + 2) % 3];
            // angle at p
            const e1 = [P[3 * q] - P[3 * p], P[3 * q + 1] - P[3 * p + 1], P[3 * q + 2] - P[3 * p + 2]], e2 = [P[3 * r] - P[3 * p], P[3 * r + 1] - P[3 * p + 1], P[3 * r + 2] - P[3 * p + 2]];
            const ang = Math.acos(Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / ((Math.hypot(e1[0], e1[1], e1[2]) * Math.hypot(e2[0], e2[1], e2[2])) || 1))));
            vn[3 * p] += ang * nx;
            vn[3 * p + 1] += ang * ny;
            vn[3 * p + 2] += ang * nz;
            const ek = ekey(p, q), e = edgeN.get(ek);
            if (e) {
                e[0] += nx;
                e[1] += ny;
                e[2] += nz;
            }
            else
                edgeN.set(ek, [nx, ny, nz]);
        }
    }
    // fragments: long triangles (an exact-path mesh has faces as a few long slivers) are split for the BVH only,
    // so its boxes stay tight; each fragment is a piece of its original triangle and answers for it
    const size = Math.max(...[0, 1, 2].map((a) => { let lo = Infinity, hi = -Infinity; for (let i = a; i < P.length; i += 3) {
        lo = Math.min(lo, P[i]);
        hi = Math.max(hi, P[i]);
    } return hi - lo; }));
    const Lmax = Math.max(size / 40, 1e-6);
    const FP = [], FT = [];
    const split = (t, a, b, c, depth) => {
        const l = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
        if (l <= Lmax || depth > 16) {
            FP.push(...a, ...b, ...c);
            FT.push(t);
            return;
        }
        // bisect the longest edge (slivers split along their length only)
        const lab = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), lbc = Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]), lca = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        if (lab >= lbc && lab >= lca) {
            const mm = [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
            split(t, a, mm, c, depth + 1);
            split(t, mm, b, c, depth + 1);
        }
        else if (lbc >= lca) {
            const mm = [0, 1, 2].map((k) => (b[k] + c[k]) / 2);
            split(t, a, b, mm, depth + 1);
            split(t, a, mm, c, depth + 1);
        }
        else {
            const mm = [0, 1, 2].map((k) => (c[k] + a[k]) / 2);
            split(t, a, b, mm, depth + 1);
            split(t, mm, b, c, depth + 1);
        }
    };
    for (let t = 0; t < nT; t++) {
        const v = [0, 1, 2].map((k) => [P[3 * I[3 * t + k]], P[3 * I[3 * t + k] + 1], P[3 * I[3 * t + k] + 2]]);
        split(t, v[0], v[1], v[2], 0);
    }
    const F = Float64Array.from(FP), FTt = Int32Array.from(FT), nF = FT.length;
    const order = new Uint32Array(nF);
    for (let t = 0; t < nF; t++)
        order[t] = t;
    const cen = new Float64Array(3 * nF);
    for (let t = 0; t < nF; t++)
        for (let a = 0; a < 3; a++)
            cen[3 * t + a] = (F[9 * t + a] + F[9 * t + 3 + a] + F[9 * t + 6 + a]) / 3;
    const bmin = [], bmax = [], left = [], right = [], start = [], count = [];
    const build = (s0, e) => {
        const id = left.length;
        left.push(-1);
        right.push(-1);
        start.push(s0);
        count.push(e - s0);
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = s0; i < e; i++) {
            const t = order[i];
            for (let k = 0; k < 3; k++) {
                const o = 9 * t + 3 * k;
                x0 = Math.min(x0, F[o]);
                y0 = Math.min(y0, F[o + 1]);
                z0 = Math.min(z0, F[o + 2]);
                x1 = Math.max(x1, F[o]);
                y1 = Math.max(y1, F[o + 1]);
                z1 = Math.max(z1, F[o + 2]);
            }
        }
        bmin.push(x0, y0, z0);
        bmax.push(x1, y1, z1);
        if (e - s0 > 4) {
            const ax = [x1 - x0, y1 - y0, z1 - z0].indexOf(Math.max(x1 - x0, y1 - y0, z1 - z0));
            const sub = Array.from(order.subarray(s0, e)).sort((u, v) => cen[3 * u + ax] - cen[3 * v + ax]);
            order.set(sub, s0);
            const mid = (s0 + e) >> 1;
            const l = build(s0, mid), r = build(mid, e);
            left[id] = l;
            right[id] = r;
        }
        return id;
    };
    build(0, nF);
    const Bmin = Float64Array.from(bmin), Bmax = Float64Array.from(bmax);
    const boxD2 = (n, x, y, z) => {
        const dx = Math.max(Bmin[3 * n] - x, 0, x - Bmax[3 * n]), dy = Math.max(Bmin[3 * n + 1] - y, 0, y - Bmax[3 * n + 1]), dz = Math.max(Bmin[3 * n + 2] - z, 0, z - Bmax[3 * n + 2]);
        return dx * dx + dy * dy + dz * dz;
    };
    // closest point on triangle t to (x,y,z): returns squared distance, writes the point and the feature
    const cp = new Float64Array(3);
    let feat = 0; // 0 face, 1..3 vertex a,b,c, 4..6 edge ab, bc, ca
    const closest = (f, x, y, z) => {
        const o = 9 * f;
        const ax = F[o], ay = F[o + 1], az = F[o + 2], bx = F[o + 3], by = F[o + 4], bz = F[o + 5], cx = F[o + 6], cy = F[o + 7], cz = F[o + 8];
        const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = x - ax, apy = y - ay, apz = z - az;
        const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
        let qx, qy, qz;
        if (d1 <= 0 && d2 <= 0) {
            qx = ax;
            qy = ay;
            qz = az;
            feat = 1;
        }
        else {
            const bpx = x - bx, bpy = y - by, bpz = z - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
            if (d3 >= 0 && d4 <= d3) {
                qx = bx;
                qy = by;
                qz = bz;
                feat = 2;
            }
            else {
                const vc = d1 * d4 - d3 * d2;
                if (vc <= 0 && d1 >= 0 && d3 <= 0) {
                    const v = d1 / (d1 - d3);
                    qx = ax + v * abx;
                    qy = ay + v * aby;
                    qz = az + v * abz;
                    feat = 4;
                }
                else {
                    const cpx = x - cx, cpy = y - cy, cpz = z - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
                    if (d6 >= 0 && d5 <= d6) {
                        qx = cx;
                        qy = cy;
                        qz = cz;
                        feat = 3;
                    }
                    else {
                        const vb = d5 * d2 - d1 * d6;
                        if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                            const w = d2 / (d2 - d6);
                            qx = ax + w * acx;
                            qy = ay + w * acy;
                            qz = az + w * acz;
                            feat = 6;
                        }
                        else {
                            const va = d3 * d6 - d5 * d4;
                            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                                const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                                qx = bx + w * (cx - bx);
                                qy = by + w * (cy - by);
                                qz = bz + w * (cz - bz);
                                feat = 5;
                            }
                            else {
                                const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
                                qx = ax + abx * v + acx * w;
                                qy = ay + aby * v + acy * w;
                                qz = az + abz * v + acz * w;
                                feat = 0;
                            }
                        }
                    }
                }
            }
        }
        cp[0] = qx;
        cp[1] = qy;
        cp[2] = qz;
        return (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
    };
    const stack = new Int32Array(256);
    let last = -1;
    const distance = (x, y, z) => {
        let best = Infinity, bt = -1, bf = 0;
        const bp = [0, 0, 0];
        // queries come in spatially coherent order (voxel by voxel): the last answer's triangle bounds the search
        if (last >= 0) {
            best = closest(last, x, y, z);
            bt = last;
            bf = feat;
            bp[0] = cp[0];
            bp[1] = cp[1];
            bp[2] = cp[2];
        }
        let sp = 0;
        stack[sp++] = 0;
        while (sp) {
            const n = stack[--sp];
            if (boxD2(n, x, y, z) >= best)
                continue;
            if (left[n] < 0) {
                for (let i = start[n], e = start[n] + count[n]; i < e; i++) {
                    const t = order[i], d2 = closest(t, x, y, z);
                    if (d2 < best) {
                        best = d2;
                        bt = t;
                        bf = feat;
                        bp[0] = cp[0];
                        bp[1] = cp[1];
                        bp[2] = cp[2];
                    }
                }
            }
            else {
                const l = left[n], r = right[n], dl = boxD2(l, x, y, z), dr = boxD2(r, x, y, z);
                if (dl < dr) {
                    if (dr < best)
                        stack[sp++] = r;
                    if (dl < best)
                        stack[sp++] = l;
                }
                else {
                    if (dl < best)
                        stack[sp++] = l;
                    if (dr < best)
                        stack[sp++] = r;
                }
            }
        }
        if (bt < 0)
            return Infinity;
        last = bt;
        // the feature of the original triangle the closest point lies on (barycentrics: near 0 = on that side)
        {
            const t = FTt[bt], ia = 3 * I[3 * t], ib = 3 * I[3 * t + 1], ic = 3 * I[3 * t + 2];
            const e0 = [P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]], e1 = [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]], v = [bp[0] - P[ia], bp[1] - P[ia + 1], bp[2] - P[ia + 2]];
            const d00 = e0[0] * e0[0] + e0[1] * e0[1] + e0[2] * e0[2], d01 = e0[0] * e1[0] + e0[1] * e1[1] + e0[2] * e1[2], d11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
            const d20 = v[0] * e0[0] + v[1] * e0[1] + v[2] * e0[2], d21 = v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2], den = d00 * d11 - d01 * d01 || 1;
            const lb = (d11 * d20 - d01 * d21) / den, lc = (d00 * d21 - d01 * d20) / den, la = 1 - lb - lc, eps = 1e-7;
            const za = la < eps, zb = lb < eps, zc = lc < eps;
            bf = za && zb ? 3 : zb && zc ? 1 : za && zc ? 2 : zc ? 4 : za ? 5 : zb ? 6 : 0;
            bt = t;
        }
        let nx, ny, nz;
        if (bf === 0) {
            nx = fn[3 * bt];
            ny = fn[3 * bt + 1];
            nz = fn[3 * bt + 2];
        }
        else if (bf <= 3) {
            const v = I[3 * bt + bf - 1];
            nx = vn[3 * v];
            ny = vn[3 * v + 1];
            nz = vn[3 * v + 2];
        }
        else {
            const k = bf - 4, a = I[3 * bt + k], b = I[3 * bt + ((k + 1) % 3)], e = edgeN.get(ekey(a, b));
            nx = e[0];
            ny = e[1];
            nz = e[2];
        }
        const s = (x - bp[0]) * nx + (y - bp[1]) * ny + (z - bp[2]) * nz;
        const d = Math.sqrt(best);
        return s < 0 ? -d : d;
    };
    return { distance, bounds: { min: [Bmin[0], Bmin[1], Bmin[2]], max: [Bmax[0], Bmax[1], Bmax[2]] } };
}
