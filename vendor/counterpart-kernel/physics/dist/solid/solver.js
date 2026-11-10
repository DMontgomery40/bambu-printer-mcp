import { shareStencil, parallelApply } from "./pool.js";
export function buildTopo(grid, minFill = 0.1) {
    const { nx, ny } = grid;
    const list = [];
    for (let e = 0; e < grid.fill.length; e++)
        if (grid.fill[e] >= minFill)
            list.push(e);
    const elems = Int32Array.from(list);
    const NX = nx + 1, NY = ny + 1;
    const nodeOf = new Int32Array(NX * NY * (grid.nz + 1)).fill(-1);
    const nodeGridL = [];
    const edofs = new Int32Array(elems.length * 24), scale = new Float64Array(elems.length);
    for (let k = 0; k < elems.length; k++) {
        const e = elems[k], ix = e % nx, iy = Math.floor(e / nx) % ny, iz = Math.floor(e / (nx * ny));
        scale[k] = grid.fill[e];
        for (let a = 0; a < 8; a++) {
            const g = (ix + (a & 1)) + NX * ((iy + ((a >> 1) & 1)) + NY * (iz + ((a >> 2) & 1)));
            let id = nodeOf[g];
            if (id < 0) {
                id = nodeGridL.length;
                nodeOf[g] = id;
                nodeGridL.push(g);
            }
            edofs[24 * k + 3 * a] = 3 * id;
            edofs[24 * k + 3 * a + 1] = 3 * id + 1;
            edofs[24 * k + 3 * a + 2] = 3 * id + 2;
        }
    }
    return { grid, elems, nodeOf, nodeGrid: Int32Array.from(nodeGridL), nNodes: nodeGridL.length, edofs, scale };
}
export function nodePosition(t, id) {
    const { nx, ny, h, origin } = t.grid, NX = nx + 1, NY = ny + 1;
    const g = t.nodeGrid[id];
    return [origin[0] + (g % NX) * h, origin[1] + (Math.floor(g / NX) % NY) * h, origin[2] + Math.floor(g / (NX * NY)) * h];
}
/** The element matrix of fine element k: (array, offset, factor). */
export function elemMatrix(t, K0, k) {
    const c = t.cut ? t.cut[k] : -1;
    return c >= 0 ? [t.cutK, 576 * c, 1] : [K0, 0, t.scale[k]];
}
const key = (x, y, z) => x + 4096 * (y + 4096 * z);
/** Assemble a level's element matrices into the 27-point block stencil. */
function assembleStencil(nNode, nE, edofs, elem, coord, f32) {
    const nbr = new Int32Array(27 * nNode).fill(-1);
    const acc = new Float64Array(243 * nNode);
    const cx = new Int32Array(8), cy = new Int32Array(8), cz = new Int32Array(8), nd = new Int32Array(8);
    for (let k = 0; k < nE; k++) {
        for (let a = 0; a < 8; a++) {
            const n = edofs[24 * k + 3 * a] / 3;
            nd[a] = n;
            const c = coord(n);
            cx[a] = c[0];
            cy[a] = c[1];
            cz[a] = c[2];
        }
        const [K, off, s] = elem(k);
        if (s === 0)
            continue;
        for (let a = 0; a < 8; a++) {
            const A = nd[a];
            for (let b = 0; b < 8; b++) {
                const slot = (cx[b] - cx[a] + 1) + 3 * (cy[b] - cy[a] + 1) + 9 * (cz[b] - cz[a] + 1);
                nbr[27 * A + slot] = nd[b];
                const o = 243 * A + 9 * slot, r = off + 24 * 3 * a + 3 * b;
                for (let i = 0; i < 3; i++) {
                    const ri = r + 24 * i;
                    acc[o + 3 * i] += s * K[ri];
                    acc[o + 3 * i + 1] += s * K[ri + 1];
                    acc[o + 3 * i + 2] += s * K[ri + 2];
                }
            }
        }
    }
    return { nbr, val: f32 ? Float32Array.from(acc) : acc };
}
/** y = (D A D + (I - D)) x on a level, serial (rows r0..r1 of nodes). */
function stencilRows(L, xm, y, r0, r1) {
    const nbr = L.nbr, val = L.val;
    for (let A = r0; A < r1; A++) {
        let y0 = 0, y1 = 0, y2 = 0;
        const nb = 27 * A, vb = 243 * A;
        for (let s = 0; s < 27; s++) {
            const B = nbr[nb + s];
            if (B < 0)
                continue;
            const o = vb + 9 * s, x0 = xm[3 * B], x1 = xm[3 * B + 1], x2 = xm[3 * B + 2];
            y0 += val[o] * x0 + val[o + 1] * x1 + val[o + 2] * x2;
            y1 += val[o + 3] * x0 + val[o + 4] * x1 + val[o + 5] * x2;
            y2 += val[o + 6] * x0 + val[o + 7] * x1 + val[o + 8] * x2;
        }
        y[3 * A] = y0;
        y[3 * A + 1] = y1;
        y[3 * A + 2] = y2;
    }
}
function matvec(L, x, y, fixedOverride) {
    const fx = fixedOverride ?? L.fixed;
    if (L.shared) {
        parallelApply(L.shared, x, fx, y);
        return;
    }
    else {
        const xm = L.xm ?? (L.xm = new Float64Array(L.ndof));
        for (let d = 0; d < L.ndof; d++)
            xm[d] = fx[d] ? 0 : x[d];
        stencilRows(L, xm, y, 0, L.nNode);
    }
    for (let d = 0; d < L.ndof; d++)
        if (fx[d])
            y[d] = x[d];
}
function computeBlockInverse(L) {
    const n = L.nNode, binv = new Float64Array(9 * n);
    for (let A = 0; A < n; A++) {
        const o = 243 * A + 9 * 13;
        const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                M[3 * i + j] = L.fixed[3 * A + i] || L.fixed[3 * A + j] ? (i === j ? 1 : 0) : L.val[o + 3 * i + j];
        for (let i = 0; i < 3; i++)
            if (!L.fixed[3 * A + i] && !(M[4 * i] > 0)) {
                L.fixed[3 * A + i] = 1;
                for (let j = 0; j < 3; j++) {
                    M[3 * i + j] = i === j ? 1 : 0;
                    M[3 * j + i] = i === j ? 1 : 0;
                }
            }
        const [a, b, c, d, e, f, g, h, k] = M;
        const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
        if (!(Math.abs(det) > 1e-300)) {
            binv[9 * A] = binv[9 * A + 4] = binv[9 * A + 8] = 1 / Math.max(a, e, k, 1e-30);
            continue;
        }
        const id = 1 / det;
        binv.set([(e * k - f * h) * id, (c * h - b * k) * id, (b * f - c * e) * id, (f * g - d * k) * id, (a * k - c * g) * id, (c * d - a * f) * id, (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id], 9 * A);
    }
    L.binv = binv;
}
function applyBinv(L, r, z, scale = 1) {
    const bi = L.binv;
    for (let A = 0; A < L.nNode; A++) {
        const o = 9 * A, r0 = r[3 * A], r1 = r[3 * A + 1], r2 = r[3 * A + 2];
        z[3 * A] = scale * (bi[o] * r0 + bi[o + 1] * r1 + bi[o + 2] * r2);
        z[3 * A + 1] = scale * (bi[o + 3] * r0 + bi[o + 4] * r1 + bi[o + 5] * r2);
        z[3 * A + 2] = scale * (bi[o + 6] * r0 + bi[o + 7] * r1 + bi[o + 8] * r2);
    }
}
function estimateLmax(L) {
    let v = new Float64Array(L.ndof);
    const w = new Float64Array(L.ndof), z = new Float64Array(L.ndof);
    for (let i = 0; i < L.ndof; i++)
        v[i] = L.fixed[i] ? 0 : 1 + ((i * 7919) % 13) / 13;
    let lam = 1;
    for (let it = 0; it < 12; it++) {
        matvec(L, v, w);
        applyBinv(L, w, z);
        let n = 0, vn = 0;
        for (let i = 0; i < L.ndof; i++) {
            n += z[i] * z[i];
            vn += v[i] * v[i];
        }
        n = Math.sqrt(n);
        lam = n / Math.sqrt(vn);
        for (let i = 0; i < L.ndof; i++)
            v[i] = z[i] / n;
    }
    return lam * 1.1;
}
/** Chebyshev smoothing of A x = b on [lmax/ratio, lmax] for Binv A, `deg` steps, starting from x. */
function chebyshev(L, b, x, deg = CHEB_DEG, ratio = 20) {
    const n = L.ndof, lmax = L.lmax, lmin = lmax / ratio;
    const theta = (lmax + lmin) / 2, delta = (lmax - lmin) / 2;
    const sc = L.scratch ?? (L.scratch = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)]);
    const [r, Ax, dvec, z] = sc;
    matvec(L, x, Ax);
    for (let i = 0; i < n; i++)
        r[i] = b[i] - Ax[i];
    let sigma = theta / delta, rho = 1 / sigma;
    applyBinv(L, r, dvec, 1 / theta);
    for (let k = 0; k < deg; k++) {
        for (let i = 0; i < n; i++)
            x[i] += dvec[i];
        if (k === deg - 1)
            break;
        matvec(L, dvec, Ax);
        for (let i = 0; i < n; i++)
            r[i] -= Ax[i];
        const rhoNew = 1 / (2 * sigma - rho);
        applyBinv(L, r, z);
        for (let i = 0; i < n; i++)
            dvec[i] = rhoNew * rho * dvec[i] + ((2 * rhoNew) / delta) * z[i];
        rho = rhoNew;
    }
}
/** Interpolation weights of a child's corner (position p in {0,1,2} per axis, units of fine h) onto coarse corner b. */
function childW(ox, oy, oz) {
    const W = new Float64Array(64);
    const w1 = (p, bb) => (p === 1 ? 0.5 : (p === 0 ? (bb === 0 ? 1 : 0) : (bb === 1 ? 1 : 0)));
    for (let a = 0; a < 8; a++) {
        const px = ox + (a & 1), py = oy + ((a >> 1) & 1), pz = oz + ((a >> 2) & 1);
        for (let bb = 0; bb < 8; bb++)
            W[a * 8 + bb] = w1(px, bb & 1) * w1(py, (bb >> 1) & 1) * w1(pz, (bb >> 2) & 1);
    }
    return W;
}
function coarsen(F) {
    const pk = new Map();
    const cx = [], cy = [], cz = [];
    const children = [];
    for (let k = 0; k < F.nE; k++) {
        const X = F.ex[k] >> 1, Y = F.ey[k] >> 1, Z = F.ez[k] >> 1, kk = key(X, Y, Z);
        let id = pk.get(kk);
        if (id === undefined) {
            id = cx.length;
            pk.set(kk, id);
            cx.push(X);
            cy.push(Y);
            cz.push(Z);
            children.push([]);
        }
        children[id].push(k);
    }
    const nE = cx.length;
    const nodeKey = new Map();
    const edofs = new Int32Array(24 * nE);
    for (let k = 0; k < nE; k++)
        for (let a = 0; a < 8; a++) {
            const kk = key(cx[k] + (a & 1), cy[k] + ((a >> 1) & 1), cz[k] + ((a >> 2) & 1));
            let id = nodeKey.get(kk);
            if (id === undefined) {
                id = nodeKey.size;
                nodeKey.set(kk, id);
            }
            edofs[24 * k + 3 * a] = 3 * id;
            edofs[24 * k + 3 * a + 1] = 3 * id + 1;
            edofs[24 * k + 3 * a + 2] = 3 * id + 2;
        }
    const ndof = 3 * nodeKey.size;
    if (ndof >= 0.7 * F.ndof)
        return null;
    const nFineNodes = F.nNode;
    const pIdx = new Int32Array(8 * nFineNodes).fill(-1), pW = new Float64Array(8 * nFineNodes);
    for (const [kk, fn] of F.nodeKey) {
        const x = kk % 4096, y = Math.floor(kk / 4096) % 4096, z = Math.floor(kk / (4096 * 4096));
        let c = 0;
        const xs = x & 1 ? [x >> 1, (x >> 1) + 1] : [x >> 1], ys = y & 1 ? [y >> 1, (y >> 1) + 1] : [y >> 1], zs = z & 1 ? [z >> 1, (z >> 1) + 1] : [z >> 1];
        const w = 1 / (xs.length * ys.length * zs.length);
        for (const X of xs)
            for (const Y of ys)
                for (const Z of zs) {
                    const cn = nodeKey.get(key(X, Y, Z));
                    if (cn === undefined)
                        throw new Error("multigrid: coarse node missing (topology bug)");
                    pIdx[8 * fn + c] = cn;
                    pW[8 * fn + c] = w;
                    c++;
                }
    }
    F.pIdx = pIdx;
    F.pW = pW;
    const Ws = [];
    for (let o = 0; o < 8; o++)
        Ws.push(childW(o & 1, (o >> 1) & 1, (o >> 2) & 1));
    const Kel = new Float64Array(576 * nE);
    const Kc = new Float64Array(576), T = new Float64Array(576);
    // children that are plain full cells with no held dof all contribute W^T K W with the same K: precompute it
    // per child position (most cells of a part are such cells)
    const pre = new Map();
    const triple = (K, base, s, W, out, off) => {
        for (let a = 0; a < 576; a++)
            Kc[a] = s * K[base + a];
        T.fill(0);
        for (let A = 0; A < 8; A++)
            for (let B = 0; B < 8; B++) {
                const w = W[A * 8 + B];
                if (w === 0)
                    continue;
                for (let r = 0; r < 24; r++) {
                    const row = 24 * r;
                    T[row + 3 * B] += w * Kc[row + 3 * A];
                    T[row + 3 * B + 1] += w * Kc[row + 3 * A + 1];
                    T[row + 3 * B + 2] += w * Kc[row + 3 * A + 2];
                }
            }
        for (let A = 0; A < 8; A++)
            for (let B = 0; B < 8; B++) {
                const w = W[A * 8 + B];
                if (w === 0)
                    continue;
                for (let j = 0; j < 3; j++) {
                    const src = 24 * (3 * A + j), dst = off + 24 * (3 * B + j);
                    for (let c = 0; c < 24; c++)
                        out[dst + c] += w * T[src + c];
                }
            }
    };
    for (let k = 0; k < nE; k++) {
        for (const ch of children[k]) {
            const o = (F.ex[ch] & 1) | ((F.ey[ch] & 1) << 1) | ((F.ez[ch] & 1) << 2);
            const W = Ws[o];
            const [K, base, s] = F.elem(ch);
            if (base === 0 && s === 1 && K.length === 576) {
                let anyFixed = false;
                for (let a = 0; a < 24; a++)
                    if (F.fixed[F.edofs[24 * ch + a]]) {
                        anyFixed = true;
                        break;
                    }
                if (!anyFixed) {
                    let G = pre.get(K);
                    if (!G) {
                        G = [];
                        pre.set(K, G);
                    }
                    if (!G[o]) {
                        G[o] = new Float64Array(576);
                        triple(K, 0, 1, W, G[o], 0);
                    }
                    const g = G[o], off = 576 * k;
                    for (let a = 0; a < 576; a++)
                        Kel[off + a] += g[a];
                    continue;
                }
            }
            for (let a = 0; a < 24; a++) {
                const fa = F.fixed[F.edofs[24 * ch + a]];
                for (let b = 0; b < 24; b++)
                    Kc[24 * a + b] = fa || F.fixed[F.edofs[24 * ch + b]] ? 0 : s * K[base + 24 * a + b];
            }
            T.fill(0);
            for (let A = 0; A < 8; A++)
                for (let B = 0; B < 8; B++) {
                    const w = W[A * 8 + B];
                    if (w === 0)
                        continue;
                    for (let r = 0; r < 24; r++) {
                        const row = 24 * r;
                        T[row + 3 * B] += w * Kc[row + 3 * A];
                        T[row + 3 * B + 1] += w * Kc[row + 3 * A + 1];
                        T[row + 3 * B + 2] += w * Kc[row + 3 * A + 2];
                    }
                }
            const off = 576 * k;
            for (let A = 0; A < 8; A++)
                for (let B = 0; B < 8; B++) {
                    const w = W[A * 8 + B];
                    if (w === 0)
                        continue;
                    for (let j = 0; j < 3; j++) {
                        const src = 24 * (3 * A + j), dst = off + 24 * (3 * B + j);
                        for (let c = 0; c < 24; c++)
                            Kel[dst + c] += w * T[src + c];
                    }
                }
        }
    }
    const nNode = nodeKey.size;
    const ncoord = new Int32Array(3 * nNode);
    for (const [kk, id] of nodeKey) {
        ncoord[3 * id] = kk % 4096;
        ncoord[3 * id + 1] = Math.floor(kk / 4096) % 4096;
        ncoord[3 * id + 2] = Math.floor(kk / (4096 * 4096));
    }
    const elem = (k) => [Kel, 576 * k, 1];
    const st = assembleStencil(nNode, nE, edofs, elem, (n) => [ncoord[3 * n], ncoord[3 * n + 1], ncoord[3 * n + 2]], false);
    const L = { ndof, nNode, nbr: st.nbr, val: st.val, fixed: new Uint8Array(ndof), binv: new Float64Array(0), lmax: 1, nE, edofs, elem,
        ex: Int32Array.from(cx), ey: Int32Array.from(cy), ez: Int32Array.from(cz), nodeKey };
    computeBlockInverse(L);
    if (nNode >= 4000)
        L.shared = shareStencil(L.nbr, L.val, nNode);
    return L;
}
function denseCholesky(L) {
    const n = L.ndof, A = new Float64Array(n * n);
    for (let Nn = 0; Nn < L.nNode; Nn++)
        for (let s = 0; s < 27; s++) {
            const B = L.nbr[27 * Nn + s];
            if (B < 0)
                continue;
            for (let i = 0; i < 3; i++)
                for (let j = 0; j < 3; j++)
                    A[(3 * Nn + i) * n + 3 * B + j] += L.val[243 * Nn + 9 * s + 3 * i + j];
        }
    for (let i = 0; i < n; i++)
        if (L.fixed[i]) {
            for (let j = 0; j < n; j++) {
                A[i * n + j] = 0;
                A[j * n + i] = 0;
            }
            A[i * n + i] = 1;
        }
    for (let j = 0; j < n; j++) {
        let s = A[j * n + j];
        for (let k = 0; k < j; k++)
            s -= A[j * n + k] * A[j * n + k];
        if (s <= 1e-14 * Math.abs(A[j * n + j]) || s <= 0) {
            s = Math.max(Math.abs(A[j * n + j]), 1e-30) * 1e-10 + 1e-300;
        }
        const d = Math.sqrt(s);
        A[j * n + j] = d;
        for (let i = j + 1; i < n; i++) {
            let t = A[i * n + j];
            for (let k = 0; k < j; k++)
                t -= A[i * n + k] * A[j * n + k];
            A[i * n + j] = t / d;
        }
    }
    L.chol = A;
}
function cholSolve(L, b) {
    const n = L.ndof, A = L.chol, y = b.slice();
    for (let i = 0; i < n; i++) {
        let s = y[i];
        for (let k = 0; k < i; k++)
            s -= A[i * n + k] * y[k];
        y[i] = s / A[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++)
            s -= A[k * n + i] * y[k];
        y[i] = s / A[i * n + i];
    }
    for (let i = 0; i < n; i++)
        if (L.fixed[i])
            y[i] = 0;
    return y;
}
export function buildFineOperator(t, Ke, o = {}) {
    const { nx, ny } = t.grid, NX = nx + 1, NY = ny + 1;
    const coord = (n) => { const g = t.nodeGrid[n]; return [g % NX, Math.floor(g / NX) % NY, Math.floor(g / (NX * NY))]; };
    const st = assembleStencil(t.nNodes, t.elems.length, t.edofs, (k) => elemMatrix(t, Ke, k), coord, false);
    const diagFull = new Float64Array(3 * t.nNodes);
    for (let A = 0; A < t.nNodes; A++)
        for (let i = 0; i < 3; i++)
            diagFull[3 * A + i] = st.val[243 * A + 9 * 13 + 4 * i];
    const shared = t.elems.length >= 3000 && o.parallel !== false ? shareStencil(st.nbr, st.val, t.nNodes) : null;
    return { nbr: st.nbr, val: st.val, diagFull, shared };
}
export function buildHierarchy(t, Ke, fixed, o = {}) {
    const t0 = performance.now();
    const { nx, ny } = t.grid;
    const ex = new Int32Array(t.elems.length), ey = new Int32Array(t.elems.length), ez = new Int32Array(t.elems.length);
    for (let k = 0; k < t.elems.length; k++) {
        const e = t.elems[k];
        ex[k] = e % nx;
        ey[k] = Math.floor(e / nx) % ny;
        ez[k] = Math.floor(e / (nx * ny));
    }
    const NX = nx + 1, NY = ny + 1;
    const nodeKey = new Map();
    for (let id = 0; id < t.nNodes; id++) {
        const g = t.nodeGrid[id];
        nodeKey.set(key(g % NX, Math.floor(g / NX) % NY, Math.floor(g / (NX * NY))), id);
    }
    const fine = o.fine ?? buildFineOperator(t, Ke, o);
    const L0 = { ndof: 3 * t.nNodes, nNode: t.nNodes, nbr: fine.nbr, val: fine.val, fixed: fixed.slice(), binv: new Float64Array(0), lmax: 1,
        nE: t.elems.length, edofs: t.edofs, elem: (k) => elemMatrix(t, Ke, k), ex, ey, ez, nodeKey, diagFull: fine.diagFull, shared: fine.shared };
    computeBlockInverse(L0);
    L0.lmax = fine.lmax?.[0] ?? estimateLmax(L0);
    const levels = [L0];
    const coarsest = o.coarsest ?? 3000;
    if (o.multigrid !== false) {
        while (levels[levels.length - 1].ndof > coarsest || (levels.length === 1 && levels[0].ndof > 600)) {
            const c = coarsen(levels[levels.length - 1]);
            if (!c)
                break;
            c.lmax = fine.lmax?.[levels.length] ?? estimateLmax(c);
            levels.push(c);
        }
        if (levels.length > 1 && levels[levels.length - 1].ndof <= 600)
            denseCholesky(levels[levels.length - 1]);
    }
    fine.lmax = levels.map((l) => l.lmax);
    return { levels, setupMs: performance.now() - t0, K0: Ke, topo: t };
}
function vcycle(H, l, b) {
    const L = H.levels[l];
    if (L.chol)
        return cholSolve(L, b);
    const x = new Float64Array(L.ndof);
    if (l === H.levels.length - 1)
        return coarseCG(L, b);
    chebyshev(L, b, x);
    const r = new Float64Array(L.ndof);
    matvec(L, x, r);
    for (let i = 0; i < L.ndof; i++)
        r[i] = L.fixed[i] ? 0 : b[i] - r[i];
    const C = H.levels[l + 1], rc = new Float64Array(C.ndof);
    const nfn = L.nNode;
    for (let n = 0; n < nfn; n++)
        for (let c = 0; c < 8; c++) {
            const cn = L.pIdx[8 * n + c];
            if (cn < 0)
                break;
            const w = L.pW[8 * n + c];
            rc[3 * cn] += w * r[3 * n];
            rc[3 * cn + 1] += w * r[3 * n + 1];
            rc[3 * cn + 2] += w * r[3 * n + 2];
        }
    for (let i = 0; i < C.ndof; i++)
        if (C.fixed[i])
            rc[i] = 0;
    const ec = vcycle(H, l + 1, rc);
    for (let n = 0; n < nfn; n++)
        for (let c = 0; c < 8; c++) {
            const cn = L.pIdx[8 * n + c];
            if (cn < 0)
                break;
            const w = L.pW[8 * n + c];
            if (!L.fixed[3 * n])
                x[3 * n] += w * ec[3 * cn];
            if (!L.fixed[3 * n + 1])
                x[3 * n + 1] += w * ec[3 * cn + 1];
            if (!L.fixed[3 * n + 2])
                x[3 * n + 2] += w * ec[3 * cn + 2];
        }
    chebyshev(L, b, x);
    return x;
}
/** Coarsest level without a factorisation: block-Jacobi CG to a loose tolerance (an accurate coarse solve
 * matters on thin walls, where the coarse grids are poor; smoothing alone tripled the outer iterations). */
