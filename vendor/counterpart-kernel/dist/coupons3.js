/**
 * The physics lab's coupons J, K and L (physics/coupons/README.md), built by the kernel for the plate. Each is read at a
 * glance (a count of ticks, a slot number, a word), told apart by bumps (a bar counts five), prints without supports
 * in PLA, and states the number it replaces. Where the README's geometry would not print or not read as written, the
 * change is made here and said (prints/2026-11-10-second-plate-b/KEY.md says it again):
 *  - J's and L's tick pitches are printable ones: J 1.0 mm along the bed (0.5 mm ticks left 0.1 mm gaps a 0.42 mm
 *    line cannot print; read halves between ticks), L 0.6 mm in height (three 0.2 mm layers; 0.5 mm steps do not
 *    fall on layers);
 *  - J's arms stand on the bed inside an open frame (an arm standing on a base plate would be fused to it), each held
 *    by a key between its tip and a post on its other side, the key as thick as the gap plus the held travel;
 *  - K is one tower with eight notches instead of eight cheek pairs (an 80 mm plate in one pair's slots would hit the
 *    others): the plate's foot sits against a stop on the base and its upper end in notch k, so its incline is set
 *    by the notch height over a fixed run.
 */
import { box, cylinder, cone, rect, polygon, path, KernelError } from "./api.js";
import { thicknessIs } from "./checks.js";
import { derived } from "./family.js";
const f3 = (v) => Number(v.toFixed(3));
function need(c, m) { if (!c)
    throw new KernelError(m); }
/** A count in bumps (1.4 mm, 1.2 mm high, 2.2 mm pitch), every five a 4 mm bar: J = 10, K = 11, L = 12. */
export function idBumps(k, x, y, z0 = 0, h = 1.2) {
    const out = [];
    let x1 = x;
    while (k >= 5) {
        out.push(box({ x: [x1, x1 + 4], y: [y - 0.7, y + 0.7], z: [z0 - 0.01, z0 + h] }));
        x1 += 4 + 1.5;
        k -= 5;
    }
    for (let i = 0; i < k; i++)
        out.push(cylinder({ d: 1.4, x: x1 + 0.7 + i * 2.2, y, z: [z0 - 0.01, z0 + h] }));
    return out;
}
// ------------------------------------------------------------------------------------------------
// J: relaxation comb
export const J_STRAINS = [0.005, 0.008, 0.011, 0.014, 0.017];
/**
 * Five tapered arms (30 long, 2.0 -> 1.0 wide in x, 6 tall) standing on the bed from a spine at the back, bending in
 * the bed plane (strain along the layers), each held deflected +x by y_i = 1.09 e_i l^2 / h0 by a key pushed between
 * its tip and a post on its -x side. A fin at each tip points at a tick scale on the front bar: ticks every 1.0 mm from
 * rest to y_i (every second one taller), so the set after release reads in ticks, halves allowed.
 */
