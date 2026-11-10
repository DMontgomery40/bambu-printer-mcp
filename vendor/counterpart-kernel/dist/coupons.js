/**
 * Test coupons that turn derived numbers into observed ones on the owner's printer, read at a glance or
 * with a press (no calipers). Each is marked with bumps or notches (count them; no small text), prints
 * without supports, and names the stored value its outcome corrects (prints/2026-11-10-second-plate/KEY.md).
 */
import { box, cylinder, cone, rect, circle, path, KernelError } from "./api.js";
import { gapIs, holeIs } from "./checks.js";
import { derived } from "./family.js";
import { strainLadder, beamStrain } from "./compliant.js";
const f3 = (v) => Number(v.toFixed(3));
function need(c, m) { if (!c)
    throw new KernelError(m); }
/** k round bumps in a row along x starting at (x, y), on the bed, height h: a count you can feel and see. */
export function bumps(k, x, y, h = 1.2, d = 1.4, pitch = 2.2) {
    // five is a bar (4 mm), so 8 reads as a bar and three bumps and stays within 9 mm
    const out = [];
    let x1 = x;
    if (k >= 5) {
        out.push(box({ x: [x, x + 4], y: [y - d / 2, y + d / 2], z: [0, h] }));
        x1 = x + 4 + pitch - d / 2;
        k -= 5;
    }
    for (let i = 0; i < k; i++)
        out.push(cylinder({ d, x: x1 + i * pitch, y, z: [0, h] }));
    return out;
}
/** k notches cut into a top rim along x: each 1.2 wide, 1.5 deep. */
export function notches(k, x, y0, y1, zTop, pitch = 3) {
    return Array.from({ length: k }, (_, i) => box({ x: [x + i * pitch - 0.6, x + i * pitch + 0.6], y: [y0, y1], z: [zTop - 1.5, zTop + 1] }));
}
/** XY strain ladder (C1, in the print plane), re-exported with the plate's numbers. */
export function ladderXY(strains, at) { return strainLadder({ strains, l: 14, h: 2.0, b: 6, at }); }
/**
 * Z strain ladder (C1, standing): the same tapered arms built upright, so the bending strain runs across the
 * layers (rule 2's bad case, on purpose): the stepped strain at which these crack is the across-layer limit.
 */
export function ladderZ(strains, at, o = {}) {
    const l = o.l ?? 14, h0 = o.h ?? 2.0, b = o.b ?? 6, [x0, y0] = at, base = 3, pitch = 9;
    const n = strains.length, W = n * pitch + 6;
    const travel = strains.map((e) => f3((1.09 * e * l * l) / h0));
    let s = box({ x: [x0, x0 + W], y: [y0, y0 + b + 6], z: [0, base] });
    const parts = [];
    strains.forEach((_, k) => {
        const ax = x0 + 4 + k * pitch;
        // tapered arm in the x-z plane, b deep in y: h0 at the root (z = base) to h0/2 at the tip
        parts.push(path().moveTo(ax - h0 / 2, base - 0.01).lineTo(ax + h0 / 2, base - 0.01).lineTo(ax + h0 / 4, base + l).lineTo(ax - h0 / 4, base + l).close().extrude({ y: [y0 + 1, y0 + 1 + b] }));
        // stop: a stout post (3 mm) beside the tip at the travel, in +x
        const sx = ax + h0 / 4 + travel[k];
        parts.push(box({ x: [sx, sx + 3], y: [y0 + 1, y0 + 1 + b], z: [base - 0.01, base + l + 1] }));
        parts.push(...bumps(k + 1, ax - 2, y0 + b + 3.5, base + 1.0, 1.2, 1.5));
    });
    s = s.add(...parts);
    return { solid: s, travel };
}
/** A round test pin of a known printed size, standing, with k notches on its top rim. */
export function testPin(d, len, k, at) {
    const [x, y] = at;
    let s = circle({ d, center: [x, y] }).extrude({ z: [0, len], top: { chamfer: 0.8 }, });
    s = s.cut(...Array.from({ length: k }, (_, i) => { const a = (i * 2 * Math.PI) / 8; const cx = x + (d / 2) * Math.cos(a), cy = y + (d / 2) * Math.sin(a); return cylinder({ d: 2, x: cx, y: cy, z: [len - 3, len + 1] }); }));
    return s.require(derived(`test pin d${d}, ${k} notch${k > 1 ? "es" : ""}`, true, `${d}`, "printed standing: its outside is the known size"));
}
/**
 * Crush-rib bore for an assemble-once fit (function "presses"): the bore clears the largest size; half-round
 * ribs reach `interference` per side inside the smallest size and crush when the pin is pressed in.
 */
