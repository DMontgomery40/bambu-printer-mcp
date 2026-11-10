/**
 * Round 3's additions to the part family, each a compliant design where that is the better one, each with its
 * function-declared fits, its facts for the physics record, and its members sized by the engine while it builds:
 *  - sprungHolder: two sprung arms that capture a round thing anywhere in a wide size range (a cable bundle "between
 *    8 and 11 mm", a pen or a marker of unknown make): straight tapered arms in the print plane whose length is set by
 *    the engine's nonlinear beam, lips that keep the smallest in, stops behind the arms; holds by shape, not preload.
 *  - hook: a J on a plate, printed on its side so the J lies in the layers, its thickness from the planar frame.
 *  - adapter: a sleeve between two objects: its bore fits one by function, its outside fits the other.
 *  - knob / cap: a bore that grips a shaft (round or D) or a tube end with crush ribs (assemble once), the rim fluted.
 * Conventions as in src/family.ts: mm, Z up = print orientation, the bed at z = 0.
 */
import { box, cylinder, cone, rect, circle, polygon, KernelError } from "./api.js";
import { gapIs, holeIs, thicknessIs } from "./checks.js";
import { decideFit, SOURCE_UNCERTAINTY, PRINT_CORRECTION } from "./fit.js";
import { interfaceRecord } from "./intent.js";
import { facts } from "./facts.js";
import { derived, screwHole } from "./family.js";
import { STRAIN, LINE } from "./compliant.js";
import { ENGINE, SIZING, armAnswer, solveFrame2D, sized, mat } from "./sizing.js";
const f3 = (v) => Number(v.toFixed(3));
function need(cond, msg) { if (!cond)
    throw new KernelError(msg); }
const srcU = (m) => (typeof m === "number" ? Math.abs(m) : m ? SOURCE_UNCERTAINTY[m] : SOURCE_UNCERTAINTY.calipers);
// ------------------------------------------------------------------------------------------------
// Sprung holder: two arms, any size in a range
/**
 * A holder for a round thing (axis Z as printed) whose size is only known as a range: `around: [min, max]` (or a
 * size and how it was measured). Print frame: the base on y <= 0 (its back face y = -base is the mounting face),
 * the channel above it along +y, two arms either side lying in the print plane, `length` along z.
 * Mount: { kind: "adhesive", pad: [w, h] } on the back face, or { kind: "screws", screw } through the base.
 */
