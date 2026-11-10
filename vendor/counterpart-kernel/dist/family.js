/**
 * The part family as first-class features (round 2). Each takes the object's measured section or outline,
 * a function for every interface and a mount, and returns a part that prints without supports in the
 * stated orientation (Z up as built), with
 *  - the geometric requirements the run measures on the mesh (sizes, holes, walls), and
 *  - the facts the physics engine proves (supports, loads, the object, flexures, requirements: src/facts.ts).
 * Conventions as in src/intent.ts: mm, Z up = print orientation, bed at z = 0; wall-mounted parts have the
 * wall at y = 0 and extend towards +y.
 */
import { box, cylinder, cone, rect, circle, polygon, path, Solid, KernelError } from "./api.js";
import { sectionFits, holeIs, thicknessIs, gapIs } from "./checks.js";
import { decideFit, PRINT_CORRECTION } from "./fit.js";
import { interfaceRecord, wallScrews, widthAt, pocket } from "./intent.js";
import { facts } from "./facts.js";
import { clampRing } from "./intent.js";
import { ENGINE, SIZING, ov, solveFrame2D, sized, mat } from "./sizing.js";
const f3 = (v) => Number(v.toFixed(3));
function need(cond, msg) { if (!cond)
    throw new KernelError(msg); }
/** A requirement the kernel proves by derivation (not a mesh measurement): its value is fixed at build time. */
export function derived(name, pass, measured, expected, fix) {
    return { name, run: () => ({ name, pass, measured, expected, fix: pass ? undefined : fix }) };
}
function objOutlineTop(o) {
    if (o.d)
        return circle({ d: o.d }).ex?.contours?.[0] ?? null;
    if (o.section)
        return rect({ size: o.section, r: o.corner_r ?? 0 }).ex?.contours?.[0] ?? null;
    return null;
}
function objMass(o, areaMm2, h) {
    if (o.kg !== undefined)
        return { kg: o.kg, assumed: false };
    return { kg: Number(((areaMm2 * h) / 1e6).toFixed(3)), assumed: true };
}
/**
 * A back plate on the wall (y = 0 .. t) spanning x0..x1 and z 0..H, held by the mount. `xs` are the
 * preferred screw positions (between pockets); `keepOut` x ranges the screws must avoid.
 */
