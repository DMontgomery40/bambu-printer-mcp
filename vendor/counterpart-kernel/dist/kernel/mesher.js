/**
 * Surface extraction: SDF -> closed, manifold, consistently wound triangle mesh.
 *
 * 1. Narrow-band octree (Lipschitz culling + tree pruning, see sdf.ts): only leaf cells of size h that
 *    can contain the surface are visited; empty space is skipped in large blocks.
 * 2. Dual contouring of Hermite data (Ju, Losasso, Schaefer, Warren, SIGGRAPH 2002): each crossing edge
 *    stores its exact zero (found by Illinois regula falsi) and the field gradient there; each surface
 *    patch gets one vertex at the minimiser of the quadric error function sum (n_i . (x - p_i))^2,
 *    solved with a truncated eigen-decomposition (Lindstrom 2000; the "mass point" regularisation of
 *    Ju et al.). This reproduces planes, sharp edges and corners exactly.
 * 3. Manifoldness: like Dual Marching Cubes (Nielson 2004) and Manifold Dual Contouring (Schaefer, Ju,
 *    Warren 2007), a cell gets one vertex per surface patch rather than one per cell. Patches are the
 *    cycles formed by pairing crossing edges on each cube face; an ambiguous face (diagonal signs) is
 *    resolved by a rule that depends only on that face's signs, so both cells sharing it agree. The
 *    dual quads then form a closed 2-manifold (every edge in two quads, every vertex a single fan).
 */
import { PRUNED, Const } from "./sdf.js";
import { Mesh } from "./mesh.js";
import { IdMap, F64List, I32List } from "./hashmap.js";
import { KernelError } from "./profile.js";
// ---- patch table ------------------------------------------------------------------------------------
// corner c = bx + 2 by + 4 bz; edge e = axis*4 + q (axis 0: q = by + 2bz; axis 1: q = bx + 2bz; axis 2: q = bx + 2by)
function edgeCorners(e) {
    const axis = e >> 2, q = e & 3;
    if (axis === 0) {
        const c0 = 2 * (q & 1) + 4 * (q >> 1);
        return [c0, c0 + 1];
    }
    if (axis === 1) {
        const c0 = (q & 1) + 4 * (q >> 1);
        return [c0, c0 + 2];
    }
    const c0 = (q & 1) + 2 * (q >> 1);
    return [c0, c0 + 4];
}
function edgeBetween(c0, c1) {
    for (let e = 0; e < 12; e++) {
        const [a, b] = edgeCorners(e);
        if ((a === c0 && b === c1) || (a === c1 && b === c0))
            return e;
    }
    throw new Error("no edge");
}
const PATCH_OF_EDGE = new Int8Array(256 * 12).fill(-1);
const PATCH_COUNT = new Uint8Array(256);
(function buildTable() {
    // faces: fixed axis a with bit b; cyclic corners in the (u, v) plane
    const faces = [];
    for (let a = 0; a < 3; a++)
        for (let b = 0; b < 2; b++) {
            const u = (a + 1) % 3, v = (a + 2) % 3;
            const cyc = [];
            for (const [bu, bv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
                const bits = [0, 0, 0];
                bits[a] = b;
                bits[u] = bu;
                bits[v] = bv;
                cyc.push(bits[0] + 2 * bits[1] + 4 * bits[2]);
            }
            faces.push(cyc);
        }
    for (let cfg = 0; cfg < 256; cfg++) {
        const inside = (c) => (cfg >> c) & 1;
        const parent = Array.from({ length: 12 }, (_, i) => i);
        const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
        const unite = (x, y) => { parent[find(x)] = find(y); };
        for (const cyc of faces) {
            const es = [0, 1, 2, 3].map((i) => edgeBetween(cyc[i], cyc[(i + 1) % 4]));
            const crossing = [0, 1, 2, 3].filter((i) => inside(cyc[i]) !== inside(cyc[(i + 1) % 4]));
            if (crossing.length === 2)
                unite(es[crossing[0]], es[crossing[1]]);
            else if (crossing.length === 4) {
                // ambiguous face: cut off each inside corner (pair the two face edges meeting at it)
                for (let i = 0; i < 4; i++) {
                    if (inside(cyc[i]))
                        unite(es[(i + 3) % 4], es[i]);
                }
            }
        }
        const ids = new Map();
        for (let e = 0; e < 12; e++) {
            const [c0, c1] = edgeCorners(e);
            if (inside(c0) === inside(c1))
                continue;
            const r = find(e);
            if (!ids.has(r))
                ids.set(r, ids.size);
            PATCH_OF_EDGE[cfg * 12 + e] = ids.get(r);
        }
        PATCH_COUNT[cfg] = ids.size;
    }
})();
// ---- symmetric 3x3 eigen solver (cyclic Jacobi) -------------------------------------------------------
function jacobiEigen(a, vals, vecs) {
    // a: [a00, a01, a02, a11, a12, a22]
    const m = [a[0], a[1], a[2], a[1], a[3], a[4], a[2], a[4], a[5]];
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let sweep = 0; sweep < 12; sweep++) {
        const off = m[1] * m[1] + m[2] * m[2] + m[5] * m[5];
        if (off < 1e-24)
            break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            const apq = m[3 * p + q];
            if (Math.abs(apq) < 1e-30)
                continue;
            const app = m[3 * p + p], aqq = m[3 * q + q];
            const theta = (aqq - app) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const mkp = m[3 * k + p], mkq = m[3 * k + q];
                m[3 * k + p] = c * mkp - s * mkq;
                m[3 * k + q] = s * mkp + c * mkq;
            }
            for (let k = 0; k < 3; k++) {
                const mpk = m[3 * p + k], mqk = m[3 * q + k];
                m[3 * p + k] = c * mpk - s * mqk;
                m[3 * q + k] = s * mpk + c * mqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[3 * k + p], vkq = v[3 * k + q];
                v[3 * k + p] = c * vkp - s * vkq;
                v[3 * k + q] = s * vkp + c * vkq;
            }
        }
    }
    vals[0] = m[0];
    vals[1] = m[4];
    vals[2] = m[8];
    for (let i = 0; i < 9; i++)
        vecs[i] = v[i]; // columns are eigenvectors
}
/**
 * Extract the zero set of `root` as a closed manifold triangle mesh.
 */
