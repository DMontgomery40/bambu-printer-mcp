/**
 * The interface a design worker calls: state the part, its material and print direction, how it is
 * held, what loads it, and what must be true; get back every requirement as pass / fail / uncertain /
 * unsupported with the number, where, why, and what would fix it in a designer's words.
 *
 *   import { check } from "counterpart-physics";
 *   const r = check({
 *     part: { solid },                       // the kernel's Solid (distance + bounds), or { mesh }, or { distance, bounds }
 *     material: "PETG", printUp: [0, 0, 1],
 *     supports: [{ kind: "screw", at: [x, 0, z], axis: [0, 1, 0], d: 4.5, head: 9 }, { kind: "wall", point: [0, 0, 0], normal: [0, 1, 0] }],
 *     loads: [{ object: { kg: 0.4, on: { box: [...] } } }, { pull: { N: 20, dir: [0, 1, 0], at: { box: [...] } } }],
 *     requirements: [{ holds: { safetyFactor: 3 } }, { deflection: { max: 1 } }, { staysIn: { tilt: 30 } }],
 *     object: { mesh, kg: 0.4 },              // the scanned object, seated in the part's frame (for staysIn / liftsOut)
 *     flexures: { arm: { snap: {...} }, clamp: { ribClamp: {...} } },
 *   });
 *
 * Units: mm, N, kg, degrees, seconds. Z is up in the part's frame unless printUp says otherwise for the
 * printer; "tilt" is about the x axis (towards -y, the wall side, positive) unless an axis is given.
 */
import { analyzeSolid, thinWall } from "./solid/analyze.js";
import { material as getMaterial } from "./materials.js";
import { snapEngine } from "./beam/snap.js";
import { ribClamp } from "./beam/ring.js";
import { tiltLimit, maxHold, contactsFromDistance, contactsFromPartEdges, featureEdgeSamples, massProperties, sampleSurface } from "./contact/statics.js";
const f2 = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const at = (p) => `(${p.map((v) => v.toFixed(1)).join(", ")})`;
function partGeometry(p) {
    if (p.solid) {
        const b = p.solid.bounds();
        return { distance: (x, y, z) => p.solid.distance(x, y, z), bounds: { min: b.min.slice(0, 3), max: b.max.slice(0, 3) }, mesh: p.mesh };
    }
    return { distance: p.distance, bounds: p.bounds, mesh: p.mesh };
}
export function check(intent) {
    const t0 = performance.now();
    const m = getMaterial(intent.material);
    const geo = partGeometry(intent.part);
    const answers = [];
    const notes = [];
    const needSolid = intent.requirements.some((r) => "holds" in r || "deflection" in r);
    let solid;
    if (needSolid) {
        if (!geo.bounds || !(geo.distance || geo.mesh))
            throw new Error("check: holds/deflection need the part as a solid (distance + bounds) or a mesh");
        const size = Math.max(...geo.bounds.max.map((v, i) => v - geo.bounds.min[i]));
        // the voxel from the thinnest wall (two cut cells across it), unless the caller chose one
        const tMin = geo.distance ? thinWall(geo.distance, geo.bounds) : NaN;
        const h = intent.resolution ?? (Number.isFinite(tMin) ? Math.min(2, Math.max(0.4, Math.round((tMin / 2) * 10) / 10, size / 140)) : Math.max(0.5, Math.min(1.5, size / 80)));
        const loads = (intent.loads ?? []).map((l) => "object" in l
            ? { kind: "force", total: [0, 0, -l.object.kg * 9.81], where: l.object.on, name: l.object.name ?? `${l.object.kg} kg object` }
            : { kind: "force", total: l.pull.dir.map((v) => (v / Math.hypot(...l.pull.dir)) * l.pull.N), where: l.pull.at, name: l.pull.name ?? `${l.pull.N} N pull` });
        const tS = performance.now();
        solid = analyzeSolid({ geometry: { distance: geo.distance, mesh: geo.mesh, bounds: geo.bounds }, material: m, printDir: intent.printUp ?? [0, 0, 1], h, supports: intent.supports ?? [], loads, map: intent.map });
        const ms = performance.now() - tS;
        notes.push(`whole part: ${solid.elements} voxels of ${h} mm (cut cells at the surface${Number.isFinite(tMin) ? `; thinnest wall ${tMin.toFixed(2)} mm` : ""}), ${solid.dofs} unknowns, ${solid.iterations} CG iterations, ${ms.toFixed(0)} ms; error estimate from a ${solid.errorEstimate?.coarseH ?? 2 * h} mm solve: deflection ${solid.errorEstimate ? (100 * solid.errorEstimate.deflectionRel).toFixed(1) : "?"}% (Richardson), peak ${solid.errorEstimate ? (100 * solid.errorEstimate.sfRel).toFixed(0) : "?"}% (zoom at twice its voxel)`);
        for (const r of solid.reactions)
            notes.push(`reaction ${r.name}: ${r.force.map((v) => v.toFixed(1)).join(", ")} N`);
        for (const a of solid.assumptions)
            notes.push(a);
        if (!solid.ok)
            answers.push({ requirement: "the part is held", verdict: "fail", value: "-", limit: "-", why: solid.message ?? "solve failed", fix: "add a support that stops the motion (another screw, or a wall face)", ms });
        for (const req of intent.requirements) {
            if ("holds" in req && solid.ok)
                answers.push(holdsAnswer(intent, solid, req.holds.safetyFactor, loads.map((l) => l.name), m, h, ms));
            if ("deflection" in req && solid.ok)
                answers.push(deflectionAnswer(solid, req.deflection.max, m, ms));
        }
    }
    for (const req of intent.requirements) {
        if ("staysIn" in req) {
            const tt = performance.now();
            answers.push(staysIn(intent, geo, req.staysIn, m));
            if (process.env.PHYSICS_DEBUG)
                console.log('staysIn ms', performance.now() - tt);
        }
        if ("liftsOut" in req)
            answers.push(liftsOut(intent, geo, req.liftsOut));
        if ("retains" in req)
            answers.push(retains(intent, geo, req.retains, m));
        if ("strain" in req && intent.flexures?.[req.strain.flexure]?.ribClamp)
            answers.push(ringStrainAnswer(intent, req.strain, m));
        else if ("strain" in req || "insertion" in req || "retention" in req)
            answers.push(snapAnswer(intent, req, m));
        if ("grips" in req)
            answers.push(gripAnswer(intent, req.grips, m));
    }
    return { name: intent.name ?? "part", answers, ms: performance.now() - t0, notes, solid };
}
const AX = ["x", "y", "z"];
/** Strength: the weakest point outside the St Venant zones of supports and load patches, judged within and
 * across layers, with the peaks inside those zones reported beside it, and sharp corners named. */