const CHEB_DEG = Number(process.env.PHYSICS_CHEB ?? 3);
const COARSE_IT = Number(process.env.PHYSICS_COARSE_IT ?? 40), COARSE_TOL = Number(process.env.PHYSICS_COARSE_TOL ?? 1e-2);
function coarseCG(L, b) {
    const n = L.ndof, x = new Float64Array(n), r = b.slice(), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    for (let i = 0; i < n; i++)
        if (L.fixed[i])
            r[i] = 0;
    applyBinv(L, r, z);
    p.set(z);
    let rz = 0, bn = 0;
    for (let i = 0; i < n; i++) {
        rz += r[i] * z[i];
        bn += r[i] * r[i];
    }
    bn = Math.sqrt(bn) || 1;
    for (let it = 0; it < COARSE_IT; it++) {
        matvec(L, p, Ap);
        let pAp = 0;
        for (let i = 0; i < n; i++)
            pAp += p[i] * Ap[i];
        if (!(pAp > 0))
            break;
        const a = rz / pAp;
        let rn = 0;
        for (let i = 0; i < n; i++) {
            x[i] += a * p[i];
            r[i] -= a * Ap[i];
            rn += r[i] * r[i];
        }
        if (Math.sqrt(rn) / bn < COARSE_TOL)
            break;
        applyBinv(L, r, z);
        let rzn = 0;
        for (let i = 0; i < n; i++)
            rzn += r[i] * z[i];
        const beta = rzn / rz;
        rz = rzn;
        for (let i = 0; i < n; i++)
            p[i] = z[i] + beta * p[i];
    }
    for (let i = 0; i < n; i++)
        if (L.fixed[i])
            x[i] = 0;
    return x;
}
/** PCG with the multigrid V-cycle. b must be zero at fixed dofs. `opFixed`: the operator's fixed set when it
 * differs from the hierarchy's (contact passes reuse a hierarchy; dofs the hierarchy holds but the operator
 * frees get a Jacobi correction). */