export function sprungHolder(o) {
    const name = o.name ?? "arms";
    const [dMin, dMax] = Array.isArray(o.around) ? o.around : [o.around - srcU(o.fit?.measured), o.around + srcU(o.fit?.measured)];
    need(dMax > dMin && dMin > 1, "sprungHolder: around is [smallest, largest] (or a size with fit.measured)");
    const tb = o.base ?? 3, b = o.length, pushMax = o.pushMax ?? 30, holdMin = o.holdMin ?? 3, M = mat(o.material);
    const c = 0.3 + PRINT_CORRECTION.holeVertical; // the largest sits with this much room
    const halfCh = dMax / 2 + c; // channel half width at the arms' inner faces
    const ret = Math.max(0.4, 0.08 * dMin); // the lips hold the smallest by this much per side
    const mouth = f3(dMin - 2 * ret);
    const y = f3((dMax + 2 * c - mouth) / 2 - c); // each lip moves this far to pass the largest
    const dx0 = dMax / 2 + c - (dMin - 2 * ret) / 2;
    const lipY = dMax + c + dx0 * (1 / Math.tan((50 * Math.PI) / 180) + 1 / Math.tan((30 * Math.PI) / 180)) + 0.5; // the largest sits below the lips
    const t0 = performance.now();
    const table = [];
    let chosen = null;
    const stopGap = f3(y + 0.4);
    for (const h0 of [2.4, 2.0, 1.7, 1.4, 1.2].filter((h) => h >= 2 * LINE + 0.3))
        for (const taper of [1, 0.5])
            for (let L = lipY + 2; L <= Math.max(3 * dMax, lipY + 40); L = f3(L * 1.12)) {
                const h1 = f3(Math.max(2 * LINE, h0 * taper));
                const a = armAnswer({ l: L, b, h0, h1, y, alpha: 30, alphaR: 50 }, { material: o.material });
                const st = armAnswer({ l: L, b, h0, h1, y: stopGap, alpha: 30, alphaR: 50 }, { material: o.material });
                if (!a || !st)
                    break;
                const ok = a.strain * 1.12 <= STRAIN.repeated && st.strain * 1.12 <= STRAIN.once && a.W <= pushMax && (a.Wout ?? Infinity) >= holdMin;
                table.push({ label: `arms ${L} long, ${h0}${h1 !== h0 ? `->${h1}` : ""} thick: push ${a.W.toFixed(1)} N, hold ${a.Wout === null ? "locks" : a.Wout.toFixed(1) + " N"}`, massG: 2 * L * b * (h0 + h1) / 2 * M.rho, strain: a.strain, ok, why: ok ? undefined : a.strain * 1.12 > STRAIN.repeated ? `strain ${(100 * a.strain).toFixed(2)}%` : st.strain * 1.12 > STRAIN.once ? "over-bends at its stop" : a.W > pushMax ? `push ${a.W.toFixed(0)} N` : `holds ${(a.Wout ?? 0).toFixed(1)} N` });
                if (ok) {
                    chosen = { L, h0, h1, strain: a.strain, stop: st.strain, W: a.W, Wout: a.Wout };
                    break;
                }
                if (a.strain * 1.12 <= STRAIN.repeated && a.W > pushMax)
                    break; // longer only gets softer from here: go thinner
            }
    // the first (thickest, shortest) arm that passes holds best: the loops run thick to thin and short to long
    need(!!chosen || !ENGINE, `sprungHolder: no arm in the print plane takes ${f3(dMin)}-${f3(dMax)} mm (each lip moves ${y} mm) within ${(100 * STRAIN.repeated).toFixed(1)}% strain and a ${pushMax} N push; narrow the range (measure it) or allow a firmer push (pushMax)`);
    const A = chosen ?? { L: Math.max(lipY + 2, 3 * dMax), h0: 1.6, h1: 0.8, strain: NaN, stop: NaN, W: NaN, Wout: null };
    const full = ENGINE ? armAnswer({ l: A.L, b, h0: A.h0, h1: A.h1, y, alpha: 30, alphaR: 50 }, { full: true, material: o.material }) : null;
    // geometry (print frame): arms as quads from the root (y = 0) to the tip (y = L), inner faces at x = +-halfCh
    const arm = (s) => { const xi = s * halfCh, xo0 = s * (halfCh + A.h0), xo1 = s * (halfCh + A.h1); return polygon(s > 0 ? [[xi, 0], [xo0, 0], [xo1, A.L], [xi, A.L]] : [[xo0, 0], [xi, 0], [xi, A.L], [xo1, A.L]]); };
    // lips at the tips: a 30-degree lead above (the object comes down from +y), a 50-degree return below
    const lead = Math.tan((30 * Math.PI) / 180), rtn = Math.tan((50 * Math.PI) / 180), dx = halfCh - mouth / 2;
    const tipY = A.L - dx / lead;
    const lip = (s) => polygon([[s * (halfCh - 0.01), tipY - dx / rtn], [s * mouth / 2, tipY], [s * (halfCh - 0.01), A.L]]);
    const W = 2 * (halfCh + A.h0 + stopGap + 2.4);
    const base = rect({ x: [-W / 2, W / 2], y: [-tb, 0.01] });
    // stops: posts outside each arm, parallel to its outer face, up to 0.8 of its length (where the arm has moved 0.7 of
    // its tip travel): the gap there stops the tip at stopGap
    const g = 0.7 * stopGap, yp = 0.8 * A.L, xo = (yy) => halfCh + A.h0 + ((A.h1 - A.h0) * yy) / A.L;
    const post = (s) => polygon([[s * (xo(0) + g), -0.01], [s * (xo(0) + g + 2.4), -0.01], [s * (xo(yp) + g + 2.4), yp], [s * (xo(yp) + g), yp]]);
    let prof = base.add(arm(1), arm(-1), lip(1), lip(-1), post(1), post(-1));
    let s = prof.extrude({ z: [0, b] });
    const mount = o.mount ?? { kind: "adhesive" };
    const supports = [];
    const reqs = [];
    if (mount.kind === "screws") {
        const h = screwHole(mount.screw ?? 4, "clearance", "horizontal");
        for (const zc of [b / 2])
            s = s.cut(cylinder({ d: h.d, x: 0, y: [-tb - 1, 1], z: zc }));
        need(halfCh * 2 >= (mount.head ?? 8) + 1, `sprungHolder: a ${mount.head ?? 8} mm screw head does not pass between the arms (${f3(2 * halfCh)} apart): use an adhesive pad`);
        supports.push({ id: "screw.1", kind: "screw", at: [0, -tb, b / 2], axis: [0, 1, 0], d: mount.screw ?? 4, head: mount.head ?? 8 }, { id: "surface", kind: "wall", point: [0, -tb, 0], normal: [0, 1, 0] });
        reqs.push(holeIs({ name: `screw hole ${h.d} through the base (${h.why}); the driver goes in between the arms`, at: [0, -tb / 2, b / 2], axis: "y", d: h.d, tol: 0.1 }));
    }
    else {
        const pad = mount.pad ?? [Math.min(W, 40), Math.min(b, 20)];
        need(pad[0] <= W + 1e-9 && pad[1] <= b + 1e-9, `sprungHolder: a ${pad[0]} x ${pad[1]} pad does not fit the ${f3(W)} x ${b} back`);
        supports.push({ id: "pad", kind: "adhesive", where: { plane: { point: [0, -tb, 0], normal: [0, -1, 0] }, within: [[-pad[0] / 2, pad[0] / 2], [-tb - 0.6, -tb + 0.6], [(b - pad[1]) / 2, (b + pad[1]) / 2]] }, area: pad[0] * pad[1] });
    }
    reqs.push(gapIs({ name: `${name}: mouth ${mouth} (the smallest, ${f3(dMin)}, held by ${f3(ret)} per side)`, at: [0, tipY, b / 2], axis: "x", w: mouth, tol: 0.08 }), gapIs({ name: `${name}: channel ${f3(2 * halfCh)} (the largest, ${f3(dMax)}, sits with ${f3(c)} per side)`, at: [0, dMax / 2, b / 2], axis: "x", w: 2 * halfCh, tol: 0.08 }), derived(`${name}: arms ${A.L} mm long, ${A.h0}${A.h1 !== A.h0 ? ` tapering to ${A.h1}` : ""} thick, in the print plane; each lip moves ${y} mm for the largest: strain ${full ? (100 * full.strain).toFixed(2) : "?"}% (repeated-use allowance ${(100 * STRAIN.repeated).toFixed(1)}%, ${STRAIN.note})`, !full || full.strain <= STRAIN.repeated, full ? `${(100 * full.strain).toFixed(2)}%` : "-", `<= ${(100 * STRAIN.repeated).toFixed(1)}%`), derived(`${name}: holds anything from ${f3(dMin)} to ${f3(dMax)} mm by shape (relaxed when closed), not by preload`, true, "captured", "survey rule 4"));
    if (ENGINE && chosen)
        reqs.push(sized({ feature: "sprungHolder", requirement: `strain <= ${(100 * STRAIN.repeated).toFixed(1)}% at the largest (${f3(dMax)}), <= ${(100 * STRAIN.once).toFixed(1)}% at the stop, push <= ${pushMax} N, pull-out >= ${holdMin} N per arm`, model: "the engine's nonlinear snap arm (search fast, the chosen confirmed with the push fed back)",
            chosen: `arms ${A.L} long, ${A.h0}${A.h1 !== A.h0 ? `->${A.h1}` : ""} thick`, predicted: { massG: 2 * A.L * b * (A.h0 + A.h1) / 2 * M.rho, strain: full?.strain }, table: table.slice(-5), evaluated: table.length, ms: performance.now() - t0,
            notes: full ? [`full model: strain ${(100 * full.strain).toFixed(2)}%, push ${full.W.toFixed(1)} N, pull-out ${full.Wout === null ? "self-locking" : full.Wout.toFixed(1) + " N"} per arm`] : undefined }));
    const armFact = { l: A.L, b, h0: A.h0, h1: A.h1, deflect: [0, y], stopAt: stopGap, plane: "xy", y, alpha: 30, alphaR: 50, mu: 0.2 };
    return s.require(...reqs, interfaceRecord({ ...decideFit({ function: "drops-in", measured: "designed" }, { id: `${name}.channel`, feature: `${name} channel`, size: dMax, shape: "round", question: "", what: "the object" }),
        object: { size: f3((dMin + dMax) / 2), uncertainty: f3((dMax - dMin) / 2), source: Array.isArray(o.around) ? "a stated range" : String(o.fit?.measured ?? "calipers") }, holds: [f3(dMin), f3(dMax)], modelled_per_side: f3(c), function: "snaps",
        primitive: "drop-in pocket", reasoning: `sprung arms for ${f3(dMin)}-${f3(dMax)} mm: channel ${f3(2 * halfCh)} clears the largest by ${f3(c)} per side, lips ${mouth} apart hold the smallest by ${f3(ret)} per side, arms sized by the engine` }), facts({ from: "sprungHolder", down: [0, 1, 0], supports,
        object: { name: "object", kg: 0.02, cylinder: { d: dMin, at: [0, dMin / 2, 0], axis: "z", span: [0, b] }, size: { nominal: f3((dMin + dMax) / 2), uncertainty: f3((dMax - dMin) / 2), source: "range" } },
        loads: [{ id: "pull", kind: "pull", N: 10, dir: [0, 1, 0], at: { box: [[-halfCh, halfCh], [-0.6, 0.6], [0, b]] }, why: "a hand tugging the object, 10 N" }],
        flexures: { [name]: { kind: "snap", ...armFact, why: "sprung arm that lets the largest in and keeps the smallest" } },
        requirements: [
            { id: `${name}.strain`, strain: { flexure: name, use: "repeated" }, why: "the largest pushed in and pulled out, many times" },
            { id: `${name}.stop`, stop: { flexure: name }, why: "an arm pried onto its stop is not over-bent" },
            { id: `${name}.push`, insertion: { flexure: name, max: pushMax }, why: "pushed in by hand" },
            { id: `${name}.retain`, retention: { flexure: name, min: holdMin }, why: "does not fall out" },
            { id: "strength", holds: { safetyFactor: 3 }, why: "the base and arm roots carry a 10 N tug" },
        ] }));
}
// ------------------------------------------------------------------------------------------------
// Hook: a J on a wall plate, printed on its side
/**
 * A wall hook: a back plate on the wall (x = 0, normal +x when in use, printed on its side so the hook lies in the
 * layers), an arm out to `reach`, a J rising `lip` at its end. `load` kg hangs in the J. Print frame: the profile in
 * XY (x away from the wall, y up in use), extruded `width` along z. Thickness from the engine's planar frame.
 */