export function jComb(at) {
    const [X, Y] = at, l = 30, h0 = 2.0, h1 = 1.0, b = 6, pitch = 13, W = 74, gap = 1.6;
    const yBar = [Y, Y + 8], yTip = Y + 12, yRoot = yTip + l, ySpine = [yRoot, yRoot + 6];
    const travel = J_STRAINS.map((e) => f3((1.09 * e * l * l) / h0));
    const keys = travel.map((t) => f3(gap + t - 0.1)); // 0.1 for the key's own print slack
    let s = box({ x: [X, X + W], y: ySpine, z: [0, b] }) // spine (the arms' roots)
        .add(box({ x: [X, X + W], y: yBar, z: [0, 3] }), // front bar: posts and tick scales
    box({ x: [X, X + 2.5], y: [Y, ySpine[1]], z: [0, 3] }), box({ x: [X + W - 2.5, X + W], y: [Y, ySpine[1]], z: [0, 3] }));
    const reqs = [];
    travel.forEach((y, i) => {
        const ax = X + 7 + i * pitch, rf = 1.2;
        // tapered arm with a flared, rounded root (the README's 1.2 mm root fillet)
        s = s.add(polygon([[ax - h0 / 2 - rf, yRoot + 0.01], [ax - h0 / 2, yRoot - rf], [ax - h1 / 2, yTip], [ax + h1 / 2, yTip], [ax + h0 / 2, yRoot - rf], [ax + h0 / 2 + rf, yRoot + 0.01]], { round: [0, 0.8, 0, 0, 0.8, 0] }).extrude({ z: [0, b] }));
        // pointer fin at the tip, pointing -y, ending 1 mm short of the front bar
        s = s.add(box({ x: [ax - 0.4, ax + 0.4], y: [yBar[1] + 1, yTip + 0.01], z: [0, b] }));
        // post on the tip's -x side, standing on the front bar's back half and rising to the tip's height
        const px1 = ax - h1 / 2 - gap;
        s = s.add(box({ x: [px1 - 3, px1], y: [yBar[0] + 4, yTip + 4], z: [0, b] }));
        // ticks on the front bar from rest to the held travel, every 1.0 mm, every second one taller
        for (let k = 0; k * 1.0 <= y + 1e-9; k++)
            s = s.add(box({ x: [ax + k * 1.0 - 0.225, ax + k * 1.0 + 0.225], y: [yBar[1] - 3.5, yBar[1] - 0.01], z: [2.99, k % 2 === 0 ? 4.2 : 3.6] }));
        s = s.add(...idBumps(i + 1, ax - 4, Y + 1.6, 3));
        reqs.push(derived(`J arm ${i + 1}: held ${y} mm by key ${i + 1} (${keys[i]} thick) = ${(100 * J_STRAINS[i]).toFixed(1)}% at the root (1.09 e l^2 / h0, tapered ${h0} -> ${h1}, l ${l})`, true, `${y} mm`, "read the set in 1 mm ticks after release"));
    });
    s = s.add(...idBumps(10, X + W - 16, ySpine[0] + 3, b));
    need(X + 7 + 4 * pitch + travel[4] + h1 / 2 < X + W - 2.5 - 0.5, "jComb: arm 5's held tip reaches the frame");
    return { solid: s.require(...reqs), travel, keys };
}
/** J's five keys: blocks keys[i] thick (x), 4 deep (y), 8 tall, with a grip tab and i+1 bumps on top. */
export function jKeys(keys, at) {
    const [X, Y] = at;
    let x = X, s = null;
    keys.forEach((t, i) => {
        const k = box({ x: [x, x + t], y: [Y, Y + 4], z: [0, 8] }).add(box({ x: [x - 1, x + t + 1], y: [Y + 4, Y + 10], z: [0, 2] }), ...idBumps(i + 1, x - 0.5, Y + 7, 2, 0.8));
        s = s ? s.add(k) : k;
        x += Math.max(t + 2, 12) + 3;
    });
    return s.require(derived(`J keys: ${keys.join(", ")} mm thick (gap 1.6 + held travel - 0.1)`, true, keys.join("/"), "one per arm, bumps = arm"));
}
// ------------------------------------------------------------------------------------------------
// K: friction stand
export const K_ANGLES = [8, 11, 14, 17, 20, 24, 28, 33];
/**
 * A base with a stop at one end and, a run D away, a tower of two cheeks (outside the 40 mm test plate) with eight
 * notches at heights D tan(theta_k): the plate's foot against the stop, its upper end in notch k, inclines at theta_k.
 * Notch k carries k bumps (bar + 3 for 8). Prints on its base; notch ceilings are 45-degree chamfers.
 */
export function kStand(at) {
    const [X, Y] = at, D = 66, Wp = 40.6, ct = 5, plateT = 2, depth = 2;
    const heights = K_ANGLES.map((a) => f3(D * Math.tan((a * Math.PI) / 180)));
    const H = Math.ceil(heights[7] + 6);
    const yIn0 = Y + ct, yIn1 = yIn0 + Wp, W = Wp + 2 * ct;
    let s = box({ x: [X, X + D + 14], y: [Y, Y + W], z: [0, 3] }) // base
        .add(box({ x: [X, X + 3], y: [yIn0, yIn1], z: [2.99, 3 + 3] })); // the stop the plate's foot rests against
    const tx = X + 3 + D; // the notches' lip: the plate rests on it
    const cheek = (y0, y1) => box({ x: [tx - 2, tx + 8], y: [y0, y1], z: [0, H] });
    s = s.add(cheek(Y, yIn0 + 0.01), cheek(yIn1 - 0.01, Y + W));
    const cuts = [];
    heights.forEach((h) => {
        const zc = 3 + h; // the plate's underside at the lip
        // a notch into each cheek's inner face, through the cheek along x: floor at zc, its ceiling rising 45 degrees
        // out of the face (prints without support), 4.6 mm open at the face for the inclined 2 mm plate
        cuts.push(path().moveTo(yIn0 + 0.01, zc).lineTo(yIn0 - depth, zc).lineTo(yIn0 - depth, zc + 0.6).lineTo(yIn0 + 0.01, zc + 0.6 + depth + 0.01).close().extrude({ x: [tx - 2.1, tx + 8.1] }));
        cuts.push(path().moveTo(yIn1 - 0.01, zc).lineTo(yIn1 - 0.01, zc + 0.6 + depth + 0.01).lineTo(yIn1 + depth, zc + 0.6).lineTo(yIn1 + depth, zc).close().extrude({ x: [tx - 2.1, tx + 8.1] }));
    });
    s = s.cut(...cuts).add(...idBumps(11, X + 6, Y + W / 2, 3));
    return { solid: s.require(derived(`K stand: run ${D} mm from the stop to the notches' lip; notch heights ${heights.join(", ")} mm = ${K_ANGLES.join(", ")} degrees (notch 1 is the lowest)`, true, "8 notches", "the first notch where the slider slides")), heights };
}
/** K's test plates: one printed flat (its top is a top surface), one printed standing (its faces are layer edges). */
export function kPlates(at, atStanding) {
    const [X, Y] = at, [Xs, Ys] = atStanding;
    const flat = box({ x: [X, X + 80], y: [Y, Y + 40], z: [0, 2] }).add(...idBumps(11, X + 2, Y + 3, 2, 0.6));
    const standing = box({ x: [Xs, Xs + 80], y: [Ys, Ys + 2], z: [0, 40] }).add(box({ x: [Xs, Xs + 80], y: [Ys - 3, Ys + 5], z: [0, 1.0] }).cut(box({ x: [Xs - 1, Xs + 81], y: [Ys - 3.5, Ys + 5.5], z: [0.6, 1.5] })));
    return [flat.require(derived("K plate, top surface (printed flat, 80 x 40 x 2)", true, "flat", "like a pocket floor or a shelf")),
        standing.require(thicknessIs({ name: "K plate, layer edges (printed standing, 80 x 2 x 40): 2.0 thick", at: [Xs + 40, Ys + 1, 20], axis: "y", t: 2 }))];
}
/** K's slider: a 20 x 20 x 8 block with a finger dimple, sliding on its bed side. */
export function kSlider(at) {
    const [X, Y] = at;
    return box({ x: [X, X + 20], y: [Y, Y + 20], z: [0, 8] }).cut(cone({ d1: 0.01, d2: 10, x: X + 10, y: Y + 10, z: [4, 8.01] }))
        .require(derived("K slider 20 x 20 x 8 (bed side down)", true, "block", "slides on its bed side"));
}
// ------------------------------------------------------------------------------------------------
// L: stiffness arm
/**
 * An arm 150 x 8 x 2.4 (12 layers) printed flat from a block, a 10 mL cup at its tip (inside 25 x 25, 16.0 deep to the
 * brim), a stiff rail beside it from the block past the cup, and on the rail's face a stepped scale every 0.6 mm in
 * height (3 layers; every fifth step longer), read by a fin on the cup. Water to the brim: 10.0 g at 150 mm.
 */