export function ribBore(o) {
    const [cx, cy] = o.at ?? [0, 0], u = o.u ?? 0.05, n = o.ribs ?? 6, wall = o.wall ?? 3;
    need(n >= 3, "ribBore: at least 3 ribs (survey 2.2)");
    const bore = o.around + u + 2 * 0.25; // clears the largest size by 0.25 per side
    const tipR = (o.around - u) / 2 - o.interference; // ribs reach inside the smallest size
    const rr = 0.8, ribH = bore / 2 - tipR;
    need(ribH <= 2 * rr, `ribBore: ribs ${f3(ribH)} high need a larger tip radius`);
    const R = bore / 2 + wall;
    let s = circle({ d: 2 * R, center: [cx, cy] }).cut(circle({ d: bore, center: [cx, cy] })).extrude({ z: [0, o.height] });
    const ribs = [];
    for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n + Math.PI / n;
        const rc = tipR + rr;
        ribs.push(cylinder({ d: 2 * rr, x: cx + rc * Math.cos(a), y: cy + rc * Math.sin(a), z: [0, o.height] }));
    }
    s = s.add(...ribs).cut(cone({ d1: 2 * tipR - 0.01, d2: bore + 1.5, x: cx, y: cy, z: [o.height - 1.2, o.height + 0.5] }));
    if (o.marks)
        s = s.cut(...notches(o.marks, cx - ((o.marks - 1) * 3) / 2, cy - R - 1, cy - R + 1.2, o.height));
    return s.require(derived(`rib bore for ${o.around}: ${n} ribs, tips ${f3(2 * tipR)} (${o.interference} per side inside the smallest size), bore ${f3(bore)} clears the largest`, true, String(f3(2 * tipR)), "assemble once (crush ribs take a set)"));
}
/** Within-layer clearance gauge: holes (axis Z) of d + 2c for each c; k bumps beside hole k. */
export function holeGauge(d, cs, at, t = 4) {
    const [x0, y0] = at, pitch = d + 6, W = cs.length * pitch + 4, D = d + 10;
    let s = rect({ x: [x0, x0 + W], y: [y0, y0 + D], r: 2 }).extrude({ z: [0, t], bottom: { chamfer: 0.3 } });
    const cuts = [], add = [], reqs = [];
    cs.forEach((c, k) => {
        const x = x0 + 2 + pitch / 2 + k * pitch, y = y0 + 3 + d / 2 + 1;
        cuts.push(cylinder({ d: d + 2 * c, x, y, z: [-1, t + 1] }));
        reqs.push(holeIs({ name: `gauge hole ${k + 1}: ${d} + 2 x ${c}`, at: [x, y, t / 2], axis: "z", d: d + 2 * c, tol: 0.03 }));
        add.push(...bumps(k + 1, x - (k * 1.6) / 2, y0 + D - 2.2, t + 1, 1.2, 1.6).map((b) => b));
    });
    return s.cut(...cuts).add(...add).require(...reqs);
}
/** The key for the hole gauge: a pin of diameter d, standing on a round handle. */
export function keyPin(d, at, len = 12) {
    const [x, y] = at;
    return circle({ d: d + 8, center: [x, y] }).extrude({ z: [0, 3], bottom: { chamfer: 0.3 } }).add(circle({ d, center: [x, y] }).extrude({ z: [2.99, 3 + len], top: { chamfer: 0.6 } }))
        .require(derived(`key pin d${d}`, true, `${d}`, "printed standing"));
}
/**
 * Across-layer clearance gauge: a block with horizontal slits (open front and back) of height T + k x layer,
 * floors and ceilings on layer boundaries; the ceilings are short bridges, which is what sags. The key is a
 * flat strip T thick. k bumps on top above slit k.
 */
export function slitGauge(T, extraLayers, at, layer = 0.2, slitW = 10, depth = 14) {
    const [x0, y0] = at, z0 = 2.0, pitch = slitW + 4, W = extraLayers.length * pitch + 4;
    const H = f3(z0 + T + Math.max(...extraLayers) * layer + 2.0);
    let s = box({ x: [x0, x0 + W], y: [y0, y0 + depth], z: [0, H] });
    const cuts = [], add = [], reqs = [];
    extraLayers.forEach((k, i) => {
        const x = x0 + 2 + pitch / 2 + i * pitch, h = f3(T + k * layer);
        cuts.push(box({ x: [x - slitW / 2, x + slitW / 2], y: [y0 - 1, y0 + depth + 1], z: [z0, z0 + h] }));
        reqs.push(gapIs({ name: `slit ${i + 1}: ${T} + ${k} layer(s) = ${h}`, at: [x, y0 + depth / 2, z0 + h / 2], axis: "z", w: h, tol: 0.01 }));
        add.push(...bumps(i + 1, x - (i * 1.6) / 2, y0 + depth / 2, 1.0, 1.2, 1.6).map((b) => b.move(0, 0, H - 0.01)));
    });
    return s.cut(...cuts).add(...add).require(...reqs);
}
/** The key for the slit gauge: a flat strip T thick, printed flat (T in whole layers). */
export function keyStrip(T, w, len, at) {
    const [x, y] = at;
    return box({ x: [x, x + len], y: [y, y + w], z: [0, T] }).add(box({ x: [x, x + 8], y: [y - 3, y + w + 3], z: [0, T] }))
        .require(derived(`key strip ${T} thick (${Math.round(T / 0.2)} layers of 0.2)`, true, `${T}`, "whole layers"));
}
void beamStrain;