export function hook(o) {
    const kg = o.load, F = kg * 9.81, W = o.width ?? 15, reach = o.reach, lip = o.lip ?? Math.max(8, reach * 0.3), screw = o.screw ?? 4, head = o.head ?? 8;
    const H = o.height ?? Math.max(40, 3 * head + 10), SF = o.safety ?? 3, M = mat(o.material);
    need(reach >= 10, "hook: reach (how far the hook stands off the wall) must be at least 10 mm");
    const hole = screwHole(screw, "clearance", "horizontal"), headD = f3(head + 2 * PRINT_CORRECTION.holeHorizontal), csk = (headD - hole.d) / 2;
    const tMin = Math.max(2.5, Math.ceil((csk + 1.2) * 2) / 2);
    // the plate (leg) from y = 0 to H, the arm at the bottom from the plate out to reach, the J's lip rising at the end
    const k = SIZING.k["hook"] ?? 0.65, kd = SIZING.kd["hook"] ?? 1, needSF = SF * 1.15, t0 = performance.now();
    const table = [];
    let pick = null;
    const ys = [H - head / 2 - 3, H - head / 2 - 3 - 2 * head];
    for (const t of o.t ? [o.t] : [tMin, tMin + 0.5, tMin + 1, tMin + 1.5, tMin + 2.5, tMin + 4, tMin + 6, tMin + 9]) {
        if (!ENGINE) {
            pick = { t, sf: NaN, defl: NaN };
            break;
        }
        const xl = t / 2, ya = t / 2;
        try {
            const r = solveFrame2D({ E: M.E, warm: "hook", members: [{ name: "plate", from: [xl, ya], to: [xl, H], h: t, b: W }, { name: "arm", from: [xl, ya], to: [reach, ya], h: t, b: W }, { name: "lip", from: [reach, ya], to: [reach, ya + lip], h: t, b: W }],
                pins: ys.map((y, i) => ({ name: `screw.${i + 1}`, at: [xl, y] })), contacts: [{ name: "wall", normal: [1, 0], on: (p) => Math.abs(p[0] - xl) < 1e-6 }],
                loads: [{ name: "load", at: [reach - t, ya], f: [0, -F] }] });
            const sf = M.S / (k * r.peak.sigma), defl = kd * Math.abs(r.deflection.load), ok = sf >= needSF && defl <= Math.max(1, reach / 50);
            table.push({ label: `t ${t}`, massG: (H + reach + lip) * t * W * M.rho, sf, defl, ok, why: ok ? undefined : sf < needSF ? `SF ${sf.toFixed(1)} at the ${r.peak.member}` : `moves ${defl.toFixed(2)} mm` });
            if (ok) {
                pick = { t, sf, defl };
                break;
            }
        }
        catch {
            table.push({ label: `t ${t}`, massG: 0, ok: false, why: "no equilibrium" });
        }
    }
    const t = pick?.t ?? (o.t ?? tMin + 9);
    need(ys[1] - head / 2 > t + 2, `hook: a ${H} mm plate is too short for two ${head} mm screws above a ${t} mm arm; make it taller (height)`);
    const r = f3(0.8 * t);
    const prof = rect({ x: [0, t], y: [0, H] }).add(rect({ x: [0, reach], y: [0, t] }), rect({ x: [reach - t, reach], y: [0, t + lip] }), polygon([[t - 0.01, t + r], [t + r, t - 0.01], [t - 0.01, t - 0.01]]), polygon([[reach - t + 0.01, t + r], [reach - t - r, t - 0.01], [reach - t + 0.01, t - 0.01]]));
    let s = prof.extrude({ z: [0, W] });
    const k2 = csk;
    for (const y of ys)
        s = s.cut(cylinder({ d: hole.d, x: [-1, t + 1], y, z: W / 2 }), cone({ d1: hole.d, d2: headD + 2, x: [t - k2, t + 1], y, z: W / 2 }));
    const reqs = [thicknessIs({ name: `hook ${t} thick`, at: [reach / 2, t / 2, W / 2], axis: "y", t }),
        holeIs({ name: `screw holes ${hole.d} (${hole.why})`, at: [0.5, ys[0], W / 2], axis: "x", d: hole.d, tol: 0.08 }),
        derived("printed on its side: the J lies in the layers, so its bending runs along them", true, "z = the hook's width", "bending within layers")];
    if (ENGINE)
        reqs.push(sized({ feature: "hook", requirement: `holds ${kg} kg in the J with SF ${SF} (sized to ${needSF.toFixed(2)}), moves at most ${f3(Math.max(1, reach / 50))} mm`, model: `planar frame (physics engine solveFrame), the wall pushing only, screws high; stress concentration x${k.toFixed(2)}`,
            chosen: `${t} mm`, predicted: { massG: (H + reach + lip) * t * W * M.rho, sf: pick?.sf, defl: pick?.defl }, table: table.slice(-4), evaluated: table.length, ms: performance.now() - t0, need: needSF, kUsed: k, sagMax: Math.max(1, reach / 50), kdUsed: kd, atMinimum: t === tMin, correction: SIZING.k["hook"] }));
    return s.require(...reqs, facts({ from: "hook", down: [0, -1, 0],
        supports: [...ys.map((y, i) => ({ id: `screw.${i + 1}`, kind: "screw", at: [0, y, W / 2], axis: [1, 0, 0], d: screw, head, countersunk: true })), { id: "wall", kind: "wall", point: [0, 0, 0], normal: [1, 0, 0] }],
        loads: [{ id: "hung", kind: "weight", kg, dir: [0, -1, 0], at: { box: [[reach - t - 4, reach - t], [t - 0.6, t + 0.6], [0, W]] }, why: `${kg} kg hung in the J` }],
        requirements: [{ id: "strength", holds: { safetyFactor: SF } }, { id: "stiffness", deflection: { max: f3(Math.max(1, reach / 50)) } }] }));
}
// ------------------------------------------------------------------------------------------------
// Adapter: a sleeve between two objects
/**
 * A sleeve (axis Z) whose bore takes object A and whose outside goes into object B, each by its own fit:
 * `inside: { d, fit }` (A's outside diameter), `outside: { d, fit }` (B's bore). The wall between is checked.
 */
