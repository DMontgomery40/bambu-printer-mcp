/**
 * Requirements a part script states and the run proves on the finished mesh: each returns pass/fail,
 * the measured value, where it was measured and, on failure, what to change. Intent-level features
 * (holder, pocket, screws, box, lid, clamp) attach their own requirements automatically.
 *
 * Printability is judged for the filament printer this kernel serves: Z up is the print orientation,
 * the lowest face is the bed. Overhang angles are measured from vertical (0 = vertical wall,
 * 90 = horizontal underside), as in the MCP's FDM guidance.
 */
import { axisOf, pt } from "./xform.js";
import { BVH } from "./kernel/bvh.js";
import { section, loopAround, outerLoopAround, loopBounds, fitCircle, thicknessAlong, gapAlong, rayCrossings } from "./bench/measure.js";
const f3 = (v) => (Math.abs(v) < 1e-9 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""));
const at = (p) => `(${p.map(f3).join(", ")})`;
const AX = ["x", "y", "z"];
export function sectionFits(o) {
    const tol = o.tol ?? 0.05;
    return {
        moved: (x, y, z) => sectionFits({ ...o, z: o.z + z, around: [o.around[0] + x, o.around[1] + y] }),
        // a horizontal section stays one only if z maps to z
        mapped: (X) => { if (!X.axes || X.axes[2].to !== 2)
            return null; const p = pt(X, [o.around[0], o.around[1], o.z]); const swap = X.axes[0].to === 1; return sectionFits({ ...o, z: p[2], around: [p[0], p[1]], size: swap ? [o.size[1], o.size[0]] : o.size }); },
        name: o.name ?? `${o.what ?? "cavity"} section ${f3(o.size[0])} x ${f3(o.size[1])} at z=${f3(o.z)}`,
        run(mesh) {
            const loops = section(mesh, 2, o.z + 0.0013);
            const l = o.outer ? outerLoopAround(loops, o.around[0], o.around[1]) : loopAround(loops, o.around[0], o.around[1]);
            if (!l)
                return { name: this.name, pass: false, measured: null, where: `z=${f3(o.z)} around ${at(o.around)}`, fix: `no closed ${o.what ?? "cavity"} outline at that height: something cuts it open there or it is not where the script put it` };
            const b = loopBounds(l);
            const ok = Math.abs(b.w - o.size[0]) <= tol && Math.abs(b.h - o.size[1]) <= tol;
            return { name: this.name, pass: ok, measured: `${f3(b.w)} x ${f3(b.h)}`, expected: `${f3(o.size[0])} x ${f3(o.size[1])} ±${tol}`, where: `z=${f3(o.z)}`,
                fix: ok ? undefined : `section is ${f3(b.w - o.size[0])} / ${f3(b.h - o.size[1])} mm off in x / y: check the clearance and that no other feature overlaps the ${o.what ?? "cavity"}` };
        },
    };
}
/** A round hole along an axis through a point must have diameter d (within tol). */
export function holeIs(o) {
    const tol = o.tol ?? 0.05;
    const ax = AX.indexOf(o.axis);
    return {
        moved: (x, y, z) => holeIs({ ...o, at: [o.at[0] + x, o.at[1] + y, o.at[2] + z] }),
        mapped: (X) => { const a = axisOf(X, o.axis); return a ? holeIs({ ...o, at: pt(X, o.at), axis: a }) : null; },
        name: o.name ?? `hole d${f3(o.d)} along ${o.axis} at ${at(o.at)}`,
        run(mesh) {
            const u = ax === 0 ? o.at[1] : o.at[0], v = ax === 2 ? o.at[1] : o.at[2];
            const l = loopAround(section(mesh, ax, o.at[ax] + 0.0013), u, v);
            if (!l)
                return { name: this.name, pass: false, measured: null, where: at(o.at), fix: "no hole outline found there: the hole is missing, open to an edge, or placed elsewhere" };
            const c = fitCircle(l);
            const ok = Math.abs(c.d - o.d) <= tol;
            return { name: this.name, pass: ok, measured: f3(c.d), expected: `${f3(o.d)} ±${tol}`, where: at(o.at), fix: ok ? undefined : `hole measures ${f3(c.d)}: something else cuts into it or it is not round` };
        },
    };
}
/** Material thickness along an axis through a point (a wall, floor or plate). */
export function thicknessIs(o) {
    const tol = o.tol ?? 0.05;
    const ax = AX.indexOf(o.axis);
    return {
        moved: (x, y, z) => thicknessIs({ ...o, at: [o.at[0] + x, o.at[1] + y, o.at[2] + z] }),
        mapped: (X) => { const a = axisOf(X, o.axis); return a ? thicknessIs({ ...o, at: pt(X, o.at), axis: a }) : null; },
        name: o.name,
        run(mesh) {
            const u = ax === 0 ? o.at[1] : o.at[0], v = ax === 2 ? o.at[1] : o.at[2];
            const t = thicknessAlong(mesh, ax, u + 0.0011, v + 0.0013, o.at[ax]);
            if (t === null)
                return { name: o.name, pass: false, measured: null, where: at(o.at), fix: "no material there" };
            const ok = o.min ? t >= o.t - tol : Math.abs(t - o.t) <= tol;
            return { name: o.name, pass: ok, measured: f3(t), expected: o.min ? `>= ${f3(o.t)}` : `${f3(o.t)} ±${tol}`, where: at(o.at), fix: ok ? undefined : `measured ${f3(t)} mm` };
        },
    };
}
/** An empty gap along an axis through a point (a slot width, a split, a clearance). */
export function gapIs(o) {
    const tol = o.tol ?? 0.05;
    const ax = AX.indexOf(o.axis);
    return {
        moved: (x, y, z) => gapIs({ ...o, at: [o.at[0] + x, o.at[1] + y, o.at[2] + z] }),
        mapped: (X) => { const a = axisOf(X, o.axis); return a ? gapIs({ ...o, at: pt(X, o.at), axis: a }) : null; },
        name: o.name,
        run(mesh) {
            const u = ax === 0 ? o.at[1] : o.at[0], v = ax === 2 ? o.at[1] : o.at[2];
            const g = gapAlong(mesh, ax, u + 0.0011, v + 0.0013, o.at[ax]);
            if (g === null)
                return { name: o.name, pass: false, measured: null, where: at(o.at), fix: "no opening there" };
            const ok = Math.abs(g - o.w) <= tol;
            return { name: o.name, pass: ok, measured: f3(g), expected: `${f3(o.w)} ±${tol}`, where: at(o.at), fix: ok ? undefined : `opening measures ${f3(g)} mm` };
        },
    };
}
/** Thinnest wall anywhere: rays from triangle centres inwards along -normal. */
export function minWall(t) {
    return {
        name: `every wall at least ${f3(t)} mm`,
        run(mesh) {
            const r = wallScan(mesh);
            const ok = r.min >= t - 0.02;
            return { name: this.name, pass: ok, measured: f3(r.min), expected: `>= ${f3(t)}`, where: at(r.where), fix: ok ? undefined : `thinnest wall ${f3(r.min)} mm at ${at(r.where)}: thicken it or move the feature that thins it` };
        },
    };
}
export function wallScan(mesh, maxSamples = 6000) {
    const p = mesh.positions, idx = mesh.indices, nt = idx.length / 3;
    const bvh = new BVH(mesh);
    const step = Math.max(1, Math.floor(nt / maxSamples));
    let best = Infinity, where = [0, 0, 0];
    for (let t = 0; t < nt; t += step) {
        const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-12)
            continue;
        nx /= l;
        ny /= l;
        nz /= l;
        const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
        // thickness = distance to the opposite surface along -n (BVH ray cast)
        const hit = bvh.rayHit(cx - nx * 1e-4, cy - ny * 1e-4, cz - nz * 1e-4, -nx, -ny, -nz);
        if (hit !== null && hit < best && hit > 0.01) {
            best = hit;
            where = [cx, cy, cz];
        }
    }
    return { min: best, where };
}
function rayHit(_bvh, mesh, ox, oy, oz, dx, dy, dz) {
    // brute force over triangles in the ray's neighbourhood (meshes here are small after decimation)
    const p = mesh.positions, idx = mesh.indices;
    let best = null;
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
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
        if (dist > 1e-6 && (best === null || dist < best))
            best = dist;
    }
    return best;
}
/**
 * Overhang / bridge / base analysis in print orientation (Z up). Downward faces steeper than maxOverhang
 * from vertical that are not on the bed are grouped into regions; a near-horizontal region is a bridge
 * if both ends are anchored, reported with its span (shortest side of its footprint).
 */