export function pcg(H, b, o = {}) {
    const t0 = performance.now();
    const L = H.levels[0], n = L.ndof, tol = o.tol ?? 1e-7, maxIt = o.maxIt ?? (H.levels.length > 1 ? 400 : 20000);
    const hFixed = L.fixed, opFixed = o.opFixed ?? L.fixed;
    const released = [];
    if (o.opFixed)
        for (let d = 0; d < n; d++)
            if (hFixed[d] && !opFixed[d])
                released.push(d);
    const op = (x, y) => matvec(L, x, y, opFixed);
    const x = o.x0 ? o.x0.slice() : new Float64Array(n);
    for (let i = 0; i < n; i++)
        if (opFixed[i])
            x[i] = 0;
    const r = new Float64Array(n), Ap = new Float64Array(n);
    op(x, Ap);
    for (let i = 0; i < n; i++)
        r[i] = opFixed[i] ? 0 : b[i] - Ap[i];
    let bn = 0;
    for (let i = 0; i < n; i++)
        if (!opFixed[i])
            bn += b[i] * b[i];
    bn = Math.sqrt(bn) || 1;
    const prec = (v) => {
        const z = H.levels.length > 1 ? vcycle(H, 0, v) : (() => { const zz = new Float64Array(n); applyBinv(L, v, zz); return zz; })();
        if (o.opFixed) {
            for (const d of released)
                z[d] = v[d] / L.diagFull[d];
            for (let d = 0; d < n; d++)
                if (opFixed[d])
                    z[d] = 0;
        }
        return z;
    };
    let z = prec(r), p = z.slice(), rz = 0;
    for (let i = 0; i < n; i++)
        rz += r[i] * z[i];
    let it = 0, rn = 0;
    for (let i = 0; i < n; i++)
        rn += r[i] * r[i];
    rn = Math.sqrt(rn);
    for (; it < maxIt && rn / bn > tol; it++) {
        op(p, Ap);
        let pAp = 0;
        for (let i = 0; i < n; i++)
            pAp += p[i] * Ap[i];
        if (!(pAp > 0))
            break;
        const a = rz / pAp;
        rn = 0;
        for (let i = 0; i < n; i++) {
            x[i] += a * p[i];
            r[i] -= a * Ap[i];
            rn += r[i] * r[i];
        }
        rn = Math.sqrt(rn);
        z = prec(r);
        let rzn = 0;
        for (let i = 0; i < n; i++)
            rzn += r[i] * z[i];
        const beta = rzn / rz;
        rz = rzn;
        for (let i = 0; i < n; i++)
            p[i] = z[i] + beta * p[i];
    }
    return { u: x, iterations: it, relres: rn / bn, ms: performance.now() - t0, converged: rn / bn <= tol };
}
/** K x with no dofs held (for reactions), from the element matrices. */
export function applyKe(t, Ke, x) {
    const y = new Float64Array(3 * t.nNodes), xe = new Float64Array(24);
    for (let k = 0; k < t.elems.length; k++) {
        const o = 24 * k;
        for (let a = 0; a < 24; a++)
            xe[a] = x[t.edofs[o + a]];
        const [K, base, s] = elemMatrix(t, Ke, k);
        for (let a = 0; a < 24; a++) {
            let acc = 0;
            const r = base + 24 * a;
            for (let b = 0; b < 24; b++)
                acc += K[r + b] * xe[b];
            y[t.edofs[o + a]] += s * acc;
        }
    }
    return y;
}
/** K x with no dofs held, from an assembled fine stencil. */
export function applyStencil(F, x) {
    const n = F.nbr.length / 27, y = new Float64Array(3 * n);
    stencilRows(F, x, y, 0, n);
    return y;
}
