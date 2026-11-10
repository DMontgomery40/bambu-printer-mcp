/**
 * A whole part under a load case: voxelise, apply supports and loads stated in plain terms, solve,
 * and report deflection, stress, the weakest point judged separately within and across layers, the
 * screw reactions, an error estimate from a second solve at twice the voxel size, and a map of material
 * that carries almost nothing.
 */
import { voxelize, voxelizeCut, voxelizeCutMesh, boundsOf } from "./grid.js";
import { fcmTables, cutCellMatrix, cellStrain, SUB } from "./fcm.js";
import { buildTopo, buildHierarchy, buildFineOperator, applyStencil, pcg, nodePosition, applyKe } from "./solver.js";
import { hexStiffness, stiffnessWorld, centreB } from "./hex.js";
function inRegion(r, p, h) {
    if ("box" in r)
        return p[0] >= r.box[0][0] - 1e-9 && p[0] <= r.box[0][1] + 1e-9 && p[1] >= r.box[1][0] - 1e-9 && p[1] <= r.box[1][1] + 1e-9 && p[2] >= r.box[2][0] - 1e-9 && p[2] <= r.box[2][1] + 1e-9;
    if ("near" in r)
        return Math.hypot(p[0] - r.near[0], p[1] - r.near[1], p[2] - r.near[2]) <= r.radius;
    if ("cylinder" in r) {
        const c = r.cylinder, an = Math.hypot(...c.axis), ax = [c.axis[0] / an, c.axis[1] / an, c.axis[2] / an];
        const d = [p[0] - c.at[0], p[1] - c.at[1], p[2] - c.at[2]], al = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
        if (c.span && (al < c.span[0] - 1e-9 || al > c.span[1] + 1e-9))
            return false;
        return Math.hypot(d[0] - al * ax[0], d[1] - al * ax[1], d[2] - al * ax[2]) <= c.r + 1e-9;
    }
    const n = r.plane.normal, q = r.plane.point, nn = Math.hypot(...n);
    const d = ((p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] + (p[2] - q[2]) * n[2]) / nn;
    if (Math.abs(d) > (r.tol ?? 0.51 * h))
        return false;
    if (r.within)
        return inRegion({ box: r.within }, p, h);
    return true;
}
/** (node, area/4) for every exposed cell face whose centre passes `inside`. */
function exposedFaceShares(t, inside) {
    const { nx, ny, nz, h, origin } = t.grid;
    const act = new Int32Array(nx * ny * nz).fill(-1);
    for (let k = 0; k < t.elems.length; k++)
        act[t.elems[k]] = k;
    const out = [];
    // face f: axis a in {0,1,2}, side s in {0,1}; local corner nodes with bit a == s
    for (let k = 0; k < t.elems.length; k++) {
        const e = t.elems[k], ix = e % nx, iy = Math.floor(e / nx) % ny, iz = Math.floor(e / (nx * ny));
        for (let a = 0; a < 3; a++)
            for (let sd = 0; sd < 2; sd++) {
                const q = [ix, iy, iz];
                q[a] += sd ? 1 : -1;
                const nb = q[0] < 0 || q[1] < 0 || q[2] < 0 || q[0] >= nx || q[1] >= ny || q[2] >= nz ? -1 : act[q[0] + nx * (q[1] + ny * q[2])];
                if (nb >= 0)
                    continue;
                const c = [origin[0] + (ix + 0.5) * h, origin[1] + (iy + 0.5) * h, origin[2] + (iz + 0.5) * h];
                c[a] += (sd ? 0.5 : -0.5) * h;
                if (!inside(c, a))
                    continue;
                const area = h * h * t.scale[k];
                for (let loc = 0; loc < 8; loc++)
                    if (((loc >> a) & 1) === sd)
                        out.push([t.edofs[24 * k + 3 * loc] / 3, area / 4]);
            }
    }
    return out;
}
/** nodes on the boundary of the voxel body (used by fewer than 8 active cells) */
function surfaceNodes(t) {
    const cnt = new Uint8Array(t.nNodes);
    for (let k = 0; k < t.elems.length; k++)
        for (let a = 0; a < 8; a++)
            cnt[t.edofs[24 * k + 3 * a] / 3]++;
    return cnt.map((c) => (c < 8 ? 1 : 0));
}
const LOADZONE_K = Number(process.env.PHYSICS_LZK ?? 2.5), LOADZONE_CAP = Number(process.env.PHYSICS_LZCAP ?? 7);
const REHOLD = Number(process.env.PHYSICS_REHOLD ?? 2e-3);
const RELEASE = Number(process.env.PHYSICS_RELEASE ?? 0);
const dbg = (m) => { if (process.env.PHYSICS_DEBUG)
    console.log(m); };
