import { section, loopArea, fitCircle } from "./bench/measure.js";
import { fitCylinder } from "./kernel/meshops.js";
const r3 = (x) => Math.round(x * 1000) / 1000;
function largestLoop(loops) {
    let best = null, a = -1;
    for (const l of loops) {
        const v = Math.abs(loopArea(l));
        if (v > a) {
            a = v;
            best = l;
        }
    }
    return best;
}
/**
 * Smooth a closed loop by averaging coordinates over +-k neighbours along it. Unbiased on flat sides
 * (averaging radii about the centroid instead pushes flat sides outward: measured +0.1 to +0.27 mm).
 */
function smoothLoop(l, k) {
    const n = l.length;
    return l.map((_, i) => {
        let sx = 0, sy = 0;
        for (let j = -k; j <= k; j++) {
            const q = l[(i + j + n) % n];
            sx += q[0];
            sy += q[1];
        }
        return [sx / (2 * k + 1), sy / (2 * k + 1)];
    });
}
function extents(l) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of l) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    }
    return { w: x1 - x0, d: y1 - y0 };
}
/** Section of the scanned object at height z (object Z up), measured over a band of +-band/2. */
export function sectionAt(mesh, z, o = {}) {
    const band = o.band ?? 1, n = o.slices ?? 5, k = o.smooth ?? 8;
    const ws = [], ds = [], cs = [];
    let area = 0, round = 0;
    for (let i = 0; i < n; i++) {
        const zi = z - band / 2 + (band * i) / (n - 1) + 0.00071;
        const l = largestLoop(section(mesh, 2, zi));
        if (!l)
            continue;
        const s = smoothLoop(l, k);
        const e = extents(s);
        ws.push(e.w);
        ds.push(e.d);
        const c = fitCircle(l);
        cs.push(c.d);
        round = Math.max(round, c.roundness);
        area += Math.abs(loopArea(l)) / n;
    }
    if (!ws.length)
        return null;
    const stat = (v) => {
        const m = v.reduce((a, b) => a + b, 0) / v.length;
        const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
        return { value: r3(m), plusMinus: r3(Math.max(0.02, 2 * sd)) };
    };
    const width = stat(ws), depth = stat(ds), cd = stat(cs);
    const isRound = Math.abs(width.value - depth.value) < 0.05 * width.value && round < 0.15 * cd.value;
    return { z, width, depth, area: r3(area), circle: isRound ? { d: cd, roundness: r3(round) } : undefined };
}
/** Best-fit cylinder to the scan's surface between two heights. */
export function fitCylinderZ(mesh, z0, z1) {
    const p = mesh.positions, pts = [];
    for (let i = 0; i < p.length; i += 3)
        if (p[i + 2] >= z0 && p[i + 2] <= z1)
            pts.push(p[i], p[i + 1], p[i + 2]);
    const f = fitCylinder(Float64Array.from(pts));
    return { diameter: { value: r3(2 * f.r), plusMinus: r3(Math.max(0.02, 2 * f.rms / Math.sqrt(pts.length / 3) + f.rms / 4)) }, axis: f.axis, point: f.point, rms: r3(f.rms), points: pts.length / 3 };
}
/** Section width (along x) at heights from z0 to z1. */
export function widthProfile(mesh, z0, z1, step = 1) {
    const out = [];
    for (let z = z0; z <= z1 + 1e-9; z += step) {
        const l = largestLoop(section(mesh, 2, z + 0.00071));
        if (l)
            out.push({ z, width: r3(extents(smoothLoop(l, 8)).w) });
    }
    return out;
}
/** Widest and narrowest (waist) widths over a height range, each re-measured over a band for its uncertainty. */
export function widestAndWaist(mesh, z0, z1) {
    const prof = widthProfile(mesh, z0, z1, 0.5);
    const wMax = prof.reduce((a, b) => (b.width > a.width ? b : a));
    const wMin = prof.reduce((a, b) => (b.width < a.width ? b : a));
    const a = sectionAt(mesh, wMax.z), b = sectionAt(mesh, wMin.z);
    return { widest: { z: wMax.z, width: a.width, depth: a.depth }, waist: { z: wMin.z, width: b.width, depth: b.depth } };
}
