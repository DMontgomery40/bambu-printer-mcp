/**
 * Mesh simplification by half-edge collapse ordered by the quadric error metric (Garland & Heckbert,
 * "Surface Simplification Using Quadric Error Metrics", SIGGRAPH 1997). Only endpoint placement is used
 * (a vertex moves onto a neighbour), so vertices never leave the original surface: exact planes, edges
 * and corners from the mesher stay exact. Collapses keep the mesh a closed 2-manifold by the link
 * condition (Dey, Edelsbrunner, Guha, Nekhayev 1999) and reject folded or needle triangles.
 *
 * The error of a vertex is the sum of squared distances to the planes of the original triangles merged
 * into it; a collapse is allowed only while that sum stays below tol^2, so every merged plane stays
 * within `tol` of the moved vertex.
 */
import { Mesh } from "./mesh.js";
/** Binary min-heap on typed arrays (cost, from, to, stamps); pop() leaves the entry in top*. */
class Heap {
    cost = new Float64Array(1 << 16);
    a = new Int32Array(1 << 16);
    b = new Int32Array(1 << 16);
    sa = new Int32Array(1 << 16);
    sb = new Int32Array(1 << 16);
    size = 0;
    topCost = 0;
    topA = 0;
    topB = 0;
    topSa = 0;
    topSb = 0;
    grow() {
        const n = this.cost.length * 2;
        const g = (x) => { const y = new x.constructor(n); y.set(x); return y; };
        this.cost = g(this.cost);
        this.a = g(this.a);
        this.b = g(this.b);
        this.sa = g(this.sa);
        this.sb = g(this.sb);
    }
    push(c, a, b, sa, sb) {
        if (this.size === this.cost.length)
            this.grow();
        const C = this.cost, A = this.a, B = this.b, SA = this.sa, SB = this.sb;
        let i = this.size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (C[p] <= c)
                break;
            C[i] = C[p];
            A[i] = A[p];
            B[i] = B[p];
            SA[i] = SA[p];
            SB[i] = SB[p];
            i = p;
        }
        C[i] = c;
        A[i] = a;
        B[i] = b;
        SA[i] = sa;
        SB[i] = sb;
    }
    pop() {
        const C = this.cost, A = this.a, B = this.b, SA = this.sa, SB = this.sb;
        this.topCost = C[0];
        this.topA = A[0];
        this.topB = B[0];
        this.topSa = SA[0];
        this.topSb = SB[0];
        const n = --this.size;
        const c = C[n], a = A[n], b = B[n], sa = SA[n], sb = SB[n];
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            if (l >= n)
                break;
            const r = l + 1;
            const m = r < n && C[r] < C[l] ? r : l;
            if (C[m] >= c)
                break;
            C[i] = C[m];
            A[i] = A[m];
            B[i] = B[m];
            SA[i] = SA[m];
            SB[i] = SB[m];
            i = m;
        }
        C[i] = c;
        A[i] = a;
        B[i] = b;
        SA[i] = sa;
        SB[i] = sb;
    }
}
export function decimate(mesh, opts) {
    const tol2 = opts.tolerance * opts.tolerance;
    const minQ = opts.minQuality ?? 0.02;
    const minDot = opts.minNormalDot ?? 0.5;
    const maxValence = opts.maxValence ?? 30;
    const pos = mesh.positions;
    const nv = pos.length / 3;
    const F = Int32Array.from(mesh.indices);
    const nf = F.length / 3;
    const faceAlive = new Uint8Array(nf).fill(1);
    const vfaces = Array.from({ length: nv }, () => []);
    for (let f = 0; f < nf; f++)
        for (let j = 0; j < 3; j++)
            vfaces[F[3 * f + j]].push(f);
    const vAlive = new Uint8Array(nv).fill(1);
    const version = new Int32Array(nv);
    const locked = opts.locked;
    // quadrics: q = [a2, ab, ac, ad, b2, bc, bd, c2, cd, d2]
    const Q = new Float64Array(nv * 10);
    for (let f = 0; f < nf; f++) {
        const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
        const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
        const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (l === 0)
            continue;
        nx /= l;
        ny /= l;
        nz /= l;
        const d = -(nx * pos[3 * a] + ny * pos[3 * a + 1] + nz * pos[3 * a + 2]);
        const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
        for (const v of [a, b, c])
            for (let k = 0; k < 10; k++)
                Q[v * 10 + k] += q[k];
    }
    const qerr = (u, v, x, y, z) => {
        let s = 0;
        for (const w of [u, v]) {
            const o = w * 10;
            s += Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x
                + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y
                + Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];
        }
        return s;
    };
    const heap = new Heap();
    const pushEdge = (u, v) => {
        // evaluate both directions: u -> v (v stays) and v -> u
        const luk = locked ? locked[u] : 0, lvk = locked ? locked[v] : 0;
        let best = Infinity, from = -1, to = -1;
        const eUV = luk ? Infinity : qerr(u, v, pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
        const eVU = lvk ? Infinity : qerr(u, v, pos[3 * u], pos[3 * u + 1], pos[3 * u + 2]);
        // on (near) ties keep the vertex with fewer faces: avoids hub vertices with huge fans on flat faces
        const tie = Math.abs(eUV - eVU) <= tol2 * 1e-6;
        if (tie ? vfaces[v].length <= vfaces[u].length : eUV < eVU) {
            best = eUV;
            from = u;
            to = v;
        }
        else {
            best = eVU;
            from = v;
            to = u;
        }
        if (!Number.isFinite(best))
            from = -1;
        if (from < 0 || best > tol2)
            return;
        heap.push(best, from, to, version[from], version[to]);
    };
    for (let f = 0; f < nf; f++) {
        const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
        if (a < b)
            pushEdge(a, b);
        if (b < c)
            pushEdge(b, c);
        if (c < a)
            pushEdge(c, a);
    }
    // neighbour marking with stamps (no Set allocation per collapse)
    const mark = new Int32Array(nv);
    let stamp = 0;
    const nbrBuf = [];
    const collectNeighbours = (v, st, out) => {
        out.length = 0;
        const fl = vfaces[v];
        for (let k = 0; k < fl.length; k++) {
            const f = fl[k];
            if (!faceAlive[f])
                continue;
            for (let j = 0; j < 3; j++) {
                const w = F[3 * f + j];
                if (w !== v && mark[w] !== st) {
                    mark[w] = st;
                    out.push(w);
                }
            }
        }
    };
    const nbU = [], nbV = [];
    const shared = [0, 0];
    while (heap.size) {
        heap.pop();
        const u = heap.topA, v = heap.topB, su = heap.topSa, sv = heap.topSb;
        if (!vAlive[u] || !vAlive[v] || version[u] !== su || version[v] !== sv)
            continue;
        // faces shared by u and v
        let ns = 0;
        const fu = vfaces[u];
        for (let k = 0; k < fu.length; k++) {
            const f = fu[k];
            if (!faceAlive[f])
                continue;
            if (F[3 * f] === v || F[3 * f + 1] === v || F[3 * f + 2] === v) {
                if (ns < 2)
                    shared[ns] = f;
                ns++;
            }
        }
        if (ns !== 2)
            continue;
        // link condition: common neighbours are exactly the two opposite vertices
        const s1 = ++stamp;
        collectNeighbours(u, s1, nbU);
        let common = 0;
        const fv = vfaces[v];
        const s2 = ++stamp;
        nbV.length = 0;
        for (let k = 0; k < fv.length; k++) {
            const f = fv[k];
            if (!faceAlive[f])
                continue;
            for (let j = 0; j < 3; j++) {
                const w = F[3 * f + j];
                if (w === v)
                    continue;
                const m = mark[w];
                if (m === s2)
                    continue;
                if (m === s1)
                    common++;
                mark[w] = s2;
                nbV.push(w);
            }
        }
        if (common !== 2)
            continue;
        if (nbU.length + nbV.length - 4 < 3)
            continue;
        if (nbU.length + nbV.length - 4 > maxValence)
            continue;
        const tx = pos[3 * v], ty = pos[3 * v + 1], tz = pos[3 * v + 2];
        let ok = true;
        for (let k = 0; k < fu.length && ok; k++) {
            const f = fu[k];
            if (!faceAlive[f] || f === shared[0] || f === shared[1])
                continue;
            const i0 = F[3 * f], i1 = F[3 * f + 1], i2 = F[3 * f + 2];
            let ax = pos[3 * i0], ay = pos[3 * i0 + 1], az = pos[3 * i0 + 2];
            let bx = pos[3 * i1], by = pos[3 * i1 + 1], bz = pos[3 * i1 + 2];
            let cx = pos[3 * i2], cy = pos[3 * i2 + 1], cz = pos[3 * i2 + 2];
            const n0x = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
            const n0y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            const n0z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            if (i0 === u) {
                ax = tx;
                ay = ty;
                az = tz;
            }
            else if (i1 === u) {
                bx = tx;
                by = ty;
                bz = tz;
            }
            else {
                cx = tx;
                cy = ty;
                cz = tz;
            }
            const n1x = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
            const n1y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            const n1z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            const l0 = Math.sqrt(n0x * n0x + n0y * n0y + n0z * n0z), l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
            if (l1 < 1e-12) {
                ok = false;
                break;
            }
            if (l0 > 0 && (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1) < minDot) {
                ok = false;
                break;
            }
            const e2 = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 + (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2 + (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2;
            if ((2 * Math.sqrt(3) * l1) / e2 < minQ) {
                ok = false;
                break;
            }
        }
        if (!ok)
            continue;
        // collapse u -> v
        faceAlive[shared[0]] = 0;
        faceAlive[shared[1]] = 0;
        const merged = vfaces[v];
        let w = 0;
        for (let k = 0; k < merged.length; k++)
            if (faceAlive[merged[k]])
                merged[w++] = merged[k];
        merged.length = w;
        for (let k = 0; k < fu.length; k++) {
            const f = fu[k];
            if (!faceAlive[f])
                continue;
            if (F[3 * f] === u)
                F[3 * f] = v;
            else if (F[3 * f + 1] === u)
                F[3 * f + 1] = v;
            else if (F[3 * f + 2] === u)
                F[3 * f + 2] = v;
            merged.push(f);
        }
        vfaces[u] = [];
        vAlive[u] = 0;
        for (let k = 0; k < 10; k++)
            Q[v * 10 + k] += Q[u * 10 + k];
        version[v]++;
        collectNeighbours(v, ++stamp, nbrBuf);
        for (const x of nbrBuf)
            pushEdge(v, x);
    }
    // compact
    const remap = new Int32Array(nv).fill(-1);
    const outPos = [];
    const outIdx = [];
    for (let f = 0; f < nf; f++) {
        if (!faceAlive[f])
            continue;
        for (let j = 0; j < 3; j++) {
            const w = F[3 * f + j];
            if (remap[w] < 0) {
                remap[w] = outPos.length / 3;
                outPos.push(pos[3 * w], pos[3 * w + 1], pos[3 * w + 2]);
            }
            outIdx.push(remap[w]);
        }
    }
    return new Mesh(Float64Array.from(outPos), Uint32Array.from(outIdx));
}