const fcmCache = new Map();
function tablesFor(C) {
    const k = Array.from(C).map((v) => v.toPrecision(10)).join(",");
    let T = fcmCache.get(k);
    if (!T) {
        T = fcmTables(C);
        fcmCache.set(k, T);
    }
    return T;
}
/** Attach cut-cell matrices (fcm.ts) to a topology: the cells listed in cutSub get their own matrix. */
function attachCutCells(t, cutSub, C, h, Ke) {
    const T = tablesFor(C);
    const nE = t.elems.length, cut = new Int32Array(nE).fill(-1);
    let n = 0;
    for (let k = 0; k < nE; k++)
        if (cutSub.has(t.elems[k]))
            cut[k] = n++;
    const cutK = new Float64Array(576 * n), cutX = new Float64Array(216 * n), cutG = new Float64Array(54 * n), cen = new Float32Array(3 * n);
    const K = new Float64Array(576), X = new Float64Array(216), G = new Float64Array(54);
    const S = SUB, alpha = 1e-5;
    const cache = new Map(), mcache = new Float64Array(n);
    for (let k = 0; k < nE; k++) {
        const i = cut[k];
        if (i < 0)
            continue;
        const f = cutSub.get(t.elems[k]);
        // cells cut the same way (a flat face crossing many cells at the same offset) share one matrix
        let key = "";
        for (let j = 0; j < f.length; j++)
            key += String.fromCharCode(48 + Math.round(f[j] * 64));
        const hit = cache.get(key);
        let m0;
        if (hit !== undefined) {
            cutK.copyWithin(576 * i, 576 * hit, 576 * hit + 576);
            cutX.copyWithin(216 * i, 216 * hit, 216 * hit + 216);
            cutG.copyWithin(54 * i, 54 * hit, 54 * hit + 54);
            m0 = mcache[hit];
        }
        else {
            m0 = cutCellMatrix(T, f, K, X, G);
            for (let j = 0; j < 576; j++)
                cutK[576 * i + j] = K[j] * h + alpha * Ke[j];
            cutX.set(X, 216 * i);
            cutG.set(G, 54 * i);
            cache.set(key, i);
        }
        mcache[i] = m0;
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (let c = 0; c < S; c++)
            for (let b = 0; b < S; b++)
                for (let a = 0; a < S; a++) {
                    const w = f[a + S * (b + S * c)];
                    sx += w * (a + 0.5);
                    sy += w * (b + 0.5);
                    sz += w * (c + 0.5);
                    sw += w;
                }
        cen[3 * i] = sx / sw / S;
        cen[3 * i + 1] = sy / sw / S;
        cen[3 * i + 2] = sz / sw / S;
        t.scale[k] = m0;
    }
    t.cut = cut;
    t.cutK = cutK;
    t.cutX = cutX;
    t.cutGbar = cutG;
    t.cutCentroid = cen;
}
/** Where a screw head bears: the countersink cone (if the part has one there) or the flat face around the hole. */
function screwSeat(dist, s, ax, h) {
    const headR = (s.head ?? 2 * s.d) / 2;
    if (!dist)
        return null;
    // a radial direction perpendicular to the axis
    const ref = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const r1 = [ax[1] * ref[2] - ax[2] * ref[1], ax[2] * ref[0] - ax[0] * ref[2], ax[0] * ref[1] - ax[1] * ref[0]], rn = Math.hypot(...r1);
    const rd = r1.map((v) => v / rn);
    const P = (al, r) => [s.at[0] + al * ax[0] + r * rd[0], s.at[1] + al * ax[1] + r * rd[1], s.at[2] + al * ax[2] + r * rd[2]];
    // the face: march along the axis just outside the head's radius, from inside the material to where it ends
    const rOut = headR + Math.max(0.4, 0.5 * h);
    let al = 0.05;
    while (al < 60 && dist(...P(al, rOut)) > 0)
        al += 0.05;
    if (al >= 60)
        return null;
    while (al < 200 && dist(...P(al, rOut)) < 0)
        al += 0.02;
    const top = al;
    const k = headR - s.d / 2;
    const countersunk = k > 0.05 && dist(...P(top - 0.4 * k, headR - 0.3 * k)) > 0;
    return { top, k: countersunk ? k : 0, headR, countersunk };
}
function solveAt(c, h, hint, seeding = false, seed) {
    const t0 = performance.now();
    const tv = performance.now();
    const C = stiffnessWorld(c.material, c.printDir ?? [0, 0, 1]);
    const Ke = hexStiffness(C, c.incompatible !== false).map((v) => v * h);
    let grid, t;
    const useCut = c.cut !== false && !!c.geometry.distance;
    if (useCut) {
        // a mesh, when there is one, gives exact sub-cell fills by ray parity (and is faster than sampling the distance)
        const vc = c.geometry.mesh ? voxelizeCutMesh(c.geometry.mesh, boundsOf(c.geometry), h) : voxelizeCut(c.geometry.distance, boundsOf(c.geometry), h);
        grid = vc.grid;
        t = buildTopo(grid, 0.02);
        attachCutCells(t, vc.cutSub, C, h, Ke);
    }
    else {
        grid = voxelize(c.geometry, h);
        t = buildTopo(grid, c.minFill ?? 0.1);
    }
    dbg(`voxelize h=${h}: ${(performance.now() - tv).toFixed(0)} ms, ${t.elems.length} cells, ${t.cutK ? t.cutK.length / 576 : 0} cut`);
    const nd = 3 * t.nNodes;
    const fixed = new Uint8Array(nd);
    const surf = surfaceNodes(t);
    const supportNodes = new Uint8Array(t.nNodes);
    const pos = [];
    for (let n = 0; n < t.nNodes; n++)
        pos.push(nodePosition(t, n));
    const supportSets = [];
    const up = new Float64Array(nd);
    const walls = [];
    const fail = (message) => ({ ok: false, message, t, u: new Float64Array(0), fixed, iterations: 0, ms: 0, C, loadSets: [], supportNodes, reactions: [] });
    for (const s of c.supports) {
        const nodes = [];
        if (s.kind === "fixed") {
            for (let n = 0; n < t.nNodes; n++)
                if (inRegion(s.where, pos[n], h))
                    nodes.push(n);
        }
        else if (s.kind === "prescribed") {
            const filt = s.filter;
            for (let n = 0; n < t.nNodes; n++)
                if (surf[n] && inRegion(s.where, pos[n], h) && (!filt || filt(pos[n]))) {
                    nodes.push(n);
                    const v = s.u(pos[n]);
                    up[3 * n] = v[0];
                    up[3 * n + 1] = v[1];
                    up[3 * n + 2] = v[2];
                }
        }
        else if (s.kind === "screw") {
            const a = s.axis, an = Math.hypot(...a), ax = [a[0] / an, a[1] / an, a[2] / an];
            const axisDof = ax.map(Math.abs).indexOf(Math.max(...ax.map(Math.abs)));
            // the head bears on the countersink cone, or on the flat face around the hole: those surface nodes are
            // held sideways (the head's clamping friction) and pushed towards the wall only (unilateral, solved with
            // the wall contacts). The shank sits in a clearance hole and holds nothing.
            const seat = screwSeat(c.geometry.distance, s, ax, h);
            const head = [];
            for (let n = 0; n < t.nNodes; n++) {
                if (!surf[n])
                    continue;
                const d = [pos[n][0] - s.at[0], pos[n][1] - s.at[1], pos[n][2] - s.at[2]];
                const al = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
                const rad = Math.hypot(d[0] - al * ax[0], d[1] - al * ax[1], d[2] - al * ax[2]);
                if (seat && seat.countersunk) {
                    const al0 = seat.top - seat.k;
                    if (al < al0 - 0.5 * h || al > seat.top + 0.5 * h || rad > seat.headR + 0.5 * h)
                        continue;
                    if (Math.abs(rad - s.d / 2 - (al - al0)) / Math.SQRT2 <= 0.75 * h)
                        head.push(n);
                }
                else if (seat) {
                    if (Math.abs(al - seat.top) <= 0.6 * h && rad >= s.d / 2 - 0.5 * h && rad <= seat.headR + 0.25 * h)
                        head.push(n);
                }
            }
            if (!seat) {
                // no distance function: round 1's rule (the outermost surface nodes within the head's radius)
                let top = -Infinity;
                const radA = [], alA = [];
                for (let n = 0; n < t.nNodes; n++) {
                    const d = [pos[n][0] - s.at[0], pos[n][1] - s.at[1], pos[n][2] - s.at[2]];
                    const al = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
                    alA.push(al);
                    radA.push(Math.hypot(d[0] - al * ax[0], d[1] - al * ax[1], d[2] - al * ax[2]));
                }
                for (let n = 0; n < t.nNodes; n++)
                    if (surf[n] && radA[n] <= s.d / 2 + 0.75 * h)
                        top = Math.max(top, alA[n]);
                const headR = (s.head ?? 2 * s.d) / 2;
                for (let n = 0; n < t.nNodes; n++)
                    if (surf[n] && radA[n] <= headR && alA[n] >= top - 0.5 * h)
                        head.push(n);
            }
            if (!head.length)
                return fail(`support ${s.name ?? s.kind}: no part material found where the head would bear (check its position against the part)`);
            for (const n of head) {
                for (let j = 0; j < 3; j++)
                    if (j !== axisDof)
                        fixed[3 * n + j] = 1;
                supportNodes[n] = 1;
            }
            supportSets.push({ name: `${s.name ?? "screw"}`, nodes: head, axis: ax });
            walls.push({ name: `${s.name ?? "screw"} head`, nodes: head, normal: [-ax[0], -ax[1], -ax[2]], screw: true });
            continue;
        }
        else {
            const nn = Math.hypot(...s.normal), nrm = [s.normal[0] / nn, s.normal[1] / nn, s.normal[2] / nn];
            for (let n = 0; n < t.nNodes; n++) {
                const d = (pos[n][0] - s.point[0]) * nrm[0] + (pos[n][1] - s.point[1]) * nrm[1] + (pos[n][2] - s.point[2]) * nrm[2];
                if (Math.abs(d) <= 0.51 * h && surf[n] && !supportNodes[n])
                    nodes.push(n);
            }
            walls.push({ name: s.name ?? "wall", nodes, normal: nrm });
            continue;
        }
        if (!nodes.length)
            return fail(`support ${s.name ?? s.kind}: no part material found there (check its position against the part)`);
        const mask = s.kind === "fixed" && s.dofs ? s.dofs : [true, true, true];
        for (const n of nodes) {
            for (let j = 0; j < 3; j++)
                if (mask[j])
                    fixed[3 * n + j] = 1;
            supportNodes[n] = 1;
        }
        supportSets.push({ name: s.name ?? s.kind, nodes });
    }
    const f = new Float64Array(nd);
    const loadSets = [];
    for (const l of c.loads) {
        if (l.kind === "gravity") {
            const g = l.g ?? [0, 0, -9.81e3];
            const rho = c.material.density * 1e-3 * 1e-3;
            for (let k = 0; k < t.elems.length; k++) {
                const m = rho * t.scale[k] * h * h * h;
                for (let a = 0; a < 8; a++)
                    for (let j = 0; j < 3; j++)
                        f[t.edofs[24 * k + 3 * a + j]] += (m * g[j] * 1e-3) / 8;
            }
            continue;
        }
        const wmap = new Map();
        const lw = l.where;
        if ("plane" in lw && c.geometry.distance && useCut)
            surfaceShares(t, c.geometry.distance, lw, h, wmap);
        if (!wmap.size) {
            // tributary weights on exposed cell faces in the region (round 1's rule; regions that are not a plane)
            const faceIn = (p, axis) => {
                if ("plane" in lw) {
                    const nn = lw.plane.normal.map(Math.abs);
                    if (nn[axis] < 0.5 * Math.max(...nn))
                        return false;
                    return inRegion({ ...lw, tol: lw.tol ?? 1.0 * h }, p, h);
                }
                return inRegion(lw, p, h);
            };
            for (const [n, area] of exposedFaceShares(t, faceIn))
                wmap.set(n, (wmap.get(n) ?? 0) + area);
        }
        const nodes = [...wmap.keys()];
        if (!nodes.length) {
            if (l.perArea)
                continue;
            return fail(`load ${l.name ?? "force"}: no part surface found in its region`);
        }
        const tot = [...wmap.values()].reduce((a, b) => a + b, 0);
        if (l.perArea)
            l.total = [l.perArea[0] * tot, l.perArea[1] * tot, l.perArea[2] * tot];
        const w = nodes.map((n) => wmap.get(n) / tot);
        nodes.forEach((n, i) => { for (let j = 0; j < 3; j++)
            f[3 * n + j] += l.total[j] * w[i]; });
        const tn = Math.hypot(...l.total) || 1;
        loadSets.push({ name: l.name ?? "load", nodes, w, dir: [l.total[0] / tn, l.total[1] / tn, l.total[2] / tn], area: tot });
    }
    let hasUp = false;
    for (let d = 0; d < nd; d++)
        if (up[d] !== 0) {
            hasUp = true;
            break;
        }
    const fEff = f.slice();
    if (hasUp) {
        const Kup = applyKe(t, Ke, up);
        for (let d = 0; d < nd; d++)
            fEff[d] -= Kup[d];
    }
    // unilateral contacts (wall, screw heads): primal-dual active set. Start from the hint (a coarser solve's
    // set) or everything held; the multigrid hierarchy is built once and reused across passes (the operator's
    // own fixed set is passed separately) until a pass changes more than a few percent of the set.
    let u = new Float64Array(nd), it = 0, wallIt = 0, active = 0, ok = true, message;
    const hasScrew = c.supports.some((q) => q.kind === "screw");
    const wallActive = walls.map((w) => new Uint8Array(w.nodes.length).fill(hasScrew && !w.screw ? 0 : 1));
    if (!hint && hasScrew)
        walls.forEach((w, wi) => { if (!w.screw)
            wallActive[wi].fill(1); });
    if (hint)
        walls.forEach((w, wi) => {
            const hs = hint.get(w.name);
            if (!hs || !hs.length)
                return;
            // nearest hint point (bucketed by a coarse grid)
            const cell = 2 * h, bk = new Map();
            for (const q of hs) {
                const k = `${Math.floor(q.p[0] / cell)},${Math.floor(q.p[1] / cell)},${Math.floor(q.p[2] / cell)}`;
                (bk.get(k) ?? bk.set(k, []).get(k)).push(q);
            }
            w.nodes.forEach((n, i) => {
                let best = Infinity, act = 0;
                const p = pos[n], cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
                for (let dx = -1; dx <= 1; dx++)
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dz = -1; dz <= 1; dz++)
                            for (const q of bk.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                                const d = (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2 + (q.p[2] - p[2]) ** 2;
                                if (d < best) {
                                    best = d;
                                    act = q.active ? 1 : 0;
                                }
                            }
                wallActive[wi][i] = best < Infinity ? act : 1;
            });
        });
    let penetration = 0;
    let lastFx = fixed;
    if (seed && seed.u.length)
        for (let n = 0; n < t.nNodes; n++) {
            const v = interpolateSolved(seed, pos[n]);
            if (v) {
                u[3 * n] = v[0] - up[3 * n];
                u[3 * n + 1] = v[1] - up[3 * n + 1];
                u[3 * n + 2] = v[2] - up[3 * n + 2];
            }
        }
    let settled = false;
    let Hh = null, hFx = null, firstIts = 0;
    const fine = buildFineOperator(t, Ke, { parallel: c.parallel });
    const tight = c.tol ?? 1e-5, loose = Math.max(tight, Number(process.env.PHYSICS_LOOSE ?? 1e-2));
    const maxPass = walls.length ? 40 : 1;
    for (wallIt = 0; wallIt < maxPass; wallIt++) {
        const fx = fixed.slice();
        walls.forEach((w, wi) => {
            const axis = w.normal.map(Math.abs).indexOf(Math.max(...w.normal.map(Math.abs)));
            w.nodes.forEach((n, i) => { if (wallActive[wi][i])
                fx[3 * n + axis] = 1; });
        });
        // rebuild the hierarchy when the held set has moved far from the one it was built with
        let diff = 0, held = 0;
        if (hFx)
            for (let d = 0; d < nd; d++) {
                if (fx[d] !== hFx[d])
                    diff++;
                if (fx[d])
                    held++;
            }
        if (!Hh || t.elems.length < 20000 || diff > Math.max(0.03 * held, 20)) {
            const th = performance.now();
            Hh = buildHierarchy(t, Ke, fx, { multigrid: c.multigrid, fine });
            hFx = fx;
            dbg(`  hierarchy ${(performance.now() - th).toFixed(0)} ms, ${Hh.levels.length} levels`);
        }
        lastFx = fx;
        const b = fEff.slice();
        for (let d = 0; d < nd; d++)
            if (fx[d])
                b[d] = 0;
        const s = pcg(Hh, b, { tol: walls.length && !settled ? loose : tight, x0: u, opFixed: hFx === fx ? undefined : fx });
        if (wallIt === 0)
            firstIts = s.iterations;
        if (hFx !== fx && s.iterations > Math.max(30, 2.5 * firstIts))
            Hh = null; // preconditioner has drifted: rebuild next pass
        u = s.u;
        it += s.iterations;
        dbg(`  pass ${wallIt}: pcg ${s.iterations} it ${s.ms.toFixed(0)} ms${hFx === fx ? "" : " (reused hierarchy)"}`);
        if (!s.converged) {
            ok = false;
            message = `solver did not converge (relative residual ${s.relres.toExponential(2)} after ${s.iterations} iterations): the part is probably not held against some motion; add a support`;
        }
        else {
            ok = true;
            message = undefined;
        }
        if (!walls.length)
            break;
        if (settled)
            break;
        const Ku = applyStencil(fine, u);
        for (let d = 0; d < nd; d++)
            Ku[d] -= fEff[d] - f[d];
        let umaxW = 0;
        for (let d = 0; d < nd; d++)
            umaxW = Math.max(umaxW, Math.abs(u[d]));
        let changed = 0;
        active = 0;
        penetration = 0;
        walls.forEach((w, wi) => {
            const axis = w.normal.map(Math.abs).indexOf(Math.max(...w.normal.map(Math.abs)));
            const sgn = Math.sign(w.normal[axis]);
            w.nodes.forEach((n, i) => {
                const d = 3 * n + axis;
                if (wallActive[wi][i]) {
                    const push = (Ku[d] - f[d]) * sgn;
                    if (push < 0) {
                        wallActive[wi][i] = 0;
                        changed++;
                    }
                }
                else {
                    const pen = -u[d] * sgn / Math.max(umaxW, 1e-30);
                    if (pen > REHOLD) {
                        wallActive[wi][i] = 1;
                        changed++;
                    }
                    else
                        penetration = Math.max(penetration, pen);
                }
                if (wallActive[wi][i])
                    active++;
            });
        });
        dbg(`    contact changes ${changed}, active ${active}, ${walls.map((w, wi) => `${w.name}:${wallActive[wi].reduce((a, b) => a + b, 0)}/${w.nodes.length}`).join(' ')}`);
        if (!changed) {
            if (seeding)
                break;
            settled = true;
        }
    }
    if (hasUp)
        for (let d = 0; d < nd; d++)
            u[d] += up[d];
    const Ku = applyKe(t, Ke, u);
    const reactions = [];
    for (const s of supportSets) {
        const r = [0, 0, 0];
        for (const n of s.nodes)
            for (let j = 0; j < 3; j++)
                r[j] += Ku[3 * n + j] - f[3 * n + j];
        if (s.axis) {
            // a screw: the part's push on the head along the axis (tension in the screw) and the sideways load the head carries
            const ax = s.axis, al = -(r[0] * ax[0] + r[1] * ax[1] + r[2] * ax[2]);
            const lat = [r[0] + al * ax[0], r[1] + al * ax[1], r[2] + al * ax[2]];
            reactions.push({ name: `${s.name} tension`, force: [al * -ax[0], al * -ax[1], al * -ax[2]], axial: al });
            reactions.push({ name: `${s.name} shear`, force: lat, lateral: Math.hypot(...lat) });
        }
        else
            reactions.push({ name: s.name, force: r });
    }
    walls.forEach((w) => {
        if (w.screw)
            return;
        const r = [0, 0, 0];
        for (const n of w.nodes)
            if (lastFx[3 * n] || lastFx[3 * n + 1] || lastFx[3 * n + 2])
                for (let j = 0; j < 3; j++)
                    r[j] += Ku[3 * n + j] - f[3 * n + j];
        reactions.push({ name: w.name, force: r });
    });
    const contactSet = new Map();
    walls.forEach((w) => contactSet.set(w.name, w.nodes.map((n) => ({ p: pos[n], active: !!(lastFx[3 * n] || lastFx[3 * n + 1] || lastFx[3 * n + 2]) }))));
    const heldFinal = new Uint8Array(t.nNodes);
    for (let n = 0; n < t.nNodes; n++)
        if (lastFx[3 * n] || lastFx[3 * n + 1] || lastFx[3 * n + 2])
            heldFinal[n] = 1;
    return { heldFinal, contactSet, t, u, fixed, iterations: it, ms: performance.now() - t0, C, loadSets, supportNodes, reactions, wall: walls.length ? { iterations: wallIt + 1, activeNodes: active, penetration } : undefined, ok, message };
}
/** Uniform traction over the true surface patch of a plane region: samples on the plane, kept where the part's
 * surface is (distance ~ 0, outward normal along the plane's), each spread to its cell's 8 nodes trilinearly. */