function holdsAnswer(intent, solid, target, loadNames, m, h, ms) {
    const w = solid.weakest;
    const sfLow = w.mode === "across layers" ? w.sf * (m.SzLow / m.Sz) : w.sf;
    // peak stresses: the zoomed peak's own error estimate when it has one, never below the 10% band the
    // benchmark measured for zoomed peaks at curved surfaces
    const band = Math.max(0.1, Math.min(0.5, solid.errorEstimate?.sfRel ?? 0.15));
    let verdict = w.sf < target * (1 - band) ? "fail" : sfLow >= target * (1 + band) ? "pass" : "uncertain";
    if (w.sf < target && verdict === "uncertain")
        verdict = w.sf < target ? (w.sf < target * (1 - band) ? "fail" : "uncertain") : verdict;
    const sharp = solid.weakestRadius !== undefined && solid.weakestRadius < 0.5 * h;
    const ori = (solid.orientations ?? []).map((o) => `${AX[o.up.indexOf(1)]} up: ${f2(o.sf)} (${o.mode})`).join(", ");
    const atLoad = solid.atLoad && Number.isFinite(solid.atLoad.sf) ? solid.atLoad : null;
    const notesAt = [];
    if (atLoad && atLoad.sf < w.sf) {
        notesAt.push(`Within ${solid.zones?.load.toFixed(1)} mm of where a load is applied the peak is ${f2(atLoad.sf)} at ${at(atLoad.where)} (${atLoad.component}); it depends on how the load is spread, which the load case does not say, so it is reported, not judged.`);
        if (atLoad.sf < target && verdict === "pass")
            verdict = "uncertain";
    }
    const why = `${w.mode === "across layers" ? `the layers there are pulled apart or sheared; across-layer strength ${m.Sz} MPa (${m.cite.UTS_z}), sources range ${m.zRatios.join("/")} of in-layer` : `in-layer strength ${m.Sxy} MPa (${m.cite.UTS_xy})`}. Same stresses judged for other print directions: ${ori}.${sharp ? ` The peak sits at a sharp inside corner (surface radius ${solid.weakestRadius.toFixed(2)} mm, under half a voxel): its stress has no finite value and grows as the model refines; treat this safety factor as an upper bound.` : ""} ${notesAt.join(" ")} Peaks within ${solid.zones?.support.toFixed(1)} mm of a held support are not judged (a held face is stiffer than any real support).`;
    const fx = holdsFix(solid, target, w, sfLow, verdict, sharp, intent);
    return { requirement: `holds ${loadNames.join(" + ")} with safety factor >= ${target}`, verdict,
        value: w.mode === "across layers" ? `${f2(w.sf)} (${f2(sfLow)} with the lowest published across-layer strength, ${m.SzLow} MPa)` : f2(w.sf), limit: `>= ${target} (a clear pass needs ${f2(target * (1 + band))}: peak stress carries about ${(100 * band).toFixed(0)}% uncertainty)`,
        where: `${at(w.where)}, ${w.mode}: ${w.component}`, why: why.trim(), fix: fx, ms, error: band };
}
function holdsFix(solid, target, w, sfLow, verdict, sharp, intent) {
    const fixes = solid.fixes;
    if (fixes?.length && verdict !== "pass")
        return fixes.map((f) => f.text).join("; or ");
    if (verdict === "pass")
        return sharp ? "add a fillet at the corner (radius about 0.6 x the wall, which the Bayer guide says captures most of the benefit, survey 3.6)" : undefined;
    const best = (solid.orientations ?? []).reduce((a, b) => (b.sf > a.sf ? b : a), { up: [0, 0, 1], sf: -1, mode: "" });
    const tScale = Math.sqrt(target / Math.min(w.sf, sfLow));
    if (sharp)
        return `add a fillet at ${at(w.where)} (radius about 0.6 x the wall, survey 3.6), then re-check`;
    if (best.sf > w.sf * 1.05)
        return `print with ${AX[best.up.indexOf(1)]} up (safety factor about ${f2(best.sf)}), or thicken the section at ${at(w.where)} by ${(100 * (tScale - 1)).toFixed(0)}%`;
    void intent;
    return `thicken the section at ${at(w.where)} by ${(100 * (tScale - 1)).toFixed(0)}% or add a fillet / rib there (bending stress falls with thickness squared)`;
}
/** Deflection: each load's mean displacement along it, extrapolated from the h and 2h solves (Richardson,
 * second order), judged with that extrapolation's own size as the error. */
