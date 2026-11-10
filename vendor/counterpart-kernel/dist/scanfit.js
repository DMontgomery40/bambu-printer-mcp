/**
 * Features shaped from the scan (round 3), on the exact scan booleans (src/scanbool.ts).
 *
 *  - scanEnvelope: the volume a scanned object sweeps on its way into a pocket. Going in along a direction, every
 *    part of the object passes through every pocket height above where it ends up, so the pocket at height h must
 *    hold the union of the object's sections from its leading end up to h: the widest section it passes through on
 *    the way in. Sampled as a polar envelope (the farthest surface along each ray from the axis, so concave pockets
 *    in a section are filled, which only adds clearance; the receipt states how much), grown by the clearance and
 *    meshed as a closed ring stack.
 *  - scanPocket: cuts that envelope out of a body with the exact scan boolean (the body's faces away from the
 *    pocket are kept bit-for-bit) and states requirements the run measures on the final mesh: the seated scan
 *    clears the pocket everywhere by at least the clearance, and it can be withdrawn along its direction.
 *  - scanSizes: what a person would otherwise be asked for, read from the scan with its uncertainty: the widest
 *    section, the round fit over a span, and the scan's own uncertainty (stated source plus measured noise).
 *
 * Frame: the object's frame, Z up (the scan as it stands). Insertion directions are axis-aligned ("-z": dropped in
 * from above; "+y": slid in towards the wall at y = 0, the kernel's wall convention).
 */
import { Mesh, checkMesh } from "./kernel/mesh.js";
import { BVH } from "./kernel/bvh.js";
import { section } from "./bench/measure.js";
import { scanBoolean } from "./scanbool.js";
import { Solid, KernelError } from "./api.js";
import { FieldNode, AABB } from "./kernel/sdf.js";
import { exactMesh } from "./runner.js";
import { decideFit, SOURCE_UNCERTAINTY } from "./fit.js";
import { fitCylinderZ, sectionAt } from "./scan.js";
import { readFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { readSTL } from "./kernel/io.js";
import { RUN_CONTEXT } from "./runner.js";
const f3 = (v) => Number(v.toFixed(3));
/** Turn the object so that its insertion direction is -z (and back). Axis permutations only (exact). */
function frameFor(along) {
    switch (along) {
        case "-z": return { to: (p) => p, from: (p) => p, flips: false };
        case "+z": return { to: ([x, y, z]) => [x, -y, -z], from: ([x, y, z]) => [x, -y, -z], flips: false };
        case "+y": return { to: ([x, y, z]) => [x, z, -y], from: ([x, y, z]) => [x, -z, y], flips: false }; // moving +y becomes moving -z
        case "-y": return { to: ([x, y, z]) => [x, -z, y], from: ([x, y, z]) => [x, z, -y], flips: false };
        case "+x": return { to: ([x, y, z]) => [-z, y, x], from: ([x, y, z]) => [z, y, -x], flips: false };
        case "-x": return { to: ([x, y, z]) => [z, y, -x], from: ([x, y, z]) => [-z, y, x], flips: false };
    }
}
function mapMesh(m, f) {
    const p = m.positions, out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const q = f([p[i], p[i + 1], p[i + 2]]);
        out[i] = q[0];
        out[i + 1] = q[1];
        out[i + 2] = q[2];
    }
    return new Mesh(out, m.indices);
}
/**
 * The envelope a scan sweeps going in along `along`, from where its leading end rests (`seat`: that end's
 * coordinate along the insertion axis in the scan's frame; default: the scan's extreme) back out past the mouth
 * at `depth` (+ 1 mm overshoot), grown by `clearance` per side. Returned in the scan's frame.
 */
