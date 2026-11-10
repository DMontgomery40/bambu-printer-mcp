/**
 * Voxel grids: a part becomes a block of equal cubes of side h, each with a fill fraction in [0, 1].
 * Sources: a signed distance function (the kernel's Solid.distance, negative inside) or a closed
 * triangle mesh (positions, indices), voxelised by casting rays along z through sub-columns.
 * Partly filled cells keep their fraction as a stiffness scale (a light "finite cell" treatment), which
 * reduces the stiffness error of the staircase; the stress in them is the material's stress.
 */
export function boundsOf(g) {
    if (g.bounds)
        return g.bounds;
    if (!g.mesh)
        throw new Error("geometry: give bounds with a distance function, or a mesh");
    const p = g.mesh.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3)
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], p[i + a]);
            max[a] = Math.max(max[a], p[i + a]);
        }
    return { min, max };
}
/** Voxelise with cell size h. `sub` sub-samples per axis for the fill fraction (2 or 3). */
export function voxelize(g, h, sub = 2) {
    const b = boundsOf(g);
    const pad = 0;
    const origin = [b.min[0] - pad, b.min[1] - pad, b.min[2] - pad];
    const nx = Math.max(1, Math.ceil((b.max[0] - origin[0]) / h - 1e-9));
    const ny = Math.max(1, Math.ceil((b.max[1] - origin[1]) / h - 1e-9));
    const nz = Math.max(1, Math.ceil((b.max[2] - origin[2]) / h - 1e-9));
    const fill = new Float32Array(nx * ny * nz);
    if (g.mesh)
        voxelizeMesh(g.mesh, { nx, ny, nz, h, origin, fill }, sub);
    else if (g.distance) {
        const d = g.distance, s = h / sub;
        for (let iz = 0; iz < nz; iz++)
            for (let iy = 0; iy < ny; iy++)
                for (let ix = 0; ix < nx; ix++) {
                    const cx = origin[0] + (ix + 0.5) * h, cy = origin[1] + (iy + 0.5) * h, cz = origin[2] + (iz + 0.5) * h;
                    const dc = d(cx, cy, cz);
                    let f;
                    if (dc < -h)
                        f = 1;
                    else if (dc > h)
                        f = 0;
                    else {
                        f = 0;
                        for (let a = 0; a < sub; a++)
                            for (let bb = 0; bb < sub; bb++)
                                for (let c = 0; c < sub; c++) {
                                    const v = d(origin[0] + ix * h + (a + 0.5) * s, origin[1] + iy * h + (bb + 0.5) * s, origin[2] + iz * h + (c + 0.5) * s);
                                    f += Math.min(1, Math.max(0, 0.5 - v / s));
                                }
                        f /= sub * sub * sub;
                    }
                    fill[ix + nx * (iy + ny * iz)] = f;
                }
    }
    else
        throw new Error("geometry: give distance or mesh");
    return { nx, ny, nz, h, origin, fill };
}
/** Ray-parity voxelisation: rays along +z at sub x sub positions per column; exact coverage along z. */
function voxelizeMesh(m, gr, sub) {
    const { nx, ny, nz, h, origin, fill } = gr;
    const R = nx * sub, S = ny * sub, s = h / sub;
    const hits = Array.from({ length: R * S }, () => []);
    const p = m.positions, idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2];
        const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), miny = Math.min(ay, by, cy), maxy = Math.max(ay, by, cy);
        const i0 = Math.max(0, Math.ceil((minx - origin[0]) / s - 0.5)), i1 = Math.min(R - 1, Math.floor((maxx - origin[0]) / s - 0.5));
        const j0 = Math.max(0, Math.ceil((miny - origin[1]) / s - 0.5)), j1 = Math.min(S - 1, Math.floor((maxy - origin[1]) / s - 0.5));
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-18)
            continue;
        for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
                // jitter the ray slightly to avoid exact edge hits
                const x = origin[0] + (i + 0.5) * s + 1.234e-7 * s, y = origin[1] + (j + 0.5) * s + 2.345e-7 * s;
                const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
                const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
                const l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0)
                    continue;
                hits[i + R * j].push(l1 * az + l2 * bz + l3 * cz);
            }
    }
    for (let j = 0; j < S; j++)
        for (let i = 0; i < R; i++) {
            const zs = hits[i + R * j].sort((u, v) => u - v);
            for (let k = 0; k + 1 < zs.length; k += 2) {
                const z0 = (zs[k] - origin[2]) / h, z1 = (zs[k + 1] - origin[2]) / h;
                for (let iz = Math.max(0, Math.floor(z0)); iz <= Math.min(nz - 1, Math.floor(z1)); iz++) {
                    const cover = Math.min(z1, iz + 1) - Math.max(z0, iz);
                    if (cover > 0)
                        fill[Math.floor(i / sub) + nx * (Math.floor(j / sub) + ny * iz)] += cover / (sub * sub);
                }
            }
        }
    for (let k = 0; k < fill.length; k++)
        fill[k] = Math.min(1, fill[k]);
}
/**
 * Voxelise for cut-cell integration: every cell the surface may pass through (|distance at the centre| below
 * half the cell diagonal) is sampled on 4 x 4 x 4 sub-cells; each sub-cell's material fraction is the linear
 * ramp 0.5 - d / s at its centre (exact for a plane crossing it along an axis). Returns the grid (fill =
 * material fraction) and, per cut cell, its sub-cell fractions.
 */
