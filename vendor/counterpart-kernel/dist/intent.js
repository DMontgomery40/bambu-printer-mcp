/**
 * Intent-level features for the parts this kernel exists for: holders and cups that fit a measured
 * object, pockets that follow an outline with a clearance, screws through a wall plate, boxes and the
 * lids that fit them, clamps around a diameter. Each one
 *  - takes the numbers a person states (object size, clearance, wall, screw size), not construction steps;
 *  - checks its own inputs and says which feature and what to change when they cannot work;
 *  - attaches the requirements that prove it on the finished mesh (sizes, holes, walls, fits).
 * Conventions: millimetres, Z up = print orientation with the bed at z = 0, wall-mounted parts have the
 * wall at y = 0 and extend towards +y.
 */
import { exactMesh } from "./runner.js";
import { checkMesh } from "./kernel/mesh.js";
import { ENGINE, armAnswer, sized } from "./sizing.js";
import { box, cylinder, cone, rect, KernelError } from "./api.js";
import { sectionFits, holeIs, thicknessIs, gapIs } from "./checks.js";
import { decideFit } from "./fit.js";
import { facts } from "./facts.js";
import { polygon as polygonOutline } from "./api.js";
const STRAIN_REPEATED = 0.010; // derived design allowance (survey §2.1; src/compliant.ts STRAIN)
function derived(name, pass, measured, expected) { return { name, run: () => ({ name, pass, measured, expected }) }; }
const f = (v) => Number(v.toFixed(3));
function need(cond, msg) { if (!cond)
    throw new KernelError(msg); }
/** A requirement that carries an interface record (the fit decision) into the run's receipt. */
export function interfaceRecord(rec) {
    return Object.assign({
        name: `fit: ${rec.feature} (${rec.function}${rec.function_inferred ? ", inferred" : ""})`,
        run: () => ({ name: `fit: ${rec.feature} (${rec.function})`, pass: true, measured: `${rec.primitive}, modelled ${rec.modelled_per_side} per side`, expected: rec.reasoning }),
    }, { record: rec });
}
/**
 * Countersunk (or plain) screw holes through a plate that lies on the wall (y = y0..y1), heads on the
 * y1 face. `at` lists [x, z] centres. Returns the cutter, with hole checks attached.
 */
export function wallScrews(o) {
    const [y0, y1] = o.plate;
    need(y1 > y0, `wallScrews: plate y range [${y0}, ${y1}] is empty`);
    const head = o.head ?? 0;
    need(!head || head >= o.d, `wallScrews: countersink ${o.head} mm is smaller than the ${o.d} mm hole`);
    const k = head ? (head - o.d) / 2 : 0;
    need(k <= y1 - y0 + 1e-9, `wallScrews: a ${head} mm countersink for a ${o.d} mm screw is ${f(k)} mm deep, more than the ${f(y1 - y0)} mm plate; use a thicker plate or a smaller head`);
    const cuts = [];
    const reqs = [];
    for (const [x, z] of o.at) {
        let c = cylinder({ d: o.d, x, y: [y0 - 1, y1 + 1], z });
        if (head)
            c = c.add(cone({ d1: o.d, d2: head + 2, x, y: [y1 - k, y1 + 1], z }));
        cuts.push(c);
        reqs.push(holeIs({ name: `screw hole d${o.d} at x=${f(x)}, z=${f(z)}`, at: [x, y0 + Math.min(0.5, (y1 - y0 - k) / 2), z], axis: "y", d: o.d }));
        if (head)
            reqs.push(holeIs({ name: `countersink d${head} at the plate face, x=${f(x)}`, at: [x, y1 - 0.05, z], axis: "y", d: head - 0.1, tol: 0.06 }));
    }
    return cuts[0].add(...cuts.slice(1)).require(...reqs);
}
/**
 * A cup on a wall plate that holds an object of measured section `fits` = [width, depth] (and corner
 * radius) with `clearance` per side. Options: drain hole, a slot in the front wall, a back plate with
 * countersunk screws. The object's section is the cavity minus the clearance; walls and floor are
 * stated thicknesses.
 */