export function scanEnvelope(scan, o) {
    const t0 = performance.now();
    const along = o.along ?? "-z", F = frameFor(along);
    const m = mapMesh(scan, F.to);
    const b = m.bounds(), z0 = b.min[2]; // the leading end (it goes in first, -z)
    const rays = o.rays ?? 180, step = o.step ?? 0.5, c = o.clearance;
    const zTop = z0 + o.depth + 1;
    // the axis: centre of the widest section in the pocket's span
    const zs = [];
    for (let z = z0 + 0.05; z <= Math.min(z0 + o.depth, b.max[2] - 0.05) + 1e-9; z += step)
        zs.push(z);
    if (zs.length < 2)
        throw new KernelError(`scanEnvelope: a ${o.depth} mm pocket holds less than one section step of the scan`);
    const loopsAt = zs.map((z) => section(m, 2, z + 0.00073));
    let cx = 0, cy = 0;
    if (o.center)
        [cx, cy] = o.center;
    else {
        let best = -1;
        loopsAt.forEach((ls) => ls.forEach((l) => { let a = 0, sx = 0, sy = 0; for (let i = 0; i < l.length; i++) {
            const p = l[i], q = l[(i + 1) % l.length], cr = p[0] * q[1] - q[0] * p[1];
            a += cr;
            sx += (p[0] + q[0]) * cr;
            sy += (p[1] + q[1]) * cr;
        } if (Math.abs(a) > best) {
            best = Math.abs(a);
            cx = sx / (3 * a);
            cy = sy / (3 * a);
        } }));
    }
    // polar radius per ray at each height: the farthest crossing of any loop (concavities filled)
    const R = zs.map((_, k) => {
        const r = new Float64Array(rays);
        for (const l of loopsAt[k])
            for (let i = 0; i < l.length; i++) {
                const p = l[i], q = l[(i + 1) % l.length];
                const ap = Math.atan2(p[1] - cy, p[0] - cx), aq = Math.atan2(q[1] - cy, q[0] - cx);
                let da = aq - ap;
                if (da > Math.PI)
                    da -= 2 * Math.PI;
                if (da < -Math.PI)
                    da += 2 * Math.PI;
                const n = Math.max(1, Math.ceil((Math.abs(da) / (2 * Math.PI)) * rays) + 1);
                for (let s = 0; s <= n; s++) {
                    const t = s / n, x = p[0] + t * (q[0] - p[0]) - cx, y = p[1] + t * (q[1] - p[1]) - cy;
                    const j = ((Math.round((Math.atan2(y, x) / (2 * Math.PI)) * rays) % rays) + rays) % rays;
                    r[j] = Math.max(r[j], Math.hypot(x, y));
                }
            }
        // gaps between samples: carry the neighbours' max (a ray no segment reached keeps the larger neighbour)
        for (let j = 0; j < rays; j++)
            if (r[j] === 0)
                r[j] = Math.max(r[(j + rays - 1) % rays], r[(j + 1) % rays]);
        return r;
    });
    // every scan vertex in each band between two section heights counts too (a bulge between sections, a flat base
    // fanned from a pole): band k is [zs[k-1], zs[k]], and each ring takes the max of the bands either side of it
    const band = zs.map(() => new Float64Array(rays));
    {
        const p = m.positions;
        for (let i = 0; i < p.length; i += 3) {
            const z = p[i + 2];
            if (z < z0 - 1e-9 || z > zs[zs.length - 1] + step)
                continue;
            const k = Math.min(zs.length - 1, Math.max(0, Math.ceil((z - zs[0]) / step)));
            const x = p[i] - cx, y = p[i + 1] - cy, j = ((Math.round((Math.atan2(y, x) / (2 * Math.PI)) * rays) % rays) + rays) % rays;
            const rr = Math.hypot(x, y);
            if (rr > band[k][j])
                band[k][j] = rr;
            // a vertex between two rays also bounds its neighbours' faces: spread to them at the chord's depth
            const jn = (j + 1) % rays, jp = (j + rays - 1) % rays, cs = Math.cos((2 * Math.PI) / rays);
            if (rr * cs > band[k][jn])
                band[k][jn] = rr * cs;
            if (rr * cs > band[k][jp])
                band[k][jp] = rr * cs;
        }
    }
    // concavity filled (the polar envelope of each section against the section's true area), worst height
    let filled = { mm2: 0, pct: 0, at: 0 };
    R.forEach((r, k) => {
        let ap = 0;
        for (let j = 0; j < rays; j++)
            ap += 0.5 * r[j] * r[(j + 1) % rays] * Math.sin((2 * Math.PI) / rays);
        let at = 0;
        for (const l of loopsAt[k]) {
            let a = 0;
            for (let i = 0; i < l.length; i++) {
                const p = l[i], q = l[(i + 1) % l.length];
                a += p[0] * q[1] - q[0] * p[1];
            }
            at += Math.abs(a / 2);
        }
        if (at > 1 && ap - at > filled.mm2)
            filled = { mm2: f3(ap - at), pct: f3((100 * (ap - at)) / at), at: f3(zs[k] - z0) };
    });
    R.forEach((r, k) => { for (let j = 0; j < rays; j++)
        r[j] = Math.max(r[j], band[k][j], k + 1 < band.length ? band[k + 1][j] : 0); });
    // cumulative: the pocket at height h holds every section below h (they all passed through it)
    const E = R.map((r) => r.slice());
    for (let k = 1; k < E.length; k++)
        for (let j = 0; j < rays; j++)
            E[k][j] = Math.max(E[k][j], E[k - 1][j]);
    // widest and mouth sizes (across x and y of the insertion frame)
    const ext = (r) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let j = 0; j < rays; j++) {
        const a = (2 * Math.PI * j) / rays, x = r[j] * Math.cos(a), y = r[j] * Math.sin(a);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    } return { w: f3(x1 - x0), d: f3(y1 - y0) }; };
    let wk = 0, wa = -1;
    R.forEach((r, k) => { const e = ext(r); if (e.w * e.d > wa) {
        wa = e.w * e.d;
        wk = k;
    } });
    // the object comes to rest on the floor, c below its scanned leading end, and a scan's leading end is itself only
    // known to about half its +-: so it may sink by up to c + u/2 from where the scan puts it. Its wider sections then
    // pass lower: each ring also holds the sections up to that far above it (found by the round 3 benchmark: a noisy
    // scan's back face put a front-entry pocket's true object 0.49 mm into its back corners)
    const sink = Math.max(0, Math.ceil(((o.sink ?? c) - 1e-9) / step));
    if (sink) {
        const S = E.map((_, k) => E[Math.min(E.length - 1, k + sink)].slice());
        for (let k = 0; k < E.length; k++)
            E[k] = S[k];
    }
    // grow by the clearance in 3D, not just along each ray: a ring takes its neighbours within c in height (a ball's
    // section, so a domed or sloping base keeps its clearance too), and along the outline the offset is taken normal to
    // it (c x sqrt(r^2 + r'^2) / r, capped at 3c, so a steep flank, like a waist seen from the front, keeps it as well)
    const dth = (2 * Math.PI) / rays;
    const G = E.map((_, k) => {
        const g = new Float64Array(rays);
        for (let j = 0; j < rays; j++) {
            let best = 0;
            for (let kk = Math.max(0, k - 3); kk <= Math.min(E.length - 1, k + 3); kk++) {
                const dz = Math.abs(zs[kk] - zs[k]);
                if (dz > c)
                    continue;
                const r = E[kk][j], rp = (E[kk][(j + 1) % rays] - E[kk][(j + rays - 1) % rays]) / (2 * dth);
                const fac = Math.min(3, Math.sqrt(r * r + rp * rp) / Math.max(r, 1e-6));
                best = Math.max(best, r + Math.sqrt(c * c - dz * dz) * fac);
            }
            g[j] = best;
        }
        return g;
    });
    // rings: the floor (c below the leading end, as wide as the first ring), each height, then straight out past the mouth
    const rings = [{ z: z0 - c, r: G[0] }];
    G.forEach((r, k) => rings.push({ z: zs[k], r }));
    rings.push({ z: zTop, r: G[G.length - 1] });
    const pos = [], idx = [];
    for (const ring of rings)
        for (let j = 0; j < rays; j++) {
            const a = (2 * Math.PI * j) / rays, rr = ring.r[j];
            pos.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a), ring.z);
        }
    const nR = rings.length;
    for (let k = 0; k + 1 < nR; k++)
        for (let j = 0; j < rays; j++) {
            const a = k * rays + j, bq = k * rays + ((j + 1) % rays), cq = (k + 1) * rays + j, d = (k + 1) * rays + ((j + 1) % rays);
            idx.push(a, bq, d, a, d, cq);
        }
    const cb = pos.length / 3;
    pos.push(cx, cy, rings[0].z);
    const ct = pos.length / 3;
    pos.push(cx, cy, zTop);
    for (let j = 0; j < rays; j++) {
        const jn = (j + 1) % rays;
        idx.push(cb, jn, j);
        idx.push(ct, (nR - 1) * rays + j, (nR - 1) * rays + jn);
    }
    let env = new Mesh(Float64Array.from(pos), Uint32Array.from(idx));
    env = mapMesh(env, F.from);
    const report = { along, depth: o.depth, clearance: c, rings: nR, rays, widest: { at: f3(zs[wk] - z0), ...ext(R[wk]) }, mouth: ext(E[E.length - 1]), filled, ms: performance.now() - t0 };
    return { mesh: env, report };
}
/** What the scan says about the object, with uncertainty: the person is never asked for these. */
export function scanSizes(scan, o = {}) {
    const b = scan.bounds();
    const z0 = o.z0 ?? b.min[2] + 0.1 * (b.max[2] - b.min[2]), z1 = o.z1 ?? b.max[2] - 0.1 * (b.max[2] - b.min[2]);
    const base = typeof o.source === "number" ? o.source : SOURCE_UNCERTAINTY.scan;
    const cyl = fitCylinderZ(scan, z0, z1);
    const mid = sectionAt(scan, (z0 + z1) / 2);
    // the scan's stated uncertainty plus its own measured spread (noise, taper over the span)
    const u = (pm) => f3(Math.sqrt(base * base + pm * pm));
    return {
        height: f3(b.max[2] - b.min[2]),
        round: { d: cyl.diameter.value, plusMinus: u(cyl.diameter.plusMinus), rms: cyl.rms, span: [f3(z0), f3(z1)] },
        section: mid ? { at: f3(mid.z), w: mid.width.value, d: mid.depth.value, plusMinus: u(Math.max(mid.width.plusMinus, mid.depth.plusMinus)) } : null,
        source: typeof o.source === "number" ? `+-${o.source}` : "scan (+-0.5 for a phone LiDAR scan)",
    };
}
/** A solid that is a finished mesh (the scan boolean's output): the runner uses the mesh as is. */
export class MeshSolid extends Solid {
    premeshed;
    constructor(premeshed, label, checks = []) {
        const bvh = new BVH(premeshed), bb = premeshed.bounds();
        super(new FieldNode((x, y, z) => bvh.signedDistance(x, y, z, 5), new AABB(bb.min[0] - 1, bb.min[1] - 1, bb.min[2] - 1, bb.max[0] + 1, bb.max[1] + 1, bb.max[2] + 1), 0.5), label, null, "a finished mesh from the scan boolean (scanPocket): make it the last operation", checks);
        this.premeshed = premeshed;
    }
    require(...reqs) { return new MeshSolid(this.premeshed, this.label, [...this.checks, ...reqs]); }
    move(x, y = 0, z = 0) { const p = this.premeshed.positions.slice(); for (let i = 0; i < p.length; i += 3) {
        p[i] += x;
        p[i + 1] += y;
        p[i + 2] += z;
    } return new MeshSolid(new Mesh(p, this.premeshed.indices), this.label, this.checks.map((c) => (c.moved ? c.moved(x, y, z) : c))); }
}
/**
 * Cut the pocket a scanned object needs out of `body`: the object (the scan, placed by `at`: where its leading end's
 * centre goes) goes in along `along` to `depth`; the clearance comes from the fit's function and the scan's
 * uncertainty. Returns a finished solid (the exact scan boolean's mesh) with requirements the run measures.
 */
