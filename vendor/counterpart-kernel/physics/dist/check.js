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
import { analyzeSolid, thinWall, screwSeat } from "./solid/analyze.js";
import { screwCheck } from "./screws.js";
import { material as getMaterial, applyObserved } from "./materials.js";
import { snapEngine } from "./beam/snap.js";
import { ribClamp } from "./beam/ring.js";
import { escapeSearch, tiltAlongPath, reversePath, fallsOut } from "./contact/escape.js";
import { meshDistance } from "./geom/meshdist.js";
import { tiltedGravity } from "./contact/statics.js";
import { tiltLimit, maxHold, contactsFromDistance, contactsFromPartEdges, featureEdgeSamples, massProperties, sampleSurface } from "./contact/statics.js";
const f2 = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const at = (p) => `(${p.map((v) => v.toFixed(1)).join(", ")})`;
function partGeometry(p) {
    if (p.solid) {
        const b = p.solid.bounds();
        return { distance: (x, y, z) => p.solid.distance(x, y, z), bounds: { min: b.min.slice(0, 3), max: b.max.slice(0, 3) }, mesh: p.mesh };
    }
    // a part given only as a mesh gets a signed distance from it (cut cells, surface stress, seats and statics need one)
    if (!p.distance && p.mesh) {
        const md = meshDistance(p.mesh);
        return { distance: md.distance, bounds: p.bounds ?? md.bounds, mesh: p.mesh };
    }
    return { distance: p.distance, bounds: p.bounds, mesh: p.mesh };
}
export function check(intent) {
    const t0 = performance.now();
    const ob = applyObserved(getMaterial(intent.material), intent.observed);
    const m = ob.material;
    const geo = partGeometry(intent.part);
    const answers = [];
    const notes = [...ob.used.map((u) => `observed: ${u}`)];
    const needSolid = intent.requirements.some((r) => "holds" in r || "deflection" in r || "screws" in r);
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
        const holdsTargets = intent.requirements.filter((r) => "holds" in r).map((r) => r.holds.safetyFactor);
        solid = analyzeSolid({ geometry: { distance: geo.distance, mesh: geo.mesh, bounds: geo.bounds }, material: m, printDir: intent.printUp ?? [0, 0, 1], h, supports: intent.supports ?? [], loads, map: intent.map, fixFor: holdsTargets.length ? Math.max(...holdsTargets) : undefined, printCandidates: intent.printCandidates });
        const ms = performance.now() - tS;
        notes.push(`whole part: ${solid.elements} voxels of ${h} mm (cut cells at the surface${Number.isFinite(tMin) ? `; thinnest wall ${tMin.toFixed(2)} mm` : ""}), ${solid.dofs} unknowns, ${solid.iterations} CG iterations, ${ms.toFixed(0)} ms; error estimate from a ${solid.errorEstimate?.coarseH ?? 2 * h} mm solve: deflection ${solid.errorEstimate ? (100 * solid.errorEstimate.deflectionRel).toFixed(1) : "?"}% (Richardson), peak ${solid.errorEstimate?.sfRel !== undefined ? `${(100 * solid.errorEstimate.sfRel).toFixed(0)}%` : "not estimated (the 2h grid has under two cells across the wall at the peak; the benchmark band of 15% is used)"}`);
        for (const r of solid.reactions)
            notes.push(`reaction ${r.name}: ${r.force.map((v) => v.toFixed(1)).join(", ")} N`);
        for (const a of solid.assumptions)
            notes.push(a);
        if (!solid.ok)
            answers.push({ requirement: "the part is held", verdict: "fail", value: "-", limit: "-", why: solid.message ?? "solve failed", fix: "add a support that stops the motion (another screw, or a wall face)", ms });
        for (const req of intent.requirements) {
            if ("holds" in req && solid.ok)
                answers.push(holdsAnswer(intent, solid, req.holds.safetyFactor, loads.map((l) => l.name), m, h, ms, Number.isFinite(tMin) ? tMin / h : Infinity));
            if ("deflection" in req && solid.ok)
                answers.push(deflectionAnswer(solid, req.deflection.max, m, ms));
            if ("screws" in req && solid.ok)
                answers.push(screwsAnswer(intent, solid, req.screws.safetyFactor, m, geo.distance, ms));
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
        if ("escape" in req)
            answers.push(escapeAnswer(intent, geo, req.escape));
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
function holdsAnswer(intent, solid, target, loadNames, m, h, ms, cellsAcross = Infinity) {
    const w = solid.weakest;
    const sfLow = w.mode === "across layers" ? w.sf * (m.SzLow / m.Sz) : w.sf;
    // peak stresses: the zoomed peak's own error estimate when it has one, never below the 10% band the
    // benchmark measured for zoomed peaks at curved surfaces; with under two cells across the thinnest wall
    // (fidelity "fast") at least 25%: on the bottle holder the 1.6 mm peak was 18% off the 0.8 mm one
    const coarse = cellsAcross < 1.8;
    const band = Math.max(coarse ? 0.25 : 0.1, Math.min(0.5, solid.errorEstimate?.sfRel ?? 0.15));
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
    if (coarse && verdict !== "pass")
        notesAt.push(`Computed with ${cellsAcross.toFixed(1)} cells across the thinnest wall: run at fidelity "normal" (two cells) for a strength verdict.`);
    // sharp inside corners elsewhere: their stress has no finite value, so this safety factor holds only once they are filleted
    const sharpOthers = (solid.sharpCorners ?? []).filter((k) => Math.hypot(k.where[0] - w.where[0], k.where[1] - w.where[1], k.where[2] - w.where[2]) > 5);
    if (sharpOthers.length) {
        notesAt.push(`Sharp inside corner${sharpOthers.length > 1 ? "s" : ""} at ${sharpOthers.map((k) => `${at(k.where)} (${k.angle.toFixed(0)} degrees, SF ${f2(k.sf)} at this voxel and lower the finer the model)`).join(", ")}: a sharp inside corner has no finite stress, so this safety factor holds only once ${sharpOthers.length > 1 ? "they are" : "it is"} filleted (radius about 0.6 x the wall, survey 3.6).`);
        // a sharp corner's value at this voxel falls as the model refines (the bottle holder's slot corner: 3.4 at
        // 1.2 mm, 2.0 at 0.3 mm), so one under twice the target makes the verdict uncertain
        if (verdict === "pass" && sharpOthers.some((k) => k.sf < 2 * target))
            verdict = "uncertain";
    }
    const why = `${w.mode === "across layers" ? `the layers there are pulled apart or sheared; across-layer strength ${m.Sz} MPa (${m.cite.UTS_z}), sources range ${m.zRatios.join("/")} of in-layer` : `in-layer strength ${m.Sxy} MPa (${m.cite.UTS_xy})`}. Same stresses judged for other print directions: ${ori}.${sharp ? ` The peak sits at a sharp inside corner (surface radius ${solid.weakestRadius.toFixed(2)} mm, under half a voxel): its stress has no finite value and grows as the model refines; treat this safety factor as an upper bound.` : ""} ${notesAt.join(" ")} Peaks within ${solid.zones?.support.toFixed(1)} mm of a held support are not judged (a held face is stiffer than any real support).`;
    let fx = holdsFix(solid, target, w, sfLow, verdict, sharp, intent);
    if (!fx && sharpOthers.length)
        fx = `fillet the sharp inside corner${sharpOthers.length > 1 ? "s" : ""} at ${sharpOthers.map((k) => at(k.where)).join(", ")} (radius about 0.6 x the wall)`;
    return { requirement: `holds ${loadNames.join(" + ")} with safety factor >= ${target}`, verdict,
        value: w.mode === "across layers" ? `${f2(w.sf)} (${f2(sfLow)} with the lowest published across-layer strength, ${m.SzLow} MPa)` : f2(w.sf), limit: `>= ${target} (a clear pass needs ${f2(target * (1 + band))}: peak stress carries about ${(100 * band).toFixed(0)}% uncertainty)`,
        where: `${at(w.where)}, ${w.mode}: ${w.component}`, why: why.trim(), fix: fx, ms, error: band };
}
function holdsFix(solid, target, w, sfLow, verdict, sharp, intent) {
    const fixes = solid.fixes?.filter((f) => f.kind !== "lighter");
    if (fixes?.length && verdict !== "pass")
        return fixes.map((f) => f.text).join("; or ");
    if (verdict === "pass")
        return sharp ? "add a fillet at the corner (radius about 0.6 x the wall, which the Bayer guide says captures most of the benefit, survey 3.6)" : undefined;
    const cands = intent.printCandidates?.map((c) => c.map((v) => Math.abs(v)));
    const best = (solid.orientations ?? []).filter((o) => !cands || cands.some((c) => c.every((v, i) => Math.abs(v - o.up[i]) < 1e-6))).reduce((a, b) => (b.sf > a.sf ? b : a), { up: [0, 0, 1], sf: -1, mode: "" });
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
/** Each screw's tension and sideways load from the solve, against what its head can do in the printed plate. */
function screwsAnswer(intent, solid, target, m, dist, ms) {
    const up = intent.printUp ?? [0, 0, 1], un = Math.hypot(...up);
    const lines = [];
    let worst = Infinity, worstName = "", fix;
    let anyAssumed = false;
    for (const s of (intent.supports ?? []).filter((q) => q.kind === "screw")) {
        const a = s.axis, an = Math.hypot(...a), ax = [a[0] / an, a[1] / an, a[2] / an];
        const seat = screwSeat(dist, s, ax, 0.5);
        const T = solid.reactions.find((r) => r.name === `${s.name ?? "screw"} tension`), V = solid.reactions.find((r) => r.name === `${s.name ?? "screw"} shear`);
        if (!seat || !T) {
            lines.push(`${s.name}: no seat or no reaction found`);
            continue;
        }
        // margin around the head: the nearest edge of the plate, sampled at the face's mid-depth around the head
        const ref = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const r1 = [ax[1] * ref[2] - ax[2] * ref[1], ax[2] * ref[0] - ax[0] * ref[2], ax[0] * ref[1] - ax[1] * ref[0]], rl = Math.hypot(...r1), e1 = r1.map((v) => v / rl), e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
        let margin = Infinity;
        if (dist)
            for (let i = 0; i < 16; i++) {
                const t = (2 * Math.PI * i) / 16, al = seat.top - 0.5 * Math.max(seat.k, 0.5);
                for (let r = seat.headR + 0.1; r < seat.headR + 30; r += 0.25) {
                    const p = [s.at[0] + al * ax[0] + r * (Math.cos(t) * e1[0] + Math.sin(t) * e2[0]), s.at[1] + al * ax[1] + r * (Math.cos(t) * e1[1] + Math.sin(t) * e2[1]), s.at[2] + al * ax[2] + r * (Math.cos(t) * e1[2] + Math.sin(t) * e2[2])];
                    if (dist(...p) > 0) {
                        margin = Math.min(margin, r - seat.headR);
                        break;
                    }
                }
            }
        const tension = Math.max(0, T.axial ?? 0), lateral = V.lateral ?? 0;
        const axisInLayers = Math.abs((ax[0] * up[0] + ax[1] * up[1] + ax[2] * up[2]) / un) < 0.5;
        if (axisInLayers && m.Stz === undefined)
            anyAssumed = true;
        const c = screwCheck({ name: s.name ?? "screw", d: s.d, head: s.head ?? 2 * s.d, countersunk: seat.countersunk, plate: seat.top, margin: Number.isFinite(margin) ? margin : 3, axisInLayers }, { tension, lateral }, m);
        const sf = Math.min(c.sfPull, c.sfHoop ?? Infinity);
        lines.push(`${c.name}: ${c.why}`);
        if (sf < worst) {
            worst = sf;
            worstName = c.name;
            fix = sf < target ? (c.mode === "countersink ring splits" ? `widen the plate around ${c.name} (ring now ${margin.toFixed(1)} mm) or use a pan-head screw with a washer` : `thicken the plate under ${c.name} to ${(seat.top * target / sf).toFixed(1)} mm or use a larger head or a washer`) : undefined;
        }
    }
    // the screw tension from the solve runs about 11% below the reference solver's on the bottle holder (stable
    // across resolutions; cause not found), so a clear pass needs 15% over the target
    const verdict = !Number.isFinite(worst) ? "unsupported" : worst < target ? "fail" : (anyAssumed && worst < 2 * target) || worst < 1.15 * target ? "uncertain" : "pass";
    return { requirement: `every screw's head holds in the plate with safety factor >= ${target}`, verdict, value: Number.isFinite(worst) ? `${f2(worst)} (${worstName})` : "-", limit: `>= ${target}`,
        why: `${lines.join(" | ")}${anyAssumed ? ". The plate's interlayer shear strength is assumed (S_z/sqrt(3)); coupon B or a measured value replaces it, and a pass needs twice the target until then" : ""}. No preload: a hand-driven screw's preload is not known and printed PLA relaxes (S16); without preload the prying solve gives the larger screw tension. A wall anchor's own pull-out is not checked (it depends on the wall). The solve's screw tension ran 9% below the reference solver's on the bottle holder at 1.2 mm voxels (2-3% at 0.8 mm), so a pass needs 1.15 x the target.`, fix, ms };
}
/** The easiest way out by hand: a path of small lifts, slides, tips over the edges it rests on and turns,
 * every pose checked against the part (object samples against the part's distance, the part's sharp edges
 * against the object's), the push it takes, the tilt at which gravity would carry it out along that path, and
 * the path reversed as the way in. */
function escapeAnswer(intent, geo, q) {
    const t0 = performance.now();
    if (!intent.object || !geo.distance || !geo.bounds)
        return { requirement: "the object comes out by hand (any path)", verdict: "unsupported", value: "-", limit: "-", why: "needs the object's mesh and the part as a distance function", ms: 0 };
    const W = intent.object.kg * 9.81;
    // the straight lift first: if it clears, it is the easiest way out (a push of the object's weight)
    const straight = liftsOut(intent, geo, { along: [0, 0, 1] });
    if (straight.verdict === "pass")
        return { requirement: "the object comes out by hand (any path, not only straight)", verdict: "pass", value: `straight up; it takes its weight, ${W.toFixed(1)} N`, limit: "a path out exists",
            where: `the way in is straight down; ${straight.value}`, why: "rigid object swept straight up through the part's distance field; no other path is easier (any other path climbs as high)", ms: performance.now() - t0 };
    const edges = geo.mesh ? featureEdgeSamples(geo.mesh, 30, 1.5).filter((p) => geo.distance(p[0], p[1], p[2]) > -1e-3) : [];
    const r = escapeSearch({ object: intent.object.mesh, distance: geo.distance, bounds: geo.bounds, weightN: W, partEdges: edges, objectDistance: meshDistance(intent.object.mesh).distance, maxSteps: 1500, spacing: 3 });
    const segs = (list) => list.map((s) => `${s.move} ${s.amount.toFixed(s.unit === "mm" ? 1 : 0)} ${s.unit}`).join(", then ");
    const axis = q.axis ?? [1, 0, 0];
    const tilt = r.out ? tiltAlongPath(r.path, axis, tiltedGravity) : Infinity;
    const back = reversePath(r.segments);
    return {
        requirement: "the object comes out by hand (any path, not only straight)", verdict: r.out ? "pass" : "fail",
        value: r.out ? `out by: ${segs(r.segments)}; it takes at least ${r.pushN.toFixed(1)} N (its weight ${W.toFixed(1)} N x the path's steepest rise, ${r.steepest.toFixed(2)} mm per mm)` : `jams after ${r.path.length - 1} moves`,
        limit: "a path out exists",
        where: r.out ? `the way in is the reverse: ${segs(back)}; closest approach to the part on the way ${r.minClearance.toFixed(2)} mm; tilting the part about (${axis.join(", ")}) would carry it out along this path from ${Number.isFinite(tilt) ? `${tilt.toFixed(0)} deg` : "beyond 90 deg"} (frictionless; another path may need less)` : r.jam?.reason,
        why: `rigid object; moves of 0.25 mm and 1 deg about the centre of mass, the object's extreme edges and wherever it touches the part, each pose clear of the part by at least -0.02 mm; ${r.evaluations} distance checks`,
        fix: r.out ? undefined : "open the mouth or the lip where it jams, or add a lead-in", ms: performance.now() - t0,
    };
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
    const mu = q.mu ?? (m.muObject?.[0] ?? m.muSteel[0]);
    const axis = q.axis ?? [1, 0, 0];
    const res = tiltLimit({ contacts, cg: mp.cg, weight: W, mu, edges: 8 }, axis, Math.max(90, q.tilt + 10), 2);
    let ok = res.angle >= q.tilt;
    // then the escape search at the required tilt: let the object settle (frictionless) and flood the poses it can
    // reach without climbing; if one is out of the part, only friction keeps it in
    let esc = "";
    let verdict = ok ? "pass" : "fail";
    if (ok) {
        const edges = geo.mesh ? featureEdgeSamples(geo.mesh, 30, 1.5).filter((p) => geo.distance(p[0], p[1], p[2]) > -1e-3) : [];
        const f = fallsOut({ object: intent.object.mesh, distance: geo.distance, bounds: bb, weightN: W, gravity: tiltedGravity(q.tilt, axis), partEdges: edges, objectDistance: meshDistance(intent.object.mesh).distance, spacing: 5, turn: 1, maxPoses: 400 });
        if (f.out) {
            verdict = "uncertain";
            esc = ` Escape search: without friction, at ${q.tilt} deg it comes out (a path of ${f.path.length} small moves: it settles, then rolls or slides out without climbing), so friction alone holds it; friction against the printed part is not measured (coupon K measures it).`;
        }
        else
            esc = f.poses < 400 ? ` Escape search: without friction, at ${q.tilt} deg every way out climbs (${f.poses} reachable poses, none out): held by shape.` : ` Escape search: not decided within 400 poses.`;
    }
    return {
        requirement: `the object stays in up to ${q.tilt} deg of tilt about ${at(axis)}`, verdict,
        value: res.mode === "stays" ? `held through the whole sweep, to ${res.angle} deg` : `held to ${res.angle.toFixed(1)} deg, then ${res.mode}`, limit: `>= ${q.tilt} deg`,
        where: `${contacts.length} candidate contacts within ${clearance} mm; centre of mass ${at(mp.cg)}`,
        why: `rigid object, friction ${mu} (the lowest measured, against steel, ${m.muNote.split(";")[0]}) only where it rests (gap under 0.05 mm); surfaces it could only reach across the clearance push without friction; equilibrium checked in the seated pose.${esc}`,
        fix: verdict === "pass" ? undefined : res.mode === "slides" || !ok ? (res.mode === "slides" ? "add a lip or deepen the pocket on the downhill side; friction alone is not enough" : "raise the front wall or lip (the object pivots over its edge), or move the pocket's opening") : "deepen the pocket or add a lip on the downhill side, so the way out climbs",
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
    const mu = q.mu ?? (m.muObject?.[0] ?? m.muSteel[0]);
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
    // point by point along the travel (consecutive queries stay close, which a mesh's distance search uses)
    for (const p of pts)
        for (let s = 0.05; s <= travel; s += s < 1 ? 0.25 : 1) {
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
            why += `; after ${q.after} s: minus ${(100 * m.relaxLoss[1]).toFixed(0)}% (the top of the measured ${(100 * m.relaxLoss[0]).toFixed(0)}-${(100 * m.relaxLoss[1]).toFixed(0)}% loss within ${m.relaxSeconds} s, ${m.relaxCite ?? "S16"})`;
            verdict = value >= q.min ? "pass" : "fail";
        }
        else {
            const placeholder = value * 0.5;
            return { requirement: `${q.flexure}: grips with at least ${q.min} N over ${sizes.join("-")} mm after ${q.after} s`, verdict: "unsupported", value: `${value.toFixed(1)} N at assembly; half of it is ${placeholder.toFixed(1)} N`, limit: `>= ${q.min} N`,
                why: `${why}. No creep or relaxation data longer than ${m.relaxSeconds ?? 0} s exists for printed ${m.name} (${m.relaxCite ? `${(100 * m.relaxLoss[0]).toFixed(0)}-${(100 * m.relaxLoss[1]).toFixed(0)}% lost within it, ${m.relaxCite}` : "PLA lost 11-14% within 500 s, S16"}); ${q.after} s is an unsupported extrapolation. The survey's placeholder rule (size it to hold after losing half) gives ${placeholder.toFixed(1)} N.`,
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