export function wallHolder(o) {
    const [bw0, bd0] = o.fits;
    const rec = decideFit(o.clearance !== undefined ? o.clearance : o.fit, { id: "holder.cavity", feature: "wallHolder cavity", what: "the object's section",
        size: Math.min(bw0, bd0), shape: "flat", inferred: "drops-in", question: "how should the object sit in the holder?" });
    const c = rec.modelled_per_side, wall = o.wall ?? 2.4, floor = o.floor ?? 3, r0 = o.corner_r ?? 0;
    const bc = o.baseChamfer ?? 0.4;
    const bottom = bc > 0 ? { bottom: { chamfer: bc } } : {};
    const [bw, bd] = o.fits;
    need(bw > 0 && bd > 0, `wallHolder: fits must be the object's [width, depth] in mm (got ${JSON.stringify(o.fits)})`);
    const cw = bw + 2 * c, cd = bd + 2 * c, cr = r0 + c;
    need(cr <= Math.min(cw, cd) / 2 + 1e-9, `wallHolder: corner_r ${r0} + clearance ${c} is more than half the ${f(Math.min(cw, cd))} mm cavity; the largest corner radius is ${f(Math.min(cw, cd) / 2 - c)}`);
    const H = floor + o.depth;
    const pl = o.plate ? { thickness: 4, wing: 15, screw: 4.5, head: 9, screws: 2, ...o.plate } : null;
    const pt = pl ? pl.thickness : wall;
    const cy = pt + cd / 2;
    const ow = cw + 2 * wall, od = cd + 2 * wall;
    let body = rect({ size: [ow, od], center: [0, cy], r: cr + wall }).extrude({ z: [0, H], ...bottom });
    const cavity = rect({ size: [cw, cd], center: [0, cy], r: cr });
    const cuts = [cavity.extrude({ z: [floor, H + 1] })];
    const reqs = [
        interfaceRecord(rec),
        sectionFits({ what: "cavity", z: floor + Math.min(10, o.depth / 3), around: [0, cy], size: [cw, cd] }),
        thicknessIs({ name: `side wall ${wall}`, at: [-(cw / 2 + wall / 2), cy, floor + Math.min(10, o.depth / 3)], axis: "x", t: wall }),
        thicknessIs({ name: `front wall ${wall}`, at: [0, cy + cd / 2 + wall / 2, floor + Math.min(5, o.depth / 4)], axis: "y", t: wall }),
        thicknessIs({ name: `floor ${floor}`, at: [cw / 2 - Math.max(cr, 2) - 1, cy, floor / 2], axis: "z", t: floor }),
    ];
    if (o.drain) {
        need(o.drain < Math.min(cw, cd), `wallHolder: drain ${o.drain} mm is wider than the ${f(Math.min(cw, cd))} mm cavity`);
        cuts.push(cylinder({ d: o.drain, x: 0, y: cy, z: [-1, floor + 1] }));
        reqs.push(holeIs({ name: `drain hole d${o.drain}`, at: [0, cy, floor / 2], axis: "z", d: o.drain }));
    }
    if (o.frontSlot) {
        const { width, above_floor } = o.frontSlot;
        need(width < ow, `wallHolder: front slot ${width} mm is wider than the ${f(ow)} mm cup`);
        need(above_floor < o.depth, `wallHolder: front slot starts ${above_floor} mm above the floor but the cup is only ${o.depth} mm deep`);
        const fy = cy + cd / 2;
        cuts.push(box({ x: [-width / 2, width / 2], y: [fy - 1, fy + wall + 1], z: [floor + above_floor, H + 1] }));
        reqs.push(gapIs({ name: `front slot ${width} wide`, at: [0, fy + wall / 2, floor + above_floor + Math.min(5, (o.depth - above_floor) / 2)], axis: "x", w: width }));
        reqs.push(thicknessIs({ name: `front slot bottom at z=${f(floor + above_floor)} (${above_floor} above the ${floor} mm floor)`, at: [0, fy + wall / 2, 0.5], axis: "z", t: floor + above_floor }));
    }
    if (pl) {
        const pw = ow + 2 * pl.wing;
        body = body.add(rect({ x: [-pw / 2, pw / 2], y: [0, pl.thickness] }).extrude({ z: [0, H], ...bottom }));
        const margin = (pl.wing - pl.head) / 2;
        need(margin >= 0.8, `wallHolder: the ${pl.head} mm countersink needs a plate wing of at least ${f(pl.head + 1.6)} mm (0.8 mm each side); the wing is ${pl.wing} mm, ${f(pl.head + 1.6 - pl.wing)} mm short. Widen plate.wing or use a smaller head`);
        const z = pl.z ?? H * 0.72;
        need(z - pl.head / 2 >= 0.8 && z + pl.head / 2 <= H - 0.8, `wallHolder: screws at z=${f(z)} put the ${pl.head} mm head within 0.8 mm of the plate's top or bottom (plate height ${f(H)}); choose z between ${f(pl.head / 2 + 0.8)} and ${f(H - pl.head / 2 - 0.8)}`);
        const xs = pl.screws === 1 ? [0] : [-(ow / 2 + pl.wing / 2), ow / 2 + pl.wing / 2];
        cuts.push(wallScrews({ at: xs.map((x) => [x, z]), plate: [0, pl.thickness], d: pl.screw, head: pl.head }));
        reqs.push(thicknessIs({ name: `back plate ${pl.thickness}`, at: [ow / 2 + pl.wing / 2, pl.thickness / 2, Math.min(z - pl.head, H / 4)], axis: "y", t: pl.thickness }));
    }
    const objH = 2 * o.depth, kg = Number(((bw * bd * objH) / 1e6).toFixed(3));
    const ol = rect({ size: [bw, bd], center: [0, cy], r: Math.min(r0, Math.min(bw, bd) / 2) }).ex?.contours?.[0];
    const xsS = pl ? (pl.screws === 1 ? [0] : [-(ow / 2 + pl.wing / 2), ow / 2 + pl.wing / 2]) : [];
    const zS = pl ? pl.z ?? H * 0.72 : 0;
    return body.cut(...cuts).require(...reqs, facts({
        from: "wallHolder",
        supports: pl ? [...xsS.map((x, i) => ({ id: `screw.${i + 1}`, kind: "screw", at: [x, 0, zS], axis: [0, 1, 0], d: pl.screw, head: pl.head, countersunk: true })), { id: "wall", kind: "wall", point: [0, 0, 0], normal: [0, 1, 0] }] : [],
        object: ol ? { name: "object", kg, prism: { outline: ol, axis: "z", span: [floor, floor + objH] }, size: { nominal: Math.min(bw, bd), uncertainty: rec.object.uncertainty, source: rec.object.source } } : undefined,
        loads: [
            { id: "weight", kind: "weight", kg, at: { plane: { point: [0, cy, floor], normal: [0, 0, 1] }, within: [[-cw / 2, cw / 2], [cy - cd / 2, cy + cd / 2], [floor - 0.6, floor + 0.6]] }, why: `the object, ${kg} kg (assumed: its volume of water, ${objH} mm tall)` },
            { id: "pull", kind: "pull", N: 20, dir: [0, 1, 0], at: { plane: { point: [0, 0, H], normal: [0, 0, 1] }, within: [[-ow / 2, ow / 2], [cy + cd / 2, cy + cd / 2 + wall], [H - 0.6, H + 0.6]] }, why: "a hand pulling the front rim, 20 N" },
        ],
        requirements: pl ? [
            { id: "strength", holds: { safetyFactor: 3 } }, { id: "stiffness", deflection: { max: 1 } },
            { id: "tilt.x", staysIn: { tilt: 30, axis: [1, 0, 0] } }, { id: "tilt.y", staysIn: { tilt: 30, axis: [0, 1, 0] } }, { id: "lift", liftsOut: { along: [0, 0, 1] } },
        ] : [{ id: "tilt.y", staysIn: { tilt: 30, axis: [0, 1, 0] } }, { id: "lift", liftsOut: { along: [0, 0, 1] } }],
    }));
}
/**
 * A pocket cutter that follows an outline with `clearance` per side: the outline is the object's shape
 * in the plane of the pocket (front view for along "y", top view for along "z"); the pocket runs over
 * `span` along that axis; `leadIn` flares the mouth at the high end. Checks the pocket's width at the
 * given probe heights against the outline's width there plus twice the clearance.
 */
