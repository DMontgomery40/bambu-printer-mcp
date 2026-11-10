/**
 * Fits by function. Every interface keeps three numbers apart, never folded into one:
 *  1. the object's true size, how it was measured and its uncertainty (calipers +-0.05, published
 *     +-0.3, scan +-0.5, photo estimate +-1.0);
 *  2. the print correction: what the printer does to this kind of feature (pockets and holes print
 *     undersize; horizontal holes also sag), for this printer, material and orientation;
 *  3. the design fit, which comes only from what the interface has to do.
 * Each function tolerates a band of size error. If the size is less certain than the band, the kernel
 * picks a mechanism that absorbs it (crush ribs, a pinch split) or asks for a measurement; it never
 * picks a "better number". The output is a primitive (drop-in pocket, rib-grip bore, split-pinch clamp),
 * and an interface record that a person's "did it fit?" answer can later be stored against.
 *
 * All numbers are starting rules for a 0.4 mm nozzle printing PLA on a Bambu P-series, written down so
 * they can be read and calibrated: there is no general clearance constant. The owner's two printed parts
 * need opposite answers: a bottle holder that is right loose, a mic mount that grips a pole whose size
 * was estimated from a photo (crush ribs and a pinch screw).
 */
import { KernelError } from "./kernel/profile.js";
/** 1. measurement: +- on the whole dimension (mm). */
export const SOURCE_UNCERTAINTY = { designed: 0, calipers: 0.05, published: 0.3, ruler: 0.3, scan: 0.5, photo: 1.0 };
/** 2. print correction per side (mm) by feature, for printer "Bambu P1S", PLA, 0.4 nozzle. To be calibrated by feedback. */
export const PRINT_CORRECTION = {
    printer: "Bambu P1S, PLA, 0.4 mm nozzle (uncalibrated starting values)",
    pocketVerticalWalls: 0.05, // inner perimeters pull in
    holeVertical: 0.05, // round hole, axis Z: prints ~0.1 small in diameter
    holeHorizontal: 0.075, // round hole, axis in XY: ~0.15 small, top sags
};
/** 3. design fit per side by function (mm), and the band of size error each tolerates (+- mm). */
export const FUNCTION_RULES = {
    "drops-in": { fit: 0.35, band: 0.3, what: "is dropped in and lifted out; loose is the point" },
    slides: { fit: 0.2, band: 0.15, what: "slides on and off by hand without binding" },
    locates: { fit: 0.1, band: 0.1, what: "sits without rattling and comes out by hand" },
    grips: { fit: null, band: 0.05, what: "is held and must not slip or turn" },
    clamps: { fit: 0.1, band: 0.05, what: "is clamped by a screw" },
    snaps: { fit: null, band: 0.1, what: "snaps over and stays" },
    presses: { fit: null, band: 0.05, what: "is pressed in permanently" },
};
export const FEEDBACK_CHOICES = ["too tight", "right", "loose", "rattles", "fell out"];
const r3 = (x) => Math.round(x * 1000) / 1000;
/**
 * Decide one interface. `size` is the mating object's size (diameter for round, governing width for
 * flat); `inferred` is the function implied by the part's kind (holder: drops-in; clamp ring: clamps),
 * used only when the script states none; otherwise the answer is `question`.
 */