export function adapter(o) {
    const ri = decideFit(o.inside.fit, { id: "adapter.bore", feature: "adapter bore", what: "object A (inside)", size: o.inside.d, shape: "round", axis: "vertical", question: "how does A sit in the sleeve?" });
    const bore = f3(o.inside.d + 2 * ri.modelled_per_side);
    // the outside is a pin going into B's hole: B's hole is the mating size; the sleeve's outside is cut smaller by the fit
    const fo = o.outside.fit, uo = srcU(fo.measured);
    const ro = decideFit({ ...fo }, { id: "adapter.outside", feature: "adapter outside", what: "object B's bore", size: o.outside.d, shape: "round", axis: "vertical", question: "how does the sleeve sit in B?" });
    const pinFit = ro.modelled_per_side - ro.print_correction.per_side; // an outside surface prints true: no hole correction
    const od = f3(o.outside.d - 2 * pinFit);
    const wall = f3((od - bore) / 2);
    need(wall >= 2 * LINE, `adapter: the wall between the ${bore} bore and the ${od} outside is ${wall} mm (under two lines); the two sizes are too close for a sleeve`);
    // exact path: chamfer the solid outline, then bore it (a chamfer on an outline with a hole goes to the field mesher)
    let s = circle({ d: od }).extrude({ z: [0, o.length], top: { chamfer: Math.min(0.6, wall / 3) } });
    if (o.flange)
        s = s.add(circle({ d: o.flange.d }).extrude({ z: [0, o.flange.t] }));
    s = s.cut(cylinder({ d: bore, x: 0, y: 0, z: [-1, o.length + 1] }));
    void uo;
    return s.require(interfaceRecord(ri), interfaceRecord({ ...ro, modelled_per_side: f3(-pinFit), print_correction: { ...ro.print_correction, per_side: 0, feature: "outside surface (no correction)" },
        reasoning: `${ro.reasoning.split(";")[0]}; the sleeve's outside is the pin: ${od} = B's ${o.outside.d} minus ${f3(pinFit)} per side` }), holeIs({ name: `bore ${bore} for A (${o.inside.d}, ${ri.function})`, at: [0, 0, o.length / 2], axis: "z", d: bore, tol: 0.06 }), derived(`outside ${od} for B's ${o.outside.d} bore (${ro.function}); wall ${wall}`, true, `${od}`, `${o.outside.d} - 2 x ${f3(pinFit)}`));
}
// ------------------------------------------------------------------------------------------------
// Knob or cap: a bore that grips with crush ribs, a fluted rim
/**
 * A knob on a shaft (`shaft: { d, flat, fit }`: a round or D shaft, `flat` = the D's depth) or a cap over a tube end
 * (`tube: { d, fit }`), gripped by crush ribs that reach `interference` inside the smallest size (assemble once).
 * The rim is fluted for a grip. `size`: outside diameter; `height`; the bore depth.
 */