export function scanPocket(body, scan, o) {
    const along = o.along ?? "-z";
    const name = o.name ?? "scan pocket";
    const sizes = scanSizes(scan);
    // the function's own fit (as if measured exactly), then the scan's uncertainty on top: a pocket shaped from the
    // scan can always be cut looser, so a +-0.5 scan widens it (and says how much it may rattle) instead of refusing
    const fit = o.fit ?? { function: "drops-in", measured: "scan" };
    const m = fit.measured ?? "scan", uScan = typeof m === "number" ? Math.abs(m) : SOURCE_UNCERTAINTY[m];
    const base = decideFit({ ...fit, measured: "designed" }, { id: `${name}`, feature: name, what: "the scanned object", size: sizes.round.d, shape: "flat", inferred: "drops-in", question: "how should the scanned object sit in its pocket?" });
    const c = f3(base.modelled_per_side + uScan / 2);
    const rec = { ...base, object: { ...base.object, uncertainty: uScan, source: typeof m === "number" ? `+-${m}` : m }, modelled_per_side: c,
        reasoning: `${base.reasoning}; plus half the scan's +-${uScan} per side (${f3(uScan / 2)}), so the largest the object can be still drops in: modelled ${c} per side, and the smallest may move up to ${f3(2 * c)} mm` };
    // place the scan: its leading end's centre at `at`
    const F = frameFor(along), mb = mapMesh(scan, F.to).bounds();
    const lead = F.from([(mb.min[0] + mb.max[0]) / 2, (mb.min[1] + mb.max[1]) / 2, mb.min[2]]);
    const placed = mapMesh(scan, ([x, y, z]) => [x - lead[0] + o.at[0], y - lead[1] + o.at[1], z - lead[2] + o.at[2]]);
    const t0 = performance.now();
    const env = scanEnvelope(placed, { along, depth: o.depth, clearance: c, sink: c + uScan / 2 });
    if (!body.poly)
        throw new KernelError("scanPocket: the body must have an exact form (boxes, extrusions, revolves and their booleans), not a blend or shell");
    const bodyMesh = exactMesh(body.poly());
    const r = scanBoolean(bodyMesh, env.mesh, "subtract");
    const ck = checkMesh(r.mesh);
    if (!ck.closed || !ck.manifold)
        throw new KernelError(`scanPocket: the cut is not closed and manifold (${ck.boundaryEdges} open edges); move the pocket so it does not graze the body's faces`);
    const ms = performance.now() - t0;
    // requirements measured on the final mesh: clearance from the seated scan, and withdrawal along the direction
    const dir = { "-z": [0, 0, -1], "+z": [0, 0, 1], "-y": [0, -1, 0], "+y": [0, 1, 0], "-x": [-1, 0, 0], "+x": [1, 0, 0] }[along];
    const sample = (step) => { const p = placed.positions, out = []; for (let i = 0; i < p.length; i += 3 * step)
        out.push([p[i], p[i + 1], p[i + 2]]); return out; };
    const pts = sample(Math.max(1, Math.floor(placed.vertexCount / 6000)));
    const clearReq = { name: `${name}: the seated scan clears the pocket by at least ${f3(c)} mm everywhere (fit ${rec.function}, ${rec.object.source})`, run: (mesh) => {
            // the object sits in air: each scan point's signed distance to the part is its clearance (negative = inside the part)
            const bvh = new BVH(mesh);
            let min = Infinity, at = [0, 0, 0];
            for (const p of pts) {
                const d = bvh.signedDistance(p[0], p[1], p[2], 3 * c + 3);
                if (d < min) {
                    min = d;
                    at = p;
                }
            }
            return { name: clearReq.name, pass: min >= 0.9 * c - 1e-6, measured: `${f3(min)} mm at (${at.map(f3).join(", ")})`, expected: `>= ${f3(0.9 * c)} mm (the clearance less 10% for sampling the envelope's rays)`, fix: min < 0.9 * c ? "the envelope's rays are too coarse for this shape: ask for rays: 360" : undefined };
        } };
    const outReq = { name: `${name}: lifts out along ${along === "-z" ? "+z" : along.startsWith("+") ? "-" + along[1] : "+" + along[1]} without touching`, run: (mesh) => {
            const bvh = new BVH(mesh);
            let worst = Infinity;
            for (let k = 1; k <= 8; k++) {
                const s = (k / 8) * (o.depth + 2);
                for (const p of pts) {
                    const d = bvh.signedDistance(p[0] - dir[0] * s, p[1] - dir[1] * s, p[2] - dir[2] * s, 2 * c + 2);
                    if (d < worst)
                        worst = d;
                }
            }
            return { name: outReq.name, pass: worst >= -1e-6, measured: `smallest gap on the way out ${f3(worst)} mm`, expected: ">= 0" };
        } };
    const info = { name: `${name}: shaped from the scan`, run: () => ({ name: `${name}: shaped from the scan`, pass: true, measured: `widest section on the way in ${env.report.widest.w} x ${env.report.widest.d} at ${env.report.widest.at} mm, mouth ${env.report.mouth.w} x ${env.report.mouth.d}; concavity filled ${env.report.filled.pct}%; clearance ${f3(c)} per side (${rec.reasoning}); envelope ${env.report.ms.toFixed(0)} ms, exact scan boolean ${r.stats.ms.toFixed(0)} ms (${ms.toFixed(0)} ms in all)`, expected: "the object goes in along its direction and sits with its clearance" }) };
    const fitRec = { name: `fit: ${name}`, record: { ...rec, scan: sizes, envelope: env.report }, run: () => ({ name: `fit: ${name}`, pass: true, measured: rec.reasoning }) };
    return new MeshSolid(r.mesh, name, [...body.checks, info, clearReq, outReq, fitRec]);
}
/**
 * A mesh the script was given (a scan): by its name. In the sandbox (and behind the printer MCP) only declared inputs
 * can be read, by the name they were declared under; on the command line, a file beside the script.
 */
export function loadMesh(name) {
    let declared = {};
    try {
        declared = JSON.parse(process.env.CP_SANDBOX_INPUTS ?? "{}");
    }
    catch {
        declared = {};
    }
    const file = declared[name] ?? (isAbsolute(name) ? name : join(RUN_CONTEXT.scriptDir ?? process.cwd(), name));
    let bytes;
    try {
        bytes = readFileSync(file);
    }
    catch (e) {
        throw new KernelError(`loadMesh: no input named "${name}"${Object.keys(declared).length ? ` (declared: ${Object.keys(declared).join(", ")})` : ""}: ${e.message.split("\n")[0]}`);
    }
    const m = readSTL(bytes);
    const c = checkMesh(m);
    if (!c.closed || !c.manifold)
        throw new KernelError(`loadMesh: "${name}" is not closed and manifold (${c.boundaryEdges} open edges): repair the scan first`);
    return m;
}
void dirname;