function deflectionAnswer(solid, max, m, ms) {
    const r = (solid.errorEstimate?.coarseH ?? 0) / solid.h;
    const ext = solid.loadDeflection.map((l, i) => {
        const d2 = solid.coarse?.loadDeflection[i];
        const e = d2 !== undefined && r > 1 ? l.along + (l.along - d2) / (r * r - 1) : l.along;
        return { name: l.name, h: l.along, ext: e, err: Math.abs(e - l.along) / Math.max(Math.abs(e), 1e-12) };
    });
    const gov = ext.reduce((a, b) => (Math.abs(b.ext) > Math.abs(a.ext) ? b : a), ext[0] ?? { name: "-", h: 0, ext: 0, err: 0 });
    const d = Math.abs(gov.ext), err = Math.max(gov.err, 0.02);
    const verdict = d * (1 + err) <= max ? "pass" : d * (1 - err) > max ? "fail" : "uncertain";
    return { requirement: `deflects at most ${max} mm under the load`, verdict, value: `${d.toFixed(3)} mm`, limit: `<= ${max} mm`,
        where: ext.map((l) => `${l.name}: ${l.ext.toFixed(3)} mm (${l.h.toFixed(3)} at the working voxel)`).join("; "),
        why: `linear elastic, E ${m.E1}/${m.E3} MPa in/across layers (${m.cite.E_xy}); extrapolated from the working voxel and twice it (second order), error estimate ${(100 * err).toFixed(1)}%`,
        fix: verdict === "pass" ? undefined : `stiffen the member that bends: thickness x${Math.cbrt(d / max).toFixed(2)} (deflection falls with thickness cubed), or add a gusset`, ms, error: err };
}
function staysIn(intent, geo, q, m) {
    const t0 = performance.now();
    if (!intent.object || !geo.distance)
        return { requirement: `stays in up to ${q.tilt} deg tilt`, verdict: "unsupported", value: "-", limit: "-", why: "needs the object's mesh (seated) and the part as a distance function", ms: 0 };
    const mp = massProperties(intent.object.mesh, 1);
    const W = intent.object.kg * 9.81;
    const clearance = 0.5; // contact band: the object may settle onto any part surface within this distance
    const bb = geo.bounds;
    const samples = sampleSurface(intent.object.mesh, 3).filter((q) => [0, 1, 2].every((a) => q.p[a] >= bb.min[a] - clearance && q.p[a] <= bb.max[a] + clearance));
    let contacts = contactsFromDistance(samples, geo.distance, clearance);
    if (geo.mesh)
        contacts = contacts.concat(contactsFromPartEdges(featureEdgeSamples(geo.mesh, 30, 2).filter((p) => geo.distance(p[0], p[1], p[2]) > -1e-3), intent.object.mesh, clearance));
    // thin the contact set: one contact per 3 mm cell and normal direction (the LP needs the extreme points
    // of each contact patch; a 3 mm cell moves a lever arm by at most 1.5 mm)
    const seen = new Set();
    contacts = contacts.filter((c0) => { const k = `${Math.round(c0.p[0] / 3)},${Math.round(c0.p[1] / 3)},${Math.round(c0.p[2] / 3)},${c0.n.map((v) => Math.round(v * 2)).join(",")}`; if (seen.has(k))
        return false; seen.add(k); return true; });
    const mu = q.mu ?? m.muSteel[0];
    const axis = q.axis ?? [1, 0, 0];
    const res = tiltLimit({ contacts, cg: mp.cg, weight: W, mu, edges: 8 }, axis, Math.max(90, q.tilt + 10), 2);
    const ok = res.angle >= q.tilt;
    return {
        requirement: `the object stays in up to ${q.tilt} deg of tilt about ${at(axis)}`, verdict: ok ? "pass" : "fail",
        value: res.mode === "stays" ? `held through the whole sweep, to ${res.angle} deg` : `held to ${res.angle.toFixed(1)} deg, then ${res.mode}`, limit: `>= ${q.tilt} deg`,
        where: `${contacts.length} candidate contacts within ${clearance} mm; centre of mass ${at(mp.cg)}`,
        why: `rigid object, friction ${mu} (the lowest measured, against steel, ${m.muNote.split(";")[0]}) only where it rests (gap under 0.05 mm); surfaces it could only reach across the clearance push without friction; equilibrium checked in the seated pose (escape motions are not searched)`,
        fix: ok ? undefined : res.mode === "slides" ? "add a lip or deepen the pocket on the downhill side; friction alone is not enough" : "raise the front wall or lip (the object pivots over its edge), or move the pocket's opening",
        ms: performance.now() - t0,
    };
}
function retains(intent, geo, q, m) {
    const t0 = performance.now();
    if (!intent.object || !geo.distance)
        return { requirement: `the object resists a ${q.N} N pull`, verdict: "unsupported", value: "-", limit: "-", why: "needs the object's mesh (seated) and the part as a distance function", ms: 0 };
    const mp = massProperties(intent.object.mesh, 1);
    const clearance = 0.5, bb = geo.bounds;
    const samples = sampleSurface(intent.object.mesh, 3).filter((s) => [0, 1, 2].every((a) => s.p[a] >= bb.min[a] - clearance && s.p[a] <= bb.max[a] + clearance));
    let contacts = contactsFromDistance(samples, geo.distance, clearance);
    if (geo.mesh)
        contacts = contacts.concat(contactsFromPartEdges(featureEdgeSamples(geo.mesh, 30, 2).filter((p) => geo.distance(p[0], p[1], p[2]) > -1e-3), intent.object.mesh, clearance));
    const seen = new Set();
    contacts = contacts.filter((c0) => { const k = `${Math.round(c0.p[0] / 3)},${Math.round(c0.p[1] / 3)},${Math.round(c0.p[2] / 3)},${c0.n.map((v) => Math.round(v * 2)).join(",")}`; if (seen.has(k))
        return false; seen.add(k); return true; });
    const mu = q.mu ?? m.muSteel[0];
    const hold = maxHold({ contacts, cg: mp.cg, weight: intent.object.kg * 9.81, mu, edges: 8 }, [0, 0, -1], q.dir, q.at ?? mp.cg);
    const unbounded = !Number.isFinite(hold);
    const ok = unbounded || hold >= q.N;
    return { requirement: `the object resists a ${q.N} N pull along ${at(q.dir)}`, verdict: ok ? "pass" : "fail", value: unbounded ? "held by the part's shape (no amount of pull moves it in this direction)" : `${Math.max(0, hold).toFixed(1)} N before it moves`, limit: `>= ${q.N} N`,
        why: `rigid object in the seated pose, its weight ${(intent.object.kg * 9.81).toFixed(1)} N, friction ${mu} (lowest measured, S13) only where it rests; walls across the clearance push without friction`, fix: ok ? undefined : "add a lip, a snap or a strap across the pull direction; friction alone cannot be relied on", ms: performance.now() - t0 };
}
function liftsOut(intent, geo, q) {
    const t0 = performance.now();
    if (!intent.object || !geo.distance)
        return { requirement: "the object lifts out", verdict: "unsupported", value: "-", limit: "-", why: "needs the object's mesh and the part's distance function", ms: 0 };
    const dir = q.along ?? [0, 0, 1], dn = Math.hypot(...dir), d = [dir[0] / dn, dir[1] / dn, dir[2] / dn];
    // only points that can meet the part on the way: inside the part's box across the travel direction
    const b = geo.bounds;
    const inBox = (p) => [0, 1, 2].every((a) => Math.abs(d[a]) > 0.5 || (p[a] >= b.min[a] - 1 && p[a] <= b.max[a] + 1));
    const pts = sampleSurface(intent.object.mesh, 3).map((s) => s.p).filter(inBox);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
        const v = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    let top = -Infinity;
    for (const c of [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.max[2]]])
        top = Math.max(top, c[0] * d[0] + c[1] * d[1] + c[2] * d[2]);
    const travel = q.distance ?? Math.max(0, top - lo + 1);
    // interference anywhere on the way; the clearance reported is the smallest once the object has left its seat
    // (the first millimetre is where it rests on its support, which is not a clearance)
    let worst = Infinity, worstAt = 0, worstP = [0, 0, 0], clear = Infinity;
    for (let s = 0.05; s <= travel; s += s < 1 ? 0.25 : 1)
        for (const p of pts) {
            const q2 = [p[0] + s * d[0], p[1] + s * d[1], p[2] + s * d[2]];
            if ([0, 1, 2].some((a) => q2[a] < b.min[a] - 0.5 || q2[a] > b.max[a] + 0.5))
                continue;
            const v = geo.distance(q2[0], q2[1], q2[2]);
            if (v < worst) {
                worst = v;
                worstAt = s;
                worstP = p;
            }
            if (s >= 1 && v < clear)
                clear = v;
        }
    void hi;
    const ok = worst >= -0.02;
    return { requirement: `the object lifts straight out along ${at(d)}`, verdict: ok ? "pass" : "fail", value: ok ? `smallest clearance once off its seat ${Number.isFinite(clear) ? clear.toFixed(2) : "-"} mm` : `interferes by ${(-worst).toFixed(2)} mm`, limit: ">= 0 mm",
        where: ok ? undefined : `object point ${at(worstP)} after ${worstAt.toFixed(1)} mm of travel`, why: "rigid object swept along a straight line through the part's distance field",
        fix: ok ? undefined : `open the pocket by ${(-worst + 0.2).toFixed(2)} mm per side there, or let a flexure (snap arm, rib) take the interference`, ms: performance.now() - t0 };
}
function snapAnswer(intent, req, m) {
    const t0 = performance.now();
    const key = (req.strain ?? req.insertion ?? req.retention).flexure;
    const fl = intent.flexures?.[key]?.snap;
    if (!fl)
        return { requirement: `flexure ${key}`, verdict: "unsupported", value: "-", limit: "-", why: `no snap flexure named ${key}`, ms: 0 };
    if (intent.material === "TPU")
        return { requirement: `flexure ${key}`, verdict: "unsupported", value: "-", limit: "-", why: m.strainNote, ms: 0 };
    const r = snapEngine({ ...fl, E: fl.E ?? m.E1 });
    const ms = performance.now() - t0;
    if (req.strain) {
        const [lo, hi] = req.strain.use === "once" ? m.strainOnce : m.strainRepeated;
        const verdict = r.strain <= lo ? "pass" : r.strain > hi ? "fail" : "uncertain";
        const k = Math.sqrt(r.strain / lo);
        return { requirement: `${key}: peak strain within the ${req.strain.use === "once" ? "single-snap" : "repeated-snap"} allowance`, verdict, value: `${(100 * r.strain).toFixed(2)}%`, limit: `${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)}% (derived, no published value)`,
            where: `${r.at.toFixed(1)} mm from the root (of ${fl.l} mm)`, why: `${m.strainNote} Nonlinear beam, tip turns ${r.tipRotationDeg.toFixed(1)} deg.`,
            fix: verdict === "pass" ? undefined : `lengthen the arm to ${(fl.l * k).toFixed(1)} mm or thin it to ${(fl.h0 / (k * k)).toFixed(2)} mm (strain grows with thickness and falls with length squared); taper it to half thickness at the hook; keep it printed flat (strain along the layers)`, ms };
    }
    if (req.insertion) {
        if (r.locks)
            return { requirement: `${key}: pushes on with at most ${req.insertion.max} N`, verdict: "fail", value: "cannot be pushed on", limit: `<= ${req.insertion.max} N`, why: `at ${r.locks.at.toFixed(2)} mm of deflection the lead face has turned to about ${r.locks.angleDeg.toFixed(0)} deg with the tip and the push no longer bends the arm (self-locking with friction ${fl.mu})`, fix: "shallower lead angle, a longer or thinner arm (less tip rotation), or a smaller undercut", ms };
        const ok = r.W <= req.insertion.max;
        return { requirement: `${key}: pushes on with at most ${req.insertion.max} N`, verdict: ok ? "pass" : "fail", value: `${r.W.toFixed(1)} N`, limit: `<= ${req.insertion.max} N`, why: `deflection force ${r.P.toFixed(1)} N through a ${fl.alpha} deg lead (turning to ${(fl.alpha + Math.abs(r.tipRotationDeg)).toFixed(0)} deg with the tip), friction ${fl.mu}`,
            fix: ok ? undefined : "shallower lead angle (25-30 deg), longer or thinner arm", ms };
    }
    const R = req.retention;
    const hold = r.Wout ?? Infinity;
    const ok = hold >= R.min;
    return { requirement: `${key}: resists a pull-out of ${R.min} N`, verdict: ok ? "pass" : "fail", value: Number.isFinite(hold) ? `${hold.toFixed(1)} N` : "self-locking", limit: `>= ${R.min} N`, why: `return angle ${fl.alphaR} deg, friction ${fl.mu}`,
        fix: ok ? undefined : "steepen the return face (towards 90 deg locks it), or stiffen the arm", ms };
}
function gripAnswer(intent, q, m) {
    const t0 = performance.now();
    const fl = intent.flexures?.[q.flexure]?.ribClamp;
    if (!fl)
        return { requirement: `grip ${q.flexure}`, verdict: "unsupported", value: "-", limit: "-", why: `no clamp flexure named ${q.flexure}`, ms: 0 };
    const sizes = q.over ?? [fl.bore, fl.bore];
    const mu = fl.mu ?? m.muSteel[0];
    const rs = sizes.map((d) => ({ d, r: ribClamp({ ...fl, pole: d, E: m.E1, mu, crushStrength: m.Sxy }) }));
    const worst = rs.reduce((a, b) => (b.r.gripAxial < a.r.gripAxial ? b : a));
    let value = worst.r.gripAxial, verdict = value >= q.min ? "pass" : "fail", relaxed = 1;
    let why = `split ring on the mean radius with ${fl.ribs ? `${fl.ribs.count} ribs` : "no ribs"}, pinch ${fl.pinch} N, friction ${mu} (lowest measured, ${m.muNote.split(";")[0]}); smallest grip at ${worst.d} mm: normal force ${worst.r.normalTotal.toFixed(0)} N, ring strain ${(100 * worst.r.ringStrain).toFixed(2)}%, ears ${worst.r.earGapClosed >= 0 ? "closed" : "opened"} by ${Math.abs(worst.r.earGapClosed).toFixed(2)} mm, ribs crushed ${Math.max(...(worst.r.crushDepth ?? [0])).toFixed(3)} mm`;
    if (q.after !== undefined && q.after > 0) {
        if (m.relaxLoss && q.after <= (m.relaxSeconds ?? 0)) {
            relaxed = 1 - m.relaxLoss[1];
            value *= relaxed;
            why += `; after ${q.after} s: minus ${(100 * m.relaxLoss[1]).toFixed(0)}% (the top of the measured ${(100 * m.relaxLoss[0]).toFixed(0)}-${(100 * m.relaxLoss[1]).toFixed(0)}% loss within ${m.relaxSeconds} s, S16)`;
            verdict = value >= q.min ? "pass" : "fail";
        }
        else {
            const placeholder = value * 0.5;
            return { requirement: `${q.flexure}: grips with at least ${q.min} N over ${sizes.join("-")} mm after ${q.after} s`, verdict: "unsupported", value: `${value.toFixed(1)} N at assembly; half of it is ${placeholder.toFixed(1)} N`, limit: `>= ${q.min} N`,
                why: `${why}. No creep or relaxation data longer than ${m.relaxSeconds ?? 0} s was found for printed ${m.name} (PLA lost 11-14% within 500 s, S16); a month is an unsupported extrapolation. The survey's placeholder rule (size it to hold after losing half) gives ${placeholder.toFixed(1)} N.`,
                fix: placeholder >= q.min ? "meets the placeholder rule; a screw the person can re-tighten keeps it safe" : `raise the pinch force (grip is about proportional to it) or add a positive lock; at least ${(q.min / placeholder * fl.pinch).toFixed(0)} N pinch to meet the placeholder rule`, ms: performance.now() - t0 };
        }
    }
    return { requirement: `${q.flexure}: grips with at least ${q.min} N over ${sizes.join("-")} mm${q.after ? ` after ${q.after} s` : ""}`, verdict, value: `${value.toFixed(1)} N (axial pull); ${rs.map((x) => `${x.d} mm: ${(x.r.gripAxial * relaxed).toFixed(1)} N`).join(", ")}`, limit: `>= ${q.min} N`, why,
        fix: verdict === "pass" ? undefined : `tighten the pinch screw harder (about ${(q.min / Math.max(value, 1e-9) * Math.max(fl.pinch, 1)).toFixed(0)} N) or close the bore so the ribs engage the smallest size`, ms: performance.now() - t0 };
}
function ringStrainAnswer(intent, q, m) {
    const t0 = performance.now();
    const fl = intent.flexures[q.flexure].ribClamp;
    const sizes = q.over ?? [fl.bore];
    const rs = sizes.map((d) => ({ d, r: ribClamp({ ...fl, pole: d, E: m.E1, mu: fl.mu ?? m.muSteel[0], crushStrength: m.Sxy }) }));
    const w = rs.reduce((a, b) => (b.r.ringStrain > a.r.ringStrain ? b : a));
    const [lo, hi] = q.use === "once" ? m.strainOnce : m.strainRepeated;
    const e = w.r.ringStrain;
    const verdict = e <= lo ? "pass" : e > hi ? "fail" : "uncertain";
    return { requirement: `${q.flexure}: ring bending strain within the ${q.use === "once" ? "single" : "repeated"}-use allowance`, verdict, value: `${(100 * e).toFixed(2)}% at ${w.d} mm`, limit: `${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)}% (derived, no published value)`,
        why: `${m.strainNote} The ring bends in its own plane, which lies in the layers when printed axis-up.`,
        fix: verdict === "pass" ? undefined : `thin the ring wall to ${(fl.wall * lo / e).toFixed(2)} mm (strain is proportional to wall for the same opening) or widen the split so the ring opens less`, ms: performance.now() - t0 };
}
export { getMaterial as material };