export function voxelizeCut(distance, b, h, minFill = 0.02, sub = 4) {
    const origin = [b.min[0], b.min[1], b.min[2]];
    const nx = Math.max(1, Math.ceil((b.max[0] - origin[0]) / h - 1e-9));
    const ny = Math.max(1, Math.ceil((b.max[1] - origin[1]) / h - 1e-9));
    const nz = Math.max(1, Math.ceil((b.max[2] - origin[2]) / h - 1e-9));
    const fill = new Float32Array(nx * ny * nz);
    const cutSub = new Map();
    const s = h / sub, half = 0.8661 * h, cornerD = new Float64Array(8);
    // blocks of 4 x 4 x 4 cells far from the surface are classified from one evaluation at the block centre
    // (the distance is 1-Lipschitz: no cell centre is farther than rB from the block centre)
    const B = 4, rB = Math.sqrt(3) * ((B - 1) / 2) * h;
    const state = new Int8Array(nx * ny * nz); // 1 full, -1 empty, 0 evaluate
    for (let bz = 0; bz < nz; bz += B)
        for (let by = 0; by < ny; by += B)
            for (let bx = 0; bx < nx; bx += B) {
                const ex = Math.min(nx, bx + B), ey = Math.min(ny, by + B), ez = Math.min(nz, bz + B);
                const db = distance(origin[0] + ((bx + ex) / 2) * h, origin[1] + ((by + ey) / 2) * h, origin[2] + ((bz + ez) / 2) * h);
                const st = db + rB <= -half ? 1 : db - rB >= half ? -1 : 0;
                if (st === 0)
                    continue;
                for (let iz = bz; iz < ez; iz++)
                    for (let iy = by; iy < ey; iy++)
                        for (let ix = bx; ix < ex; ix++)
                            state[ix + nx * (iy + ny * iz)] = st;
            }
    for (let iz = 0; iz < nz; iz++)
        for (let iy = 0; iy < ny; iy++)
            for (let ix = 0; ix < nx; ix++) {
                const e = ix + nx * (iy + ny * iz);
                if (state[e] === 1) {
                    fill[e] = 1;
                    continue;
                }
                if (state[e] === -1)
                    continue;
                const cx = origin[0] + (ix + 0.5) * h, cy = origin[1] + (iy + 0.5) * h, cz = origin[2] + (iz + 0.5) * h;
                const dc = distance(cx, cy, cz);
                if (dc <= -half) {
                    fill[e] = 1;
                    continue;
                }
                if (dc >= half)
                    continue;
                const f = new Float32Array(sub * sub * sub);
                let tot = 0;
                // a flat surface through the cell (the common case: the distance is linear over the cell, checked at its
                // 8 corners) gives every sub-cell's distance without evaluating it
                let gx = 0, gy = 0, gz = 0;
                const dcr = cornerD;
                for (let q = 0; q < 8; q++) {
                    const sx = q & 1 ? 1 : -1, sy = q & 2 ? 1 : -1, sz = q & 4 ? 1 : -1;
                    const v = distance(cx + 0.5 * h * sx, cy + 0.5 * h * sy, cz + 0.5 * h * sz);
                    dcr[q] = v;
                    gx += sx * v;
                    gy += sy * v;
                    gz += sz * v;
                }
                gx /= 4 * h;
                gy /= 4 * h;
                gz /= 4 * h;
                let lin = Math.abs(Math.hypot(gx, gy, gz) - 1) < 0.02;
                for (let q = 0; lin && q < 8; q++) {
                    const sx = q & 1 ? 1 : -1, sy = q & 2 ? 1 : -1, sz = q & 4 ? 1 : -1;
                    if (Math.abs(dcr[q] - (dc + 0.5 * h * (gx * sx + gy * sy + gz * sz))) > 0.005 * h)
                        lin = false;
                }
                for (let c = 0; c < sub; c++)
                    for (let bb = 0; bb < sub; bb++)
                        for (let a = 0; a < sub; a++) {
                            const ox = (a + 0.5) * s - 0.5 * h, oy = (bb + 0.5) * s - 0.5 * h, oz = (c + 0.5) * s - 0.5 * h;
                            const v = lin ? dc + gx * ox + gy * oy + gz * oz : distance(cx + ox, cy + oy, cz + oz);
                            const fr = Math.min(1, Math.max(0, 0.5 - v / s));
                            f[a + sub * (bb + sub * c)] = fr;
                            tot += fr;
                        }
                tot /= sub * sub * sub;
                if (tot < minFill)
                    continue;
                if (tot > 0.9999) {
                    fill[e] = 1;
                    continue;
                }
                fill[e] = tot;
                cutSub.set(e, f);
            }
    return { grid: { nx, ny, nz, h, origin, fill }, cutSub };
}
/**
 * Cut-cell voxelisation of a closed triangle mesh by ray parity: rays along z at the centres of 4 x 4 sub-columns
 * per cell give each sub-cell's material fraction exactly along z (the same 4 x 4 x 4 sub-cells as voxelizeCut).
 */