function wallMount(m, o) {
    const out = { add: [], cut: [], reqs: [], supports: [], notes: [], plateT: 0 };
    const [x0, x1] = o.x;
    if (m.kind === "screws") {
        const t = m.plate ?? 4, screw = m.screw ?? 4.5, head = m.head ?? 9, n = m.count ?? 2;
        out.plateT = t;
        out.add.push(box({ x: [x0, x1], y: [0, t], z: [0, o.H] }));
        const z = m.z ?? f3(o.H * 0.72);
        need(z - head / 2 >= 0.8 && z + head / 2 <= o.H - 0.8, `${o.feature}: screws at z=${z} put the ${head} mm head within 0.8 mm of the plate's edge (height ${f3(o.H)})`);
        const xs = o.xs && o.xs.length >= n ? pickSpread(o.xs, n) : Array.from({ length: n }, (_, i) => (n === 1 ? (x0 + x1) / 2 : x0 + head / 2 + 2 + ((x1 - x0 - head - 4) * i) / (n - 1)));
        out.cut.push(wallScrews({ at: xs.map((x) => [x, z]), plate: [0, t], d: screw, head }));
        xs.forEach((x, i) => out.supports.push({ id: `screw.${i + 1}`, kind: "screw", at: [x, 0, z], axis: [0, 1, 0], d: screw, head, countersunk: true }));
        out.supports.push({ id: "wall", kind: "wall", point: [0, 0, 0], normal: [0, 1, 0] });
    }
    else if (m.kind === "keyhole") {
        // hangs on screw heads: a head hole, a slot up for the shank, and a recess behind for the head
        const t = m.plate ?? 5, screw = m.screw ?? 4, head = m.head ?? 8, lip = 1.8;
        need(t >= lip + 2, `${o.feature}: a keyhole plate must be at least ${lip + 2} mm thick (got ${t})`);
        out.plateT = t;
        out.add.push(box({ x: [x0, x1], y: [0, t], z: [0, o.H] }));
        const z = m.z ?? f3(o.H * 0.6), slot = 8, hd = head + 0.6, sd = screw + 0.6;
        need(z + slot + hd / 2 + 2 <= o.H, `${o.feature}: the keyhole needs ${f3(slot + hd / 2 + 2)} mm above z=${z}; the plate is ${f3(o.H)} tall`);
        const xs = o.xs && o.xs.length >= 2 ? pickSpread(o.xs, 2) : [x0 + (x1 - x0) * 0.2, x1 - (x1 - x0) * 0.2];
        for (const [i, x] of xs.entries()) {
            out.cut.push(cylinder({ d: hd, x, y: [-1, t + 1], z })); // head goes in here
            out.cut.push(box({ x: [x - sd / 2, x + sd / 2], y: [-1, t + 1], z: [z, z + slot] })); // shank slides up
            out.cut.push(cylinder({ d: sd, x, y: [-1, t + 1], z: z + slot }));
            out.cut.push(box({ x: [x - hd / 2, x + hd / 2], y: [-1, t - lip], z: [z, z + slot] })); // head rides behind the lip
            out.cut.push(cylinder({ d: hd, x, y: [-1, t - lip], z: z + slot }));
            out.reqs.push(gapIs({ name: `keyhole slot ${f3(sd)} for a ${screw} mm screw at x=${f3(x)}`, at: [x, t - lip / 2, z + slot / 2], axis: "x", w: sd, tol: 0.06 }));
            out.supports.push({ id: `keyhole.${i + 1}`, kind: "keyhole", at: [x, 0, z + slot], axis: [0, 1, 0], d: screw, head });
        }
        out.supports.push({ id: "wall", kind: "wall", point: [0, 0, 0], normal: [0, 1, 0] });
        out.notes.push(`keyholes: drive two ${screw} mm screws ${f3(xs[1] - xs[0])} mm apart, heads standing ${f3(t - lip - 0.5)} mm proud of the wall, and hang the part on them`);
    }
    else if (m.kind === "adhesive") {
        const t = m.plate ?? 3, pad = m.pad ?? [50, 18];
        out.plateT = t;
        need(x1 - x0 >= pad[0] && o.H >= pad[1], `${o.feature}: the ${pad[0]} x ${pad[1]} mm pad does not fit the ${f3(x1 - x0)} x ${f3(o.H)} back`);
        out.add.push(box({ x: [x0, x1], y: [0, t], z: [0, o.H] }));
        const zc = o.H - pad[1] / 2 - 2;
        out.supports.push({ id: "pad", kind: "adhesive", where: { plane: { point: [0, 0, 0], normal: [0, -1, 0] }, within: [[-pad[0] / 2, pad[0] / 2], [-0.6, 0.6], [zc - pad[1] / 2, zc + pad[1] / 2]] }, area: pad[0] * pad[1] });
        out.supports.push({ id: "wall", kind: "wall", point: [0, 0, 0], normal: [0, 1, 0] });
        out.notes.push(`adhesive pad ${pad[0]} x ${pad[1]} mm on the flat back, high on the plate (it carries the prying load in tension)`);
    }
    else if (m.kind === "desk") {
        // standing on a desk: held by friction under its base; the engine's contact is frictionless, so the base is held (stated)
        out.supports.push({ id: "desk", kind: "fixed", where: { plane: { point: [0, 0, 0], normal: [0, 0, -1] }, within: [[-1e4, 1e4], [-1e4, 1e4], [-0.6, 0.6]] } });
    }
    else if (m.kind === "clamp") {
        // a clamp ring around a vertical pole behind the part
        const t = 4;
        out.plateT = t;
        out.add.push(box({ x: [x0, x1], y: [0, t], z: [0, o.H] }));
        const ring0 = clampRing({ around: m.around, fit: { function: "clamps", measured: m.measured ?? "calipers" }, wall: m.wall ?? 4, height: Math.min(o.H, 30) });
        // the ring's wall probe faces the plate here: keep its other requirements
        const ring = new Solid(ring0.sdf, ring0.label, ring0.poly, ring0.whyNoPoly, ring0.checks.filter((c) => !/^ring wall/.test(c.name)));
        const rb = ring.bounds();
        const R = -rb.min[0];
        out.add.push(ring.move(0, -R + 1.5, 0));
        out.supports.push({ id: "pole", kind: "pole", at: [0, -R + 1.5, 0], axis: [0, 0, 1], d: m.around, span: [0, Math.min(o.H, 30)] });
    }
    if (o.plateIncluded && m.kind !== "clamp")
        out.add = [];
    if (o.plateIncluded && m.kind === "clamp")
        out.add = out.add.slice(1);
    return out;
}
function pickSpread(xs, n) {
    if (n === 1)
        return [xs[Math.floor(xs.length / 2)]];
    return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
}
// ------------------------------------------------------------------------------------------------
// Holder: one object, any mount
export function holder(o) {
    const ob = o.object;
    need(!!(ob.section || ob.d), "holder: give the object's section: object: { section: [w, d], corner_r } or { d } (for a front-loading outline use rack with count: 1)");
    const round = !!ob.d;
    const size = round ? ob.d : Math.min(...ob.section);
    const rec = decideFit(o.fit, { id: "holder.cavity", feature: "holder cavity", what: "the object's section", size, shape: round ? "round" : "flat", inferred: "drops-in", question: "how should the object sit in the holder?" });
    const c = rec.modelled_per_side, wall = ov("holder.wall", o.wall ?? 2.4), floor = ov("holder.floor", o.floor ?? 3);
    const mount = o.mount ?? { kind: "screws" };
    const bc = o.baseChamfer ?? 0.4, bottom = bc > 0 ? { bottom: { chamfer: bc } } : {};
    const [bw, bd] = round ? [ob.d, ob.d] : ob.section;
    const r0 = round ? ob.d / 2 : ob.corner_r ?? 0;
    const cw = bw + 2 * c, cd = bd + 2 * c, cr = Math.min(r0 + c, Math.min(cw, cd) / 2);
    const H = floor + o.depth;
    const wallMounted = mount.kind !== "desk";
    const reqs = [interfaceRecord(rec)];
    const ow = cw + 2 * wall, od = cd + 2 * wall;
    let mounted;
    let cy;
    if (wallMounted) {
        const wing = mount.kind === "screws" ? 15 : mount.kind === "keyhole" ? 14 : mount.kind === "adhesive" ? Math.max(0, ((mount.pad?.[0] ?? 50) - ow) / 2 + 2) : 0;
        const pw = ow + 2 * wing;
        mounted = wallMount(mount, { x: [-pw / 2, pw / 2], H, xs: mount.kind === "screws" || mount.kind === "keyhole" ? [-(ow / 2 + wing / 2), ow / 2 + wing / 2] : undefined, feature: "holder" });
        cy = mounted.plateT + cd / 2;
    }
    else {
        mounted = wallMount(mount, { x: [-ow / 2, ow / 2], H, feature: "holder" });
        cy = 0;
    }
    let body = rect({ size: [ow, od], center: [0, cy], r: cr + wall }).extrude({ z: [0, H], ...bottom });
    for (const a of mounted.add)
        body = body.add(a.require());
    const cuts = [rect({ size: [cw, cd], center: [0, cy], r: cr }).extrude({ z: [floor, H + 1] }), ...mounted.cut];
    reqs.push(...mounted.reqs);
    // probes clear of the drain and the front slot (worker run A7: a 55 mm nozzle hole and a slot to the floor left
    // both probes measuring air)
    const slotFrom = o.frontSlot ? floor + o.frontSlot.above_floor : Infinity;
    const zSec = Math.min(floor + Math.min(10, o.depth / 3), slotFrom - 1);
    const xFloor = o.drain && o.drain / 2 > cw / 4 - 1 ? (Math.min(cw, cd) / 2 + o.drain / 2) / 2 : cw / 4;
    if (zSec > floor + 0.5)
        reqs.push(sectionFits({ what: "cavity", z: zSec, around: [0, cy], size: [cw, cd] }));
    else
        reqs.push(derived(`cavity ${f3(cw)} x ${f3(cd)}: not measured as a closed section (the front slot runs down to the floor)`, true, "open at the front", "the fit is stated in the receipt"));
    if (!o.drain || o.drain / 2 < Math.min(cw, cd) / 2 - 2)
        reqs.push(thicknessIs({ name: `floor ${floor}`, at: [xFloor, cy, floor / 2], axis: "z", t: floor }));
    if (o.drain) {
        cuts.push(cylinder({ d: o.drain, x: 0, y: cy, z: [-1, floor + 1] }));
        reqs.push(holeIs({ name: `drain d${o.drain}`, at: [0, cy, floor / 2], axis: "z", d: o.drain }));
    }
    if (o.frontSlot) {
        const fy = cy + cd / 2;
        need(o.frontSlot.width < cw, `holder: front slot ${o.frontSlot.width} mm is wider than the ${f3(cw)} mm cavity`);
        // the slot's bottom corners are sharp inside corners in the path of a knock: filleted (physics round 2: on this
        // holder under a 60 N knock, r 1 / 2 / 3 mm gave SF 1.65 / 2.53 / 3.05)
        const sr = f3(Math.min(3, o.frontSlot.width / 2 - 0.01, Math.max(0.5, (H + 1 - floor - o.frontSlot.above_floor) / 2 - 0.01)));
        cuts.push(rect({ x: [-o.frontSlot.width / 2, o.frontSlot.width / 2], y: [floor + o.frontSlot.above_floor, H + 1 + sr], r: sr }).extrude({ y: [fy - 1, fy + wall + 1] }));
    }
    // desk: a base wide enough not to tip over when knocked, with the object in it
    const objH = ob.height ?? 2 * o.depth;
    const area = round ? Math.PI * bw * bw / 4 : bw * bd;
    const mass = objMass(ob, area, objH);
    if (mount.kind === "desk") {
        const tilt = mount.tilt ?? 15;
        const partKg = (ow * od * H - cw * cd * o.depth) * 1.24e-6;
        const zcg = (mass.kg * (floor + objH / 2) + partKg * H / 2) / (mass.kg + partKg);
        const half = Math.max(od / 2, zcg * Math.tan((tilt * Math.PI) / 180));
        const flange = Math.ceil(Math.max(0, half - od / 2) * 100 + 1) / 100; // rounded up: never short of the angle
        if (flange > 0)
            body = body.add(rect({ size: [ow + 2 * flange, od + 2 * flange], center: [0, cy], r: cr + wall + flange }).extrude({ z: [0, Math.min(3, H)], ...bottom }));
        const tipAt = (Math.atan((od / 2 + flange) / zcg) * 180) / Math.PI;
        reqs.push(derived(`stands on the desk: tips over at ${tipAt.toFixed(1)} deg with the ${mass.kg} kg object in it`, tipAt >= tilt - 1e-6, `${tipAt.toFixed(1)} deg (base ${f3(od + 2 * flange)} mm deep, centre of mass ${zcg.toFixed(1)} mm up)`, `>= ${tilt} deg`, "widen the base"));
    }
    let s = body.cut(...cuts).require(...reqs);
    // what it must do
    const outline = objOutlineTop(ob).map(([x, y]) => [x, y + cy]);
    const dn = mounted.supports.length ? undefined : undefined;
    void dn;
    const reqF = [
        { id: "strength", holds: { safetyFactor: 3 }, why: "carries the object and a 20 N pull on the rim with margin" },
        { id: "stiffness", deflection: { max: 1 }, why: "the rim moves at most 1 mm under that pull" },
        { id: "tilt.x", staysIn: { tilt: 30, axis: [1, 0, 0] }, why: "the object stays in when the holder is knocked forward or back" },
        { id: "tilt.y", staysIn: { tilt: 30, axis: [0, 1, 0] }, why: "and sideways" },
        { id: "lift", liftsOut: { along: [0, 0, 1] }, why: "it lifts straight out" },
    ];
    const fx = {
        from: "holder", supports: mounted.supports,
        // the walls are the parameter a strength fix changes as a whole (local thickening does not help: physics round 2)
        parameters: [{ name: "wall", value: wall, unit: "mm", feature: "holder", id: "holder.wall" }, { name: "floor", value: floor, unit: "mm", feature: "holder", id: "holder.floor" }],
        object: { name: ob.name ?? "object", kg: mass.kg, prism: { outline, axis: "z", span: [floor, floor + objH] }, size: { nominal: size, uncertainty: rec.object.uncertainty, source: rec.object.source } },
        loads: [
            { id: "weight", kind: "weight", kg: mass.kg, at: { plane: { point: [0, cy, floor], normal: [0, 0, 1] }, within: [[-cw / 2, cw / 2], [cy - cd / 2, cy + cd / 2], [floor - 0.6, floor + 0.6]] }, why: `the ${mass.kg} kg object${mass.assumed ? " (assumed: its volume full of water)" : ""} on the floor` },
            { id: "pull", kind: "pull", N: 20, dir: [0, 1, 0], at: { plane: { point: [0, 0, H], normal: [0, 0, 1] }, within: [[-ow / 2, ow / 2], [cy + cd / 2, cy + cd / 2 + wall], [H - 0.6, H + 0.6]] }, why: "a hand pulling the front rim, 20 N" },
        ],
        requirements: reqF,
    };
    s = s.require(facts(fx));
    return s;
}
// ------------------------------------------------------------------------------------------------
// Rack: a row of pockets for several objects
export function rack(o) {
    need(!!o.object !== !!o.objects, "rack: give object and count (the same object in every pocket) or objects: [...] (one pocket each)");
    const obs = o.objects ?? Array.from({ length: o.count ?? 0 }, () => o.object);
    const ob = obs[0], n = obs.length;
    need(Number.isInteger(n) && n >= 1 && n <= 24, `rack: count must be 1 to 24 (got ${n})`);
    need(!o.objects || !ob.outline, "rack: objects: [...] is for objects dropped in from the top (each a section or d)");
    const entry = o.entry ?? (ob.outline ? "front" : "top");
    const divider = o.divider ?? 5, endWall = o.endWall ?? Math.max(divider, 3), floor = o.floor ?? 3;
    const mount = o.mount ?? { kind: "screws" };
    const reqs = [];
    const bc = o.baseChamfer ?? 0.4;
    if (entry === "front") {
        need(!!(ob.outline && ob.thickness), "rack (front entry): give object: { outline: <front view, base at sketch y = 0>, thickness }");
        const outline = ob.outline, ob2 = outline.bounds();
        const rec = decideFit(o.fit, { id: "rack.pocket", feature: "rack pocket", what: "the object's outline", size: Math.min(ob2.size[0], ob.thickness), shape: "flat", inferred: "drops-in", question: "how should the objects sit in the rack?" });
        const c = rec.modelled_per_side;
        const W = ob2.size[0], pw = W + 2 * c, pitch = pw + divider;
        const width = n * pw + (n - 1) * divider + 2 * endWall;
        const H = o.height ?? f3(floor + c + Math.min(ob2.size[1], ob2.size[1] * 0.85));
        const plateT = mount.kind === "screws" ? mount.plate ?? 6 : mount.kind === "keyhole" ? mount.plate ?? 6 : mount.kind === "adhesive" ? mount.plate ?? 4 : 4;
        const D = o.depth ?? f3(plateT + ob.thickness + 2 * c + (o.wall ?? 0));
        need(D >= plateT + ob.thickness + c, `rack: depth ${D} leaves no room for the ${ob.thickness} mm object in front of the ${plateT} mm plate`);
        const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);
        const xc = (ob2.min[0] + ob2.max[0]) / 2;
        let body = rect({ x: [-width / 2, width / 2], y: [0, D] }).extrude({ z: [0, H], ...(bc > 0 ? { bottom: { chamfer: bc } } : {}) });
        const m2 = mount.kind === "screws" ? { ...mount, plate: plateT, count: mount.count ?? n } : mount.kind === "keyhole" ? { ...mount, plate: plateT } : mount;
        const mounted = wallMount(m2, { x: [-width / 2, width / 2], H, xs, feature: "rack", plateIncluded: true });
        for (const a of mounted.add)
            body = body.add(a);
        const pockets = xs.map((x, i) => pocket({ outline: outline.move(-xc, 0), fit: o.fit ?? "drops-in", along: "y", span: [plateT, D], leadIn: o.leadIn ?? 1.5, at: [x, floor + c], name: `${i + 1}`,
            probes: [Math.min(10, ob2.size[1] / 4), ...probeHeights(outline, ob2)] }));
        // pockets open at the top: carry the outline's top width up through the rim
        const topY = floor + c + ob2.max[1];
        const extra = [];
        if (topY < H + 0.5) {
            const wt = widthAt(outline, ob2.max[1] - 0.05);
            const hw = (wt ? wt.width : W) / 2 + c;
            for (const x of xs)
                extra.push(box({ x: [x - hw, x + hw], y: [plateT, D + 1], z: [topY - 0.5, H + 1] }));
        }
        body = body.cut(...pockets, ...extra, ...mounted.cut).require(...mounted.reqs, thicknessIs({ name: `floor ${floor} under pocket 1`, at: [xs[0], plateT + (D - plateT) / 2, floor / 2], axis: "z", t: floor }), ...(n > 1 ? [thicknessIs({ name: `divider ${f3(divider)} between pockets 1 and 2`, at: [(xs[0] + xs[1]) / 2, plateT + (D - plateT) / 2, floor + 5], axis: "x", t: divider, min: true })] : []));
        // facts: each object a prism of its outline through its thickness, seated on the floor; weight on every floor
        const objPts = outline.ex?.contours?.[0];
        const mass = objMass(ob, Math.abs(polyArea(objPts ?? [])), ob.thickness);
        const y0 = plateT + c;
        const fx = {
            from: "rack", supports: mounted.supports,
            object: objPts ? { name: ob.name ?? "object", kg: mass.kg, prism: { outline: objPts.map(([u, v]) => [u - xc + xs[0], v + floor + c]), axis: "y", span: [y0, y0 + ob.thickness] }, size: { nominal: Math.min(ob2.size[0], ob.thickness), uncertainty: rec.object.uncertainty, source: rec.object.source } } : undefined,
            loads: [
                ...xs.map((x, i) => ({ id: `weight.${i + 1}`, kind: "weight", kg: mass.kg, at: { plane: { point: [x, 0, floor], normal: [0, 0, 1] }, within: [[x - pw / 2, x + pw / 2], [plateT, D], [floor - 0.6, floor + 0.6]] }, why: `object ${i + 1}, ${mass.kg} kg${mass.assumed ? " (assumed: its volume of water)" : ""}` })),
                { id: "pull", kind: "pull", N: 20, dir: [0, 1, 0], at: { box: [[xs[0] - pw / 2 - divider, xs[0] - pw / 2], [D - 3, D], [0.55 * H, 0.85 * H]] }, why: "a 20 N pull on the front of the end wall" },
            ],
            requirements: [
                { id: "strength", holds: { safetyFactor: 3 }, why: "carries every object and a 20 N pull with margin" },
                { id: "stiffness", deflection: { max: 1 } },
                { id: "slide", liftsOut: { along: [0, 1, 0] }, why: "each object slides straight out of the front" },
                { id: "tilt.y", staysIn: { tilt: 20, axis: [0, 1, 0] }, why: "an object stays in when the rack is knocked sideways" },
            ],
        };
        return body.require(facts(fx));
    }
    // top entry: a row of cups sharing walls
    need(obs.every((q) => !!(q.section || q.d)), "rack (top entry): give each object as { section: [w, d], corner_r } or { d }");
    const round = !!ob.d;
    const sz = obs.map((q) => (q.d ? [q.d, q.d] : q.section));
    const [bw, bd] = sz[0];
    const rec = decideFit(o.fit, { id: "rack.pocket", feature: "rack pocket", what: "the object's section", size: Math.min(...sz.flat()), shape: round ? "round" : "flat", inferred: "drops-in", question: "how should the objects sit in the rack?" });
    const c = rec.modelled_per_side, wall = ov("rack.wall", o.wall ?? 2.4);
    const depth = o.depth ?? 40;
    need(depth > 0, "rack: depth must be > 0");
    // each pocket its own size (worker run A9: three jars of 45, 52 and 60 mm), all lined up against the back
    const cws = sz.map(([w]) => w + 2 * c), cds = sz.map(([, d]) => d + 2 * c);
    const cw = cws[0], cdOne = Math.max(...cds);
    // rows front to back (worker run A10: six batteries in two rows of three): the pockets' block is that deep
    const nRows = o.rows ?? 1;
    need(Number.isInteger(nRows) && nRows >= 1 && nRows <= 12, `rack: rows must be 1 to 12 (got ${nRows})`);
    need(nRows === 1 || !o.mount || o.mount.kind === "desk" || o.mount.kind === "screws" || o.mount.kind === "adhesive", "rack: rows work with a desk, screws or an adhesive pad");
    const cd = nRows * cdOne + (nRows - 1) * divider;
    const crs = obs.map((q, i) => (q.d ? cws[i] / 2 : Math.min((q.corner_r ?? 0) + c, Math.min(cws[i], cds[i]) / 2)));
    const H = floor + depth;
    const width = cws.reduce((a, b) => a + b, 0) + (n - 1) * divider + 2 * endWall;
    const xs = [];
    {
        let x = -width / 2 + endWall;
        for (const w of cws) {
            xs.push(x + w / 2);
            x += w + divider;
        }
    }
    void bw;
    void bd;
    const wallMounted = mount.kind !== "desk";
    // screws behind the pockets cannot be reached with a driver (worker run A9r drilled holes through the front wall):
    // they go in wings beyond the end walls, as on the holder
    const wing = mount.kind === "screws" ? (mount.head ?? 9) + 6 : 0;
    const mounted = mount.kind === "screws"
        ? wallMount({ ...mount, count: 2 }, { x: [-width / 2 - wing, width / 2 + wing], H, xs: [-width / 2 - wing / 2, width / 2 + wing / 2], feature: "rack" })
        : wallMount(mount, { x: [-width / 2, width / 2], H, xs, feature: "rack", plateIncluded: true });
    const plateT = wallMounted ? mounted.plateT : 0;
    const cy = plateT + wall * 0 + cd / 2 + (wallMounted ? 0 : 0);
    const od = cd + (wallMounted ? wall : 2 * wall);
    const y0 = wallMounted ? plateT : -cd / 2 - wall;
    let body = rect({ x: [-width / 2, width / 2], y: [wallMounted ? 0 : y0, wallMounted ? plateT + cd + wall : y0 + od], r: 0 }).extrude({ z: [0, H], ...(bc > 0 ? { bottom: { chamfer: bc } } : {}) });
    const ccy = wallMounted ? cy : 0;
    // pockets against the back (y = plate + cds[i] / 2 from it), so a smaller one leaves its extra wall at the front
    const rowY = (j) => ccy - cd / 2 + cdOne / 2 + j * (cdOne + divider);
    const pcy = (i, j = 0) => rowY(j) - (cdOne - cds[i]) / 2 * (wallMounted ? 1 : 0);
    const cups = Array.from({ length: nRows }, (_, j) => xs.map((x, i) => rect({ size: [cws[i], cds[i]], center: [x, pcy(i, j)], r: crs[i] }).extrude({ z: [floor, H + 1], top: o.leadIn ? { flare: o.leadIn + 1 } : undefined }))).flat();
    for (const a of mounted.add)
        body = body.add(a);
    body = body.cut(...cups, ...mounted.cut).require(interfaceRecord(rec), ...mounted.reqs, ...xs.map((x, i) => sectionFits({ what: `pocket ${i + 1}`, z: floor + Math.min(8, depth / 3), around: [x, pcy(i)], size: [cws[i], cds[i]] })), ...(nRows > 1 ? [sectionFits({ what: `row ${nRows}, pocket 1`, z: floor + Math.min(8, depth / 3), around: [xs[0], pcy(0, nRows - 1)], size: [cws[0], cds[0]] }), thicknessIs({ name: `divider ${f3(divider)} between rows`, at: [xs[0], rowY(0) + cdOne / 2 + divider / 2, floor + Math.min(8, depth / 3)], axis: "y", t: divider, min: true })] : []), ...(n > 1 ? [thicknessIs({ name: `divider ${f3(divider)}`, at: [xs[0] + cws[0] / 2 + divider / 2, pcy(0), floor + Math.min(8, depth / 3)], axis: "x", t: divider, min: true })] : []));
    const objH = ob.height ?? 2 * depth;
    const areas = obs.map((q, i) => (q.d ? (Math.PI * q.d * q.d) / 4 : sz[i][0] * sz[i][1]));
    const masses = obs.map((q, i) => objMass(q, areas[i], q.height ?? 2 * depth));
    const area = areas[0], mass = masses[0];
    const ol = objOutlineTop(ob);
    if (mount.kind === "desk") {
        // a base wide enough not to tip at `tilt` with every pocket full (the narrow direction governs)
        const tilt = mount.tilt ?? 15, od2 = cd + 2 * wall;
        const partKg = (width * od2 * H - nRows * areas.reduce((a, b) => a + b, 0) * depth) * 1.24e-6;
        const kgAll = nRows * masses.reduce((a, m) => a + m.kg, 0);
        const zcg = (kgAll * (floor + objH / 2) + partKg * H / 2) / (kgAll + partKg);
        const half = Math.max(od2 / 2, zcg * Math.tan((tilt * Math.PI) / 180));
        const flange = Math.ceil(Math.max(0, half - od2 / 2) * 100 + 1) / 100; // rounded up: never short of the angle
        // the base is cut by the pockets too (added after them, it refilled their bottoms under a floor thinner than 3 mm:
        // worker run A10r)
        if (flange > 0)
            body = body.add(rect({ size: [width + 2 * flange, od2 + 2 * flange], center: [0, ccy], r: Math.min(flange, 3) }).extrude({ z: [0, Math.min(3, H)], ...(bc > 0 ? { bottom: { chamfer: bc } } : {}) })).cut(...cups);
        const tipAt = (Math.atan((od2 / 2 + flange) / zcg) * 180) / Math.PI;
        body = body.require(derived(`stands on the desk: tips over at ${tipAt.toFixed(1)} deg with all ${n * nRows} pockets full (${mass.kg} kg each, ${objH} mm tall${mass.assumed ? ", mass assumed" : ""})`, tipAt >= tilt - 1e-6, `${tipAt.toFixed(1)} deg (base ${f3(od2 + 2 * flange)} mm deep, centre of mass ${zcg.toFixed(1)} mm up)`, `>= ${tilt} deg`, "widen the base"));
    }
    const fx = {
        from: "rack", supports: mounted.supports,
        object: { name: ob.name ?? "object", kg: mass.kg, prism: { outline: ol.map(([u, v]) => [u + xs[0], v + pcy(0)]), axis: "z", span: [floor, floor + objH] }, size: { nominal: Math.min(...sz[0]), uncertainty: rec.object.uncertainty, source: rec.object.source } },
        loads: [
            ...Array.from({ length: nRows }, (_, j) => xs.map((x, i) => ({ id: `weight.${j * n + i + 1}`, kind: "weight", kg: masses[i].kg, at: { plane: { point: [x, pcy(i, j), floor], normal: [0, 0, 1] }, within: [[x - cws[i] / 2, x + cws[i] / 2], [pcy(i, j) - cds[i] / 2, pcy(i, j) + cds[i] / 2], [floor - 0.6, floor + 0.6]] }, why: `object ${j * n + i + 1}, ${masses[i].kg} kg${masses[i].assumed ? " (assumed: its volume of water)" : ""}` }))).flat(),
            { id: "pull", kind: "pull", N: 20, dir: [0, 1, 0], at: { box: [[-width / 2, -width / 2 + endWall], [ccy + cd / 2, ccy + cd / 2 + wall], [H - 2, H]] }, why: "a 20 N pull on the front rim" },
        ],
        requirements: [
            { id: "strength", holds: { safetyFactor: 3 } }, { id: "stiffness", deflection: { max: 1 } },
            { id: "tilt.x", staysIn: { tilt: 30, axis: [1, 0, 0] } }, { id: "tilt.y", staysIn: { tilt: 30, axis: [0, 1, 0] } },
            { id: "lift", liftsOut: { along: [0, 0, 1] } },
        ],
    };
    if (mount.kind === "desk")
        fx.loads = fx.loads.filter((l) => l.id !== "pull");
    return body.require(facts(fx));
}
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q[0] * r[1] - r[0] * q[1];
} return a / 2; }
/** Heights where the outline is narrowest and widest (for pocket probes), away from its ends. */
function probeHeights(p, b) {
    let lo = { y: 0, w: Infinity }, hi = { y: 0, w: -Infinity };
    for (let i = 1; i < 40; i++) {
        const y = b.min[1] + (b.size[1] * i) / 40;
        const w = widthAt(p, y);
        if (!w)
            continue;
        if (w.width < lo.w)
            lo = { y, w: w.width };
        if (w.width > hi.w)
            hi = { y, w: w.width };
    }
    return [lo.y].filter((y) => y > 0).map(f3);
}
// ------------------------------------------------------------------------------------------------
// Bracket: a shelf bracket printed on its side (the L lies in the layers, so bending runs along them)
export function bracket(o) {
    // print frame: the L in the XY plane, extruded along z by `width`. Wall at x = 0 (normal +x), leg up +y,
    // shelf arm along +x at the top. In use: gravity is -y in this frame. Every member lies in the layers.
    const SF = o.safety ?? 3, kg = o.load.kg, at = o.load.at ?? o.shelf, F = kg * 9.81; // default: the load at the front edge (worst case)
    const sag = o.sag ?? Math.max(0.5, o.shelf / 100);
    const screw = o.screw ?? 4.5, head = o.head ?? 9, form = o.form ?? "truss";
    const hole = screwHole(screw, "clearance", "horizontal");
    const headD = f3(head + 2 * PRINT_CORRECTION.holeHorizontal);
    const zs = o.width / 2;
    const reqs = [];
    let prof, ys, t, tArm = 0;
    if (form === "truss") {
        // leg, arm and a diagonal brace in the print plane, sized by the physics engine's planar frame while it builds
        // (src/sizing.ts): the lightest leg, arm, brace and brace foot that carry the load with the model's margin
        const z = sizeTruss({ shelf: o.shelf, height: o.height, width: o.width, kg, at, SF, sag, head, headD, hole: hole.d, t: o.t, material: o.material });
        t = z.tl;
        const { ta, wb, yA, xB } = z;
        ys = z.ys;
        // the truss as one outline with every sharp inside corner filleted, not left for a failure to name it (the
        // engine names sharp inside corners and sizes their fillets; ~1.25 x the wall, survey 3.6): the outer boundary's
        // two (where the brace's outer face meets the arm and the leg) and the three of the open triangle inside
        const H = o.height, A = [t, yA], B = [xB, H - ta];
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]), d = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], nrm = [-d[1], d[0]];
        // the brace's inner face: line AB moved wb towards the corner between leg and arm
        const Ai = [A[0] + nrm[0] * wb, A[1] + nrm[1] * wb];
        const atX = (x) => [x, Ai[1] + ((x - Ai[0]) * d[1]) / d[0]];
        const atY = (y) => [Ai[0] + ((y - Ai[1]) * d[0]) / d[1], y];
        const C1 = atX(t), C2 = atY(H - ta), C3 = [t, H - ta];
        const edge = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
        const rIn = f3(Math.max(1, 1.25 * Math.min(t, ta, wb)));
        const rOut = (p, a, b) => f3(Math.min(rIn, 0.3 * edge(p, a), 0.3 * edge(p, b)));
        const outer = polygon([[0, 0], [0, H], [o.shelf, H], [o.shelf, H - ta], B, A, [t, 0]], { round: [0, 0, 0, 0, rOut(B, [o.shelf, H - ta], A), rOut(A, B, [t, 0]), 0] });
        const holeOK = C1[1] < H - ta - 1 && C2[0] > t + 1;
        const holeR = holeOK ? [C3, C1, C2].map((pt, i, a) => f3(Math.min(rIn, 0.3 * edge(pt, a[(i + 1) % 3]), 0.3 * edge(pt, a[(i + 2) % 3])))) : [];
        prof = holeOK ? outer.cut(polygon([C3, C1, C2], { round: holeR })) : outer;
        const r = rIn;
        void r;
        reqs.push(derived(`inside corners filleted: ${holeOK ? `the triangle's ${holeR.join(", ")} mm, ` : ""}where the brace meets the arm ${rOut(B, [o.shelf, H - ta], A)} mm and the leg ${rOut(A, B, [t, 0])} mm (1.25 x the thinnest member, as the engine sizes them)`, true, `${rIn} mm`, "no sharp inside corner in the load path"));
        tArm = ta;
        reqs.push(thicknessIs({ name: `leg ${t}`, at: [t / 2, (ys[0] + ys[1]) / 2, 2], axis: "x", t }), derived(`truss in the print plane: leg ${t} mm, arm ${ta} mm, brace ${wb} mm from ${f3(yA)} up the leg to ${f3(xB)} along the arm; sized by the physics engine for ${kg} kg at ${f3(at)} mm (${z.report.model}) and proved below`, true, `${t} / ${ta} / ${wb}`, "strength and sag proved below"));
        reqs.push(sized(z.report));
    }
    else {
        const S = 39, E = 2680;
        const tStrength = 1.3 * Math.sqrt((6 * F * at * SF) / (o.width * S));
        const tStiff = Math.cbrt((0.149 * 12 * F * at * at * (at / 3 + o.height)) / (E * o.width * sag * 0.85));
        t = o.t ?? f3(Math.max(4, Math.ceil(Math.max(tStrength, tStiff) * 2) / 2));
        const free = 3 * head + 6;
        need(o.height - t >= free + 10, `bracket: the ${o.height} mm leg is too short for a ${t} mm arm and two ${head} mm screws two heads apart (needs ${f3(free + 10 + t)})`);
        const g = f3(Math.min(0.55 * Math.min(o.shelf, o.height), o.height - t - free, o.shelf - t - 5));
        prof = path().moveTo(0, 0).lineTo(t, 0).lineTo(t, o.height - t - g).lineTo(t + g, o.height - t).lineTo(o.shelf, o.height - t).lineTo(o.shelf, o.height).lineTo(0, o.height).close();
        ys = [head / 2 + 3, o.height - t - g - head / 2 - 3];
        reqs.push(thicknessIs({ name: `leg ${t} (strength needs ${tStrength.toFixed(1)} incl. +30% for the corner; a sag of at most ${f3(sag)} needs ${tStiff.toFixed(1)})`, at: [t / 2, (ys[0] + ys[1]) / 2, 2], axis: "x", t }));
        tArm = t;
    }
    let s = prof.extrude({ z: [0, o.width] });
    if (form === "truss") {
        // screwdriver access through the brace, in line with each screw
        for (const y of ys)
            s = s.cut(cylinder({ d: head + 1, x: [t + 3, o.shelf + 1], y, z: zs }));
        reqs.push(derived(`screwdriver access through the brace in line with each screw (${head + 1} mm)`, true, "open", "a straight driver reaches each head"));
    }
    const k = (headD - hole.d) / 2;
    for (const y of ys)
        s = s.cut(cylinder({ d: hole.d, x: [-1, t + 1], y, z: zs }), cone({ d1: hole.d, d2: headD + 2, x: [t - k, t + 1], y, z: zs }));
    s = s.require(...reqs, thicknessIs({ name: `shelf arm ${tArm}`, at: [o.shelf - 3, o.height - tArm / 2, 2], axis: "y", t: tArm }), holeIs({ name: `screw holes ${hole.d} (${hole.why}), ${f3(ys[1] - ys[0])} mm apart`, at: [0.5, ys[0], zs], axis: "x", d: hole.d, tol: 0.08 }), ...ys.map((y, i) => holeIs({ name: `countersink ${headD} at the leg's face, screw ${i + 1}`, at: [t - 0.05, y, zs], axis: "x", d: headD - 0.1, tol: 0.08 })), derived(`printed on its side: the L lies in the layers, so the bending at the corner runs along them`, true, "z = the bracket's width", "bending within layers"));
    return s.require(facts({
        from: "bracket", down: [0, -1, 0],
        parameters: form === "truss" ? [{ name: "leg", value: t, unit: "mm", feature: "bracket", id: "bracket.leg", sized: true }, { name: "arm", value: tArm, unit: "mm", feature: "bracket", id: "bracket.arm", sized: true },
            { name: "screw spacing", value: f3(ys[1] - ys[0]), unit: "mm", feature: "bracket", id: "bracket.screwSpacing", sized: true }] : [{ name: "t", value: t, unit: "mm", feature: "bracket", id: "bracket.t" }],
        supports: [...ys.map((y, i) => ({ id: `screw.${i + 1}`, kind: "screw", at: [0, y, zs], axis: [1, 0, 0], d: screw, head, countersunk: true })), { id: "wall", kind: "wall", point: [0, 0, 0], normal: [1, 0, 0] }],
        loads: [{ id: "load", kind: "weight", kg, dir: [0, -1, 0], at: { box: [[Math.max(t, at - 5), Math.min(o.shelf, at + 5)], [o.height - 0.6, o.height + 0.6], [0, o.width]] }, why: `${kg} kg on the shelf, ${f3(at)} mm from the wall` }],
        requirements: [{ id: "strength", holds: { safetyFactor: SF }, why: `carries ${kg} kg with safety factor ${SF}` }, { id: "stiffness", deflection: { max: sag }, why: `the shelf sags at most ${f3(sag)} mm` }],
    }));
}
/**
 * Size a bracket truss with the physics engine's planar frame: leg (on the wall, screws high where it pulls off,
 * the wall pushing where it presses), arm, diagonal brace. Candidates: leg, arm and brace thickness, where the
 * brace meets the leg, screw spacing. Strength: the frame's peak fibre stress times a stress-concentration factor
 * (joints, holes, countersinks) that the whole-part solve calibrates; the brace is also checked for buckling in
 * the print plane. Keeps the lightest candidate with SF >= target x 1.15 (the engine's own peak-stress margin)
 * and sag within the limit.
 */
