/**
 * Compliant primitives with their design rules built in (docs/research/compliant-mechanisms.md §1, §2, §4):
 *  - every flexing beam lies in the print plane (its length and its bending in XY, so the strain runs
 *    along the layers: rule 2), or the feature says why it cannot;
 *  - every flexure is sized from strain, not thickness (rule 1: lengthen, then taper, never just thin);
 *  - every flexure has a hard stop at a travel whose strain is within the single-use allowance (rule 3);
 *  - a closed snap carries no stress (rule 4): it holds by geometry; held preload is reported as temporary.
 * The strain allowances for printed PLA and PETG are not published: the design uses the conservative end
 * of the derived range (single snap 1.7%, repeated 1.0%; survey §2.1, physics/materials) and every part
 * carries that uncertainty into its physics record; coupons that measure it are emitted by `*Coupon`.
 */
import { box, cylinder, cone, rect, circle, path, KernelError } from "./api.js";
import { gapIs, holeIs, thicknessIs } from "./checks.js";
import { decideFit, SOURCE_UNCERTAINTY, PRINT_CORRECTION } from "./fit.js";
import { interfaceRecord } from "./intent.js";
import { ENGINE, armAnswer, sized } from "./sizing.js";
import { facts } from "./facts.js";
import { derived } from "./family.js";
import { text } from "./api.js";
const f3 = (v) => Number(v.toFixed(3));
function need(cond, msg) { if (!cond)
    throw new KernelError(msg); }
/** Design allowances (conservative ends of the derived, unmeasured ranges) and print line/layer. */
export const STRAIN = { once: 0.017, repeated: 0.010, note: "derived, not measured for printed PLA/PETG (survey §2.1): coupon C1 measures it" };
export const LINE = 0.42, LAYER = 0.2;
/** Bayer: constant section y = 0.67 e l^2 / h; tapered to h/2 y = 1.09 e l^2 / h. Strain at tip travel y. */
export function beamStrain(y, l, h, tapered) { return (y * h) / ((tapered ? 1.09 : 0.67) * l * l); }
/** Shortest length that keeps travel y within strain e. */
export function beamLength(y, h, e, tapered) { return Math.sqrt((y * h) / ((tapered ? 1.09 : 0.67) * e)); }
function uncertaintyOf(spec) {
    const m = spec?.measured;
    if (typeof m === "number")
        return { u: Math.abs(m), source: `+-${Math.abs(m)}` };
    if (m)
        return { u: SOURCE_UNCERTAINTY[m], source: m };
    return { u: SOURCE_UNCERTAINTY.calipers, source: "calipers (assumed)" };
}
/** Annular sector (r0..r1, angles a0..a1 radians, CCW) as an exact outline of lines and arcs. */
export function sector(r0, r1, a0, a1, cx = 0, cy = 0) {
    const P = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = P(r0, a0), [x1, y1] = P(r1, a0), [x2, y2] = P(r1, a1), [x3, y3] = P(r0, a1);
    const large = a1 - a0 > Math.PI;
    return path().moveTo(x0, y0).lineTo(x1, y1).arcTo(x2, y2, { r: r1, large }).lineTo(x3, y3).arcTo(x0, y0, { r: r0, clockwise: true, large }).close();
}
export function designFingers(o) {
    const useEngine = !!ENGINE && !o.rule;
    const e = o.e ?? STRAIN.repeated, E = 2680, mu = o.mu ?? 0.2, wallO = o.wall ?? 2.4;
    // choose finger thickness h and the interference at the smallest size to give the most grip at the smallest size
    // within the strain limit at the largest: grip = mu x count x 3 E I yMin / l^3 with l from strain (best near yMin = 2u)
    let best = null, bestGrip = -1;
    const hs = o.h ? [o.h] : [1.0, 1.2, 1.5, 1.8, 2.2];
    const iMins = o.interference !== undefined ? [o.interference] : [0.15, 0.3, 0.5, o.u, 1.5 * o.u, 2 * o.u].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
    for (const h of hs)
        for (const iMin of iMins) {
            if (h < 2 * LINE - 1e-9)
                continue;
            const yMax = o.u + iMin, yMin = iMin;
            const tipR = (o.d - o.u) / 2 - iMin, beamR = (o.d + o.u) / 2 + 0.3;
            // shortest finger within strain at the largest size: the engine's nonlinear beam when built (Bayer's linear rule otherwise)
            let lMin = beamLength(yMax, h, e * 0.9, false);
            if (useEngine) {
                lMin = beamLength(yMax, h, e, false);
                for (let k = 0; k < 12; k++) {
                    const a = armAnswer({ l: lMin, b: o.height, h0: h, y: yMax, alpha: 30, mu: 0 });
                    if (a.strain * 1.05 <= e)
                        break;
                    lMin *= 1.06;
                }
            }
            const stop = f3(yMax + 0.25), slotR = beamR + h, outerR = slotR + stop + wallO, rMid = beamR + h / 2;
            const rootDeg = (Math.max(2.4, 1.5 * h) / rMid) * 180 / Math.PI, gapDeg = (0.8 / rMid) * 180 / Math.PI;
            const count = Math.min(12, Math.floor(360 / ((lMin / rMid) * 180 / Math.PI + rootDeg + gapDeg)));
            if (count < 3)
                continue;
            const spanDeg = 360 / count - rootDeg - gapDeg, l = (spanDeg * Math.PI / 180) * rMid;
            let strainMax = beamStrain(yMax, l, h, false), strainStop = beamStrain(stop, l, h, false);
            let P = (3 * E * (o.height * h ** 3 / 12) * yMin) / l ** 3;
            if (useEngine) {
                strainMax = armAnswer({ l, b: o.height, h0: h, y: yMax, alpha: 30, mu: 0 }).strain;
                strainStop = armAnswer({ l, b: o.height, h0: h, y: stop, alpha: 30, mu: 0 }).strain;
                P = armAnswer({ l, b: o.height, h0: h, y: yMin, alpha: 30, mu: 0 }).P;
                if (strainMax > e)
                    continue;
            }
            if (strainStop > STRAIN.once)
                continue;
            const grip = mu * count * P;
            const D = { grip: f3(grip), count, l: f3(l), h, b: o.height, yMin: f3(yMin), yMax: f3(yMax), stop, tipR: f3(tipR), beamR: f3(beamR), slotR: f3(slotR), outerR: f3(outerR), strainMax, strainStop, rootDeg, spanDeg, gapDeg };
            // the first design that reaches the hold wins (least material moved); otherwise the strongest
            const enough = o.holdN !== undefined && grip >= o.holdN * 1.2;
            if (enough && (bestGrip < (o.holdN ?? 0) * 1.2 || grip < bestGrip)) {
                best = D;
                bestGrip = grip;
            }
            else if (bestGrip < (o.holdN ?? Infinity) * 1.2 && grip > bestGrip) {
                best = D;
                bestGrip = grip;
            }
        }
    need(!!best, `fingerBore: no finger in the print plane can take up +-${o.u} on a ${o.d} mm bore within ${(100 * e).toFixed(1)}% strain (3 fingers needed). Ask for a better measurement, or use a pinch split.`);
    return best;
}
/**
 * A ring whose bore grips a round object (axis Z) of diameter `around`, known to +- (measured), with
 * elastic fingers lying in the print plane. Returns the ring (outer radius in `.bounds()`); union it into
 * a part, or use it alone. The fingers' backs are a hard stop against the ring.
 */