export function decideFit(spec, ctx) {
    const assumptions = [];
    if (typeof spec === "number")
        throw new KernelError(`${ctx.feature}: a bare clearance (${spec} mm) does not say what the fit has to do. State fit: { function: "drops-in" | "slides" | "locates" | "grips" | "clamps", measured: "calipers" | "published" | "scan" | "photo" | +-mm }. To use your own calibrated number, add clearance and because.`);
    if (typeof spec === "string")
        spec = { function: spec };
    let inferred = false;
    if (!spec) {
        if (!ctx.inferred)
            throw new KernelError(`${ctx.feature}: ${ctx.question} State fit: { function: ... }.`);
        spec = { function: ctx.inferred };
        inferred = true;
        assumptions.push(`function "${ctx.inferred}" inferred from the part's kind`);
    }
    const fn = spec.function, rule = FUNCTION_RULES[fn];
    if (!rule)
        throw new KernelError(`${ctx.feature}: unknown fit function "${fn}"; use one of ${Object.keys(FUNCTION_RULES).join(", ")}`);
    if (fn === "snaps" || fn === "presses")
        throw new KernelError(`${ctx.feature}: a "${fn}" fit is a feature of its own: use cradle({ around, fit: { function: "grips", measured } }) to snap over a round object, fingerBore(...) for an elastic grip, or "grips" / "clamps" here (press-in bosses are not built yet).`);
    let u, source;
    if (typeof spec.measured === "number") {
        u = Math.abs(spec.measured);
        source = `+-${u} as stated`;
    }
    else if (spec.measured) {
        if (!(spec.measured in SOURCE_UNCERTAINTY))
            throw new KernelError(`${ctx.feature}: measured must be one of ${Object.keys(SOURCE_UNCERTAINTY).join(", ")} or +- mm`);
        u = SOURCE_UNCERTAINTY[spec.measured];
        source = spec.measured;
    }
    else {
        u = SOURCE_UNCERTAINTY.calipers;
        source = "calipers (assumed)";
        assumptions.push(`size assumed measured with calipers (+-${u}); say measured: "published" | "scan" | "photo" | +-mm if not`);
    }
    const corrFeature = ctx.shape === "round" ? `round hole, ${ctx.axis ?? "vertical"} axis` : "pocket, vertical walls";
    const corr = ctx.shape === "round" ? (ctx.axis === "horizontal" ? PRINT_CORRECTION.holeHorizontal : PRINT_CORRECTION.holeVertical) : PRINT_CORRECTION.pocketVerticalWalls;
    const base = {
        id: ctx.id, feature: ctx.feature, function: fn, function_inferred: inferred,
        object: { size: ctx.size, uncertainty: u, source },
        print_correction: { per_side: corr, feature: corrFeature, printer: PRINT_CORRECTION.printer },
        design_fit: { per_side: rule.fit, band: rule.band }, assumptions, feedback: null,
    };
    const n = r3(ctx.size), what = `${ctx.what ?? ctx.feature}: a ${n} mm ${ctx.shape === "round" ? "diameter" : "size"} (${source}, +-${u}) that ${rule.what}`;
    if (spec.clearance !== undefined) {
        if (!spec.because)
            throw new KernelError(`${ctx.feature}: an explicit clearance needs because: "<why this number>" (for example a fit ring that was right).`);
        return { ...base, primitive: fn === "drops-in" ? "drop-in pocket" : "locating fit", modelled_per_side: spec.clearance, holds: [r3(n - u), r3(n + 2 * spec.clearance)],
            reasoning: `${what}. Modelled ${spec.clearance} mm per side as stated (${spec.because}); print correction and design fit not applied separately.` };
    }
    // plain fits: the uncertainty must sit inside the function's band
    if (fn === "drops-in" || fn === "slides" || (fn === "locates" && u <= rule.band)) {
        if (u > rule.band)
            throw new KernelError(`${ctx.feature}: the size is known to +-${u} (${source}) but a "${fn}" fit only tolerates +-${rule.band}. Ask for a caliper measurement of the ${ctx.what ?? "object"}, or use a mechanism that absorbs the error (fit: "grips" or "clamps").`);
        const m = r3(rule.fit + corr);
        const prim = fn === "drops-in" ? "drop-in pocket" : fn === "slides" ? "sliding fit" : "locating fit";
        return { ...base, primitive: prim, modelled_per_side: m, holds: [r3(n - rule.band), r3(n + rule.band)],
            reasoning: `${what}. ${prim}: modelled ${m} mm per side = design fit ${rule.fit} (${fn}) + print correction ${corr} (${corrFeature}); tolerates sizes ${r3(n - rule.band)} to ${r3(n + rule.band)}.` };
    }
    if (fn === "clamps" && ctx.shape === "round") {
        // the bore clears the largest size (round 2 cleared the nominal, so a +-1 handle at its largest did not pass: worker
        // run A5), and the split widens until it closes the bore onto the smallest; refused only past a quarter of the ring
        const m = r3(rule.fit + corr);
        const bore = r3(n + u + 2 * m);
        const closeNeeded = bore - (n - u);
        const g = Math.max(ctx.splitGap ?? 2, Math.ceil(Math.PI * closeNeeded * 2) / 2), closes = r3(g / Math.PI);
        if (g > 0.25 * Math.PI * n)
            throw new KernelError(`${ctx.feature}: the ${n} mm size is known to +-${u} (${source}); a split that closes the bore from the largest to the smallest would be ${g} mm, over a quarter of the ring. Ask for a caliper measurement, or use fingerBore for a light hold.`);
        return { ...base, primitive: "split-pinch clamp", modelled_per_side: m, split: { gap: g, closes_diameter_by: closes }, holds: [r3(bore - closes), r3(bore - 0.05)],
            reasoning: `${what}. Split-pinch clamp: bore ${bore} (the largest size, ${r3(n + u)}, + design fit ${rule.fit} to slide on before tightening + print correction ${corr} per side); the ${g} mm split closes it by up to ${closes}, so it clamps ${r3(bore - closes)} to ${r3(bore - 0.05)} mm.` };
    }
    // grips (or locates with an uncertain size). Rules from docs/research/compliant-mechanisms.md (rule 4, section 4):
    // a long hold comes from a screw, not from elastic preload in PLA/PETG (creep), and crushed ribs take a set,
    // so the pinch split alone must close the bore from above the largest size to the smallest: g >= pi * (2u + 2 * clear).
    if (ctx.shape !== "round")
        throw new KernelError(`${ctx.feature}: a gripping fit on a flat section is not built yet; use a drop-in pocket with a stated clearance and because, or a round feature.`);
    const clear = 0.1 + corr; // the cut bore clears the largest expected size by this, per side
    const bore = r3(n + u + 2 * clear);
    const closeNeeded = bore - (n - u); // diameter the split must take up
    if (u > 0.5) {
        const g = r3(Math.PI * closeNeeded);
        throw new KernelError(`${ctx.feature}: the ${n} mm size is only known to +-${u} (${source}). A pinch split would need a ${g} mm gap to cover that (g >= 2 pi u), and crush ribs take a set, so: ask for a caliper measurement of ${ctx.what ?? "the object"}'s diameter, or use fingerBore({ around, fit, height }) (elastic fingers in the print plane take up +-1) for a light hold.`);
    }
    const g = Math.max(ctx.splitGap ?? 2, Math.ceil(Math.PI * closeNeeded * 2) / 2);
    const closes = r3(g / Math.PI);
    const holds = [r3(bore - closes), r3(bore - 0.05)];
    if (u <= 0.1) {
        return { ...base, primitive: "split-pinch clamp", modelled_per_side: r3(clear + u / 2), split: { gap: g, closes_diameter_by: closes }, holds,
            reasoning: `${what}. A grip that must hold for months comes from a screw (PLA and PETG creep), so: split-pinch clamp, bore ${bore} (clears the largest size by ${r3(clear)} per side, print correction ${corr} included); the ${g} mm split closes it by up to ${closes}, so it grips ${holds[0]} to ${holds[1]} mm.` };
    }
    const count = n < 15 ? 4 : n < 45 ? 6 : 8;
    const ribH = 0.3; // centring ribs; the screw does the holding
    return { ...base, primitive: "rib-grip bore + pinch split", modelled_per_side: r3((bore - n) / 2), ribs: { count, height: ribH, tip_per_side: r3((bore - 2 * ribH - n) / 2) }, split: { gap: g, closes_diameter_by: closes }, holds,
        reasoning: `${what}. The size is less certain (+-${u}) than a grip tolerates (+-${rule.band}): ${count} crush ribs ${ribH} mm high centre it in a ${bore} mm bore (cut above the largest size, ${r3(n + u)}, print correction ${corr} included) and a ${g} mm pinch split (g >= pi x ${r3(closeNeeded)}) closes it by up to ${closes}, so the screw grips anything from ${holds[0]} to ${holds[1]} mm.` };
}