export function pocket(o) {
    const [ox, oy] = o.at ?? [0, 0];
    const ob = o.outline.bounds();
    const rec = decideFit(o.clearance !== undefined ? o.clearance : o.fit, { id: `pocket${o.name ? "." + o.name : ""}`, feature: `pocket${o.name ? ` "${o.name}"` : ""}`, what: "the object's outline",
        size: Math.min(ob.size[0], ob.size[1]), shape: "flat", question: "how should the object sit in this pocket: dropped in and lifted out (\"drops-in\"), located without rattle (\"locates\"), or slid in (\"slides\")?" });
    const clearance = rec.modelled_per_side;
    const prof = o.outline.offset(clearance).move(ox, oy);
    // span[1] is the mouth face; the cutter runs 1 mm past it by itself, so a lead-in measures leadIn at the face
    const over = 1;
    const span = [o.span[0], o.span[1] + over];
    const top = o.leadIn ? { flare: o.leadIn + over } : undefined;
    const cut = prof.extrude(o.along === "y" ? { y: span, top } : { z: span, top });
    const reqs = [interfaceRecord(rec)];
    for (const v of o.probes ?? []) {
        const w = widthAt(o.outline, v);
        if (w === null)
            continue;
        const mid = (o.span[0] + o.span[1]) / 2 - (o.leadIn ?? 0) / 2;
        const xc = w.center + ox;
        if (o.along === "y")
            reqs.push(gapIs({ name: `pocket at x=${f(xc)} is ${f(w.width)} + 2 x ${clearance} wide at height ${f(v + oy)}`, at: [xc, mid, v + oy], axis: "x", w: w.width + 2 * clearance }));
        else
            reqs.push(gapIs({ name: `pocket at x=${f(xc)} is ${f(w.width)} + 2 x ${clearance} wide at y=${f(v + oy)}`, at: [xc, v + oy, mid], axis: "x", w: w.width + 2 * clearance }));
        if (o.leadIn && o.along === "y") {
            const yIn = o.span[1] - 0.3;
            reqs.push(gapIs({ name: `lead-in ${o.leadIn} at the mouth (y=${f(o.span[1])}): pocket ${f(w.width + 2 * clearance + 2 * (o.leadIn - 0.3))} wide 0.3 mm inside`, at: [xc, yIn, v + oy], axis: "x", w: w.width + 2 * clearance + 2 * (o.leadIn - 0.3), tol: 0.08 }));
        }
    }
    return cut.require(...reqs);
}
/** Width of a profile along x at sketch height y (outer extent of the region containing its middle). */
export function widthAt(p, y) {
    const b = p.bounds();
    const d = (x) => p.shape.d(x, y);
    const xm = (b.min[0] + b.max[0]) / 2;
    if (d(xm) >= 0)
        return null;
    const edge = (from, to) => { let a = from, c = to; for (let i = 0; i < 60; i++) {
        const m = (a + c) / 2;
        if (d(m) < 0)
            a = m;
        else
            c = m;
    } return (a + c) / 2; };
    const x0 = edge(xm, b.min[0] - 1), x1 = edge(xm, b.max[0] + 1);
    return { width: x1 - x0, center: (x0 + x1) / 2 };
}
const BOXES = new WeakMap();
/** An open-topped box of outside size [length, width, height] with stated wall, floor and corner radius. */
export function openBox(o) {
    let holdRec = null;
    const nx = o.compartments?.[0] ?? 1, ny = o.compartments?.[1] ?? 1, dv = o.divider ?? 1.2;
    if (o.holds) {
        if (o.size)
            throw new KernelError("openBox: give size (outside) or holds (the thing inside), not both");
        const [hw, hd, hh] = o.holds;
        holdRec = decideFit(o.fit, { id: "box.inside", feature: "openBox inside", what: "the thing it holds", size: Math.min(hw, hd), shape: "flat", inferred: "drops-in", question: "how should the thing sit in the box?" });
        const c = holdRec.modelled_per_side;
        // holds is one compartment's thing: the inside is nx x ny of them plus the dividers between
        o = { ...o, size: [f(nx * (hw + 2 * c) + (nx - 1) * dv + 2 * o.wall), f(ny * (hd + 2 * c) + (ny - 1) * dv + 2 * o.wall), f((o.floor ?? o.wall) + hh + 1)] };
    }
    if (!o.size)
        throw new KernelError("openBox: give size: [L, W, H] (outside) or holds: [w, d, h] (the thing inside)");
    const [L, W, H] = o.size, wall = o.wall, floor = o.floor ?? wall, r = o.corner_r ?? 0, [x, y] = o.at ?? [0, 0];
    need(r <= Math.min(L, W) / 2 + 1e-9, `openBox: corner_r ${r} is more than half the ${Math.min(L, W)} mm side`);
    need(2 * wall < Math.min(L, W) && floor < H, `openBox: walls of ${wall} mm leave no inside in a ${L} x ${W} box (or the floor fills it)`);
    const outer = rect({ size: [L, W], center: [x, y], r });
    const bc = o.baseChamfer ?? 0.4;
    // probes low in the box (below any latch groove) and on the walls without grooves
    const zProbe = floor + Math.min(2, (H - floor) / 4);
    const snapsOnY = o.lid === "snaps" && L - 2 * wall > W - 2 * wall; // the grooves go in the longer pair of walls
    const b = outer.extrude({ z: [0, H], ...(bc > 0 ? { bottom: { chamfer: bc } } : {}) }).cut(outer.offset(-wall).extrude({ z: [floor, H + 1] })).require(...(nx * ny === 1 ? [sectionFits({ what: "box inside", z: zProbe, around: [x, y], size: [L - 2 * wall, W - 2 * wall] })] : []), snapsOnY ? thicknessIs({ name: `box wall ${wall}`, at: [x - L / 2 + wall / 2, y, zProbe], axis: "x", t: wall }) : thicknessIs({ name: `box wall ${wall}`, at: [x, y - W / 2 + wall / 2, zProbe], axis: "y", t: wall }), thicknessIs({ name: `box floor ${floor}`, at: [x + (nx > 1 ? (L - 2 * wall) / nx / 4 : 0), y + (ny > 1 ? (W - 2 * wall) / ny / 4 : 0), floor / 2], axis: "z", t: floor }));
    let bx = holdRec ? b.require(interfaceRecord(holdRec)) : b;
    let snaps;
    let dividers;
    if (nx * ny > 1) {
        const iL = L - 2 * wall, iW = W - 2 * wall, cw = (iL - (nx - 1) * dv) / nx, cd = (iW - (ny - 1) * dv) / ny;
        need(cw > 2 && cd > 2, `openBox: ${nx} x ${ny} compartments with ${dv} mm dividers leave no room in a ${f(iL)} x ${f(iW)} inside`);
        const xs = Array.from({ length: nx - 1 }, (_, i) => x - iL / 2 + (i + 1) * cw + i * dv + dv / 2), ys = Array.from({ length: ny - 1 }, (_, j) => y - iW / 2 + (j + 1) * cd + j * dv + dv / 2);
        const divs = [...xs.map((xc) => box({ x: [xc - dv / 2, xc + dv / 2], y: [y - iW / 2 - 0.01, y + iW / 2 + 0.01], z: [floor - 0.01, H] })), ...ys.map((yc) => box({ x: [x - iL / 2 - 0.01, x + iL / 2 + 0.01], y: [yc - dv / 2, yc + dv / 2], z: [floor - 0.01, H] }))];
        bx = bx.add(...divs);
        const reqs = [];
        for (let i = 0; i < nx; i++)
            for (let j = 0; j < ny; j++) {
                const cx = x - iL / 2 + i * (cw + dv) + cw / 2, cy = y - iW / 2 + j * (cd + dv) + cd / 2;
                if (i + j < 2 || (i === nx - 1 && j === ny - 1))
                    reqs.push(sectionFits({ what: `compartment ${i + 1},${j + 1}`, z: zProbe, around: [cx, cy], size: [f(cw), f(cd)] }));
            }
        if (xs.length)
            reqs.push(thicknessIs({ name: `divider ${dv}`, at: [xs[0], y, zProbe], axis: "x", t: dv }));
        bx = bx.require(...reqs);
        dividers = { xs, ys, t: dv };
    }
    if (o.lid === "snaps") {
        // a groove in each of the longer pair of walls' inside faces: 45-degree ceiling (prints upright, and the latch can be
        // pulled off), flat floor. Built for the x walls, turned a quarter for the y walls (exact).
        const u = 0.6, depthTop = 4, g = u + 0.2;
        const [Lx, Wy] = snapsOnY ? [W, L] : [L, W];
        const len = Math.min(Wy - 2 * wall - 2 * (r + 2), 24);
        need(H - floor > depthTop + 6, "openBox: too shallow for snap grooves");
        // the closed hook's widest point sits depthTop below the rim; the groove's full depth reaches 0.2 above it (round 2
        // put the ceiling's corner there, so a closed hook pressed 0.2-0.6 mm into the wall; found by worker run A16)
        const zc = H - depthTop + g + 0.2;
        // a wall thinner than the groove plus 1 mm gets a pad outside over each groove (found by worker run A15)
        const pad = Math.max(0, f(g + 1.0 - wall));
        const cuts = [], pads = [];
        for (const s of [-1, 1]) {
            const xi = s * (Lx / 2 - wall), xo = s * (Lx / 2);
            const pts = s > 0 ? [[xi - 0.01, zc - 3], [xi + g, zc - 3], [xi + g, zc - g], [xi - 0.01, zc + 0.01]] : [[xi + 0.01, zc - 3], [xi + 0.01, zc + 0.01], [xi - g, zc - g], [xi - g, zc - 3]];
            cuts.push(polygonOutline(pts).extrude({ y: [-len / 2, len / 2] }));
            if (pad > 0)
                pads.push(box({ x: s > 0 ? [xo - 0.01, xo + pad] : [xo - pad, xo + 0.01], y: [-len / 2 - 1, len / 2 + 1], z: [Math.max(0, zc - 4), Math.min(H, zc + 1)] }));
        }
        const turn = (q) => (snapsOnY ? q.rotate("z", 90) : q).move(x, y, 0);
        if (pads.length)
            bx = bx.add(...pads.map(turn));
        // dividers: notch their ends where the lid's lip comes down (lip wall 1.6 + clearance 0.3 + 0.2), 7 mm deep
        if (dividers) {
            const nW = 2.2, nD = 7.5, notch = [];
            for (const xc of dividers.xs)
                for (const s of [-1, 1])
                    notch.push(box({ x: [xc - dv, xc + dv], y: s > 0 ? [y + (W / 2 - wall) - nW, y + W / 2 - wall + 0.01] : [y - (W / 2 - wall) - 0.01, y - (W / 2 - wall) + nW], z: [H - nD, H + 1] }));
            for (const yc of dividers.ys)
                for (const s of [-1, 1])
                    notch.push(box({ y: [yc - dv, yc + dv], x: s > 0 ? [x + (L / 2 - wall) - nW, x + L / 2 - wall + 0.01] : [x - (L / 2 - wall) - 0.01, x - (L / 2 - wall) + nW], z: [H - nD, H + 1] }));
            bx = bx.cut(...notch);
        }
        bx = bx.cut(...cuts.map(turn));
        if (pad > 0)
            bx = bx.require(derived(`latch grooves ${g} deep in ${wall} mm walls: a ${pad} mm pad outside each keeps 1 mm behind the groove`, true, `${pad} mm`, "1 mm of wall behind each groove"));
        snaps = { undercut: u, depth: depthTop, length: len, side: snapsOnY ? "y" : "x" };
    }
    BOXES.set(bx, { length: L, width: W, height: H, wall, floor, corner_r: r, at: [x, y], snaps, dividers });
    return bx;
}
export function lidFor(boxSolid, o = {}) {
    const info = BOXES.get(boxSolid);
    need(!!info, "lidFor: pass the solid returned by openBox (before cutting or adding to it)");
    const at = o.at ?? [info.at[0] + info.length + (o.gap ?? 10), info.at[1]];
    // a snapping lid needs a lip tall enough to carry its hook below the lead-in chamfer: choose it unless stated
    const lip = o.lip ?? (info.snaps ? Math.max(6, Math.ceil(info.snaps.depth + 0.4 + info.snaps.undercut / Math.tan(Math.PI / 6) + 0.5 + (o.chamfer ?? 1))) : 6);
    let lid;
    if (info.snaps?.side === "y") {
        // latches on the y walls: build it for x walls in a turned frame and turn it back a quarter (exact; requirements and facts turn with it)
        const turned = { ...info, length: info.width, width: info.length, at: [0, 0] };
        lid = lidCore(turned, { ...o, lip, at: [0, 0] }).rotate("z", 90).move(at[0], at[1], 0);
    }
    else
        lid = lidCore({ ...info, at: info.at }, { ...o, lip, at });
    // closed, does the lid overlap the box? (flipped over onto the rim, exact intersection; round 2 asserted it, and a
    // worker run found the hooks pressing into the wall)
    if (boxSolid.poly && lid.poly) {
        try {
            const T = o.thickness ?? 3;
            const closed = lid.move(-at[0], -at[1], 0).rotate("x", 180).move(info.at[0], info.at[1], info.height + T);
            const m = exactMesh(boxSolid.intersect(closed).poly());
            const v = Math.abs(m.triangleCount ? checkMesh(m).volume : 0);
            lid = lid.require(derived(`closed, the lid does not overlap the box (exact intersection of the box and the lid flipped onto its rim): ${v.toFixed(3)} mm3`, v < 0.01, `${v.toFixed(3)} mm3`, "0 mm3 (else the lip or a latch hook presses into the box)"));
        }
        catch (e) {
            lid = lid.require(derived(`closed-lid overlap not checked: ${e.message}`, true, "-", "-"));
        }
    }
    return lid;
}
function lidCore(info, o) {
    const { length: L, width: W, wall, corner_r: r } = info;
    const fn0 = typeof o.fit === "string" ? o.fit : o.fit?.function;
    const snapping = fn0 === "snaps";
    if (snapping && !info.snaps)
        throw new KernelError('lidFor: a snapping lid needs the box made with openBox({ ..., lid: "snaps" }) (grooves in its short walls)');
    if (snapping)
        o = { ...o, fit: { function: "slides", measured: "designed" } };
    // the box is ours: its inside is known exactly ("designed") unless the script says otherwise
    const lidSpec = o.clearance !== undefined ? o.clearance : typeof o.fit === "string" ? { function: o.fit, measured: "designed" } : o.fit ? { measured: "designed", ...o.fit } : undefined;
    const rec = decideFit(lidSpec, { id: "lid.lip", feature: "lidFor lip", what: "the box's inside",
        size: Math.min(info.length, info.width) - 2 * info.wall, shape: "flat", question: "how should the lid stay on: lift off freely (\"slides\"), sit without rattling and come off by hand (\"locates\")? (snap lids are not built yet)" });
    // the lip is the inner part: its walls are outside walls, so no pocket correction applies to it
    const c = rec.modelled_per_side - rec.print_correction.per_side, t = o.thickness ?? 3, lipH = o.lip ?? 6, lw = o.lipWall ?? 1.6, ch = o.chamfer ?? 1;
    need(2 * (wall + c + lw) < Math.min(L, W), `lidFor: wall ${wall} + clearance ${c} + lip wall ${lw} leaves no room inside a ${Math.min(L, W)} mm box`);
    need(ch <= lipH / 2, `lidFor: chamfer ${ch} mm is more than half the ${lipH} mm lip`);
    const [x, y] = o.at;
    const outer = rect({ size: [L, W], center: [x, y], r });
    const lipOuter = outer.offset(-(wall + c));
    let lip = lipOuter.extrude({ z: [t - 0.01, t + lipH], top: ch ? { chamfer: ch } : undefined }).cut(lipOuter.offset(-lw).extrude({ z: [t, t + lipH + 1] }));
    let plate = outer.extrude({ z: [0, t] });
    const latchReqs = [];
    let latchFacts = null;
    if (snapping) {
        // latch arms in the print plane: a section of each short side of the lip, freed by a gap at its tip and a window
        // through the plate beside it, standing on the bed; it bends sideways (strain along the layers). The window's
        // inner edge is its hard stop. A 30-degree lead and 45-degree return hook on its outer face meets the box's groove.
        const sn = info.snaps, yU = sn.undercut, e = STRAIN_REPEATED * 0.9;
        need(lipH >= sn.depth + 2, `lidFor: a snapping lid needs a lip at least ${sn.depth + 2} mm tall (the groove is ${sn.depth} mm down)`);
        let la = Math.min(sn.length, Math.max(8, Math.sqrt((1.5 * lw * yU) / e)));
        const stop = Number((yU + 0.3).toFixed(2));
        let strain = (1.5 * lw * yU) / (la * la), strainStop = (1.5 * lw * stop) / (la * la);
        const bArm = t + lipH - ch;
        let latchReport = null;
        if (ENGINE) {
            // sized by the engine's nonlinear snap arm (hook push fed back): the shortest arm within the repeated-use strain at
            // the hook, the single-use strain at its stop, closing by thumb (<= 25 N) and holding (>= 5 N); round 2's linear
            // rule is kept for comparison
            const t0 = performance.now(), ruleLa = la, table = [];
            const judge = (l) => { const a = armAnswer({ l, b: bArm, h0: lw, y: yU, alpha: 30, alphaR: 45 }, { full: true }), st = armAnswer({ l, b: bArm, h0: lw, y: stop, alpha: 30, alphaR: 45 }, { full: true }); return { a, st, ok: a.strain <= STRAIN_REPEATED && st.strain <= 0.017 && a.W <= 25 && (a.Wout ?? Infinity) >= 5 }; };
            const ruleJ = judge(ruleLa);
            let chosen = null, cj = ruleJ;
            for (let l = 6; l <= sn.length + 1e-9; l = Number((l * 1.08).toFixed(3))) {
                const j = judge(Math.min(l, sn.length));
                table.push({ label: `arm ${f(Math.min(l, sn.length))} long: close ${j.a.W.toFixed(1)} N, hold ${j.a.Wout === null ? "locks" : j.a.Wout.toFixed(1) + " N"}`, massG: 0, strain: j.a.strain, ok: j.ok, why: j.ok ? undefined : j.a.strain > STRAIN_REPEATED ? `strain ${(100 * j.a.strain).toFixed(2)}%` : j.st.strain > 0.017 ? "over-bends at its stop" : j.a.W > 25 ? "too stiff to close by thumb" : "holds under 5 N" });
                if (j.ok) {
                    chosen = Math.min(l, sn.length);
                    cj = j;
                    break;
                }
                if (l >= sn.length)
                    break;
            }
            need(chosen !== null, `lidFor: no latch arm in the ${f(sn.length)} mm groove stays within ${100 * STRAIN_REPEATED}% strain at a ${yU} mm hook and closes by thumb (the engine's nonlinear arm); use a longer box or a thinner lip wall`);
            la = chosen;
            strain = cj.a.strain;
            strainStop = cj.st.strain;
            latchReport = { feature: "lidFor snaps", requirement: `latch strain <= ${100 * STRAIN_REPEATED}% at the hook, <= 1.7% at the stop, closes <= 25 N, holds >= 5 N`, model: "the engine's nonlinear snap arm, hook push fed back",
                chosen: `arms ${f(la)} long, ${lw} thick, ${f(bArm)} tall: close ${cj.a.W.toFixed(1)} N, hold ${cj.a.Wout === null ? "self-locking" : cj.a.Wout.toFixed(1) + " N"}`, predicted: { massG: 0, strain },
                handRule: { label: `round 2 rule (linear, 0.9 x allowance): arms ${f(ruleLa)} long; by the engine strain ${(100 * ruleJ.a.strain).toFixed(2)}%, close ${ruleJ.a.W.toFixed(1)} N`, massG: 0, strain: ruleJ.a.strain },
                table: table.slice(-5), evaluated: table.length, ms: performance.now() - t0 };
        }
        need(strain <= STRAIN_REPEATED + 1e-9, `lidFor: the ${f(sn.length)} mm groove is too short for a latch arm within ${100 * STRAIN_REPEATED}% strain (needs ${f(Math.sqrt((1.5 * lw * yU) / e))} mm); use a longer box`);
        const xs = [-1, 1], cutsP = [], cutsL = [], arms = [];
        const y0 = y - la / 2, y1 = y + la / 2, gap = 1.0;
        const zH = t + sn.depth; // hook's widest point: groove ceiling height when seated
        const hookTop = zH + 0.4 + yU / Math.tan(Math.PI / 6);
        need(hookTop + 0.5 <= t + lipH - ch, `lidFor: the latch hook reaches ${f(hookTop - t)} mm up the lip, into its ${ch} mm lead-in chamfer (lip ${lipH}); use a lip of at least ${f(hookTop - t + 0.5 + ch)} mm or a smaller chamfer`);
        for (const sg of xs) {
            const xo = x + sg * (L / 2 - wall - c), xi = xo - sg * lw; // lip wall's outer / inner face
            const lo = Math.min(xo, xi), hi = Math.max(xo, xi);
            cutsL.push(box({ x: [lo - 0.5, hi + 0.5], y: [y0, y1 + gap], z: [t - 0.5, t + lipH + 1] })); // free the lip section
            const wlo = sg > 0 ? lo - stop : lo - 0.01, whi = sg > 0 ? hi + 0.01 : hi + stop;
            cutsP.push(box({ x: [wlo, whi], y: [y0, y1 + gap], z: [-1, t + 1] })); // window: the arm's stop is its inner edge
            arms.push(box({ x: [lo, hi], y: [y0, y1], z: [0, t + lipH - ch] }));
            // hook on the outer face near the tip: lead 30 deg (deeper side), return 45 deg (towards the plate, printable)
            const lead = yU / Math.tan(Math.PI / 6);
            const hk = sg > 0
                ? [[xo - 0.01, zH - yU], [xo + yU, zH], [xo + yU, zH + 0.4], [xo - 0.01, zH + 0.4 + lead]]
                : [[xo + 0.01, zH - yU], [xo + 0.01, zH + 0.4 + lead], [xo - yU, zH + 0.4], [xo - yU, zH]];
            arms.push(polygonOutline(hk).extrude({ y: [y1 - Math.min(10, la * 0.6), y1] }));
        }
        plate = plate.cut(...cutsP);
        lip = lip.cut(...cutsL);
        latchReqs.push(derived(`latch arms ${f(la)} mm long, ${lw} thick, standing in the print plane (they bend in the layers); strain at the ${yU} mm hook ${(100 * strain).toFixed(2)}% (repeated-use allowance 1.0%, derived, not measured)`, true, `${(100 * strain).toFixed(2)}%`, "<= 1.0%"), derived(`each arm stops against the window's edge after ${stop} mm: strain there ${(100 * strainStop).toFixed(2)}%`, strainStop <= 0.017, `${(100 * strainStop).toFixed(2)}%`, "<= 1.7% (single-use)"), derived("closed, the hook sits in the groove with the arm straight: no stress held (the overlap check below proves the hook clears the wall)", true, "relaxed", "survey rule 4"));
        if (latchReport)
            latchReqs.push(sized(latchReport));
        const arm = { l: f(la), b: f(bArm), h0: lw, deflect: [0, yU], stopAt: stop, plane: "xy", y: yU, alpha: 30, alphaR: 45, mu: 0.2 };
        latchFacts = facts({ from: "lidFor snaps", flexures: { latch: { kind: "snap", ...arm } },
            requirements: [{ id: "latch.strain", strain: { flexure: "latch", use: "repeated" }, why: "opened and closed many times" }, { id: "latch.stop", stop: { flexure: "latch" } },
                { id: "latch.close", insertion: { flexure: "latch", max: 25 }, why: "closes with a thumb (each latch at most 25 N)" }, { id: "latch.hold", retention: { flexure: "latch", min: 5 }, why: "stays shut when the box is lifted by its lid (each latch at least 5 N)" }] });
        lip = lip.add(...arms);
    }
    const lidSolid = plate.add(lip);
    return (latchFacts ? lidSolid.require(...latchReqs, latchFacts) : lidSolid).require(interfaceRecord({ ...rec, modelled_per_side: Number(c.toFixed(3)), print_correction: { ...rec.print_correction, per_side: 0, feature: "lip outside walls (no correction)" }, reasoning: rec.reasoning.replace(/modelled [\d.]+ mm per side = design fit ([\d.]+) \([a-z-]+\) \+ print correction [\d.]+ \([^)]*\)/, `modelled ${c.toFixed(3)} mm per side = design fit $1 (the lip's walls are outside walls, so no pocket correction)`) }), sectionFits({ what: "lid plate", z: t / 2, around: [x, y], size: [L, W], outer: true }), snapping ? thicknessIs({ name: `lip wall ${lw} (box inside minus ${c} per side; the short sides carry the latches)`, at: [x, y + (W / 2 - wall - c - lw / 2), t + Math.min(2, lipH / 3)], axis: "y", t: lw })
        : sectionFits({ what: `lip (box inside minus ${c} per side)`, z: t + Math.min(2, lipH / 3), around: [x, y], size: [L - 2 * (wall + c), W - 2 * (wall + c)], outer: true }));
}
/**
 * A split clamp ring around a tube of diameter `bore` (axis Z), wall `wall`, `height` tall, slit `gap`
 * wide on +x with two ears and a bolt hole across them; optional arm towards -x.
 */