export function fingerBore(o) {
    const known = ["around", "fit", "height", "wall", "at", "holdN", "name", "h"];
    const extra = Object.keys(o).filter((k) => !known.includes(k));
    need(!extra.length, `fingerBore: unknown option${extra.length > 1 ? "s" : ""} ${extra.join(", ")}; it takes ${known.join(", ")} (the finger count and length come from the strain rule and the hold)`);
    const { u, source } = uncertaintyOf(o.fit);
    const d = o.around;
    const holdN = o.holdN ?? 5;
    const t0 = performance.now();
    const D = designFingers({ d, u, height: o.height, wall: o.wall, holdN, h: o.h });
    const msF = performance.now() - t0;
    if ((D.grip ?? 0) < holdN) {
        const hNeed = Math.ceil((o.height * holdN) / (D.grip ?? 1e-9));
        throw new KernelError(`fingerBore: over ${f3(d - u)}-${f3(d + u)} mm (+-${u}, ${source}) the best fingers in the print plane grip the smallest size with about ${(D.grip ?? 0).toFixed(1)} N in a ${o.height} mm ring (asked: ${holdN} N; grip grows with the ring's height). Make the ring ${hNeed} mm tall, add a pinch split (clampRing with fit "grips"), or ask for a caliper measurement (+-0.05 lets a plain clamp do it).`);
    }
    const [cx, cy] = o.at ?? [0, 0];
    const rad = (deg) => (deg * Math.PI) / 180;
    let ring = circle({ d: 2 * D.outerR, center: [cx, cy] }).cut(circle({ d: 2 * D.beamR, center: [cx, cy] })).extrude({ z: [0, o.height] });
    const cuts = [], bumps = [];
    for (let i = 0; i < D.count; i++) {
        const a0 = rad(i * (360 / D.count)), aR = a0 + rad(D.rootDeg), aE = aR + rad(D.spanDeg), aG = aE + rad(D.gapDeg);
        cuts.push(sector(D.slotR, D.slotR + D.stop, aR, aE + rad(D.gapDeg) * 0.5, cx, cy).extrude({ z: [-1, o.height + 1] })); // slot behind the finger (its stop)
        cuts.push(sector(D.beamR - 0.5, D.slotR + D.stop, aE, aG, cx, cy).extrude({ z: [-1, o.height + 1] })); // frees the finger's tip
        const bw = Math.min(rad(D.spanDeg) * 0.22, 3 / D.beamR);
        bumps.push(sector(D.tipR, D.beamR + D.h / 2, aE - bw, aE, cx, cy).extrude({ z: [0, o.height] })); // ends flush with the finger tip: no ledge
    }
    const lead = Math.max(0.3, Math.min(D.yMax + 0.5, o.height / 3, D.beamR - D.tipR - 0.6)); // the lead-in stays inside the bumps: no feather on the fingers
    ring = ring.cut(...cuts).add(...bumps).cut(cone({ d1: 2 * D.tipR - 0.01, d2: 2 * (D.tipR + lead + 1), x: cx, y: cy, z: [o.height - lead, o.height + 1] }));
    const finger = { l: D.l, b: o.height, h0: D.h, deflect: [D.yMin, D.yMax], stopAt: D.stop, plane: "xy", why: `elastic finger taking up the size's +-${u} (${source})` };
    const name = o.name ?? "fingers";
    const reqs = [
        derived(`${name}: ${D.count} fingers ${D.l} mm long, ${D.h} thick, lying in the print plane; strain at the largest size ${(100 * D.strainMax).toFixed(2)}% (designed to the repeated-use allowance ${(100 * STRAIN.repeated).toFixed(1)}%, ${STRAIN.note})`, D.strainMax <= STRAIN.repeated + 1e-9, `${(100 * D.strainMax).toFixed(2)}%`, `<= ${(100 * STRAIN.repeated).toFixed(1)}%`, "lengthen the fingers (fewer, longer) or thin them to 2 lines"),
        derived(`${name}: hard stop ${D.stop} mm behind each finger; strain at the stop ${(100 * D.strainStop).toFixed(2)}%`, D.strainStop <= STRAIN.once + 1e-9, `${(100 * D.strainStop).toFixed(2)}%`, `<= ${(100 * STRAIN.once).toFixed(1)}% (single-use)`, "narrow the slot behind the fingers"),
        minRadiusIs({ name: `${name}: tip circle ${f3(2 * D.tipR)} (smallest size ${f3(d - u)} minus 2 x ${D.yMin})`, at: [cx, cy], z: o.height / 3, d: 2 * D.tipR }),
    ];
    if (ENGINE) {
        // round 2's rule (Bayer's linear formulas at 0.9 of the allowance) for the same ring, judged by the same engine
        let R = null;
        try {
            R = designFingers({ d, u, height: o.height, wall: o.wall, holdN, h: o.h, rule: true });
        }
        catch {
            R = null;
        }
        const judge = (F) => { const st = armAnswer({ l: F.l, b: o.height, h0: F.h, y: F.yMax, alpha: 30, mu: 0 }), lo = armAnswer({ l: F.l, b: o.height, h0: F.h, y: F.yMin, alpha: 30, mu: 0 }); return { strain: st.strain, grip: 0.2 * F.count * lo.P }; };
        const jr = R ? judge(R) : null;
        reqs.push(sized({ feature: "fingerBore", requirement: `the most grip at the smallest size (at least ${holdN} N) within ${(100 * STRAIN.repeated).toFixed(1)}% strain at the largest and ${(100 * STRAIN.once).toFixed(1)}% at the stop`,
            model: "the engine's nonlinear beam per finger (strain at the largest size, force at the smallest)", chosen: `${D.count} fingers ${D.l} long, ${D.h} thick, ${D.yMin} preload at the smallest`,
            predicted: { massG: 0, strain: D.strainMax }, handRule: R && jr ? { label: `round 2 rule: ${R.count} fingers ${R.l} long, ${R.h} thick, grip ${jr.grip.toFixed(1)} N by the engine`, massG: 0, strain: jr.strain } : undefined,
            table: [], evaluated: 0, ms: msF, notes: [`grip at the smallest size ${(D.grip ?? 0).toFixed(1)} N by the engine's finger force x friction 0.2`] }));
    }
    return ring.require(...reqs, facts({
        from: "fingerBore",
        flexures: { [name]: { kind: "fingers", count: D.count, finger, around: [f3(d - u), f3(d + u)], why: `bore for a ${d} mm (+-${u}, ${source}) round object` } },
        requirements: [
            { id: `${name}.grip`, grips: { flexure: name, min: holdN }, why: `holds with at least ${holdN} N across the size range` },
            { id: `${name}.grip.month`, grips: { flexure: name, min: holdN, after: 2.6e6 }, why: "and still after a month (elastic preload relaxes)" },
            { id: `${name}.strain`, strain: { flexure: name, use: "repeated" }, why: "fingers survive repeated insertion of the largest size" },
            { id: `${name}.stop`, stop: { flexure: name }, why: "a finger pushed onto its stop is not over-bent" },
        ],
    }));
}
export function designCradle(o) {
    const dMin = o.d - o.u, dMax = o.d + o.u;
    const seatR = dMax / 2 + 0.15 + PRINT_CORRECTION.holeVertical; // relaxed around the largest size: no stress when closed
    const ret = o.retain ?? Math.max(0.4, 0.06 * dMin); // undercut per side that holds the smallest
    const mouth = f3(dMin - 2 * ret);
    const yMax = f3((dMax - mouth) / 2); // each lip moves this far for the largest size
    const e = o.e ?? STRAIN.repeated;
    const mouthDeg = (Math.asin(Math.min(1, mouth / 2 / seatR)) * 180) / Math.PI; // lip angle from the top
    const armLen = (rd, hh) => ((180 - rd - mouthDeg) * Math.PI / 180) * (seatR + hh / 2);
    const stop = f3(yMax + 0.4), b = o.length ?? 15, pushMax = o.pushMax ?? 40, holdMin = o.holdMin ?? 5;
    if (ENGINE && o.h === undefined) {
        const cands = [];
        for (const rootDeg of [40, 35, 30, 25, 20])
            for (const tapered of [false, true])
                for (let h0 = Math.max(2 * LINE + 0.6, 0.14 * dMax); h0 >= (tapered ? 4 : 2) * LINE - 1e-9; h0 = f3(h0 * 0.88)) {
                    const l = armLen(rootDeg, h0);
                    cands.push({ label: `root ${rootDeg} deg, ${f3(h0)}${tapered ? `->${f3(h0 / 2)}` : ""} thick, ${f3(l)} long`, params: { rootDeg, tapered, h0: f3(h0), l }, massG: 2 * l * b * (tapered ? 0.75 : 1) * h0 * 1.24e-3 });
                }
        const t0 = performance.now();
        const scored = cands.map((c) => {
            const h1 = c.params.tapered ? c.params.h0 / 2 : c.params.h0;
            const a = armAnswer({ l: c.params.l, b, h0: c.params.h0, h1, y: yMax, alpha: 30, alphaR: 60 });
            const s = armAnswer({ l: c.params.l, b, h0: c.params.h0, h1, y: stop, alpha: 30, alphaR: 60 });
            // the fast call leaves out the hook's push fed back, which adds 10-15% strain (measured on round 2's cradle): margin 1.15
            const ok = a.strain * 1.15 <= e && s.strain * 1.15 <= STRAIN.once && a.W <= pushMax && (a.Wout ?? Infinity) >= holdMin;
            return { ...c, strain: a.strain, push: a.W, hold: a.Wout ?? Infinity, ok, why: ok ? undefined : a.strain * 1.15 > e ? `strain ${(100 * a.strain).toFixed(2)}%` : s.strain * 1.15 > STRAIN.once ? `stop ${(100 * s.strain).toFixed(2)}%` : a.W > pushMax ? `push ${a.W.toFixed(0)} N` : `holds ${(a.Wout ?? 0).toFixed(1)} N` };
        });
        const okc = scored.filter((c) => c.ok).sort((p, q) => q.hold - p.hold || p.massG - q.massG);
        // confirm the best with the full model (hook push fed back); step down the list if it is over
        let chosen = null, full = null, fullStop = null;
        for (const c of okc.slice(0, 6)) {
            const h1 = c.params.tapered ? c.params.h0 / 2 : c.params.h0;
            full = armAnswer({ l: c.params.l, b, h0: c.params.h0, h1, y: yMax, alpha: 30, alphaR: 60 }, { full: true });
            fullStop = armAnswer({ l: c.params.l, b, h0: c.params.h0, h1, y: stop, alpha: 30, alphaR: 60 }, { full: true });
            if (full.strain <= e && fullStop.strain <= STRAIN.once && full.W <= pushMax) {
                chosen = c;
                break;
            }
        }
        need(!!chosen, `cradle: a ${o.d} mm object known to +-${o.u} needs each lip to move ${yMax} mm; no arm in the print plane (root 20-40 deg, 2 lines and up, tapered or not) stays within ${(100 * e).toFixed(1)}% strain with a stop and snaps in under ${pushMax} N. Ask for a better measurement, or use a strap.`);
        const c = chosen, h1 = c.params.tapered ? c.params.h0 / 2 : c.params.h0;
        // round 2's hand rule (Bayer's linear formula at 0.9 of the allowance), judged by the same engine
        const hr = designCradleRule({ d: o.d, u: o.u, retain: o.retain });
        const hra = armAnswer({ l: hr.l, b, h0: hr.h0, h1: hr.h1, y: hr.yMax, alpha: 30, alphaR: 60 }, { full: true });
        const report = {
            feature: "cradle", requirement: `strain at the largest size <= ${(100 * e).toFixed(1)}% (repeated), at the stop <= ${(100 * STRAIN.once).toFixed(1)}%, push-in <= ${pushMax} N per arm, pull-out >= ${holdMin} N: the best hold`,
            model: "the engine's nonlinear snap arm (fast search, the chosen arm confirmed with the hook push fed back)",
            chosen: c.label, predicted: { massG: c.massG, strain: full.strain }, handRule: { label: `round 2 rule (Bayer, 0.9 x allowance): ${hr.h0}${hr.tapered ? `->${hr.h1}` : ""} thick, ${hr.l} long`, massG: 2 * hr.l * b * hr.h0 * 1.24e-3, strain: hra.strain },
            table: okc.slice(0, 4).concat(scored.filter((x) => !x.ok).slice(0, 2)).map((x) => ({ label: `${x.label}: push ${x.push.toFixed(0)} N, hold ${Number.isFinite(x.hold) ? x.hold.toFixed(0) : "locks"} N`, massG: x.massG, strain: x.strain, ok: x.ok, why: x.why })),
            evaluated: scored.length, ms: performance.now() - t0,
            notes: [`chosen arm with the full model: strain ${(100 * full.strain).toFixed(2)}%, at the stop ${(100 * fullStop.strain).toFixed(2)}%, push ${full.W.toFixed(1)} N, pull-out ${full.Wout === null ? "self-locking" : full.Wout.toFixed(1) + " N"} per arm; round 2's rule reached ${(100 * hra.strain).toFixed(2)}% by the same model`],
        };
        return { seatR: f3(seatR), h0: c.params.h0, h1: f3(h1), mouth, yMax, l: f3(c.params.l), rootDeg: c.params.rootDeg, mouthDeg, strain: full.strain, stop, strainStop: fullStop.strain, tapered: c.params.tapered, report };
    }
    return designCradleRule(o);
}
/** Round 2's hand rule (Bayer's linear formula at 0.9 of the allowance): kept for comparison and for an engine-less build. */
export function designCradleRule(o) {
    const dMin = o.d - o.u, dMax = o.d + o.u;
    const seatR = dMax / 2 + 0.15 + PRINT_CORRECTION.holeVertical;
    const ret = o.retain ?? Math.max(0.4, 0.06 * dMin);
    const mouth = f3(dMin - 2 * ret);
    const yMax = f3((dMax - mouth) / 2);
    const e = (o.e ?? STRAIN.repeated) * 0.9;
    let h0 = o.h ?? Math.max(2 * LINE + 0.6, 0.12 * dMax);
    const mouthDeg = (Math.asin(Math.min(1, mouth / 2 / seatR)) * 180) / Math.PI;
    let rootDeg = 40;
    const armLen = (rd, hh) => ((180 - rd - mouthDeg) * Math.PI / 180) * (seatR + hh / 2);
    let tapered = false, l = armLen(rootDeg, h0), strain = beamStrain(yMax, l, h0, false);
    while (strain > e && rootDeg > 20) {
        rootDeg -= 5;
        l = armLen(rootDeg, h0);
        strain = beamStrain(yMax, l, h0, false);
    }
    if (strain > e) {
        tapered = true;
        strain = beamStrain(yMax, l, h0, true);
    }
    while (strain > e && h0 / 2 > 2 * LINE) {
        h0 = f3(h0 * 0.9);
        l = armLen(rootDeg, h0);
        strain = beamStrain(yMax, l, h0, tapered);
    }
    need(strain <= e * 1.0001, `cradle: a ${o.d} mm object known to +-${o.u} needs each lip to move ${yMax} mm; the longest, thinnest printable arm reaches ${(100 * strain).toFixed(2)}% strain (limit ${(100 * e / 0.9).toFixed(1)}%). Ask for a better measurement, or use a strap.`);
    const stop = f3(yMax + 0.4);
    return { seatR: f3(seatR), h0: f3(h0), h1: f3(tapered ? h0 / 2 : h0), mouth, yMax, l: f3(l), rootDeg, mouthDeg, strain, stop, strainStop: beamStrain(stop, l, h0, tapered), tapered };
}
/**
 * A snap cradle for a round object (axis Z when printed: the C lies in the layers). Base on -y with an
 * optional flat foot for screws or adhesive. Arms are lengthened and tapered from strain; the mouth is
 * sized at the smallest size; the seat is relaxed around the largest (it holds by geometry, no preload);
 * outer stops limit how far a lip can be pried.
 */