export function lArm(at) {
    const [X, Y] = at, L = 150, aw = 8, h = 2.4, cupIn = 25, cupD = 16, cw = 1.2, fl = 1.2, gap = 2.5;
    const cupO = cupIn + 2 * cw, cx0 = X + 40 + L, cyc = Y; // cup from the arm's tip
    const railY = [cyc - cupO / 2 - gap - 6, cyc - cupO / 2 - gap];
    let s = box({ x: [X, X + 40], y: [railY[0], cyc + 12], z: [0, 15] }) // block (ties the rail)
        .add(box({ x: [X + 39.99, cx0 + 0.01], y: [cyc - aw / 2, cyc + aw / 2], z: [0, h] })) // the arm
        .add(box({ x: [cx0, cx0 + cupO], y: [cyc - cupO / 2, cyc + cupO / 2], z: [0, fl + cupD] }).cut(box({ x: [cx0 + cw, cx0 + cw + cupIn], y: [cyc - cupIn / 2, cyc + cupIn / 2], z: [fl, fl + cupD + 1] })))
        .add(box({ x: [X + 39.99, cx0 + cupO + 8], y: railY, z: [0, 20] })); // the rail
    // the fin on the cup's rail side, at the cup's middle, its edge 0.6 mm from the rail
    const fx = cx0 + cupO / 2;
    s = s.add(box({ x: [fx - 0.4, fx + 0.4], y: [railY[1] + 0.6, cyc - cupO / 2 + 0.01], z: [fl + 4, fl + 12] }));
    // the scale: steps on the rail's face every 0.6 mm (3 layers) from z = 3 to 17 beside the fin, every fifth longer
    const tick = 0.6;
    for (let k = 0; 3 + k * tick <= 17 + 1e-9; k++) {
        const z = 3 + k * tick, long = k % 5 === 0;
        s = s.add(box({ x: [fx + 1, fx + (long ? 6 : 3.5)], y: [railY[1] - 0.01, railY[1] + 0.5], z: [z, z + 0.2] }));
    }
    s = s.add(...idBumps(12, X + 4, cyc + 6, 15));
    const E = 2680, I = (aw * h ** 3) / 12, F = 0.0981, d = (F * L ** 3) / (3 * E * I);
    return { solid: s.require(derived(`L arm ${L} x ${aw} x ${h} (12 layers), cup 25 x 25 x 16.0 = 10.0 mL; scale steps ${tick} mm (3 layers); at E 2680 MPa the water deflects the tip ${d.toFixed(2)} mm = ${(d / tick).toFixed(1)} steps`, true, `${(d / tick).toFixed(1)} steps`, "E = F L^3 / (3 I d)"), thicknessIs({ name: `L arm ${h} thick`, at: [X + 40 + L / 2, cyc, h / 2], axis: "z", t: h })), tickMm: tick, expectedTicks: f3(d / tick) };
}
void cylinder;
void rect;