function sizeTruss(o) {
    const M = mat(o.material), F = o.kg * 9.81, H = o.height, W = o.width;
    const k = SIZING.k["bracket"] ?? TRUSS_KT, kd = SIZING.kd["bracket"] ?? 1;
    const csk = (o.headD - o.hole) / 2;
    const tlMin = Math.max(2.5, Math.ceil((csk + 1.2) * 2) / 2); // under the countersink: at least 1.2 mm (3 lines) of seat
    let headAt = 1; // where the brace meets the arm: 1 = near the tip, else a fraction of the way to the load
    const geom = (tl, ta, wb, foot, spacing) => {
        const r = f3(Math.max(1, 1.25 * Math.min(tl, ta, wb))); // the inside corner's fillet (the screws clear it)
        const yTop = H - ta - r - o.head / 2 - 2, ys = [f3(yTop - spacing * o.head), f3(yTop)];
        const yA = f3(Math.max(tl + 4, foot * H));
        if (!(yA >= tl + 2 && ys[0] - o.head / 2 > yA + wb + 2))
            return null;
        const tip = o.shelf - Math.max(8, ta);
        const xB = f3(Math.max(tl + 10, headAt >= 1 ? tip : Math.min(tip, Math.max(o.at + wb, headAt * tip))));
        return { tl, ta, wb, yA, xB, ys, r, key: `${foot}:${spacing}:${headAt}` };
    };
    const massOf = (g) => {
        const Lb = Math.hypot(g.xB - g.tl, H - g.ta - g.yA);
        return (g.tl * H + g.ta * (o.shelf - g.tl) + g.wb * Lb + g.r * g.r / 2 - 2 * o.hole * g.tl * 0.0) * W * M.rho;
    };
    const frame = (g) => {
        const yArm = H - g.ta / 2, xLeg = g.tl / 2;
        // the brace's centreline from its foot on the leg to its head under the arm
        const A = [xLeg, g.yA + g.wb / 2], B = [g.xB, yArm];
        // the screw holes and countersinks take their width from the leg, and their edges concentrate its stress (x1.5: the
        // whole-part solve put an 8 kg bracket's peak at the top screw hole's edge); the screwdriver holes through the brace are
        // left to the whole-part correction: as a width cut they made the frame 2.3x too pessimistic)
        const legB = (p) => (g.ys.some((y) => Math.abs(p[1] - y) < o.headD / 2) ? W - (o.hole + o.headD) / 2 : W);
        const res = solveFrame2D({ E: M.E, warm: g.key,
            members: [{ name: "leg", from: [xLeg, 0], to: [xLeg, yArm], h: g.tl, b: W, n: 16, bOf: legB, ktOf: (p) => (g.ys.some((y) => Math.abs(p[1] - y) < o.headD / 2) ? 1.5 : 1) }, { name: "arm", from: [xLeg, yArm], to: [o.shelf, yArm], h: g.ta, b: W, n: 12 }, { name: "brace", from: A, to: B, h: g.wb, b: W, n: 12 }],
            pins: g.ys.map((y, i) => ({ name: `screw.${i + 1}`, at: [xLeg, y] })),
            contacts: [{ name: "wall", normal: [1, 0], on: (p) => Math.abs(p[0] - xLeg) < 1e-6 }],
            loads: [{ name: "load", at: [Math.min(o.at, o.shelf), yArm], f: [0, -F] }] });
        // brace buckling in the print plane (joints between pinned and fixed: K = 0.85)
        const Lb = Math.hypot(B[0] - A[0], B[1] - A[1]), I = (W * g.wb ** 3) / 12, Pcr = (Math.PI ** 2 * M.E * I) / (0.85 * Lb) ** 2;
        const sigB = res.stress.find((s) => s.member === "brace")?.sigma ?? 0;
        const Nb = sigB * W * g.wb; // upper bound on the brace's axial force from its peak fibre stress
        return { res, buckleSF: Pcr / Math.max(Nb, 1e-9) };
    };
    // leave the engine's band, not sit on its line: peak stress on thin walls carries 25% at the fast setting the run
    // proves at (13-15% at normal; physics round 2)
    const needSF = o.SF * 1.25;
    // a driver reaches each screw from +x across the open triangle and through the brace: the length it must reach is
    // where the brace's underside crosses the screw's height (a worker run found a 60 mm leg needing a 200 mm bit)
    const REACH_MAX = 125; // a common driver (100 mm shaft and its bit); longer reaches are stated in the receipt
    const driverReach = (g) => Math.max(...g.ys.map((y) => { const yb = g.yA, xb = g.tl, yt = H - g.ta, xt = g.xB; return y <= yb ? g.tl : xb + ((y - yb) / Math.max(1e-6, yt - yb)) * (xt - xb) + g.wb; }));
    const label = (g) => `leg ${g.tl}, arm ${g.ta}, brace ${g.wb} from ${g.yA} up the leg to ${g.xB} along the arm, screws ${f3(g.ys[1] - g.ys[0])} apart (a screwdriver reaches ${driverReach(g).toFixed(0)} mm through the brace)`;
    function scoreOne(c) {
        let fr;
        try {
            fr = frame(c.params);
        }
        catch {
            return { ok: false, sf: 0, defl: Infinity, why: "buckles (the engine's nonlinear frame finds no equilibrium under the load)" };
        }
        const { res, buckleSF } = fr;
        const sf = M.S / (k * res.peak.sigma), defl = kd * Math.abs(res.deflection.load);
        const reach = driverReach(c.params);
        void reach;
        const ok = sf >= needSF && buckleSF >= needSF && defl <= o.sag;
        return { sf: Math.min(sf, buckleSF), defl, ok, why: ok ? undefined : sf < needSF ? `SF ${sf.toFixed(1)} at the ${res.peak.member}` : buckleSF < needSF ? `brace buckles at SF ${buckleSF.toFixed(1)}` : `sags ${defl.toFixed(2)} mm` };
    }
    if (!ENGINE || !geom(o.t ? Math.max(o.t, tlMin) : tlMin, o.t ?? 2.5, o.t ? f3(Math.max(5, 1.4 * o.t)) : 2.5, 0.12, 2)) {
        const tl = Math.max(tlMin, o.t ?? 3), g = geom(tl, tl, Math.max(5, 1.4 * tl), 0.12, 2) ?? geom(tl, tl, 3, 0.12, 1.5);
        need(!!g, `bracket: the ${H} mm leg is too short for a brace foot and two ${o.head} mm screws; make the leg taller or use form: "solid"`);
        const report = { feature: "bracket", requirement: `SF ${o.SF}, sag ${o.sag} mm`, model: ENGINE ? "fixed layout (no room to search)" : "hand rule (physics engine not built)", chosen: label(g), predicted: { massG: massOf(g) }, table: [], evaluated: 0, ms: 0 };
        return { ...g, report };
    }
    // Greedy, per layout (where the brace meets the leg, how far apart the screws are): start at the thinnest printable
    // members and thicken, one step at a time, the member whose step buys the most margin per gram, until the frame
    // meets the requirement. A fixed `t` turns the search off (one candidate).
    const t0 = performance.now();
    const step = (v) => f3(v < 4 ? v + 0.5 : v < 8 ? v + 1 : v * 1.2);
    const cap = { tl: Math.max(tlMin, H / 3), ta: H / 2.5, wb: H / 2.5 };
    const feet = o.t ? [0.12] : [0.12, 0.3], spacings = o.t ? [2] : [2, 1.5];
    // the brace's head near the arm's tip, or at the load (shorter and steeper: a short leg under a deep shelf buckles a long brace)
    const heads = o.t ? [1] : o.at < 0.8 * o.shelf ? [1, 0] : [1];
    const all = [];
    let evaluated = 0;
    const score = (g) => { evaluated++; const c = { label: label(g), params: g, massG: massOf(g) }; const r = scoreOne(c); const s2 = { ...c, ...r }; all.push(s2); return s2; };
    const margin = (x) => Math.min((x.sf ?? 0) / needSF, o.sag / Math.max(x.defl ?? Infinity, 1e-9));
    for (const hd of heads)
        for (const foot of feet)
            for (const spacing of spacings) {
                headAt = hd;
                let cur = geom(o.t ? Math.max(o.t, tlMin) : tlMin, o.t ?? 2.5, o.t ? f3(Math.max(5, 1.4 * o.t)) : 2.5, foot, spacing);
                if (!cur)
                    continue;
                let sc = score(cur);
                for (let it = 0; it < 30 && !sc.ok && !o.t; it++) {
                    let best = null;
                    for (const key of ["tl", "ta", "wb"]) {
                        const v = step(cur[key]);
                        if (v > cap[key])
                            continue;
                        const g = geom(key === "tl" ? v : cur.tl, key === "ta" ? v : cur.ta, key === "wb" ? v : cur.wb, foot, spacing);
                        if (!g)
                            continue;
                        const s2 = score(g), gain = (margin(s2) - margin(sc)) / Math.max(1e-6, s2.massG - sc.massG);
                        if (!best || gain > best.gain || (s2.ok && !best.s.ok))
                            best = { g, s: s2, gain };
                    }
                    if (!best)
                        break;
                    cur = best.g;
                    sc = best.s;
                }
            }
    // the lightest that meets it; a layout a standard driver can reach is preferred when it costs at most 10% more
    const oks0 = all.filter((x) => x.ok).sort((p, q) => p.massG - q.massG);
    const reachable = oks0.find((x) => driverReach(x.params) <= REACH_MAX && x.massG <= 1.1 * (oks0[0]?.massG ?? Infinity));
    const oks = reachable ? [reachable, ...oks0.filter((x) => x !== reachable)] : oks0;
    const chosen = oks[0] ?? all.slice().sort((p, q) => margin(q) - margin(p))[0];
    const minMass = Math.min(...all.map((x) => x.massG));
    const pick = { chosen: oks[0] ?? null, table: [...oks.slice(0, 4), ...all.filter((x) => !x.ok).sort((p, q) => q.massG - p.massG).slice(0, 2)], evaluated, ms: performance.now() - t0 };
    headAt = 1;
    // round 2's hand rule for the same load, judged by the same model (for the receipt and the report)
    const Lf = (o.kg * o.at) / 360, th = Math.max(3, Math.ceil(2 * 5 * Math.pow(0.2033 * Lf, 0.77)) / 2);
    const gh = geom(th, th, f3(Math.max(5, 1.4 * th)), 0.12, 2);
    let handRule;
    if (gh) {
        const { res } = frame(gh);
        handRule = { label: `round 2 rule: leg = arm = ${th}, brace ${gh.wb}`, massG: massOf(gh), sf: M.S / (k * res.peak.sigma), defl: kd * Math.abs(res.deflection.load) };
    }
    // The frame misjudges some layouts (its stress factor against the whole part ranged 0.29-0.94 across brackets; on a
    // 6 kg, 200 x 150 bracket it chose a 110 g truss weaker than round 2's 79 g rule). So round 2's rule stays a candidate:
    // when it is lighter than the frame's pick and the frame does not rule it out clearly (its SF at least half the
    // target), it is built and the whole-part proof decides (the runner rebuilds lighter if it carries too much margin).
    let c = chosen;
    if (gh && handRule && !o.t && handRule.massG < c.massG && (handRule.sf ?? 0) >= 0.5 * needSF && !SIZING.k["bracket"]) {
        c = { label: `${label(gh)} (round 2's rule: lighter than the frame's pick, which cannot rule it out; the whole-part proof decides)`, params: gh, massG: handRule.massG, sf: handRule.sf, defl: handRule.defl, ok: true };
    }
    const report = {
        feature: "bracket", requirement: `holds ${o.kg} kg at ${f3(o.at)} mm with SF ${o.SF} (sized to ${needSF.toFixed(2)}: the engine's 25% peak-stress band at the fast setting), brace buckling too, sag <= ${o.sag} mm`,
        model: `planar frame (physics engine solveFrame, Timoshenko), stress concentration x${k.toFixed(2)}${SIZING.k["bracket"] ? " (this run's whole-part correction)" : " (calibrated on the whole-part solve)"}`,
        chosen: c.label, predicted: { massG: c.massG, sf: c.sf, defl: c.defl }, handRule,
        table: pick.table.map(({ label, massG, sf, defl, ok, why }) => ({ label, massG, sf, defl, ok, why })), evaluated: pick.evaluated, ms: pick.ms,
        correction: SIZING.k["bracket"], need: needSF, kUsed: k, sagMax: o.sag, kdUsed: kd, atMinimum: !!pick.chosen && pick.chosen.massG <= minMass + 1e-9,
        notes: pick.chosen ? undefined : [`no truss within the ${H} mm leg met the requirement (best: ${c.why}); the closest is used and the proof below says by how much it falls short: a taller leg, a wider bracket or a lighter load would do it`],
    };
    return { ...c.params, report };
}
let TRUSS_KT = 0.65; // frame peak stress x 0.65 = whole-part peak, measured on the 3 kg, 120 x 100 truss (REPORT-round3.md)
export function setTrussKt(k) { TRUSS_KT = k; }
// ------------------------------------------------------------------------------------------------
// Spacers, shims and plates with holes and slots
/** Hole for a screw by what it must do: "clearance" (passes freely), "tap" (self-tapping pilot), "insert" (heat-set brass insert). */
export function screwHole(screw, use = "clearance", axis = "vertical") {
    const corr = axis === "vertical" ? PRINT_CORRECTION.holeVertical : PRINT_CORRECTION.holeHorizontal;
    if (use === "clearance") {
        const d = f3(screw + 2 * (0.2 + corr));
        return { d, why: `clearance for a ${screw} mm screw: + 0.2 per side (slides) + print correction ${corr} per side = ${d}` };
    }
    if (use === "tap") {
        const d = f3(0.85 * screw + 2 * corr);
        return { d, why: `pilot for a ${screw} mm self-tapping screw into plastic: 0.85 x ${screw} + print correction = ${d}` };
    }
    const INS = { 2: 3.2, 2.5: 3.6, 3: 4.0, 4: 5.6, 5: 6.4 }; // common heat-set insert hole sizes (M2..M5)
    const d0 = INS[screw];
    if (!d0)
        throw new KernelError(`screwHole: no heat-set insert size for M${screw}; use M2, M2.5, M3, M4 or M5`);
    return { d: d0, why: `heat-set insert for M${screw}: the insert maker's hole ${d0} (melts in, no print correction)` };
}
export function spacer(o) {
    const h = screwHole(o.screw, o.use ?? "clearance");
    const od = o.od ?? f3(h.d + 2 * Math.max(1.6, h.d * 0.4));
    need(od >= h.d + 2 * 0.8, `spacer: an outside diameter of ${od} leaves less than 0.8 mm of wall around the ${h.d} mm hole`);
    return circle({ d: od }).extrude({ z: [0, o.height], bottom: { chamfer: 0.3 } }).cut(cylinder({ d: h.d, x: 0, y: 0, z: [-1, o.height + 1] }))
        .require(holeIs({ name: `bore d${h.d} (${h.why})`, at: [0, 0, o.height / 2], axis: "z", d: h.d }), thicknessIs({ name: `height ${o.height}`, at: [(od + h.d) / 4, 0, o.height / 2], axis: "z", t: o.height }));
}
export function shim(o) {
    const [w, d] = o.size;
    let s = rect({ size: [w, d], r: o.corner_r ?? 1 }).extrude({ z: [0, o.thickness] });
    const reqs = [thicknessIs({ name: `thickness ${o.thickness} (${Math.round(o.thickness / 0.2)} layers of 0.2: print with a 0.2 mm first layer)`, at: [w / 4, 0, o.thickness / 2], axis: "z", t: o.thickness })];
    if (o.slot) {
        const h = screwHole(o.slot.screw), L = o.slot.length ?? d * 0.6;
        need(L + h.d < d, `shim: a ${L} mm slot does not fit the ${d} mm shim`);
        // a slot open at one edge, so the shim slides in under a loosened screw
        s = s.cut(box({ x: [-h.d / 2, h.d / 2], y: [d / 2 - L, d / 2 + 1], z: [-1, o.thickness + 1] }), cylinder({ d: h.d, x: 0, y: d / 2 - L, z: [-1, o.thickness + 1] }));
        reqs.push(gapIs({ name: `slot ${h.d} wide (${h.why})`, at: [0, d / 2 - L / 2, o.thickness / 2], axis: "x", w: h.d, tol: 0.06 }));
    }
    return s.require(...reqs);
}
export function plate(o) {
    const [w, d] = o.size, t = o.thickness;
    let s = rect({ size: [w, d], r: o.corner_r ?? 2 }).extrude({ z: [0, t], bottom: { chamfer: 0.4 } });
    const cuts = [], reqs = [];
    for (const hl of o.holes ?? []) {
        const h = screwHole(hl.screw, hl.use ?? "clearance");
        const [x, y] = hl.at;
        need(Math.abs(x) + h.d / 2 + 1 <= w / 2 && Math.abs(y) + h.d / 2 + 1 <= d / 2, `plate: the hole at (${x}, ${y}) is within 1 mm of the edge`);
        cuts.push(cylinder({ d: h.d, x, y, z: [-1, t + 1] }));
        if (hl.countersink) {
            const k = (hl.countersink - h.d) / 2;
            need(k < t - 0.6, `plate: a ${hl.countersink} mm countersink is deeper than the ${t} mm plate allows`);
            cuts.push(cone({ d1: h.d, d2: hl.countersink + 2, x, y, z: [t - k, t + 1] }));
            reqs.push(holeIs({ name: `countersink ${hl.countersink} at the top face, (${x}, ${y})`, at: [x, y, t - 0.05], axis: "z", d: hl.countersink - 0.1, tol: 0.06 }));
        }
        reqs.push(holeIs({ name: `hole d${h.d} at (${x}, ${y}): ${h.why}`, at: [x, y, Math.min(t / 2, 0.5)], axis: "z", d: h.d }));
    }
    for (const sl of o.slots ?? []) {
        const h = screwHole(sl.screw);
        const [x0, y0] = sl.from, [x1, y1] = sl.to, L = Math.hypot(x1 - x0, y1 - y0), ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
        const sp = rect({ size: [L + h.d, h.d], r: h.d / 2 - 1e-3 }).rotate(ang).move((x0 + x1) / 2, (y0 + y1) / 2);
        cuts.push(sp.extrude({ z: [-1, t + 1] }));
        const axisAligned = Math.abs(x1 - x0) < 1e-9 || Math.abs(y1 - y0) < 1e-9;
        if (axisAligned) {
            const along = Math.abs(y1 - y0) < 1e-9 ? "x" : "y", across = along === "x" ? "y" : "x";
            reqs.push(gapIs({ name: `slot for a ${sl.screw} mm screw: ${f3(L + h.d)} overall (centres ${f3(L)} apart: the screw travels ${f3(L)})`, at: [(x0 + x1) / 2, (y0 + y1) / 2, t / 2], axis: along, w: L + h.d, tol: 0.06 }), gapIs({ name: `slot ${h.d} wide (${h.why})`, at: [(x0 + x1) / 2, (y0 + y1) / 2, t / 2], axis: across, w: h.d, tol: 0.06 }));
        }
        else
            reqs.push(derived(`slot for a ${sl.screw} mm screw: centres ${f3(L)} apart (the screw travels ${f3(L)}), ${f3(L + h.d)} overall, ${h.d} wide`, true, `${h.d} wide`, h.why));
    }
    return s.cut(...cuts).require(...reqs, thicknessIs({ name: `plate ${t}`, at: [w / 2 - 2, 0, t / 2], axis: "z", t }));
}
void polygon;
// ------------------------------------------------------------------------------------------------
// Clip onto a shelf, desk edge or rail: a C printed flat (the C lies in the layers; every member bends in them)
/**
 * A C-clip over an edge of thickness `onto.thickness` (known to +- by `onto.measured`). Print frame: the board's
 * thickness runs along x (jaw 1 against its face x = 0, jaw 2 at the far face), it enters along -y towards the
 * spine at y = 0..wall; the clip is `width` wide in z. Hold:
 *  - "screw" (default; survey §4: a months-long hold comes from a screw): the jaws clear the largest board and a
 *    screw through jaw 2, with a hex nut trapped in it, takes up the rest. No preload is carried by the plastic.
 *  - "spring": jaw 2 is a cantilever sized from strain that pinches the board; a guard outside it is its stop.
 *    Held preload relaxes in PLA/PETG, so its long-term grip is reported as unsupported.
 * `hook` adds a J below jaw 1 to hang something on (`load` kg on it).
 */