export function contour(root, opts) {
    const h = opts.h;
    const qefThr = opts.qefThreshold ?? 0.02;
    const b = root.bounds;
    if (!b.isFinite() || b.isEmpty())
        throw new KernelError("The part has no finite size: it is empty or unbounded (a subtraction or intersection left nothing, or a half-space was not intersected with a solid).");
    // grid: origin offset by an irrational fraction of h so that round-number planes do not sit on nodes
    const pad = 2 * h;
    const ox = b.minX - pad - 0.3183 * h, oy = b.minY - pad - 0.2718 * h, oz = b.minZ - pad - 0.1414 * h;
    const NX = Math.ceil((b.maxX + pad - ox) / h) + 1;
    const NY = Math.ceil((b.maxY + pad - oy) / h) + 1;
    const NZ = Math.ceil((b.maxZ + pad - oz) / h) + 1;
    const maxN = Math.max(NX, NY, NZ);
    if (NX * NY * NZ > 2 ** 52)
        throw new KernelError("The part is too large for this resolution.");
    let levels = 0;
    while ((1 << levels) < maxN)
        levels++;
    const CX = NX + 1, CXY = (NX + 1) * (NY + 1);
    const cornerKey = (i, j, k) => i + j * CX + k * CXY;
    const stats = { h, leafCells: 0, surfaceCells: 0, evaluations: 0, crossingEdges: 0, vertices: 0, triangles: 0,
        ms: { octree: 0, corners: 0, edges: 0, qef: 0, faces: 0 } };
    let t0 = performance.now();
    // ---- 1. octree descent ----
    const leafI = new I32List(), leafJ = new I32List(), leafK = new I32List();
    const leafNode = [];
    const sqrt3h = Math.sqrt(3) / 2 * h;
    const maxLeaves = opts.maxLeafCells ?? 3_000_000;
    const visit = (node, i, j, k, level) => {
        const s = 1 << level;
        if (i >= NX || j >= NY || k >= NZ)
            return;
        const r = s * sqrt3h * 1.02 + 1e-9;
        const cx = ox + (i + s / 2) * h, cy = oy + (j + s / 2) * h, cz = oz + (k + s / 2) * h;
        const p = node.prune(cx, cy, cz, r);
        const v = PRUNED.v;
        if (p instanceof Const)
            return;
        if (Math.abs(v) > p.L * r)
            return;
        if (level === 0) {
            leafI.push(i);
            leafJ.push(j);
            leafK.push(k);
            leafNode.push(p);
            if (leafNode.length > maxLeaves)
                throw new KernelError(`field mesher: more than ${maxLeaves} cells at ${h} mm; use a coarser resolution`);
            return;
        }
        const hs = s >> 1;
        for (let c = 0; c < 8; c++)
            visit(p, i + (c & 1 ? hs : 0), j + (c & 2 ? hs : 0), k + (c & 4 ? hs : 0), level - 1);
    };
    visit(root, 0, 0, 0, levels);
    const nLeaf = leafNode.length;
    stats.leafCells = nLeaf;
    stats.ms.octree = performance.now() - t0;
    t0 = performance.now();
    // ---- 2. corner values, configs ----
    const cornerIds = new IdMap(nLeaf * 2);
    const cornerVal = new F64List(nLeaf * 2);
    const cfgs = new Uint8Array(nLeaf);
    const vals8 = new Float64Array(8);
    let evals = 0;
    const cellIds = new IdMap(nLeaf);
    const surf = []; // leaf index of surface cells
    for (let n = 0; n < nLeaf; n++) {
        const i = leafI.data[n], j = leafJ.data[n], k = leafK.data[n];
        const node = leafNode[n];
        let cfg = 0;
        for (let c = 0; c < 8; c++) {
            const ci = i + (c & 1), cj = j + ((c >> 1) & 1), ck = k + (c >> 2);
            const key = cornerKey(ci, cj, ck);
            const before = cornerIds.size;
            const id = cornerIds.getOrInsert(key);
            let val;
            if (cornerIds.size !== before) {
                val = node.f(ox + ci * h, oy + cj * h, oz + ck * h);
                evals++;
                cornerVal.push(val);
            }
            else
                val = cornerVal.data[id];
            vals8[c] = val;
            if (val < 0)
                cfg |= 1 << c;
        }
        cfgs[n] = cfg;
        if (cfg !== 0 && cfg !== 255)
            surf.push(n);
    }
    stats.surfaceCells = surf.length;
    // vertex numbering: one vertex per patch
    const vertBase = new Int32Array(nLeaf).fill(-1);
    let nVert = 0;
    for (const n of surf) {
        cellIds.getOrInsert(cornerKey(leafI.data[n], leafJ.data[n], leafK.data[n]));
        vertBase[n] = nVert;
        nVert += PATCH_COUNT[cfgs[n]];
    }
    // map cell key -> leaf index
    const cellLeaf = new Int32Array(cellIds.size);
    for (const n of surf)
        cellLeaf[cellIds.get(cornerKey(leafI.data[n], leafJ.data[n], leafK.data[n]))] = n;
    stats.ms.corners = performance.now() - t0;
    t0 = performance.now();
    // ---- 3. crossing edges: zero and normal; accumulate QEFs ----
    const qef = new Float64Array(nVert * 10); // ata(6) atb(3) btb(1)
    const mass = new Float64Array(nVert * 4); // sum xyz, count
    const edgeIds = new IdMap(surf.length * 2);
    const edgeLower = new I32List(surf.length * 2); // corner key of lower end is recomputed; store leaf of discovery
    const edgeKeys = new F64List(surf.length * 2);
    const edgeInsideLow = new I32List(surf.length * 2);
    const edgePN = new F64List(surf.length * 12); // px py pz nx ny nz
    const edgeAxisStep = [1, CX, CXY];
    for (const n of surf) {
        const cfg = cfgs[n];
        const i = leafI.data[n], j = leafJ.data[n], k = leafK.data[n];
        const node = leafNode[n];
        const vb = vertBase[n];
        for (let e = 0; e < 12; e++) {
            const patch = PATCH_OF_EDGE[cfg * 12 + e];
            if (patch < 0)
                continue;
            const [c0, c1] = edgeCorners(e);
            const axis = e >> 2;
            const ai = i + (c0 & 1), aj = j + ((c0 >> 1) & 1), ak = k + (c0 >> 2);
            const lowKey = cornerKey(ai, aj, ak);
            const ekey = lowKey * 3 + axis;
            const before = edgeIds.size;
            const eid = edgeIds.getOrInsert(ekey);
            let px, py, pz, nx, ny, nz;
            if (edgeIds.size !== before) {
                // new edge: find the zero between the two corners
                const x0 = ox + ai * h, y0 = oy + aj * h, z0 = oz + ak * h;
                const dx = axis === 0 ? h : 0, dy = axis === 1 ? h : 0, dz = axis === 2 ? h : 0;
                let fa = cornerVal.data[cornerIds.get(lowKey)];
                let fb = cornerVal.data[cornerIds.get(lowKey + edgeAxisStep[axis])];
                const insideLow = fa < 0;
                // Illinois regula falsi on t in [0, 1]
                let ta = 0, tb = 1, side = 0;
                let t = fa / (fa - fb);
                for (let it = 0; it < 24; it++) {
                    t = (fa * tb - fb * ta) / (fa - fb);
                    const ft = node.f(x0 + dx * t, y0 + dy * t, z0 + dz * t);
                    evals++;
                    if (Math.abs(ft) < 1e-9 * h)
                        break;
                    if ((ft < 0) === (fb < 0)) {
                        tb = t;
                        fb = ft;
                        if (side === -1)
                            fa /= 2;
                        side = -1;
                    }
                    else {
                        ta = t;
                        fa = ft;
                        if (side === 1)
                            fb /= 2;
                        side = 1;
                    }
                    if (tb - ta < 1e-9)
                        break;
                }
                px = x0 + dx * t;
                py = y0 + dy * t;
                pz = z0 + dz * t;
                // gradient by central differences
                const eps = h * 1e-3;
                nx = node.f(px + eps, py, pz) - node.f(px - eps, py, pz);
                ny = node.f(px, py + eps, pz) - node.f(px, py - eps, pz);
                nz = node.f(px, py, pz + eps) - node.f(px, py, pz - eps);
                evals += 6;
                let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (!(len > 0)) {
                    nx = axis === 0 ? 1 : 0;
                    ny = axis === 1 ? 1 : 0;
                    nz = axis === 2 ? 1 : 0;
                    len = 1;
                    if (!insideLow) {
                        nx = -nx;
                        ny = -ny;
                        nz = -nz;
                    }
                }
                nx /= len;
                ny /= len;
                nz /= len;
                edgeKeys.push(ekey);
                edgeInsideLow.push(insideLow ? 1 : 0);
                edgeLower.push(n);
                edgePN.push(px);
                edgePN.push(py);
                edgePN.push(pz);
                edgePN.push(nx);
                edgePN.push(ny);
                edgePN.push(nz);
            }
            else {
                const o = eid * 6, d = edgePN.data;
                px = d[o];
                py = d[o + 1];
                pz = d[o + 2];
                nx = d[o + 3];
                ny = d[o + 4];
                nz = d[o + 5];
            }
            const v = vb + patch;
            const q = v * 10;
            const bdot = nx * px + ny * py + nz * pz;
            qef[q] += nx * nx;
            qef[q + 1] += nx * ny;
            qef[q + 2] += nx * nz;
            qef[q + 3] += ny * ny;
            qef[q + 4] += ny * nz;
            qef[q + 5] += nz * nz;
            qef[q + 6] += nx * bdot;
            qef[q + 7] += ny * bdot;
            qef[q + 8] += nz * bdot;
            qef[q + 9] += bdot * bdot;
            const m = v * 4;
            mass[m] += px;
            mass[m + 1] += py;
            mass[m + 2] += pz;
            mass[m + 3] += 1;
        }
    }
    stats.crossingEdges = edgeIds.size;
    stats.ms.edges = performance.now() - t0;
    t0 = performance.now();
    // ---- 4. solve QEFs ----
    const pos = new Float64Array(nVert * 3);
    const rank = new Uint8Array(nVert);
    const ata = new Float64Array(6), ev = new Float64Array(3), evec = new Float64Array(9);
    for (const n of surf) {
        const np = PATCH_COUNT[cfgs[n]];
        const i = leafI.data[n], j = leafJ.data[n], k = leafK.data[n];
        const minx = ox + i * h, miny = oy + j * h, minz = oz + k * h;
        for (let p = 0; p < np; p++) {
            const v = vertBase[n] + p;
            const q = v * 10, m = v * 4;
            const cnt = mass[m + 3];
            const mx = mass[m] / cnt, my = mass[m + 1] / cnt, mz = mass[m + 2] / cnt;
            for (let s = 0; s < 6; s++)
                ata[s] = qef[q + s];
            // rhs = atb - ata * mass
            const rx = qef[q + 6] - (ata[0] * mx + ata[1] * my + ata[2] * mz);
            const ry = qef[q + 7] - (ata[1] * mx + ata[3] * my + ata[4] * mz);
            const rz = qef[q + 8] - (ata[2] * mx + ata[4] * my + ata[5] * mz);
            jacobiEigen(ata, ev, evec);
            const emax = Math.max(Math.abs(ev[0]), Math.abs(ev[1]), Math.abs(ev[2]));
            let sx = 0, sy = 0, sz = 0, rk = 0;
            for (let c = 0; c < 3; c++) {
                if (Math.abs(ev[c]) < qefThr * emax || emax === 0)
                    continue;
                rk++;
                const ux = evec[c], uy = evec[3 + c], uz = evec[6 + c];
                const coef = (ux * rx + uy * ry + uz * rz) / ev[c];
                sx += coef * ux;
                sy += coef * uy;
                sz += coef * uz;
            }
            let x = mx + sx, y = my + sy, z = mz + sz;
            // keep the vertex inside its cell (prevents folds where features leave the cell)
            const clamp = (val, lo) => (val < lo ? lo : val > lo + h ? lo + h : val);
            x = clamp(x, minx);
            y = clamp(y, miny);
            z = clamp(z, minz);
            pos[3 * v] = x;
            pos[3 * v + 1] = y;
            pos[3 * v + 2] = z;
            rank[v] = rk;
        }
    }
    stats.ms.qef = performance.now() - t0;
    t0 = performance.now();
    // ---- 5. dual faces: one quad per crossing edge ----
    const tris = new I32List(edgeIds.size * 6);
    const nE = edgeIds.size;
    const quad = [0, 0, 0, 0];
    for (let eid = 0; eid < nE; eid++) {
        const ekey = edgeKeys.data[eid];
        const axis = ekey % 3;
        const ck = (ekey - axis) / 3;
        const k = Math.floor(ck / CXY), rem = ck - k * CXY, j = Math.floor(rem / CX), i = rem - j * CX;
        const u = (axis + 1) % 3, w = (axis + 2) % 3;
        const offs = [[0, 0], [-1, 0], [-1, -1], [0, -1]];
        let ok = true;
        for (let s = 0; s < 4; s++) {
            const [du, dw] = offs[s];
            const cc = [i, j, k];
            cc[u] += du;
            cc[w] += dw;
            const cid = cellIds.get(cornerKey(cc[0], cc[1], cc[2]));
            if (cid < 0) {
                ok = false;
                break;
            }
            const n = cellLeaf[cid];
            // local edge index inside that cell
            const bits = [0, 0, 0];
            bits[u] = -du;
            bits[w] = -dw;
            const q = axis === 0 ? bits[1] + 2 * bits[2] : axis === 1 ? bits[0] + 2 * bits[2] : bits[0] + 2 * bits[1];
            const patch = PATCH_OF_EDGE[cfgs[n] * 12 + axis * 4 + q];
            if (patch < 0) {
                ok = false;
                break;
            }
            quad[s] = vertBase[n] + patch;
        }
        if (!ok)
            throw new KernelError("Internal mesher error: a crossing edge is missing a neighbouring cell (surface touches the grid boundary).");
        let a = quad[0], b2 = quad[1], c = quad[2], d = quad[3];
        if (!edgeInsideLow.data[eid]) {
            const tmp = b2;
            b2 = d;
            d = tmp;
        }
        // choose diagonal: connect feature vertices (rank >= 2) if possible, else the flatter split
        const r02 = Math.min(rank[a], rank[c]), r13 = Math.min(rank[b2], rank[d]);
        let use02;
        if (r02 >= 2 && r13 < 2)
            use02 = true;
        else if (r13 >= 2 && r02 < 2)
            use02 = false;
        else
            use02 = flatness(pos, a, b2, c, d) >= flatness(pos, b2, c, d, a);
        if (use02) {
            tris.push(a);
            tris.push(b2);
            tris.push(c);
            tris.push(a);
            tris.push(c);
            tris.push(d);
        }
        else {
            tris.push(a);
            tris.push(b2);
            tris.push(d);
            tris.push(b2);
            tris.push(c);
            tris.push(d);
        }
    }
    stats.ms.faces = performance.now() - t0;
    stats.evaluations = evals;
    stats.vertices = nVert;
    stats.triangles = tris.length / 3;
    return { mesh: new Mesh(pos, Uint32Array.from(tris.view())), stats };
}
/** Cosine between the normals of triangles (a,b,c) and (a,c,d): 1 = coplanar. */
function flatness(p, a, b, c, d) {
    const n1 = triNormal(p, a, b, c), n2 = triNormal(p, a, c, d);
    const l1 = Math.hypot(n1[0], n1[1], n1[2]), l2 = Math.hypot(n2[0], n2[1], n2[2]);
    if (l1 === 0 || l2 === 0)
        return -2;
    return (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2);
}
function triNormal(p, a, b, c) {
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