export function printability(mesh, o = {}) {
    const maxOv = o.maxOverhang ?? 45, p = mesh.positions, idx = mesh.indices, nt = idx.length / 3;
    const b = mesh.bounds();
    const zmin = b.min[2];
    let base = 0;
    const bad = [];
    const ang = new Float64Array(nt), area = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
        const a = idx[3 * t] * 3, bb = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
        const ux = p[bb] - p[a], uy = p[bb + 1] - p[a + 1], uz = p[bb + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l === 0)
            continue;
        area[t] = l / 2;
        const zc = (p[a + 2] + p[bb + 2] + p[c + 2]) / 3;
        const nzn = nz / l;
        if (nzn < -0.999 && zc - zmin < 0.05) {
            base += l / 2;
            continue;
        }
        if (nzn >= 0)
            continue;
        const deg = Math.asin(Math.min(1, -nzn)) * 180 / Math.PI; // 0 = vertical wall, 90 = horizontal underside
        ang[t] = deg;
        if (deg > maxOv + 0.5)
            bad.push(t);
    }
    // group bad faces into regions by shared vertices
    const nv = p.length / 3, par = new Int32Array(nv).map((_, i) => i);
    const find = (x) => { while (par[x] !== x) {
        par[x] = par[par[x]];
        x = par[x];
    } return x; };
    for (const t of bad) {
        const a = find(idx[3 * t]), bb = find(idx[3 * t + 1]), c = find(idx[3 * t + 2]);
        par[a] = bb;
        par[find(c)] = find(bb);
    }
    const regions = new Map();
    for (const t of bad) {
        const r = find(idx[3 * t]);
        if (!regions.has(r))
            regions.set(r, []);
        regions.get(r).push(t);
    }
    const out = [];
    let worst = 0, longestBridge = 0;
    for (const ts of regions.values()) {
        let A = 0, wa = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0, cz = 0;
        for (const t of ts) {
            A += area[t];
            wa = Math.max(wa, ang[t]);
            for (let k = 0; k < 3; k++) {
                const v = idx[3 * t + k] * 3;
                x0 = Math.min(x0, p[v]);
                x1 = Math.max(x1, p[v]);
                y0 = Math.min(y0, p[v + 1]);
                y1 = Math.max(y1, p[v + 1]);
                cx += p[v] * area[t];
                cy += p[v + 1] * area[t];
                cz += p[v + 2] * area[t];
            }
        }
        if (A < 0.5)
            continue; // ignore specks
        cx /= 3 * A;
        cy /= 3 * A;
        cz /= 3 * A;
        const span = Math.min(x1 - x0, y1 - y0);
        // near-horizontal undersides are bridges; so are narrow strips (<= 6 mm across: the top of a horizontal
        // hole up to about 8 mm, which FDM printers span from both sides without support)
        const kind = wa > 85 || span <= 6 ? "bridge" : "overhang";
        if (kind === "bridge")
            longestBridge = Math.max(longestBridge, span);
        worst = Math.max(worst, wa);
        out.push({ angle_deg: Math.round(wa), area_mm2: Math.round(A * 10) / 10, where: `around (${f3(cx)}, ${f3(cy)}, ${f3(cz)})${kind === "bridge" ? `, span ${f3(span)} mm` : ""}`, kind });
    }
    out.sort((u, v) => v.area_mm2 - u.area_mm2);
    const vol = mesh.volume(), surf = mesh.area();
    const density = o.density ?? 1.24; // PLA g/cm3
    // rough print time: 2 perimeters of 0.42 x 0.2 mm on all surface, 15% infill of the rest, 12 mm3/s, 2 s per layer
    const shell = Math.min(vol, surf * 0.84);
    const printed = shell + 0.15 * Math.max(0, vol - shell);
    const layers = (b.max[2] - b.min[2]) / 0.2;
    const mw = wallScan(mesh, 1500);
    return {
        base_area_mm2: Math.round(base), min_wall_mm: Math.round(mw.min * 1000) / 1000, min_wall_where: at(mw.where), overhangs: out.slice(0, 8), worst_overhang_deg: Math.round(worst),
        longest_bridge_mm: Math.round(longestBridge * 10) / 10,
        supports_needed: out.some((r) => r.kind === "overhang") || longestBridge > (o.maxBridge ?? 30),
        mass_g: Math.round((printed / 1000) * density * 10) / 10,
        print_time_min_estimate: Math.round((printed / 12 + layers * 2) / 60),
    };
}
/** Requirement form of the printability analysis. */
export function printable(o = {}) {
    return {
        name: `prints Z-up without supports (overhang <= ${o.maxOverhang ?? 45} deg, bridges <= ${o.maxBridge ?? 30} mm${o.flatBase ? `, base >= ${o.flatBase} mm2` : ""})`,
        run(mesh) {
            const r = printability(mesh, o);
            const ov = r.overhangs.filter((x) => x.kind === "overhang");
            const br = r.overhangs.filter((x) => x.kind === "bridge" && Number((x.where.match(/span ([\d.]+)/) ?? [])[1]) > (o.maxBridge ?? 30));
            const baseOk = !o.flatBase || r.base_area_mm2 >= o.flatBase;
            const ok = ov.length === 0 && br.length === 0 && baseOk;
            const first = ov[0] ?? br[0];
            return { name: this.name, pass: ok, measured: ok ? `worst ${r.worst_overhang_deg} deg, longest bridge ${r.longest_bridge_mm} mm, base ${r.base_area_mm2} mm2` : first ? `${first.kind} ${first.angle_deg} deg, ${first.area_mm2} mm2 ${first.where}` : `base ${r.base_area_mm2} mm2`,
                where: first?.where,
                fix: ok ? undefined : first ? (first.kind === "overhang" ? "chamfer that downward edge at 45 deg, or turn the part so the face points up" : "shorten the bridge, add a support rib, or reorient") : "put a flat face on the bed" };
        },
    };
}
void rayCrossings;
