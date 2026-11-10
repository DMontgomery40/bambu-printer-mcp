/**
 * Materials for the engine, read from materials/data.json (every number there carries its source id and
 * where in the source it was read; see materials/SOURCES.md). This module only chooses which sourced
 * value is the nominal one (the Bambu Lab data sheet, because the owner prints on a Bambu P1S) and keeps
 * the spread across sources so checks can report a range instead of one number.
 *
 * Gaps filled by stated assumption, never by a remembered number:
 *  - Poisson ratio 0.35 for all plastics (the Bayer guide's generic value; not measured for these).
 *  - Shear modulus across layers G13 = E_z / (2 (1 + 0.35)) (no measured value found).
 *  - Interlayer shear strength = S_z / sqrt(3) (no measured value found).
 *  - Allowable strain: no published value for printed PLA or PETG. The engine uses a derived candidate
 *    range (conservative .. optimistic) and reports "uncertain" between them.
 */
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(new URL("../materials/data.json", import.meta.url), "utf8"));
export const SOURCES = data.sources;
function v(m, k) { const e = data[m][k]; if (!e || e.value === null || e.value === undefined)
    throw new Error(`materials: ${m}.${k} has no sourced value`); return e.value; }
function all(m, k) { const e = data[m][k]; if (!e)
    return []; return [e.value, ...(e.others ?? []).map((o) => o.value)].filter((x) => typeof x === "number"); }
function src(m, k) { const e = data[m][k]; return e?.source ?? "?"; }
const NU = 0.35;
function make(name) {
    const E1 = v(name, "E_xy_MPa"), E3 = v(name, "E_z_MPa");
    const Sxy = v(name, "UTS_xy_MPa"), Sz = v(name, "UTS_z_MPa");
    const xs = all(name, "UTS_xy_MPa"), zs = all(name, "UTS_z_MPa");
    const ratios = [];
    // pair ratios source by source where both exist
    const e1 = data[name]["UTS_xy_MPa"], e3 = data[name]["UTS_z_MPa"];
    const bySrc = (e) => { const m = new Map(); if (e.value !== null && e.source)
        m.set(e.source, e.value); for (const o of e.others ?? [])
        if (!m.has(o.source))
            m.set(o.source, o.value); return m; };
    const mx = bySrc(e1), mz = bySrc(e3);
    for (const [s, z] of mz)
        if (mx.has(s))
            ratios.push(Math.round((z / mx.get(s)) * 100) / 100);
    void xs;
    let strainOnce, strainRepeated, strainNote;
    if (name === "PLA") {
        strainOnce = [0.017, 0.024];
        strainRepeated = [0.010, 0.0144];
        strainNote = "no published allowable strain for printed PLA. Range: 0.7 x 2.4% (OpenFlexure's near-yield design strain, survey docs/research/compliant-mechanisms.md section 2.1) to 0.7 x 3.4% (UltiMaker PLA yield strain, S4), both by the Bayer amorphous rule (S5 p.11); repeated = x0.6 (S5 p.12). Across layers UltiMaker PLA has no yield and breaks at 2.0% (S4).";
    }
    else if (name === "PETG") {
        strainOnce = [0.017, 0.036];
        strainRepeated = [0.010, 0.0216];
        strainNote = "no published allowable strain for printed PETG. Range: PLA's conservative figure (survey: use PLA numbers until coupon C1) to 0.7 x 5.1% (Prusament PETG yield strain, S3) by the Bayer amorphous rule (S5 p.11); repeated = x0.6 (S5 p.12).";
    }
    else {
        strainOnce = [NaN, NaN];
        strainRepeated = [NaN, NaN];
        strainNote = "TPU: no snap-fit strain data; its data-sheet moduli disagree 7x (9.8 MPa S6 vs 67 MPa S8). Linear checks are not meaningful for TPU; the engine refuses strain verdicts for it.";
    }
    const frE = data[name].friction_vs_steel_or_aluminium;
    const fr = frE?.value?.static_dry ?? frE?.static_dry;
    const muSteel = fr ? [Math.min(...Object.values(fr)), Math.max(...Object.values(fr))] : [NaN, NaN];
    const rel = data[name].stress_relaxation?.value;
    return {
        name, E1, E3, nu12: NU, nu31: (NU * E3) / E1, G13: E3 / (2 * (1 + NU)),
        Sxy, Sz, density: v(name, "density_g_cm3"),
        SzLow: Math.min(...zs), zRatios: ratios,
        strainOnce, strainRepeated, strainNote,
        muSteel, muNote: fr ? `static, dry, against steel at 30-70 N (S13); plastic on plastic not measured (the Bayer guide's table, S5 p.15, multiplies by 1.2-2.0 for same-on-same in other plastics)` : "no friction data",
        relaxLoss: rel ? [rel.range_pct[0] / 100, rel.range_pct[1] / 100] : undefined, relaxSeconds: rel?.duration_s,
        cite: { E_xy: src(name, "E_xy_MPa"), E_z: src(name, "E_z_MPa"), UTS_xy: src(name, "UTS_xy_MPa"), UTS_z: src(name, "UTS_z_MPa") },
    };
}
export const MATERIALS = { PLA: make("PLA"), PETG: make("PETG"), TPU: make("TPU") };
export function material(name) { const m = MATERIALS[name]; if (!m)
    throw new Error(`unknown material ${name}; use PLA, PETG or TPU`); return m; }
