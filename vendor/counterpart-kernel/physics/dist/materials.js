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