export function clip(o) {
    const T = o.onto.thickness, m = o.onto.measured ?? "ruler";
    const u = typeof m === "number" ? Math.abs(m) : { designed: 0, calipers: 0.05, published: 0.3, ruler: 0.3, scan: 0.5, photo: 1.0 }[m];
    need(u !== undefined, `clip: measured must be designed, calipers, published, ruler, scan, photo or +-mm`);
    const hold = o.hold ?? "screw", R = o.reach, W = o.width;
    need(R >= 10, "clip: reach (how far the jaws go over the edge) must be at least 10 mm");
    // the C's wall (jaw under the board, spine, hook) sized by the engine's planar frame for the hung load (screw hold)
    const sizing = o.wall === undefined && hold === "screw" ? sizeClip({ T, u, R, W, screw: o.screw ?? 4, hook: o.hook, kg: o.load ?? (o.hook ? 1 : 2.04), material: o.material }) : null;
    const wall = o.wall ?? sizing?.wall ?? 4;
    const reqs = [];
    const parts = [];
    let G, jaw2T;
    const supports = [];
    const flex = {}, reqF = [];
    if (hold === "screw") {
        const sc = o.screw ?? 4, nutAF = sc === 4 ? 7.0 : 5.5, nutT = sc === 4 ? 3.2 : 2.4;
        G = f3(T + u + 2 * 0.25); // clears the largest board by 0.25 per side
        jaw2T = Math.max(wall, nutT + 3);
        const sy = wall + R * 0.6, sz = W / 2, hole = sc + 0.4;
        need(W >= nutAF / Math.cos(Math.PI / 6) + 2.4, `clip: a ${W} mm wide clip is too narrow for an M${sc} nut`);
        parts.push(box({ x: [-wall, 0], y: [0, wall + R], z: [0, W] }), box({ x: [-wall, G + jaw2T], y: [0, wall], z: [0, W] }), box({ x: [G, G + jaw2T], y: [0, wall + R], z: [0, W] }));
        let s = parts[0].add(...parts.slice(1));
        // screw along x through jaw 2; hex nut trapped from the outside, a vertex up (prints without support)
        const hex = path();
        const rr = nutAF / 2 / Math.cos(Math.PI / 6) + 0.15;
        // hexagon with its top vertex raised to a 45-degree roof, so the trap's ceiling prints without support
        for (let i = 0; i < 6; i++) {
            const a = Math.PI / 2 + (i * Math.PI) / 3;
            const k = i === 0 ? (0.5 + Math.cos(Math.PI / 6)) : 1;
            i ? hex.lineTo(sy + rr * Math.cos(a), sz + rr * Math.sin(a)) : hex.moveTo(sy, sz + rr * k);
        }
        s = s.cut(cylinder({ d: hole, x: [G - 1, G + jaw2T + 1], y: sy, z: sz }), hex.close().extrude({ x: [G + jaw2T - nutT - 0.3, G + jaw2T + 1] }));
        reqs.push(gapIs({ name: `opening ${G} (the largest board, ${f3(T + u)}, + 0.25 per side): the screw does the holding`, at: [G / 2, wall + R / 2, W / 4], axis: "x", w: G }), holeIs({ name: `M${sc} screw hole ${hole}`, at: [G + 0.5, sy, sz], axis: "x", d: hole, tol: 0.12 }));
        // the board pushes only: its underside on jaw 1 (down), its front edge on the spine; the tightened screw holds jaw 2
        // (round 2 held jaw 1's face fixed, which let the board pull the clip up and left the spine and jaw 2 unloaded)
        supports.push({ id: "board.under", kind: "edge", point: [0, 0, 0], normal: [-1, 0, 0], where: { box: [[-0.6, 0.6], [wall + 1, wall + R], [0, W]] } }, { id: "board.edge", kind: "edge", point: [0, wall, 0], normal: [0, -1, 0], where: { box: [[0, G], [wall - 0.6, wall + 0.6], [0, W]] } }, { id: "screw tip", kind: "fixed", where: { cylinder: { at: [G, sy, sz], axis: [1, 0, 0], r: hole / 2 + 2.5, span: [0, Math.max(2, jaw2T / 2)] } } });
        reqs.push(derived("held by a screw, not by preload (survey rule 4): grip does not relax away", true, `M${sc} with a trapped nut`, "re-tightenable"));
        s = s.require(...reqs);
        parts.length = 0;
        parts.push(s);
    }
    else {
        // spring: jaw 2 pinches; the tip gap is the smallest board minus 0.3; strain at the largest within the held allowance
        const tipGap = T - u - 0.3, yMax = f3(T + u - tipGap);
        const e = 0.009, l = R;
        let h = Math.max(1.7, Math.min(wall, (e * 0.67 * l * l) / yMax));
        const strain = (yMax * h) / (0.67 * l * l);
        need(strain <= 0.0101, `clip: a ${R} mm jaw cannot take ${yMax} mm of spring within 1% strain; lengthen reach to ${f3(Math.sqrt((yMax * 1.7) / (0.67 * 0.009)))} mm or use hold: "screw"`);
        G = f3(tipGap + h); // jaw 2's root sits at G; its inner face slopes to the tip gap
        jaw2T = h;
        const stop = f3(yMax + 0.6);
        let s = box({ x: [-wall, 0], y: [0, wall + R], z: [0, W] }).add(box({ x: [-wall, G + h + stop + 3], y: [0, wall], z: [0, W] }), path().moveTo(G, wall).lineTo(G + h, wall).lineTo(tipGap + h, wall + R).lineTo(tipGap, wall + R).close().extrude({ z: [0, W] }), box({ x: [G + h + stop, G + h + stop + 3], y: [0, wall + R * 0.8], z: [0, W] }));
        reqs.push(derived(`spring jaw ${R} long, ${f3(h)} thick, in the print plane: strain at the largest board ${(100 * strain).toFixed(2)}% held`, true, `${(100 * strain).toFixed(2)}%`, "<= 1.0%"), derived("held by elastic preload: PLA/PETG relax (11-14% in 500 s, S16); for a months-long hold use hold: \"screw\"", true, "temporary", "survey rule 4"));
        flex["jaw"] = { kind: "cantilever", l: R, b: W, h0: h, deflect: [0.3, yMax], stopAt: stop, plane: "xy", why: "the spring jaw pinching the board" };
        reqF.push({ id: "jaw.strain", strain: { flexure: "jaw", use: "held" } }, { id: "jaw.stop", stop: { flexure: "jaw" } });
        supports.push({ id: "board", kind: "fixed", where: { box: [[-0.6, 0.6], [wall + 1, wall + R], [0, W]] } });
        parts.push(s.require(...reqs));
    }
    let s = parts[0];
    const down = [-1, 0, 0];
    const loads = [];
    if (o.hook) {
        const { drop, opening } = o.hook;
        s = s.add(box({ x: [-wall - drop, -wall + 0.01], y: [0, wall], z: [0, W] }), box({ x: [-2 * wall - drop, -wall - drop + 0.01], y: [0, 2 * wall + opening], z: [0, W] }), box({ x: [-2 * wall - drop, -wall - drop + Math.min(opening * 0.6, drop)], y: [wall + opening, 2 * wall + opening], z: [0, W] }));
        loads.push({ id: "hung", kind: "weight", kg: o.load ?? 1, dir: down, at: { box: [[-wall - drop - 0.6, -wall - drop + 0.6], [wall, wall + opening], [0, W]] }, why: `${o.load ?? 1} kg hung on the hook` });
    }
    else
        loads.push({ id: "pull", kind: "pull", N: 20, dir: down, at: { box: [[-wall - 0.6, -wall + 0.6], [wall, wall + R], [0, W]] }, why: "20 N pulling the clip down" });
    if (sizing)
        s = s.require(sized(sizing.report));
    return s.require(facts({ from: "clip", down, supports, loads, flexures: flex, requirements: [{ id: "strength", holds: { safetyFactor: 3 } }, { id: "stiffness", deflection: { max: 1 } }, ...reqF] }));
}
/** stress and deflection factors (whole part over frame) measured on the round 2 T14 clip (2 kg on a 30 mm hook) */
const CLIP_K = [0.5, 1.7];
/** The clip's C and hook as a planar frame (print plane; down is -x): wall from the lightest that carries the hung load. */
function sizeClip(o) {
    if (!ENGINE)
        return null;
    const M = mat(o.material), F = o.kg * 9.81, k = SIZING.k["clip"] ?? CLIP_K[0], kd = SIZING.kd["clip"] ?? CLIP_K[1], needSF = 3 * 1.25, t0 = performance.now();
    const nutT = o.screw === 4 ? 3.2 : 2.4, G = o.T + o.u + 0.5;
    const table = [];
    let chosen = null, evaluated = 0;
    for (const w of [2, 2.5, 3, 3.5, 4, 5, 6, 8]) {
        const j2 = Math.max(w, nutT + 3), sy = w + o.R * 0.6, x1 = -w / 2, x2 = G + j2 / 2;
        const members = [
            { name: "jaw under the board", from: [x1, w / 2], to: [x1, w + o.R], h: w, b: o.W },
            { name: "spine", from: [x1, w / 2], to: [x2, w / 2], h: w, b: o.W },
            { name: "jaw over the board", from: [x2, w / 2], to: [x2, w + o.R], h: j2, b: o.W }
        ];
        let load = [x1, w + o.R / 2];
        if (o.hook) {
            const xj = -w - o.hook.drop - w / 2;
            members.push({ name: "hook stem", from: [x1, w / 2], to: [xj, w / 2], h: w, b: o.W }, { name: "hook", from: [xj, w / 2], to: [xj, w + o.hook.opening + w / 2], h: w, b: o.W });
            load = [xj, w + o.hook.opening / 2];
        }
        evaluated++;
        let sf = 0, defl = Infinity, why;
        try {
            const r = solveFrame2D({ E: M.E, warm: "clip", members, pins: [{ name: "screw", at: [x2, sy] }],
                contacts: [{ name: "board.under", normal: [-1, 0], on: (p) => Math.abs(p[0] - x1) < 1e-6 && p[1] > w }, { name: "board.edge", normal: [0, -1], on: (p) => Math.abs(p[1] - w / 2) < 1e-6 && p[0] > 0 && p[0] < G }],
                loads: [{ name: "load", at: load, f: [-F, 0] }] });
            sf = M.S / (k * r.peak.sigma);
            defl = kd * Math.abs(r.deflection.load);
            why = sf < needSF ? `SF ${sf.toFixed(1)} at the ${r.peak.member}` : defl > 1 ? `moves ${defl.toFixed(2)} mm` : undefined;
        }
        catch {
            why = "no equilibrium";
        }
        const massG = (2 * (o.R + w) * w + (G + j2) * w + (o.hook ? (o.hook.drop + o.hook.opening + 2 * w) * w : 0)) * o.W * M.rho;
        table.push({ label: `wall ${w}`, massG, sf, defl, ok: !why, why });
        if (!why) {
            chosen = { w, sf, defl, massG };
            break;
        }
    }
    const c = chosen ?? { w: 8, sf: table[table.length - 1].sf ?? 0, defl: table[table.length - 1].defl ?? 0, massG: table[table.length - 1].massG };
    return { wall: c.w, report: { feature: "clip", requirement: `holds ${o.kg} kg${o.hook ? " on the hook" : ""} with SF 3 (sized to ${needSF.toFixed(2)}), moves at most 1 mm`, model: `planar frame (physics engine solveFrame), the board pushing only, the screw holding jaw 2; stress concentration x${k.toFixed(2)}`,
            chosen: `wall ${c.w} (jaws, spine${o.hook ? ", hook" : ""})`, predicted: { massG: c.massG, sf: c.sf, defl: c.defl }, handRule: { label: "round 2 rule: wall 4", massG: 0 }, table: table.slice(-4), evaluated, ms: performance.now() - t0,
            need: needSF, kUsed: k, sagMax: 1, kdUsed: kd, atMinimum: !!chosen && chosen.w === 2, correction: SIZING.k["clip"], notes: chosen ? undefined : ["no wall up to 8 mm carries it: the proof below says by how much"] } };
}