function surfaceShares(t, dist, lw, h, wmap) {
    const n0 = lw.plane.normal, nn = Math.hypot(...n0), n = [n0[0] / nn, n0[1] / nn, n0[2] / nn];
    const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u1 = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]], ul = Math.hypot(...u1);
    const e1 = [u1[0] / ul, u1[1] / ul, u1[2] / ul], e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const g = t.grid, q0 = lw.plane.point;
    const box = lw.within ?? [[g.origin[0], g.origin[0] + g.nx * h], [g.origin[1], g.origin[1] + g.ny * h], [g.origin[2], g.origin[2] + g.nz * h]];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < 8; i++) {
        const c = [box[0][i & 1], box[1][(i >> 1) & 1], box[2][(i >> 2) & 1]];
        const d = [c[0] - q0[0], c[1] - q0[1], c[2] - q0[2]];
        const a = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], b = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
        a0 = Math.min(a0, a);
        a1 = Math.max(a1, a);
        b0 = Math.min(b0, b);
        b1 = Math.max(b1, b);
    }
    const sp = Math.min(h / 3, 0.25), area = sp * sp, e = 1e-3;
    const cellAt = new Int32Array(g.nx * g.ny * g.nz).fill(-1);
    for (let k = 0; k < t.elems.length; k++)
        cellAt[t.elems[k]] = k;
    for (let a = a0 + sp / 2; a < a1; a += sp)
        for (let b = b0 + sp / 2; b < b1; b += sp) {
            const p = [q0[0] + a * e1[0] + b * e2[0], q0[1] + a * e1[1] + b * e2[1], q0[2] + a * e1[2] + b * e2[2]];
            if (!inRegion({ box }, p, h))
                continue;
            const d = dist(p[0], p[1], p[2]);
            if (Math.abs(d) > 0.02)
                continue;
            const gr = [(dist(p[0] + e, p[1], p[2]) - dist(p[0] - e, p[1], p[2])) / (2 * e), (dist(p[0], p[1] + e, p[2]) - dist(p[0], p[1] - e, p[2])) / (2 * e), (dist(p[0], p[1], p[2] + e) - dist(p[0], p[1], p[2] - e)) / (2 * e)];
            if (gr[0] * n[0] + gr[1] * n[1] + gr[2] * n[2] < 0.9)
                continue;
            const pin = [p[0] - 0.01 * h * n[0], p[1] - 0.01 * h * n[1], p[2] - 0.01 * h * n[2]];
            const fx = (pin[0] - g.origin[0]) / h, fy = (pin[1] - g.origin[1]) / h, fz = (pin[2] - g.origin[2]) / h;
            const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
            if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz)
                continue;
            const k = cellAt[ix + g.nx * (iy + g.ny * iz)];
            if (k < 0)
                continue;
            const tx = fx - ix, ty = fy - iy, tz = fz - iz;
            for (let c = 0; c < 8; c++) {
                const w = ((c & 1) ? tx : 1 - tx) * (((c >> 1) & 1) ? ty : 1 - ty) * (((c >> 2) & 1) ? tz : 1 - tz);
                if (w <= 0)
                    continue;
                const node = t.edofs[24 * k + 3 * c] / 3;
                wmap.set(node, (wmap.get(node) ?? 0) + w * area);
            }
        }
}
/** Distance from each point to the nearest of `src` points, if within r (else Infinity); bucketed. */
function nearMask(points, n, src, r) {
    const out = new Uint8Array(n);
    if (!src.length || r <= 0)
        return out;
    const cell = r, bk = new Map();
    for (const q of src) {
        const k = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)},${Math.floor(q[2] / cell)}`;
        (bk.get(k) ?? bk.set(k, []).get(k)).push(q);
    }
    const r2 = r * r;
    for (let i = 0; i < n; i++) {
        const p = points(i), cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
        search: for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++)
                    for (const q of bk.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                        if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 <= r2) {
                            out[i] = 1;
                            break search;
                        }
                    }
    }
    return out;
}
/** Thickness of the part under a load patch: twice the deepest inscribed half-thickness found marching in from it. */
function patchThickness(dist, pts) {
    let best = 0;
    const e = 1e-3;
    const step = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += step) {
        const p = pts[i];
        const g = [(dist(p[0] + e, p[1], p[2]) - dist(p[0] - e, p[1], p[2])), (dist(p[0], p[1] + e, p[2]) - dist(p[0], p[1] - e, p[2])), (dist(p[0], p[1], p[2] + e) - dist(p[0], p[1], p[2] - e))];
        const gn = Math.hypot(...g);
        if (gn < 1e-12)
            continue;
        for (let d = 0.25; d <= 6; d += 0.25) {
            const v = -dist(p[0] - (g[0] / gn) * d, p[1] - (g[1] / gn) * d, p[2] - (g[2] / gn) * d);
            if (v > best)
                best = v;
            if (v < 0)
                break;
        }
    }
    return 2 * best;
}
function evaluate(c, s) {
    const { t, u, C } = s, h = t.grid.h;
    const Bc = centreB();
    const d = c.printDir ?? [0, 0, 1], dn = Math.hypot(...d), e3 = [d[0] / dn, d[1] / dn, d[2] / dn];
    const Stz = c.material.Stz ?? c.material.Sz / Math.sqrt(3);
    const { nx, ny, origin } = t.grid;
    const nE = t.elems.length;
    // sample point of each cell: its centre, or a cut cell's material centroid
    const P = new Float64Array(3 * nE);
    for (let k = 0; k < nE; k++) {
        const e = t.elems[k], ci = t.cut ? t.cut[k] : -1;
        const fx = ci >= 0 ? t.cutCentroid[3 * ci] : 0.5, fy = ci >= 0 ? t.cutCentroid[3 * ci + 1] : 0.5, fz = ci >= 0 ? t.cutCentroid[3 * ci + 2] : 0.5;
        P[3 * k] = origin[0] + ((e % nx) + fx) * h;
        P[3 * k + 1] = origin[1] + ((Math.floor(e / nx) % ny) + fy) * h;
        P[3 * k + 2] = origin[2] + (Math.floor(e / (nx * ny)) + fz) * h;
    }
    const at = (k) => [P[3 * k], P[3 * k + 1], P[3 * k + 2]];
    // St Venant zones, in millimetres so they do not move with the voxel size: within max(2h, 2 mm) of a held
    // node (a held face is stiffer than any real support and its edge is a singularity), and within
    // max(2h, 1.5 x the part's thickness under the patch, at most 4 mm) of a load patch (the stress there
    // depends on how the load is spread, which the load case does not say)
    const held = [];
    for (let n = 0; n < t.nNodes; n++)
        if (s.supportNodes[n] || (s.heldFinal && s.heldFinal[n]))
            held.push(nodePosition(t, n));
    const rSup = Math.max(2 * h, 2);
    const nearSupport = nearMask(at, nE, held, rSup);
    let rLoad = 0;
    const nearLoad = new Uint8Array(nE);
    if (c.loadZone !== false)
        for (const L of s.loadSets) {
            const pts = L.nodes.map((n) => nodePosition(t, n));
            const r = c.geometry.distance ? Math.max(2 * h, Math.min(LOADZONE_CAP, LOADZONE_K * patchThickness(c.geometry.distance, pts))) : 2 * h;
            rLoad = Math.max(rLoad, r);
            const m = nearMask(at, nE, pts, r);
            for (let k = 0; k < nE; k++)
                nearLoad[k] |= m[k];
        }
    let best = { sf: Infinity, where: [0, 0, 0], mode: "within layers", stress: 0, strength: 1, component: "" };
    let bestS = { ...best }, bestL = { ...best };
    let vmMax = 0, energy = 0;
    const sed = new Float64Array(nE);
    const sigAll = new Float64Array(6 * nE), fiAll = new Float64Array(nE);
    const eps = new Float64Array(6), sig = new Float64Array(6), ue = new Float64Array(24), alpha = new Float64Array(9);
    const judge = (sg, where) => {
        const [sx, sy, sz, tyz, txz, txy] = sg;
        const vm = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (tyz * tyz + txz * txz + txy * txy));
        const tr = [sx * e3[0] + txy * e3[1] + txz * e3[2], txy * e3[0] + sy * e3[1] + tyz * e3[2], txz * e3[0] + tyz * e3[1] + sz * e3[2]];
        const sn = tr[0] * e3[0] + tr[1] * e3[1] + tr[2] * e3[2];
        const ts = Math.sqrt(Math.max(0, tr[0] ** 2 + tr[1] ** 2 + tr[2] ** 2 - sn * sn));
        const fiXY = vm / c.material.Sxy;
        const fiZ = Math.sqrt((Math.max(0, sn) / c.material.Sz) ** 2 + (ts / Stz) ** 2);
        return fiZ > fiXY
            ? { vm, sf: 1 / fiZ, where, mode: "across layers", stress: sn > 0 ? sn : ts, strength: sn > 0 ? c.material.Sz : Stz, component: `layer-normal ${sn.toFixed(2)} MPa, layer shear ${ts.toFixed(2)} MPa` }
            : { vm, sf: 1 / fiXY, where, mode: "within layers", stress: vm, strength: c.material.Sxy, component: `von Mises ${vm.toFixed(2)} MPa` };
    };
    const MINFILL = 0.25;
    for (let k = 0; k < nE; k++) {
        const ci = t.cut ? t.cut[k] : -1;
        for (let a = 0; a < 24; a++)
            ue[a] = u[t.edofs[24 * k + a]];
        if (ci >= 0) {
            const X = t.cutX, o = 216 * ci;
            for (let m = 0; m < 9; m++) {
                let v = 0;
                for (let a = 0; a < 24; a++)
                    v += X[o + 24 * m + a] * ue[a];
                alpha[m] = -v;
            }
            cellStrain(2 * t.cutCentroid[3 * ci] - 1, 2 * t.cutCentroid[3 * ci + 1] - 1, 2 * t.cutCentroid[3 * ci + 2] - 1, ue, alpha, t.cutGbar.subarray(54 * ci, 54 * ci + 54), eps);
            for (let i = 0; i < 6; i++)
                eps[i] /= h;
        }
        else
            for (let i = 0; i < 6; i++) {
                let v = 0;
                for (let a = 0; a < 24; a++)
                    v += Bc[i * 24 + a] * ue[a];
                eps[i] = v / h;
            }
        for (let i = 0; i < 6; i++) {
            let v = 0;
            for (let j = 0; j < 6; j++)
                v += C[i * 6 + j] * eps[j];
            sig[i] = v;
        }
        let w = 0;
        for (let i = 0; i < 6; i++)
            w += 0.5 * sig[i] * eps[i];
        sed[k] = w;
        energy += w * t.scale[k] * h * h * h;
        sigAll.set(sig, 6 * k);
        if (t.scale[k] < MINFILL)
            continue;
        const cand = judge(sig, at(k));
        fiAll[k] = 1 / cand.sf;
        if (nearSupport[k]) {
            if (cand.sf < bestS.sf)
                bestS = cand;
        }
        else if (nearLoad[k]) {
            if (cand.sf < bestL.sf)
                bestL = cand;
        }
        else {
            vmMax = Math.max(vmMax, cand.vm);
            if (cand.sf < best.sf)
                best = cand;
        }
    }
    // surface extrapolation: a sample point sits up to about h/2 inside the surface; extrapolate the stress
    // tensor linearly in the distance function from the cell and a full cell one step further in
    const raw = best;
    const dist = c.geometry.distance;
    const cellAt = new Int32Array(t.grid.nx * t.grid.ny * t.grid.nz).fill(-1);
    for (let k = 0; k < nE; k++)
        cellAt[t.elems[k]] = k;
    const extrapolate = (k) => {
        if (!dist)
            return null;
        const p = at(k), phi = dist(p[0], p[1], p[2]), dd = h / 2;
        if (phi < -1.5 * h)
            return null;
        const g = [dist(p[0] + dd, p[1], p[2]) - dist(p[0] - dd, p[1], p[2]), dist(p[0], p[1] + dd, p[2]) - dist(p[0], p[1] - dd, p[2]), dist(p[0], p[1], p[2] + dd) - dist(p[0], p[1], p[2] - dd)];
        const gn = Math.hypot(...g);
        if (gn < 1e-12)
            return null;
        const q = [p[0] - (g[0] / gn) * h, p[1] - (g[1] / gn) * h, p[2] - (g[2] / gn) * h];
        const qi = [Math.floor((q[0] - origin[0]) / h), Math.floor((q[1] - origin[1]) / h), Math.floor((q[2] - origin[2]) / h)];
        if (qi.some((v, a) => v < 0 || v >= [nx, ny, t.grid.nz][a]))
            return null;
        const k2 = cellAt[qi[0] + nx * (qi[1] + ny * qi[2])];
        if (k2 < 0 || k2 === k || t.scale[k2] < 0.99)
            return null;
        const p2 = at(k2), phi2 = dist(p2[0], p2[1], p2[2]);
        if (phi - phi2 < 0.3 * h)
            return null;
        const se = new Float64Array(6), r = Math.min(1.5, -phi / (phi - phi2));
        for (let i = 0; i < 6; i++) {
            const s1 = sigAll[6 * k + i], s2 = sigAll[6 * k2 + i];
            se[i] = s1 + (s1 - s2) * r;
        }
        return judge(se, [p[0] - (g[0] / gn) * phi, p[1] - (g[1] / gn) * phi, p[2] - (g[2] / gn) * phi]);
    };
    const order = Array.from(fiAll.keys()).filter((k) => fiAll[k] > 0).sort((a, b) => fiAll[b] - fiAll[a]).slice(0, 120);
    for (const k of order) {
        const cand = extrapolate(k);
        if (!cand)
            continue;
        const tag = { ...cand, component: cand.component + " (extrapolated to the surface)" };
        if (nearSupport[k]) {
            if (cand.sf < bestS.sf)
                bestS = tag;
        }
        else if (nearLoad[k]) {
            if (cand.sf < bestL.sf)
                bestL = tag;
        }
        else if (cand.sf < best.sf)
            best = tag;
    }
    const sorted = Array.from(sed).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const thr = 0.01 * med;
    let idleV = 0, totV = 0;
    const idleMask = new Uint8Array(nE);
    for (let k = 0; k < nE; k++) {
        const v = t.scale[k] * h ** 3;
        totV += v;
        if (sed[k] < thr && !nearSupport[k]) {
            idleV += v;
            idleMask[k] = 1;
        }
    }
    const regions = idleRegions(t, idleMask);
    let maxU = 0, maxAt = [0, 0, 0];
    for (let n = 0; n < t.nNodes; n++) {
        const m = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
        if (m > maxU) {
            maxU = m;
            maxAt = nodePosition(t, n);
        }
    }
    const loadDeflection = s.loadSets.map((L) => {
        const v = [0, 0, 0];
        L.nodes.forEach((n, i) => { for (let j = 0; j < 3; j++)
            v[j] += L.w[i] * u[3 * n + j]; });
        return { name: L.name, along: v[0] * L.dir[0] + v[1] * L.dir[1] + v[2] * L.dir[2], vector: v };
    });
    const massG = totV * c.material.density * 1e-3;
    const candidates = Array.from(fiAll.keys()).filter((k) => fiAll[k] > 0 && !nearSupport[k] && !nearLoad[k]).sort((a, b) => fiAll[b] - fiAll[a]).slice(0, 60).map((k) => ({ sf: 1 / fiAll[k], where: at(k), mode: "within layers", stress: 0, strength: 0, component: "" }));
    const centres = new Float32Array(3 * nE);
    for (let k = 0; k < nE; k++) {
        centres[3 * k] = P[3 * k];
        centres[3 * k + 1] = P[3 * k + 1];
        centres[3 * k + 2] = P[3 * k + 2];
    }
    const map = { centres, sed: Float32Array.from(sed), fi: Float32Array.from(fiAll), h, sig: sigAll, scale: t.scale, nearSupport, nearLoad };
    const orientations = [];
    for (const up of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        let worst = Infinity, mode = "";
        for (let k = 0; k < nE; k++) {
            if (t.scale[k] < MINFILL || nearSupport[k] || nearLoad[k])
                continue;
            const [sx, sy, sz, tyz, txz, txy] = sigAll.subarray(6 * k, 6 * k + 6);
            const vm = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (tyz * tyz + txz * txz + txy * txy));
            const tr = [sx * up[0] + txy * up[1] + txz * up[2], txy * up[0] + sy * up[1] + tyz * up[2], txz * up[0] + tyz * up[1] + sz * up[2]];
            const sn = tr[0] * up[0] + tr[1] * up[1] + tr[2] * up[2];
            const ts = Math.sqrt(Math.max(0, tr[0] ** 2 + tr[1] ** 2 + tr[2] ** 2 - sn * sn));
            const fz = Math.sqrt((Math.max(0, sn) / c.material.Sz) ** 2 + (ts / Stz) ** 2), fx = vm / c.material.Sxy;
            const sf = 1 / Math.max(fz, fx);
            if (sf < worst) {
                worst = sf;
                mode = fz > fx ? "across layers" : "within layers";
            }
        }
        orientations.push({ up, sf: worst, mode });
    }
    return { orientations, map, candidates, best, raw, bestS, bestL, rSup, rLoad, vmMax, energy, idle: { fraction: idleV / totV, massG: idleV * c.material.density * 1e-3, regions }, maxU, maxAt, loadDeflection, massG };
}
function idleRegions(t, mask) {
    const { nx, ny, nz, h, origin } = t.grid;
    const idx = new Int32Array(nx * ny * nz).fill(-1);
    for (let k = 0; k < t.elems.length; k++)
        if (mask[k])
            idx[t.elems[k]] = k;
    const seen = new Uint8Array(nx * ny * nz), out = [];
    for (let s0 = 0; s0 < idx.length; s0++) {
        if (idx[s0] < 0 || seen[s0])
            continue;
        const st = [s0];
        seen[s0] = 1;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        let vol = 0;
        while (st.length) {
            const e = st.pop();
            const x = e % nx, y = Math.floor(e / nx) % ny, z = Math.floor(e / (nx * ny));
            vol += t.scale[idx[e]] * h ** 3;
            mn[0] = Math.min(mn[0], x);
            mn[1] = Math.min(mn[1], y);
            mn[2] = Math.min(mn[2], z);
            mx[0] = Math.max(mx[0], x);
            mx[1] = Math.max(mx[1], y);
            mx[2] = Math.max(mx[2], z);
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const X = x + dx, Y = y + dy, Z = z + dz;
                if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz)
                    continue;
                const q = X + nx * (Y + ny * Z);
                if (idx[q] >= 0 && !seen[q]) {
                    seen[q] = 1;
                    st.push(q);
                }
            }
        }
        out.push({ min: [origin[0] + mn[0] * h, origin[1] + mn[1] * h, origin[2] + mn[2] * h], max: [origin[0] + (mx[0] + 1) * h, origin[1] + (mx[1] + 1) * h, origin[2] + (mx[2] + 1) * h], volume: vol });
    }
    return out.sort((a, b) => b.volume - a.volume).slice(0, 6);
}
/**
 * The thinnest wall a part has, for choosing the voxel: on a coarse grid, every interior point's local wall
 * thickness is twice the largest inscribed distance in its neighbourhood; the 10th percentile over the part's
 * volume is the thin-wall thickness (edges, chamfers and small slivers do not count).
 */
export function thinWall(distance, b) {
    const size = Math.max(...b.max.map((v, i) => v - b.min[i]));
    const g = Math.max(0.25, size / 120);
    const nx = Math.ceil((b.max[0] - b.min[0]) / g), ny = Math.ceil((b.max[1] - b.min[1]) / g), nz = Math.ceil((b.max[2] - b.min[2]) / g);
    const d = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++)
                d[i + nx * (j + ny * k)] = -distance(b.min[0] + (i + 0.5) * g, b.min[1] + (j + 0.5) * g, b.min[2] + (k + 0.5) * g);
    const R = 3;
    const vals = [];
    for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
                if (d[i + nx * (j + ny * k)] <= 0)
                    continue;
                let m = 0;
                for (let c = -R; c <= R; c++)
                    for (let bb = -R; bb <= R; bb++)
                        for (let a = -R; a <= R; a++) {
                            const I = i + a, J = j + bb, K = k + c;
                            if (I < 0 || J < 0 || K < 0 || I >= nx || J >= ny || K >= nz)
                                continue;
                            m = Math.max(m, d[I + nx * (J + ny * K)]);
                        }
                vals.push(2 * m);
            }
    if (!vals.length)
        return size;
    vals.sort((a, b2) => a - b2);
    return vals[Math.floor(0.1 * vals.length)];
}
export function analyzeSolid(c) {
    const t0 = performance.now();
    // unilateral contacts (wall, screw heads): find the contact set on the 2h grid first (an eighth of the
    // cost), then start the h solve from it; the 2h solve doubles as the error estimate
    const unilateral = c.supports.some((s) => s.kind === "wall" || s.kind === "screw");
    // unilateral contacts: nested active sets, 4h then 2h then h, each started from the coarser one's set (most
    // passes then happen where they are cheap); the 2h solve doubles as the error estimate
    let seed4 = null;
    if (unilateral && c.nested !== false) {
        const s4 = solveAt(c, 4 * c.h, undefined, true);
        if (s4.u.length && s4.ok)
            seed4 = s4;
    }
    let s2pre = c.errorEstimate !== false || unilateral ? solveAt(c, 2 * c.h, seed4?.contactSet, true, seed4 ?? undefined) : null;
    let hc = 2 * c.h;
    // thin walls can vanish at 2h without cut cells; fall back to 1.5h for the contact seed and the error estimate
    if (s2pre && (!s2pre.u.length || !s2pre.ok)) {
        hc = 1.5 * c.h;
        s2pre = solveAt(c, hc, undefined, true);
    }
    const s = solveAt(c, c.h, unilateral && s2pre?.contactSet ? s2pre.contactSet : undefined, false, s2pre && s2pre.u.length ? s2pre : undefined);
    const assumptions = [];
    if (c.material.Stz === undefined)
        assumptions.push(`interlayer shear strength assumed Sz/sqrt(3) = ${(c.material.Sz / Math.sqrt(3)).toFixed(1)} MPa (no measured value)`);
    if (c.supports.some((q) => q.kind === "screw"))
        assumptions.push("screws: the head bears on the countersink cone (or the flat face around the hole), holds it sideways and pushes it towards the wall only; the shank sits in a clearance hole; no preload");
    assumptions.push("peaks within 2 mm (or two cells) of a held support are reported separately ('at a support'): a held face is stiffer than any real support, and its edge is a singularity");
    assumptions.push("peaks within 2.5 x the part's thickness under a load patch (at most 7 mm) are reported separately ('at the load'): there the stress depends on how the load is spread, which the load case does not say (a shell's edge zone is about sqrt(R t), 5 mm for a 2.4 mm wall on an 8-10 mm corner radius)");
    assumptions.push("linear elastic, small deflection; surface cells are integrated over their material (cut cells) and judged at their material centroid; cells under a quarter full are not used for the peak");
    const blank = { sf: NaN, where: [0, 0, 0], mode: "within layers", stress: NaN, strength: NaN, component: "" };
    if (!s.ok && !s.u.length)
        return { ok: false, message: s.message, dofs: 0, elements: 0, iterations: 0, ms: performance.now() - t0, loadDeflection: [], maxDisplacement: { value: NaN, at: [0, 0, 0] }, weakest: blank, atSupport: blank, reactions: [], vonMisesMax: NaN, energy: NaN, idle: { fraction: NaN, massG: NaN, regions: [] }, massG: NaN, assumptions };
    const tev = performance.now();
    const ev = evaluate(c, s);
    dbg(`evaluate ${(performance.now() - tev).toFixed(0)} ms`);
    const zf = c.zoom ?? 4;
    let zoomInfo, weakestGlobal, zoomSfRel;
    if (zf > 1 && c.geometry.distance && c.geometry.bounds && s.ok) {
        const tz = performance.now();
        const z = zoomRefine(c, s, [ev.best, ...ev.candidates.filter((q) => q.sf <= 1.3 * ev.best.sf)].slice(0, 12), zf);
        zoomInfo = { boxes: z.boxes, h: z.hz, ms: performance.now() - tz };
        dbg(`zoom ${z.boxes} boxes ${zoomInfo.ms.toFixed(0)} ms`);
        zoomSfRel = z.sfRel;
        if (z.best) {
            // inside a zoom box the zoomed answer replaces the global one; outside every box the global candidates stand
            weakestGlobal = ev.best;
            const outside = [ev.best, ...ev.candidates].filter((q) => !z.zoomed.some((b) => [0, 1, 2].every((a) => q.where[a] >= b[0][a] && q.where[a] <= b[1][a])));
            const o = outside.reduce((a, b) => (!a || b.sf < a.sf ? b : a), null);
            ev.best = o && o.sf < z.best.sf ? o : z.best;
        }
    }
    const res = {
        ok: s.ok, message: s.message, dofs: 3 * s.t.nNodes, elements: s.t.elems.length, iterations: s.iterations, ms: 0,
        loadDeflection: ev.loadDeflection, maxDisplacement: { value: ev.maxU, at: ev.maxAt }, weakest: ev.best, weakestRaw: ev.raw, weakestGlobal, zoom: zoomInfo, atSupport: ev.bestS, atLoad: ev.bestL, zones: { support: ev.rSup, load: ev.rLoad },
        reactions: s.reactions, vonMisesMax: ev.vmMax, energy: ev.energy, idle: ev.idle, massG: ev.massG, wallContact: s.wall, assumptions, map: c.map ? ev.map : undefined, orientations: ev.orientations,
        weakestRadius: c.geometry.distance ? surfaceRadius(c.geometry.distance, ev.best.where, c.h) : undefined,
    };
    if (c.errorEstimate !== false && s2pre) {
        const s2 = s2pre;
        if (s2.u.length) {
            const e2 = evaluate(c, s2);
            res.coarse = { weakestSf: e2.best.sf, loadDeflection: e2.loadDeflection.map((l) => l.along) };
            // the governing load's deflection (the largest), not the first load's
            const gi = ev.loadDeflection.reduce((b, l, i) => (Math.abs(l.along) > Math.abs(ev.loadDeflection[b]?.along ?? 0) ? i : b), 0);
            const d1 = ev.loadDeflection[gi]?.along ?? ev.maxU, d2 = e2.loadDeflection[gi]?.along ?? e2.maxU;
            const ratio = hc / c.h, rich = c.cut !== false && c.geometry.distance ? ratio ** 2 - 1 : ratio ** 2 - 1; // second-order Richardson for the deflection
            // safety factor: from the zoom at twice its voxel when a zoom ran, else from the coarse global solve
            const sfRel = zoomSfRel ?? Math.abs((weakestGlobal ?? ev.best).sf - e2.best.sf) / (weakestGlobal ?? ev.best).sf;
            res.errorEstimate = { deflectionRel: Math.abs(d1 - d2) / Math.max(1e-30, Math.abs(d1)) / rich, sfRel, coarseH: hc };
        }
    }
    res.ms = performance.now() - t0;
    res.h = c.h;
    return res;
}
/**
 * Zoom: the weakest candidates' neighbourhoods re-solved at a finer voxel size, with the global solution's
 * displacements imposed on the zoom box's cut faces (submodelling; St Venant: the box reaches 4 global
 * cells beyond the peak). Free surfaces inside the box stay free; loads inside the box are not re-applied,
 * so zooms are skipped where a load region reaches into the box.
 */
/** Trilinear interpolation of a solved displacement field at p (missing nodes skipped); null outside. */
function interpolateSolved(s, p) {
    const g = s.t.grid, H = g.h, NX = g.nx + 1, NY = g.ny + 1;
    const fx = (p[0] - g.origin[0]) / H, fy = (p[1] - g.origin[1]) / H, fz = (p[2] - g.origin[2]) / H;
    const ix = Math.min(g.nx - 1, Math.max(0, Math.floor(fx))), iy = Math.min(g.ny - 1, Math.max(0, Math.floor(fy))), iz = Math.min(g.nz - 1, Math.max(0, Math.floor(fz)));
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const out = [0, 0, 0];
    let wsum = 0;
    for (let a = 0; a < 8; a++) {
        const i = ix + (a & 1), j = iy + ((a >> 1) & 1), k = iz + ((a >> 2) & 1);
        const id = s.t.nodeOf[i + NX * (j + NY * k)];
        if (id < 0)
            continue;
        const w = ((a & 1) ? tx : 1 - tx) * (((a >> 1) & 1) ? ty : 1 - ty) * (((a >> 2) & 1) ? tz : 1 - tz);
        if (w <= 0)
            continue;
        wsum += w;
        for (let j2 = 0; j2 < 3; j2++)
            out[j2] += w * s.u[3 * id + j2];
    }
    return wsum > 1e-9 ? [out[0] / wsum, out[1] / wsum, out[2] / wsum] : null;
}
/** Radius of curvature of the part's surface near p (from the distance function's Laplacian); Infinity if flat. */
function surfaceRadius(dist, p, H) {
    const e = 0.25 * H, f0 = dist(p[0], p[1], p[2]);
    const g = [dist(p[0] + e, p[1], p[2]) - dist(p[0] - e, p[1], p[2]), dist(p[0], p[1] + e, p[2]) - dist(p[0], p[1] - e, p[2]), dist(p[0], p[1], p[2] + e) - dist(p[0], p[1], p[2] - e)];
    const gn = Math.hypot(...g) || 1;
    const q = [p[0] - (f0 * g[0]) / gn, p[1] - (f0 * g[1]) / gn, p[2] - (f0 * g[2]) / gn];
    const fq = dist(q[0], q[1], q[2]);
    let lap = 0;
    for (let a = 0; a < 3; a++) {
        const d1 = [...q], d2 = [...q];
        d1[a] += e;
        d2[a] -= e;
        lap += (dist(...d1) + dist(...d2) - 2 * fq) / (e * e);
    }
    return Math.abs(lap) < 1e-6 ? Infinity : 1 / Math.abs(lap);
}
function zoomRefine(c, s, candidates, factor) {
    const zoomed = [];
    const g = s.t.grid, H = g.h;
    let hz = H / factor, half = 4 * H;
    const NX = g.nx + 1, NY = g.ny + 1;
    const gl = (p) => {
        // trilinear interpolation of the global displacement from the cell containing p (missing nodes skipped)
        const fx = (p[0] - g.origin[0]) / H, fy = (p[1] - g.origin[1]) / H, fz = (p[2] - g.origin[2]) / H;
        const ix = Math.min(g.nx - 1, Math.max(0, Math.floor(fx))), iy = Math.min(g.ny - 1, Math.max(0, Math.floor(fy))), iz = Math.min(g.nz - 1, Math.max(0, Math.floor(fz)));
        const tx = fx - ix, ty = fy - iy, tz = fz - iz;
        const out = [0, 0, 0];
        let wsum = 0;
        for (let a = 0; a < 8; a++) {
            const i = ix + (a & 1), j = iy + ((a >> 1) & 1), k = iz + ((a >> 2) & 1);
            const id = s.t.nodeOf[i + NX * (j + NY * k)];
            if (id < 0)
                continue;
            const w = ((a & 1) ? tx : 1 - tx) * (((a >> 1) & 1) ? ty : 1 - ty) * (((a >> 2) & 1) ? tz : 1 - tz);
            if (w <= 0)
                continue;
            wsum += w;
            for (let j2 = 0; j2 < 3; j2++)
                out[j2] += w * s.u[3 * id + j2];
        }
        return wsum > 1e-9 ? [out[0] / wsum, out[1] / wsum, out[2] / wsum] : null;
    };
    let best = null, boxes = 0, bestSub = null, bestHz = 0;
    const done = [];
    for (const cand of candidates) {
        // box half-size: at least 4 global cells and two local radii (St Venant), at most 8 cells
        const R = surfaceRadius(c.geometry.distance, cand.where, H);
        half = Math.min(Math.max(8 * H, 3), Math.max(4 * H, Number.isFinite(R) ? 2 * R : 4 * H));
        if (done.some((q) => Math.max(Math.abs(q[0] - cand.where[0]), Math.abs(q[1] - cand.where[1]), Math.abs(q[2] - cand.where[2])) < half))
            continue;
        done.push(cand.where);
        const lo = [cand.where[0] - half, cand.where[1] - half, cand.where[2] - half], hi = [cand.where[0] + half, cand.where[1] + half, cand.where[2] + half];
        // the box must not reach into a load region (loads are not re-applied inside the zoom)
        const pb = c.geometry.bounds;
        const blo = [Math.max(lo[0], pb.min[0]), Math.max(lo[1], pb.min[1]), Math.max(lo[2], pb.min[2])], bhi = [Math.min(hi[0], pb.max[0]), Math.min(hi[1], pb.max[1]), Math.min(hi[2], pb.max[2])];
        // loads reaching into the box are re-applied there as the same traction (plane patches only)
        const subLoads = [];
        let unsupportedLoad = false;
        s.loadSets.forEach((L, li) => {
            const inBox = L.nodes.some((n) => { const p = nodePosition(s.t, n); return p[0] >= blo[0] - 1e-9 && p[0] <= bhi[0] + 1e-9 && p[1] >= blo[1] - 1e-9 && p[1] <= bhi[1] + 1e-9 && p[2] >= blo[2] - 1e-9 && p[2] <= bhi[2] + 1e-9; });
            if (!inBox)
                return;
            const gl = c.loads.filter((q) => q.kind === "force")[li];
            if (!gl || !("plane" in gl.where) || !L.area) {
                unsupportedLoad = true;
                return;
            }
            const w0 = gl.where.within ?? [[-1e9, 1e9], [-1e9, 1e9], [-1e9, 1e9]];
            const within = [[Math.max(w0[0][0], blo[0]), Math.min(w0[0][1], bhi[0])], [Math.max(w0[1][0], blo[1]), Math.min(w0[1][1], bhi[1])], [Math.max(w0[2][0], blo[2]), Math.min(w0[2][1], bhi[2])]];
            subLoads.push({ kind: "force", total: [0, 0, 0], perArea: [gl.total[0] / L.area, gl.total[1] / L.area, gl.total[2] / L.area], where: { ...gl.where, within }, name: gl.name });
        });
        if (unsupportedLoad)
            continue;
        const dist = c.geometry.distance;
        // zoom voxel from the local surface radius: about ten cells per radius, between H/factor and H/1.5;
        // finer stair-stepped voxels over-predict curved-surface peaks (benchmark: plate with a hole)
        // thin walls: at least four zoom cells through the local wall thickness
        let tLoc = Infinity;
        {
            let m = 0;
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++)
                        m = Math.max(m, -dist(cand.where[0] + 0.5 * H * dx, cand.where[1] + 0.5 * H * dy, cand.where[2] + 0.5 * H * dz));
            if (m > 0)
                tLoc = 2 * m;
        }
        hz = Math.max(H / factor, Math.min(H / 1.5, R / 10, tLoc / 4));
        if (hz >= H / 1.5 - 1e-12)
            continue;
        const sub = { ...c, geometry: { distance: (x, y, z) => Math.max(dist(x, y, z), blo[0] - x, x - bhi[0], blo[1] - y, y - bhi[1], blo[2] - z, z - bhi[2]), bounds: { min: blo, max: bhi } },
            h: hz, supports: [{ kind: "prescribed", name: "zoom boundary", where: { box: [[blo[0], bhi[0]], [blo[1], bhi[1]], [blo[2], bhi[2]]] }, u: (p) => gl(p) ?? [0, 0, 0] }],
            loads: subLoads, errorEstimate: false, zoom: 0, nested: false };
        // only nodes on the box's cut faces are prescribed: wrap the region test
        // held nodes of the global model inside the box (supports, held wall contact) stay held at their global displacement
        const held = [];
        for (let n = 0; n < s.t.nNodes; n++)
            if (s.fixed[3 * n] || s.fixed[3 * n + 1] || s.fixed[3 * n + 2] || (s.heldFinal && s.heldFinal[n])) {
                const q = nodePosition(s.t, n);
                if (q[0] >= blo[0] - H && q[0] <= bhi[0] + H && q[1] >= blo[1] - H && q[1] <= bhi[1] + H && q[2] >= blo[2] - H && q[2] <= bhi[2] + H)
                    held.push(q);
            }
        const nearHeld = (p) => held.some((q) => Math.abs(q[0] - p[0]) <= 0.51 * H && Math.abs(q[1] - p[1]) <= 0.51 * H && Math.abs(q[2] - p[2]) <= 0.51 * H);
        const onCut = (p) => [0, 1, 2].some((a) => (Math.abs(p[a] - blo[a]) < 0.5 * hz && blo[a] > pb.min[a] + 1e-9) || (Math.abs(p[a] - bhi[a]) < 0.5 * hz && bhi[a] < pb.max[a] - 1e-9)) || nearHeld(p);
        sub.supports[0].filter = onCut;
        const zs = solveAt(sub, hz);
        if (!zs.u.length)
            continue;
        boxes++;
        {
            const m = Math.max(2 * hz, 2);
            zoomed.push([[blo[0] + m, blo[1] + m, blo[2] + m], [bhi[0] - m, bhi[1] - m, bhi[2] - m]]);
        }
        const ev = evaluate(sub, zs);
        if (ev.best.sf < Infinity && (!best || ev.best.sf < best.sf)) {
            best = { ...ev.best, component: ev.best.component + ` (zoom h=${hz.toFixed(3)})` };
            bestSub = sub;
            bestHz = hz;
        }
    }
    // error estimate for the zoomed peak: the same box at twice the zoom voxel
    let sfRel;
    if (best && bestSub && 2 * bestHz < H) {
        const z2 = solveAt({ ...bestSub, h: 2 * bestHz }, 2 * bestHz);
        if (z2.u.length) {
            const e2 = evaluate({ ...bestSub, h: 2 * bestHz }, z2);
            sfRel = Math.abs(e2.best.sf - best.sf) / best.sf;
        }
    }
    return { best, boxes, hz, sfRel, zoomed };
}
/** Write the strain-energy map as a coloured point cloud (PLY): blue = carries nothing, red = works hardest. */
export function energyMapPly(map) {
    const n = map.sed.length, logs = Array.from(map.sed, (v) => Math.log10(Math.max(v, 1e-30)));
    const sorted = [...logs].sort((a, b) => a - b), lo = sorted[Math.floor(0.02 * n)], hi = sorted[Math.floor(0.995 * n)];
    const lines = ["ply", "format ascii 1.0", `element vertex ${n}`, "property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", "property float sed", "end_header"];
    for (let k = 0; k < n; k++) {
        const t = Math.min(1, Math.max(0, (logs[k] - lo) / Math.max(1e-9, hi - lo)));
        const r = Math.round(255 * t), b = Math.round(255 * (1 - t)), g = Math.round(255 * (1 - Math.abs(2 * t - 1)));
        lines.push(`${map.centres[3 * k].toFixed(2)} ${map.centres[3 * k + 1].toFixed(2)} ${map.centres[3 * k + 2].toFixed(2)} ${r} ${g} ${b} ${map.sed[k].toExponential(3)}`);
    }
    return lines.join("\n") + "\n";
}
