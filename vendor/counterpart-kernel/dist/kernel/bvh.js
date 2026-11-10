export class BVH {
    mesh;
    nodeMin;
    nodeMax;
    nodeLeft;
    nodeStart;
    nodeCount;
    order;
    nNodes = 0;
    // pseudonormals
    faceN;
    vertN;
    edgeN = new Map();
    bounds;
    constructor(mesh) {
        this.mesh = mesh;
        const p = mesh.positions, idx = mesh.indices, nt = idx.length / 3, nv = p.length / 3;
        const cent = new Float64Array(nt * 3), tmin = new Float64Array(nt * 3), tmax = new Float64Array(nt * 3);
        for (let t = 0; t < nt; t++)
            for (let a = 0; a < 3; a++) {
                const x0 = p[idx[3 * t] * 3 + a], x1 = p[idx[3 * t + 1] * 3 + a], x2 = p[idx[3 * t + 2] * 3 + a];
                tmin[3 * t + a] = Math.min(x0, x1, x2);
                tmax[3 * t + a] = Math.max(x0, x1, x2);
                cent[3 * t + a] = (x0 + x1 + x2) / 3;
            }
        const cap = 2 * nt + 1;
        this.nodeMin = new Float64Array(cap * 3);
        this.nodeMax = new Float64Array(cap * 3);
        this.nodeLeft = new Int32Array(cap);
        this.nodeStart = new Int32Array(cap);
        this.nodeCount = new Int32Array(cap);
        this.order = new Int32Array(nt).map((_, i) => i);
        const build = (start, count) => {
            const n = this.nNodes++;
            let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
            let cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
            for (let i = start; i < start + count; i++) {
                const t = this.order[i];
                for (let a = 0; a < 3; a++) {
                    mn[a] = Math.min(mn[a], tmin[3 * t + a]);
                    mx[a] = Math.max(mx[a], tmax[3 * t + a]);
                    cmn[a] = Math.min(cmn[a], cent[3 * t + a]);
                    cmx[a] = Math.max(cmx[a], cent[3 * t + a]);
                }
            }
            for (let a = 0; a < 3; a++) {
                this.nodeMin[3 * n + a] = mn[a];
                this.nodeMax[3 * n + a] = mx[a];
            }
            if (count <= 4) {
                this.nodeLeft[n] = -1;
                this.nodeStart[n] = start;
                this.nodeCount[n] = count;
                return n;
            }
            let axis = 0;
            if (cmx[1] - cmn[1] > cmx[axis] - cmn[axis])
                axis = 1;
            if (cmx[2] - cmn[2] > cmx[axis] - cmn[axis])
                axis = 2;
            const mid = (cmn[axis] + cmx[axis]) / 2;
            let i = start, j = start + count - 1;
            while (i <= j) {
                if (cent[3 * this.order[i] + axis] < mid)
                    i++;
                else {
                    const tmp = this.order[i];
                    this.order[i] = this.order[j];
                    this.order[j] = tmp;
                    j--;
                }
            }
            let leftCount = i - start;
            if (leftCount === 0 || leftCount === count)
                leftCount = count >> 1;
            const l = build(start, leftCount);
            build(start + leftCount, count - leftCount);
            this.nodeLeft[n] = l; // right child is always nNodes after left subtree: store explicitly via start
            this.nodeStart[n] = -1;
            this.nodeCount[n] = 0;
            return n;
        };
        // store right child index in nodeCount for internal nodes
        const buildRoot = (start, count) => build(start, count);
        buildRoot(0, nt);
        // fix right children: recompute by traversal (left subtree size known by walking)
        this.fixRight(0);
        this.bounds = { min: [this.nodeMin[0], this.nodeMin[1], this.nodeMin[2]], max: [this.nodeMax[0], this.nodeMax[1], this.nodeMax[2]] };
        // pseudonormals
        this.faceN = new Float64Array(nt * 3);
        this.vertN = new Float64Array(nv * 3);
        for (let t = 0; t < nt; t++) {
            const ia = idx[3 * t], ib = idx[3 * t + 1], ic = idx[3 * t + 2];
            const ux = p[3 * ib] - p[3 * ia], uy = p[3 * ib + 1] - p[3 * ia + 1], uz = p[3 * ib + 2] - p[3 * ia + 2];
            const vx = p[3 * ic] - p[3 * ia], vy = p[3 * ic + 1] - p[3 * ia + 1], vz = p[3 * ic + 2] - p[3 * ia + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz) || 1;
            nx /= l;
            ny /= l;
            nz /= l;
            this.faceN[3 * t] = nx;
            this.faceN[3 * t + 1] = ny;
            this.faceN[3 * t + 2] = nz;
            const corners = [ia, ib, ic];
            for (let k = 0; k < 3; k++) {
                const v = corners[k], a = corners[(k + 1) % 3], b = corners[(k + 2) % 3];
                const e1 = [p[3 * a] - p[3 * v], p[3 * a + 1] - p[3 * v + 1], p[3 * a + 2] - p[3 * v + 2]];
                const e2 = [p[3 * b] - p[3 * v], p[3 * b + 1] - p[3 * v + 1], p[3 * b + 2] - p[3 * v + 2]];
                const ang = Math.acos(Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / ((Math.hypot(e1[0], e1[1], e1[2]) * Math.hypot(e2[0], e2[1], e2[2])) || 1))));
                this.vertN[3 * v] += ang * nx;
                this.vertN[3 * v + 1] += ang * ny;
                this.vertN[3 * v + 2] += ang * nz;
                const key = Math.min(v, a) * nv + Math.max(v, a);
                const en = this.edgeN.get(key) ?? [0, 0, 0];
                en[0] += nx;
                en[1] += ny;
                en[2] += nz;
                this.edgeN.set(key, en);
            }
        }
    }
    right;
    fixRight(root) {
        // nodes were numbered in preorder: left child = n + 1; right child = n + 1 + size(left subtree)
        this.right = new Int32Array(this.nNodes).fill(-1);
        const size = new Int32Array(this.nNodes);
        const sz = (n) => {
            if (this.nodeLeft[n] < 0)
                return (size[n] = 1);
            const l = n + 1;
            const ls = sz(l);
            const r = n + 1 + ls;
            this.right[n] = r;
            return (size[n] = 1 + ls + sz(r));
        };
        sz(root);
    }
    /** Closest point on the mesh: returns distance, and fills out (closest point, feature normal). */
    closest(px, py, pz, maxDist = Infinity, out) {
        const p = this.mesh.positions, idx = this.mesh.indices;
        let best = maxDist * maxDist;
        let bestT = -1, bx = 0, by = 0, bz = 0, bFeat = 0, bu = 0, bv = 0;
        const stack = new Int32Array(128);
        let sp = 0;
        stack[sp++] = 0;
        while (sp) {
            const n = stack[--sp];
            const d2 = boxDist2(this.nodeMin, this.nodeMax, n, px, py, pz);
            if (d2 >= best)
                continue;
            if (this.nodeLeft[n] < 0) {
                const s = this.nodeStart[n], c = this.nodeCount[n];
                for (let i = s; i < s + c; i++) {
                    const t = this.order[i];
                    const r = closestOnTri(px, py, pz, p, idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]);
                    if (r.d2 < best) {
                        best = r.d2;
                        bestT = t;
                        bx = r.x;
                        by = r.y;
                        bz = r.z;
                        bFeat = r.feat;
                        bu = r.u;
                        bv = r.v;
                    }
                }
            }
            else {
                const l = n + 1, rr = this.right[n];
                const dl = boxDist2(this.nodeMin, this.nodeMax, l, px, py, pz), dr = boxDist2(this.nodeMin, this.nodeMax, rr, px, py, pz);
                if (dl < dr) {
                    if (dr < best)
                        stack[sp++] = rr;
                    if (dl < best)
                        stack[sp++] = l;
                }
                else {
                    if (dl < best)
                        stack[sp++] = l;
                    if (dr < best)
                        stack[sp++] = rr;
                }
            }
        }
        if (bestT < 0)
            return maxDist;
        if (out) {
            out[0] = bx;
            out[1] = by;
            out[2] = bz;
            // feature pseudonormal
            const nv = p.length / 3;
            const ia = idx[3 * bestT], ib = idx[3 * bestT + 1], ic = idx[3 * bestT + 2];
            let n;
            if (bFeat === 0)
                n = [this.faceN[3 * bestT], this.faceN[3 * bestT + 1], this.faceN[3 * bestT + 2]];
            else if (bFeat <= 3) {
                const v = [ia, ib, ic][bFeat - 1];
                n = [this.vertN[3 * v], this.vertN[3 * v + 1], this.vertN[3 * v + 2]];
            }
            else {
                const [a, b] = bFeat === 4 ? [ia, ib] : bFeat === 5 ? [ib, ic] : [ic, ia];
                n = this.edgeN.get(Math.min(a, b) * nv + Math.max(a, b)) ?? [0, 0, 1];
            }
            out[3] = n[0];
            out[4] = n[1];
            out[5] = n[2];
            out[6] = bestT;
            out[7] = bu;
            out[8] = bv;
        }
        return Math.sqrt(best);
    }
    tmp = new Float64Array(9);
    /** Signed distance (negative inside) for closed, outward-wound meshes. */
    signedDistance(x, y, z, maxDist = Infinity) {
        const o = this.tmp;
        const d = this.closest(x, y, z, maxDist, o);
        if (d >= maxDist)
            return this.insideByRay(x, y, z) ? -maxDist : maxDist;
        const s = (x - o[0]) * o[3] + (y - o[1]) * o[4] + (z - o[2]) * o[5];
        return s < 0 ? -d : d;
    }
    /** Nearest hit distance along a ray (origin o, unit direction d), or null. Slab test per node. */
    rayHit(ox, oy, oz, dx, dy, dz, tMin = 1e-6) {
        const p = this.mesh.positions, idx = this.mesh.indices;
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
        let best = Infinity;
        const stack = new Int32Array(128);
        let sp = 0;
        stack[sp++] = 0;
        const mn = this.nodeMin, mx = this.nodeMax;
        while (sp) {
            const n = stack[--sp];
            let t0 = (mn[3 * n] - ox) * ix, t1 = (mx[3 * n] - ox) * ix;
            let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
            t0 = (mn[3 * n + 1] - oy) * iy;
            t1 = (mx[3 * n + 1] - oy) * iy;
            lo = Math.max(lo, Math.min(t0, t1));
            hi = Math.min(hi, Math.max(t0, t1));
            t0 = (mn[3 * n + 2] - oz) * iz;
            t1 = (mx[3 * n + 2] - oz) * iz;
            lo = Math.max(lo, Math.min(t0, t1));
            hi = Math.min(hi, Math.max(t0, t1));
            if (!(hi >= Math.max(lo, 0)) || lo > best)
                continue;
            if (this.nodeLeft[n] < 0) {
                for (let i = this.nodeStart[n]; i < this.nodeStart[n] + this.nodeCount[n]; i++) {
                    const t = this.order[i];
                    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
                    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
                    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
                    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                    const det = e1x * px + e1y * py + e1z * pz;
                    if (Math.abs(det) < 1e-14)
                        continue;
                    const inv = 1 / det;
                    const tx = ox - p[a], ty = oy - p[a + 1], tz = oz - p[a + 2];
                    const u = (tx * px + ty * py + tz * pz) * inv;
                    if (u < 0 || u > 1)
                        continue;
                    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
                    const v = (dx * qx + dy * qy + dz * qz) * inv;
                    if (v < 0 || u + v > 1)
                        continue;
                    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
                    if (dist > tMin && dist < best)
                        best = dist;
                }
            }
            else {
                stack[sp++] = n + 1;
                stack[sp++] = this.right[n];
            }
        }
        return best === Infinity ? null : best;
    }
    /** Parity of crossings of a +X ray (for far points where the pseudonormal sign is not computed). */
    insideByRay(x, y, z) {
        const p = this.mesh.positions, idx = this.mesh.indices;
        let count = 0;
        const stack = new Int32Array(128);
        let sp = 0;
        stack[sp++] = 0;
        while (sp) {
            const n = stack[--sp];
            if (this.nodeMax[3 * n] < x || this.nodeMin[3 * n + 1] > y || this.nodeMax[3 * n + 1] < y || this.nodeMin[3 * n + 2] > z || this.nodeMax[3 * n + 2] < z)
                continue;
            if (this.nodeLeft[n] < 0) {
                for (let i = this.nodeStart[n]; i < this.nodeStart[n] + this.nodeCount[n]; i++) {
                    const t = this.order[i];
                    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
                    // 2D test in (y, z); jitter-free half-open edge rule
                    const y1 = p[a + 1], z1 = p[a + 2], y2 = p[b + 1], z2 = p[b + 2], y3 = p[c + 1], z3 = p[c + 2];
                    const det = (z2 - z3) * (y1 - y3) + (y3 - y2) * (z1 - z3);
                    if (det === 0)
                        continue;
                    const l1 = ((z2 - z3) * (y - y3) + (y3 - y2) * (z - z3)) / det;
                    const l2 = ((z3 - z1) * (y - y3) + (y1 - y3) * (z - z3)) / det;
                    const l3 = 1 - l1 - l2;
                    if (l1 < 0 || l2 < 0 || l3 < 0)
                        continue;
                    const xi = l1 * p[a] + l2 * p[b] + l3 * p[c];
                    if (xi > x)
                        count++;
                }
            }
            else {
                stack[sp++] = n + 1;
                stack[sp++] = this.right[n];
            }
        }
        return (count & 1) === 1;
    }
}
function boxDist2(mn, mx, n, x, y, z) {
    const dx = Math.max(mn[3 * n] - x, 0, x - mx[3 * n]);
    const dy = Math.max(mn[3 * n + 1] - y, 0, y - mx[3 * n + 1]);
    const dz = Math.max(mn[3 * n + 2] - z, 0, z - mx[3 * n + 2]);
    return dx * dx + dy * dy + dz * dz;
}
const R = { d2: 0, x: 0, y: 0, z: 0, feat: 0, u: 0, v: 0 };
/** feat: 0 face, 1..3 vertex a/b/c, 4 edge ab, 5 edge bc, 6 edge ca. */
export function closestOnTri(px, py, pz, p, ia, ib, ic) {
    const ax = p[3 * ia], ay = p[3 * ia + 1], az = p[3 * ia + 2];
    const bx = p[3 * ib], by = p[3 * ib + 1], bz = p[3 * ib + 2];
    const cx = p[3 * ic], cy = p[3 * ic + 1], cz = p[3 * ic + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const set = (x, y, z, feat, u, v) => {
        const dx = px - x, dy = py - y, dz = pz - z;
        R.d2 = dx * dx + dy * dy + dz * dz;
        R.x = x;
        R.y = y;
        R.z = z;
        R.feat = feat;
        R.u = u;
        R.v = v;
        return R;
    };
    if (d1 <= 0 && d2 <= 0)
        return set(ax, ay, az, 1, 0, 0);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3)
        return set(bx, by, bz, 2, 1, 0);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return set(ax + v * abx, ay + v * aby, az + v * abz, 4, v, 0);
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6)
        return set(cx, cy, cz, 3, 0, 1);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return set(ax + w * acx, ay + w * acy, az + w * acz, 6, 0, w);
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return set(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz), 5, 1 - w, w);
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w, 0, v, w);
}