export function clampRing(o) {
    let bore, rec = null;
    if (o.around !== undefined) {
        if (o.bore !== undefined)
            throw new KernelError("clampRing: give around (the tube's size; the kernel derives the bore) or bore, not both");
        rec = decideFit(o.fit, { id: "clamp.bore", feature: "clampRing bore", what: "the tube", size: o.around, shape: "round", axis: "vertical", inferred: "clamps",
            question: "", splitGap: o.gap ?? 2 });
        bore = o.around + 2 * rec.modelled_per_side;
    }
    else {
        need(o.bore !== undefined, "clampRing: give around: <the tube's diameter> (and fit) so the kernel can derive the bore");
        bore = o.bore;
    }
    const split = rec ? !!rec.split : true;
    const gap = rec?.split?.gap ?? o.gap ?? 2;
    const bolt = o.bolt ?? 3.2;
    const R = bore / 2 + o.wall, el = o.earLength ?? Math.max(3 * bolt, 8), et = o.earThickness ?? o.wall;
    if (split) {
        need(bolt < el - 1.6, `clampRing: the ${bolt} mm bolt hole needs ears longer than ${f(bolt + 1.6)} mm (they are ${el})`);
        need(bolt < o.height - 1.6, `clampRing: the ${bolt} mm bolt hole needs a ring taller than ${f(bolt + 1.6)} mm`);
    }
    let s = cylinder({ d: 2 * R, x: 0, y: 0, z: [0, o.height] });
    if (split)
        s = s.add(box({ x: [R - 2, R + el], y: [-(gap / 2 + et), gap / 2 + et], z: [0, o.height] }));
    if (o.arm)
        s = s.add(box({ x: [-R - o.arm.length, -R + 2], y: [-o.arm.width / 2, o.arm.width / 2], z: [0, o.height] }));
    const cuts = [cylinder({ d: bore, x: 0, y: 0, z: [-1, o.height + 1] })];
    if (split)
        cuts.push(box({ x: [0, R + el + 1], y: [-gap / 2, gap / 2], z: [-1, o.height + 1] }), cylinder({ d: bolt, x: R + el / 2, y: [-(gap / 2 + et + 1), gap / 2 + et + 1], z: o.height / 2 }));
    s = s.cut(...cuts);
    // wall probed along y at x = -1.5: clear of the split, the arm and any crush rib; chord-corrected
    const px = -1.5, tWall = Math.sqrt(R * R - px * px) - Math.sqrt((bore / 2) ** 2 - px * px);
    const reqs = [
        thicknessIs({ name: `ring wall ${o.wall}`, at: [px, bore / 2 + o.wall / 2, o.height / 2], axis: "y", t: tWall }),
    ];
    if (rec?.ribs) {
        // crush ribs: half-round ridges along the bore, protruding ribs.height, spaced away from the split
        const rr = Math.max(0.6, rec.ribs.height);
        const ribs = [];
        for (let k = 0; k < rec.ribs.count; k++) {
            const a = Math.PI / rec.ribs.count + (2 * Math.PI * k) / rec.ribs.count;
            const rc = bore / 2 + rr - rec.ribs.height;
            ribs.push(cylinder({ d: 2 * rr, x: rc * Math.cos(a), y: rc * Math.sin(a), z: [0, o.height] }));
        }
        s = s.add(...ribs).cut(box({ x: [0, R + el + 1], y: [-gap / 2, gap / 2], z: [-1, o.height + 1] })).intersect(cylinder({ d: 2 * R + 2 * el + 2 * (o.arm?.length ?? 0) + 10, x: 0, y: 0, z: [0, o.height] }));
    }
    if (split) {
        reqs.push(gapIs({ name: `split ${gap} wide`, at: [R - o.wall / 2, 0, o.height / 2], axis: "y", w: gap }));
        reqs.push(holeIs({ name: `bolt hole d${bolt}`, at: [R + el / 2, gap / 2 + et / 2, o.height / 2], axis: "y", d: bolt }));
    }
    if (!rec?.ribs)
        reqs.push(gapIs({ name: `bore ${f(bore)} across`, at: [0, 0, o.height / 2], axis: "y", w: bore }));
    if (rec)
        reqs.push(interfaceRecord(rec));
    if (rec && split) {
        // what it must do: the screw's pinch grips the tube over the whole size range; the ring's strain stays in bounds
        const pinch = 50;
        reqs.push(facts({ from: "clampRing", supports: [{ id: "tube", kind: "pole", at: [0, 0, 0], axis: [0, 0, 1], d: o.around, span: [0, o.height] }],
            flexures: { clamp: { kind: "ribClamp", bore, wall: o.wall, height: o.height, gap, ear: el, ribs: rec.ribs ? { count: rec.ribs.count, height: rec.ribs.height, r: Math.max(0.6, rec.ribs.height) } : undefined, pinch, why: `a ${pinch} N pinch across the ears (an M3 screw done up by hand: assumed)` } },
            requirements: [
                { id: "grip", grips: { flexure: "clamp", min: 15, over: rec.holds }, why: "holds with at least 15 N along the tube over the whole size range" },
                { id: "grip.month", grips: { flexure: "clamp", min: 15, over: rec.holds, after: 2.6e6 }, why: "and after a month (the screw can be re-tightened)" },
                { id: "ring.strain", strain: { flexure: "clamp", use: "repeated", over: rec.holds }, why: "the ring's bending strain when closed on the smallest size" },
            ] }));
    }
    return s.require(...reqs);
}
/**
 * A fit coupon: a short slice of a drop-in pocket for an object of section `fits` = [w, d] (corner
 * radius `corner_r`), modelled at `perSide` mm per side, `height` tall with a lead-in on top, and
 * `marks` notches on its rim so coupons can be told apart without reading text. Print a few at
 * different perSide values and drop the object into each: that measures this printer's correction.
 */