export function cradle(o) {
    const { u, source } = uncertaintyOf(o.fit);
    const D = designCradle({ d: o.around, u, length: o.length });
    const name = o.name ?? "cradle";
    const [cx, cy] = o.at ?? [0, 0];
    const rad = (deg) => (deg * Math.PI) / 180;
    const R0 = D.seatR;
    // lips: round ends whose centres put the narrowest gap exactly at the mouth
    // the lip rounds the arm's tip exactly (diameter = the tip's thickness): a wider circle stood 0.1-0.2 proud of the outer
    // face and left a 0.13 mm sliver where it rejoined (found by worker run A4)
    const lipR = D.h1 / 2;
    const lx = D.mouth / 2 + lipR, ly = Math.sqrt(Math.max((R0 + lipR) ** 2 - lx * lx, 0));
    const m = Math.atan2(lx, ly); // lip angle from the top
    // taper: outer face on a circle centred delta below the seat's centre (h0 at the root, h1 at the lip)
    const root = rad(D.rootDeg);
    const delta = D.tapered ? (D.h0 - D.h1) / (Math.cos(root) + Math.cos(m)) : 0;
    const R1 = R0 + D.h1 + delta * Math.cos(m);
    const F = 4 * (R1 + 10);
    const wedge = path().moveTo(cx, cy).lineTo(cx + F * Math.sin(m), cy + F * Math.cos(m)).lineTo(cx - F * Math.sin(m), cy + F * Math.cos(m)).close();
    let prof = circle({ d: 2 * R1, center: [cx, cy - delta] }).cut(circle({ d: 2 * R0, center: [cx, cy] }), wedge);
    prof = prof.add(circle({ d: 2 * lipR, center: [cx + lx, cy + ly] }), circle({ d: 2 * lipR, center: [cx - lx, cy + ly] }));
    // base under the bottom +-rootDeg; stops outside each arm, concentric with its outer face, `stop` away
    const Rb = R1 + delta; // outer radius at the bottom
    const by0 = cy - Rb - 3;
    const base = rect({ x: [cx - Math.sin(root) * Rb - 0.5, cx + Math.sin(root) * Rb + 0.5], y: [by0, cy - Math.cos(root) * R0] });
    const stopR0 = R1 + D.stop, stopR1 = stopR0 + 2.4;
    const top = rad(15);
    const stops = [sector(stopR0, stopR1, rad(-90) + root, top, cx, cy - delta), sector(stopR0, stopR1, rad(180) - top, rad(270) - root, cx, cy - delta)];
    const stopBase = rect({ x: [cx - stopR1, cx + stopR1], y: [by0, cy - delta - Math.cos(root) * stopR0 + 0.6] }).cut(circle({ d: 2 * stopR0, center: [cx, cy - delta] }));
    let s = prof.add(base, ...stops, stopBase).extrude({ z: [0, o.length] });
    const reqs = [
        gapIs({ name: `${name}: mouth ${D.mouth} (smallest size ${f3(o.around - u)} minus 2 x ${f3((o.around - u - D.mouth) / 2)} undercut)`, at: [cx, cy + ly, o.length / 2], axis: "x", w: D.mouth, tol: 0.05 }),
        derived(`${name}: arms ${D.l} mm long, ${D.h0}${D.tapered ? ` tapering to ${D.h1}` : ""} thick, in the print plane; strain at the largest size ${(100 * D.strain).toFixed(2)}% (repeated-use allowance ${(100 * STRAIN.repeated).toFixed(1)}%, ${STRAIN.note})`, true, `${(100 * D.strain).toFixed(2)}%`, `<= ${(100 * STRAIN.repeated).toFixed(1)}%`),
        ...(D.report ? [sized(D.report)] : []),
        derived(`${name}: closed, the seat (r ${D.seatR}) clears the largest size (r ${f3((o.around + u) / 2)}): no stress held`, D.seatR >= (o.around + u) / 2, `${f3(D.seatR - (o.around + u) / 2)} mm clear`, ">= 0"),
        derived(`${name}: stops ${D.stop} mm outside each arm; strain at the stop ${(100 * D.strainStop).toFixed(2)}%`, D.strainStop <= STRAIN.once, `${(100 * D.strainStop).toFixed(2)}%`, `<= ${(100 * STRAIN.once).toFixed(1)}%`, "bring the stops closer"),
    ];
    if (o.foot) {
        // screws go beside the stops with room for their heads; if the stated width has none, the foot keeps its width
        // and runs on past the cradle along the pipe (upwards as printed, so nothing starts in mid-air), screws there
        const ft = o.foot.thickness ?? 4, headR = o.foot.screw ? o.foot.screw + 0.5 : 0, xsBeside = stopR1 + 1.0 + headR;
        const fw = Math.max(o.foot.width, 2 * stopR1);
        const beside = !o.foot.screw || o.foot.width >= 2 * (xsBeside + headR + 1.5);
        const ext = beside ? 0 : 2 * headR + 4;
        s = s.add(box({ x: [cx - fw / 2, cx + fw / 2], y: [by0 - ft, by0 + 0.01], z: [0, o.length + ext] }));
        if (!beside)
            reqs.push(derived(`${name}: the arms' stops take ${f3(2 * stopR1)} of the ${o.foot.width} mm foot, so it runs on ${f3(ext)} mm past the cradle along the pipe and the screws go there`, true, `${f3(ext)} mm`, "screw heads clear of the stops"));
        const holes = !o.foot.screw ? [] : beside ? [[cx - xsBeside, o.length / 2], [cx + xsBeside, o.length / 2]] : [[cx - (fw / 2 - headR - 2), o.length + ext / 2], [cx + (fw / 2 - headR - 2), o.length + ext / 2]];
        if (o.foot.screw)
            for (const [x, zh] of holes) {
                s = s.cut(cylinder({ d: o.foot.screw + 0.5, x, y: [by0 - ft - 1, by0 + 1], z: zh }));
                reqs.push(holeIs({ name: `foot screw hole d${o.foot.screw + 0.5}`, at: [x, by0 - ft / 2, zh], axis: "y", d: o.foot.screw + 0.5, tol: 0.1 }));
            }
    }
    const arm = { l: D.l, b: o.length, h0: D.h0, h1: D.h1, deflect: [0, D.yMax], stopAt: D.stop, plane: "xy", y: D.yMax, alpha: 30, alphaR: 60, mu: 0.2 };
    return s.require(...reqs, interfaceRecord({ ...decideFit({ function: "drops-in", measured: "calipers" }, { id: `${name}.seat`, feature: `${name} seat`, size: o.around, shape: "round", question: "", what: "the object" }),
        object: { size: o.around, uncertainty: u, source }, holds: [f3(o.around - u), f3(o.around + u)], modelled_per_side: f3(D.seatR - o.around / 2), function: "snaps",
        primitive: "drop-in pocket", reasoning: `snap cradle for a ${o.around} mm (+-${u}, ${source}) round object: seat r ${D.seatR} (relaxed around the largest), mouth ${D.mouth} (holds the smallest by ${f3((o.around - u - D.mouth) / 2)} per side), arms sized from strain` }), facts({
        from: "cradle", down: [0, -1, 0],
        flexures: { [name]: { kind: "cradle", arm, d: [f3(o.around - u), f3(o.around + u)], relaxedAbove: f3(2 * D.seatR) } },
        requirements: [
            { id: `${name}.strain`, strain: { flexure: name, use: "repeated" }, why: "snapping the largest size in and out, many times" },
            { id: `${name}.stop`, stop: { flexure: name }, why: "a lip pried onto its stop is not over-bent" },
            { id: `${name}.relaxed`, relaxed: { flexure: name }, why: "closed, it holds by geometry, not preload" },
            { id: `${name}.push`, insertion: { flexure: name, max: 40 }, why: "snaps in by hand (each arm, at most 40 N)" },
            { id: `${name}.retain`, retention: { flexure: name, min: 5 }, why: "does not fall out (each arm resists 5 N)" },
        ],
    }));
}
export function designSnap(o) {
    const e = (o.use === "once" ? STRAIN.once : STRAIN.repeated) * 0.9;
    const h0 = o.h ?? 2 * (2 * LINE); // tapered to h0/2 >= 2 lines
    const l = o.l ?? f3(Math.max(4 * h0, beamLength(o.y, h0, e, true)));
    const strain = beamStrain(o.y, l, h0, true);
    const stop = f3(o.y + 0.3);
    return { l, h0, h1: f3(h0 / 2), b: o.b, y: o.y, strain, stop, strainStop: beamStrain(stop, l, h0, true) };
}
/**
 * A snap arm lying in the print plane: root at (x, y), length along +x, bending in y (towards -y when the
 * hook is pushed), tapered h0 -> h0/2, hook of depth y on its +y face at the tip with a lead angle
 * (30 deg) and a return face (45 deg: separable and printable). A stop block sits `stop` behind the tip.
 * Returns the arm, the hook and the stop (union with the part), plus the cutter that frees the arm.
 */