export function voxelizeCutMesh(m, b, h, minFill = 0.02, sub = 4) {
    const origin = [b.min[0], b.min[1], b.min[2]];
    const nx = Math.max(1, Math.ceil((b.max[0] - origin[0]) / h - 1e-9));
    const ny = Math.max(1, Math.ceil((b.max[1] - origin[1]) / h - 1e-9));
    const nz = Math.max(1, Math.ceil((b.max[2] - origin[2]) / h - 1e-9));
    const R = nx * sub, S = ny * sub, s = h / sub, nzs = nz * sub;
    const hits = Array.from({ length: R * S }, () => []);
    const p = m.positions, idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, bb = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[bb], by = p[bb + 1], bz = p[bb + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2];
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - origin[0]) / s - 0.5)), i1 = Math.min(R - 1, Math.floor((Math.max(ax, bx, cx) - origin[0]) / s - 0.5));
        const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - origin[1]) / s - 0.5)), j1 = Math.min(S - 1, Math.floor((Math.max(ay, by, cy) - origin[1]) / s - 0.5));
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-18)
            continue;
        for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
                const x = origin[0] + (i + 0.5) * s + 1.234e-7 * s, y = origin[1] + (j + 0.5) * s + 2.345e-7 * s;
                const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0)
                    continue;
                hits[i + R * j].push(l1 * az + l2 * bz + l3 * cz);
            }
    }
    // per sub-column, coverage of each of the nz * sub z-bins
    const cov = new Float32Array(R * S * nzs);
    for (let j = 0; j < S; j++)
        for (let i = 0; i < R; i++) {
            const zs = hits[i + R * j].sort((u, v) => u - v), o = (i + R * j) * nzs;
            for (let k = 0; k + 1 < zs.length; k += 2) {
                const z0 = (zs[k] - origin[2]) / s, z1 = (zs[k + 1] - origin[2]) / s;
                for (let q = Math.max(0, Math.floor(z0)); q <= Math.min(nzs - 1, Math.floor(z1)); q++) {
                    const cv = Math.min(z1, q + 1) - Math.max(z0, q);
                    if (cv > 0)
                        cov[o + q] += cv;
                }
            }
        }
    const fill = new Float32Array(nx * ny * nz), cutSub = new Map();
    const f = new Float32Array(sub * sub * sub);
    for (let iz = 0; iz < nz; iz++)
        for (let iy = 0; iy < ny; iy++)
            for (let ix = 0; ix < nx; ix++) {
                let tot = 0;
                for (let c = 0; c < sub; c++)
                    for (let bb = 0; bb < sub; bb++)
                        for (let a = 0; a < sub; a++) {
                            const v = Math.min(1, cov[((ix * sub + a) + R * (iy * sub + bb)) * nzs + iz * sub + c]);
                            f[a + sub * (bb + sub * c)] = v;
                            tot += v;
                        }
                tot /= sub * sub * sub;
                if (tot < minFill)
                    continue;
                const e = ix + nx * (iy + ny * iz);
                if (tot > 0.9999) {
                    fill[e] = 1;
                    continue;
                }
                fill[e] = tot;
                cutSub.set(e, f.slice());
            }
    return { grid: { nx, ny, nz, h, origin, fill }, cutSub };
}