export function fitCoupon(o) {
    const [w, d] = o.fits, c = o.perSide, h = o.height ?? 10, wall = o.wall ?? 2.4, li = o.leadIn ?? 1, r = (o.corner_r ?? 0) + c;
    const [x, y] = o.at ?? [0, 0];
    need(o.marks >= 1 && o.marks <= 5, "fitCoupon: marks must be 1 to 5 notches");
    const inner = rect({ size: [w + 2 * c, d + 2 * c], center: [x, y], r });
    let ring = inner.offset(wall).extrude({ z: [0, h], bottom: { chamfer: 0.4 } }).cut(inner.extrude({ z: [-1, h + 0.01], top: { flare: li } }));
    const notches = [];
    const ow = w + 2 * c + 2 * wall;
    for (let k = 0; k < o.marks; k++) {
        const nx = x - ((o.marks - 1) * 6) / 2 + k * 6;
        notches.push(box({ x: [nx - 1.25, nx + 1.25], y: [y - (d / 2 + c + wall + 1), y - (d / 2 + c) + 0.01], z: [h - 3, h + 1] }));
    }
    ring = ring.cut(...notches);
    void ow;
    // the coupon's own interface record: the modelled clearance is the variable under test, so the
    // person's answer ("too tight" ... "fell out") calibrates the print correction for this printer
    const rec = decideFit({ function: "drops-in", measured: "calipers", clearance: c, because: `fit coupon (${o.marks} notch${o.marks > 1 ? "es" : ""})` }, { id: `coupon.${o.marks}`, feature: `fit ring, ${o.marks} notch${o.marks > 1 ? "es" : ""}`, what: "the object's section", size: Math.min(w, d), shape: "flat", question: "" });
    return ring.require(interfaceRecord(rec), sectionFits({ what: `coupon ${c} per side`, z: h / 2 - 1, around: [x, y], size: [w + 2 * c, d + 2 * c] }));
}