export function snapArm(o) {
    const D = designSnap({ y: o.y, b: o.b, use: o.use, l: o.l, h: o.h });
    const [x, y0] = o.at, z0 = o.z0 ?? 0;
    const arm = polygon4([[x, y0 - D.h0 / 2], [x + D.l, y0 - D.h1 / 2], [x + D.l, y0 + D.h1 / 2], [x, y0 + D.h0 / 2]]);
    const tan30 = Math.tan(Math.PI / 6), hookLen = D.y / tan30 + D.y + 0.8;
    const hook = polygon4([[x + D.l - hookLen, y0 + D.h1 / 2 - 0.01], [x + D.l - D.y - 0.8, y0 + D.h1 / 2 + D.y], [x + D.l - 0.8, y0 + D.h1 / 2 + D.y], [x + D.l, y0 + D.h1 / 2 - 0.01]]);
    const solid = arm.add(hook).extrude({ z: [z0, z0 + D.b] });
    return { solid, design: D, stopY: y0 - D.h1 / 2 - D.stop };
}
/** The smallest distance from a vertical axis to the mesh in a band around height z, as a diameter. */
function minRadiusIs(o) {
    const tol = o.tol ?? 0.05;
    return { name: o.name, moved: (x, y, z) => minRadiusIs({ ...o, at: [o.at[0] + x, o.at[1] + y], z: o.z + z }), run(mesh) {
            let m = Infinity;
            const p = mesh.positions, idx = mesh.indices;
            for (let t = 0; t < idx.length; t += 3)
                for (let k = 0; k < 3; k++) {
                    const v = idx[t + k] * 3;
                    if (Math.abs(p[v + 2] - o.z) > o.z)
                        continue;
                    const r = Math.hypot(p[v] - o.at[0], p[v + 1] - o.at[1]);
                    if (r < o.d / 2 + 5)
                        m = Math.min(m, r);
                }
            const d = 2 * m, ok = Math.abs(d - o.d) <= tol;
            return { name: o.name, pass: ok, measured: f3(d), expected: `${f3(o.d)} +-${tol}`, fix: ok ? undefined : "the fingers' tips are not where the design put them" };
        } };
}
/** k marks along x at (x, y), height h: bumps, with five as a 4 mm bar (8 = bar + 3 bumps). */
export function markBumps(k, x, y, h, d = 1.2, pitch = 1.5) {
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
function polygon4(p) { return path().moveTo(p[0][0], p[0][1]).lineTo(p[1][0], p[1][1]).lineTo(p[2][0], p[2][1]).lineTo(p[3][0], p[3][1]).close(); }
// ------------------------------------------------------------------------------------------------
// Coupons: each primitive's test piece
/**
 * Snap strain ladder (survey coupon C1, in the print plane): `n` tapered arms of the same geometry
 * (l, h0 -> h0/2, b) on one bar, each with a fixed hard stop at the travel that gives a stepped strain.
 * The person presses every tip to its stop once and lets go: arms that crack or stay bent mark the limit.
 * Marks: k bumps on the bar beside arm k (count them, no text).
 */
export function strainLadder(o) {
    const l = o.l ?? 14, h0 = o.h ?? 2.0, b = o.b ?? 6, [x0, y0] = o.at ?? [0, 0];
    const pitch = 9, n = o.strains.length, W = n * pitch + 4;
    const travel = o.strains.map((e) => f3(1.09 * e * l * l / h0));
    // bar along x at the bottom (y0 .. y0+6); arms stand along +y from the bar, bending in x; stops are posts beside each tip
    let s = rect({ x: [x0, x0 + W], y: [y0, y0 + 6] }).extrude({ z: [0, b], bottom: { chamfer: 0.3 } });
    const arms = [];
    o.strains.forEach((e, k) => {
        const ax = x0 + 4 + k * pitch;
        arms.push(polygon4([[ax - h0 / 2, y0 + 6 - 0.01], [ax + h0 / 2, y0 + 6 - 0.01], [ax + h0 / 4, y0 + 6 + l], [ax - h0 / 4, y0 + 6 + l]]).extrude({ z: [0, b] }));
        // tip pad to press, and the stop post at the computed travel (in +x)
        arms.push(rect({ x: [ax - h0 / 4, ax + h0 / 4 + 0.01], y: [y0 + 6 + l - 2, y0 + 6 + l] }).extrude({ z: [0, b] }));
        arms.push(rect({ x: [ax + h0 / 4 + travel[k], ax + h0 / 4 + travel[k] + 1.6], y: [y0 + 6 + l - 4, y0 + 6 + l + 1] }).extrude({ z: [0, b] }));
        arms.push(rect({ x: [ax + h0 / 4 + travel[k], ax + h0 / 4 + travel[k] + 1.6], y: [y0 + 6 - 0.01, y0 + 6 + l - 4] }).extrude({ z: [0, 1.2] })); // stop post's foot
        // marks: k+1 small bumps on the bar's front edge (y0) under the arm
        arms.push(...markBumps(k + 1, ax - 3.5, y0 + 0.2, b));
    });
    s = s.add(...arms);
    return { solid: s, arms: o.strains.map((e, k) => ({ strain: e, travel: travel[k] })) };
}
void text;
void thicknessIs;
void rect;