export const RAW = data;
/** The kernel's ladder strains (KEY.md, coupons A and B) */
export const LADDER_STRAINS = [0.008, 0.010, 0.012, 0.015, 0.018, 0.022, 0.027, 0.033];
/** J: held tip travel for each arm (mm): tapered arm l 30, h 2.0 -> 1.0, travel = 1.09 eps l^2 / h0 (Bayer Table 1), strains 0.5..1.7% */
export const J_STRAINS = [0.005, 0.008, 0.011, 0.014, 0.017];
export const J_TRAVEL = J_STRAINS.map((e) => (1.09 * e * 30 * 30) / 2.0);
/** K: the stand's inclines (deg) */
export const K_ANGLES = [8, 11, 14, 17, 20, 24, 28, 33];
/** L: arm and load: l 150 mm, b 8, h 2.4 (12 layers of 0.2), cup 25 x 25 x 16 mm inside to the brim (10.0 g of water) */
export const L_ARM = { l: 150, b: 8, h: 2.4, waterG: 10.0 };
/** Apply observations to a material: returns the material with the observed values and one line per replacement. */
export function applyObserved(m, obs = []) {
    const out = { ...m, cite: { ...m.cite } };
    const used = [];
    for (const o of obs) {
        if (o.material !== m.name)
            continue;
        const tag = `coupon ${o.coupon}${o.printed ? `, printed ${o.printed}` : ""}${o.printer ? ` on ${o.printer}` : ""}`;
        if (o.coupon === "A" || o.coupon === "B") {
            const st = o.strains ?? LADDER_STRAINS;
            const safe = (k) => (k === undefined ? undefined : k === "none" ? st[st.length - 1] : k >= 2 ? st[k - 2] : 0);
            const brk = (k) => (k === undefined || k === "none" ? undefined : st[k - 1]);
            if (o.coupon === "A") {
                const s1 = safe(o.once), s10 = safe(o.ten);
                if (s1 !== undefined) {
                    out.strainOnce = [s1, s1];
                    used.push(`single-use strain allowance in the layers ${(100 * s1).toFixed(1)}% (observed, ${tag}: arms up to ${(100 * s1).toFixed(1)}% survived${brk(o.once) ? `, ${(100 * brk(o.once)).toFixed(1)}% did not` : ", every arm survived (a lower bound)"}), replacing the derived ${(100 * m.strainOnce[0]).toFixed(1)}-${(100 * m.strainOnce[1]).toFixed(1)}%`);
                }
                if (s10 !== undefined) {
                    out.strainRepeated = [s10, s10];
                    used.push(`repeated-use strain allowance ${(100 * s10).toFixed(1)}% (observed after ten bends, ${tag}), replacing the derived ${(100 * m.strainRepeated[0]).toFixed(1)}-${(100 * m.strainRepeated[1]).toFixed(1)}%`);
                }
            }
            else {
                const s1 = safe(o.once);
                if (s1 !== undefined) {
                    const Sz = m.E3 * s1; // linear to break across the layers (UltiMaker PLA: "No yield" across, S4)
                    out.SzLow = Math.min(out.SzLow, Sz);
                    out.Sz = Math.min(out.Sz, Math.max(Sz, 1));
                    out.strainZ = s1;
                    used.push(`across-layer strain limit ${(100 * s1).toFixed(1)}% (observed, ${tag}); across-layer strength taken as E_z x that = ${Sz.toFixed(0)} MPa (lower bound; linear to break across layers, S4), replacing ${m.Sz} MPa (${m.cite.UTS_z}) where lower`);
                    out.cite.UTS_z = `${tag}`;
                }
            }
        }
        else if (o.coupon === "J") {
            const y = J_TRAVEL[o.arm - 1];
            if (!y)
                continue;
            const set = 0.5 * o.setTicks, r = Math.min(1, set / y), dr = 0.25 / y;
            out.relaxLoss = [Math.max(0, r - dr), Math.min(1, r + dr)];
            out.relaxSeconds = o.heldSeconds;
            out.relaxCite = `observed, ${tag}`;
            used.push(`stress relaxation ${(100 * r).toFixed(0)}% (+-${(100 * dr).toFixed(0)}) after ${(o.heldSeconds / 86400).toFixed(1)} days held at ${(100 * J_STRAINS[o.arm - 1]).toFixed(1)}% strain (observed, ${tag}: set ${set.toFixed(1)} mm of ${y.toFixed(1)} mm held, read on release; set / held = relaxed fraction for a standard linear solid), replacing ${m.relaxLoss ? `${(100 * m.relaxLoss[0]).toFixed(0)}-${(100 * m.relaxLoss[1]).toFixed(0)}% within ${m.relaxSeconds} s (S16)` : "no data"}`);
        }
        else if (o.coupon === "K") {
            const a = K_ANGLES[o.stays - 1] ?? 0, b2 = K_ANGLES[o.slides - 1] ?? 90;
            const lo = Math.tan((a * Math.PI) / 180), hi = Math.tan((b2 * Math.PI) / 180);
            if (o.pair === "object-part") {
                out.muObject = [lo, hi];
                used.push(`friction of the object on the printed part ${lo.toFixed(2)}-${hi.toFixed(2)} (observed, ${tag}: stays at ${a} deg, slides at ${b2} deg)`);
            }
            else {
                out.muSteel = [lo, lo];
                out.muNote = `observed ${o.pair} static ${lo.toFixed(2)}-${hi.toFixed(2)} (${tag}; the lower end is used)`;
                used.push(`static friction ${o.pair} ${lo.toFixed(2)}-${hi.toFixed(2)} (observed, ${tag}), replacing ${m.muSteel[0]}-${m.muSteel[1]} against steel (S13)`);
            }
        }
        else if (o.coupon === "L") {
            const d = 0.5 * (o.fullTicks - o.emptyTicks);
            if (!(d > 0))
                continue;
            const F = (L_ARM.waterG / 1000) * 9.81, I = (L_ARM.b * L_ARM.h ** 3) / 12;
            const E = (F * L_ARM.l ** 3) / (3 * I * d);
            // reading +-0.25 mm on d, water to the brim +-3%, the arm's 12 layers +-0.05 mm (x3 in h^3)
            const rel = Math.hypot(0.25 / d, 0.03, (3 * 0.05) / L_ARM.h);
            out.E1 = E;
            out.cite.E_xy = tag;
            used.push(`in-layer modulus ${E.toFixed(0)} MPa +-${(100 * rel).toFixed(0)}% (observed, ${tag}: ${d.toFixed(1)} mm under 10 g of water at 150 mm), replacing ${m.E1} MPa (${m.cite.E_xy}; sources span ${m.E1}-3292)`);
        }
    }
    return { material: out, used };
}