export function knob(o) {
    const tgt = o.shaft ?? o.tube;
    need(!!tgt, "knob: give shaft: { d, flat?, fit } (a knob) or tube: { d, fit } (a cap)");
    const u = srcU(tgt.fit?.measured), d = tgt.d, depth = o.depth ?? o.height - 2, H = o.height;
    need(depth <= H - 1.2 || !!o.tube, `knob: a ${depth} mm bore leaves under 1.2 mm on top of a ${H} mm knob`);
    const interference = 0.25; // crush ribs (the second plate's coupon E measures 0.15 / 0.30)
    const bore = f3(d + u + 2 * 0.25), tipR = (d - u) / 2 - interference, rr = 0.8, n = o.ribs ?? 6;
    need(bore / 2 - tipR <= 2 * rr, `knob: ribs ${f3(bore / 2 - tipR)} high for +-${u}: measure the ${o.shaft ? "shaft" : "tube"} (calipers)`);
    const R = o.size / 2, fl = o.flutes ?? Math.max(6, Math.round((Math.PI * o.size) / 6));
    need(R - bore / 2 >= 1.6, `knob: a ${o.size} mm knob leaves under 1.6 mm around the ${bore} bore`);
    // fluted rim: a circle with round notches
    let rim = circle({ d: o.size });
    for (let k = 0; k < fl; k++) {
        const a = (2 * Math.PI * k) / fl;
        rim = rim.cut(circle({ d: Math.min(3, (Math.PI * o.size) / fl / 1.6), center: [R * Math.cos(a), R * Math.sin(a)] }));
    }
    // the fluted outline extruded plain (its chamfered offset is not exact); a chamfered disc on top keeps the edge soft
    let s = rim.extrude({ z: [0, H - 1.2] }).add(circle({ d: o.size - Math.min(3, (Math.PI * o.size) / fl / 1.6) }).extrude({ z: [H - 1.21, H], top: { chamfer: 0.5 } }));
    const z0 = o.shaft ? -1 : H - depth; // a knob's bore opens at the bottom; a cap's too (it goes over the tube)
    s = s.cut(cylinder({ d: bore, x: 0, y: 0, z: [o.shaft ? -1 : -1, depth] }));
    void z0;
    const ribs = [];
    for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n + Math.PI / n;
        const rc = tipR + rr;
        ribs.push(cylinder({ d: 2 * rr, x: rc * Math.cos(a), y: rc * Math.sin(a), z: [0, depth] }));
    }
    s = s.add(...ribs).cut(cone({ d1: bore + 1.2, d2: 2 * tipR - 0.01, x: 0, y: 0, z: [-0.01, 1.0] }));
    if (o.shaft?.flat) {
        // the D: a flat at (d/2 - flat) from the axis, its ribs still bearing on the round part
        const fx = d / 2 - o.shaft.flat;
        s = s.add(box({ x: [fx + 0.05, bore / 2 + 0.01], y: [-bore / 2, bore / 2], z: [0, depth] }).intersect(cylinder({ d: bore + 0.02, x: 0, y: 0, z: [0, depth] })));
    }
    return s.require(derived(`${o.shaft ? "knob on a" : "cap over a"} ${d} mm ${o.shaft ? (o.shaft.flat ? "D shaft" : "shaft") : "tube"} (+-${u}): ${n} crush ribs reach ${interference} inside the smallest size, the bore ${bore} clears the largest; assemble once (the ribs take a set: coupon E on the second plate measures it)`, true, `${f3(2 * tipR)} tip circle`, "rib grip"), holeIs({ name: `bore ${bore}`, at: [0, 0, depth / 2], axis: "z", d: Math.min(bore, 2 * tipR), tol: 2 }));
}
