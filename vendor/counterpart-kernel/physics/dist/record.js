/**
 * The part record in, every requirement answered: `answer(record)` reads a `counterpart/part-record@1`
 * (docs/part-record.md, plain JSON from the kernel) and returns a `counterpart/part-answer@1` with one answer
 * per requirement id, in order: pass, fail, uncertain or unsupported, with the number, where, why, what would
 * fix it, the fidelity it was computed at, its error estimate and the time it took.
 *
 * The record's mesh becomes the engine's geometry directly: cut cells by ray parity (exact along z), a signed
 * distance from a bounding-volume hierarchy for everything that needs one (surface stress, screw seats, load
 * patches, statics). Whole-part requirements that share loads share one solve. Flexures are beams (snap,
 * cantilever, fingers, cradle) or the split-ring clamp. The kinds the kernel's adapter (src/prove.ts) filled
 * from beam formulas before the engine read the record are taken over here, with the same models.
 *
 * Frames: the record is in the print frame; `down` is gravity in that frame. When `down` is not -z the whole
 * record is turned (an axis permutation) into the use frame, where the engine's statics take gravity as -z;
 * the print direction turns with it, so layers stay where they were printed.
 */
import { check } from "./check.js";
import { material as getMaterial } from "./materials.js";
import { snapEngine } from "./beam/snap.js";
import { meshDistance } from "./geom/meshdist.js";
import { thinWall } from "./solid/analyze.js";
const KEYS = ["holds", "deflection", "staysIn", "liftsOut", "retains", "strain", "stop", "insertion", "retention", "grips", "relaxed", "escape"];
const keyOf = (r) => KEYS.find((k) => k in r);
/** A signed axis permutation taking `down` to -z (only axis-aligned `down` is accepted). */
function useFrame(down) {
    const a = down.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-9);
    if (a < 0 || down.some((v, i) => i !== a && Math.abs(v) > 1e-9))
        return null;
    if (a === 2 && down[2] < 0)
        return { perm: [0, 1, 2], sign: [1, 1, 1] };
    if (a === 2)
        return { perm: [0, 1, 2], sign: [1, -1, -1] }; // upside down: turn about x
    // down along +-x or +-y: that axis becomes z (pointing up = -down), the old z takes its place
    const perm = [0, 1, 2];
    perm[2] = a;
    perm[a] = 2;
    const sign = [1, 1, 1];
    sign[2] = -Math.sign(down[a]);
    sign[a] = Math.sign(down[a]); // keeps a right-handed frame
    return { perm, sign };
}
const rv = (R, v) => [R.sign[0] * v[R.perm[0]], R.sign[1] * v[R.perm[1]], R.sign[2] * v[R.perm[2]]];
const rRange = (R, b) => [0, 1, 2].map((i) => { const [p, q] = b[R.perm[i]]; return R.sign[i] > 0 ? [p, q] : [-q, -p]; });
function rRegion(R, g) {
    if (g.box)
        return { box: rRange(R, g.box) };
    if (g.near)
        return { near: rv(R, g.near), radius: g.radius };
    if (g.cylinder)
        return { cylinder: { ...g.cylinder, at: rv(R, g.cylinder.at), axis: rv(R, g.cylinder.axis) } };
    if (g.plane)
        return { plane: { point: rv(R, g.plane.point), normal: rv(R, g.plane.normal) }, ...(g.within ? { within: rRange(R, g.within) } : {}), ...(g.tol ? { tol: g.tol } : {}) };
    return g;
}
function rMesh(R, m) {
    const p = m.positions, out = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const v = rv(R, [p[i], p[i + 1], p[i + 2]]);
        out[i] = v[0];
        out[i + 1] = v[1];
        out[i + 2] = v[2];
    }
    // a reflection would turn the triangles inside out
    const det = R.sign[0] * R.sign[1] * R.sign[2] * permSign(R.perm);
    const idx = det > 0 ? m.indices : m.indices.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]);
    return { positions: out, indices: idx };
}
function permSign(p) { let s = 1; for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
        if (p[i] > p[j])
            s = -s; return s; }
/** Voxel for whole-part checks from the thinnest wall: fast 1.5 cells across it, normal 2, fine 3 (cut cells make 1.5-2 cells enough for bending). */
export function resolutionFor(f, tMin, size) {
    const per = f === "fast" ? 1.5 : f === "fine" ? 3 : 2;
    let h = Math.round((tMin / per) * 10) / 10;
    // keep the whole part to a few hundred thousand unknowns
    h = Math.max(h, size / (f === "fine" ? 220 : f === "fast" ? 90 : 140));
    return Math.min(3, Math.max(0.3, h));
}
export function answer(rec, opts = {}) {
    const t0 = performance.now();
    const fidelity = opts.fidelity ?? rec.fidelity ?? "normal";
    const notes = [];
    const out = new Map();
    const reqName = (r) => { const k = keyOf(r); return k ? `${k}${r[k]?.flexure ? ` ${r[k].flexure}` : ""}` : Object.keys(r).filter((x) => !["id", "why", "from"].includes(x)).join(","); };
    const put = (r, a, ms, extraWhy = "", error) => out.set(r.id, { id: r.id, requirement: a.requirement ?? reqName(r), verdict: a.verdict, value: a.value ?? "-", limit: a.limit ?? "-", where: a.where, why: `${a.why ?? ""}${extraWhy}`, fix: a.fix, fidelity, ms: Math.round(a.ms ?? ms), from: r.from, ...(error !== undefined ? { error } : {}) });
    const unsupported = (r, why) => put(r, { verdict: "unsupported", why }, 0);
    const done = () => ({ schema: "counterpart/part-answer@1", name: rec.name, answers: rec.requirements.map((r) => out.get(r.id) ?? { id: r.id, requirement: reqName(r), verdict: "unsupported", value: "-", limit: "-", why: "no answer", fidelity, ms: 0 }), notes, ms: Math.round(performance.now() - t0), engine: "counterpart-physics round 2" });
    const matName = ["PLA", "PETG", "TPU"].find((n) => n === rec.material.name.toUpperCase());
    if (!matName) {
        for (const r of rec.requirements)
            unsupported(r, `material ${rec.material.name}: the engine has sourced data for PLA, PETG and TPU only`);
        return done();
    }
    const m = getMaterial(matName);
    if (!rec.material.stated)
        notes.push(`material ${matName} was assumed by the kernel, not stated by the person; a result that would change with PETG says so`);
    const R = useFrame(rec.down ?? [0, 0, -1]);
    if (!R) {
        for (const r of rec.requirements)
            unsupported(r, `gravity ${JSON.stringify(rec.down)} in the print frame is not along an axis; the engine turns records only by axis permutations`);
        return done();
    }
    if (R.perm.join() !== "0,1,2" || R.sign.join() !== "1,1,1")
        notes.push(`used with gravity along ${JSON.stringify(rec.down)} in its print frame: checked in the use frame (axes ${R.perm.map((p, i) => `${R.sign[i] < 0 ? "-" : ""}${"xyz"[p]}`).join(" ")}), layers kept as printed`);
    const mesh = rMesh(R, rec.mesh);
    const tg = performance.now();
    const md = meshDistance(mesh);
    const bounds = md.bounds;
    const size = Math.max(...bounds.max.map((v, i) => v - bounds.min[i]));
    const tMin = thinWall(md.distance, bounds);
    const h = resolutionFor(fidelity, tMin, size);
    notes.push(`geometry: ${mesh.indices.length / 3} triangles, signed distance by BVH, thinnest wall ${tMin.toFixed(2)} mm (10th percentile of local thickness) -> ${h} mm voxels at fidelity "${fidelity}" (${(performance.now() - tg).toFixed(0)} ms)`);
    const printUp = rv(R, rec.print?.up ?? [0, 0, 1]);
    // supports
    const supports = [];
    for (const s of rec.supports ?? []) {
        switch (s.kind) {
            case "screw":
                supports.push({ kind: "screw", name: s.id, at: rv(R, s.at), axis: rv(R, s.axis), d: s.d, head: s.head });
                break;
            case "keyhole":
                notes.push(`${s.id}: a keyhole hangs on a screw head; checked as a screw (which also holds outwards; a keyhole does only behind its head)`);
                supports.push({ kind: "screw", name: s.id, at: rv(R, s.at), axis: rv(R, s.axis), d: s.d, head: s.head });
                break;
            case "wall":
            case "edge":
                supports.push({ kind: "wall", name: s.id, point: rv(R, s.point), normal: rv(R, s.normal) });
                break;
            case "fixed":
                supports.push({ kind: "fixed", name: s.id, where: rRegion(R, s.where) });
                break;
            case "adhesive":
                notes.push(`${s.id}: adhesive pad held as a fixed face; the pad's own rating${s.ratingN ? ` (${s.ratingN} N)` : ""} is not modelled`);
                supports.push({ kind: "fixed", name: s.id, where: rRegion(R, s.where) });
                break;
            case "pole":
                supports.push({ kind: "fixed", name: s.id, where: { cylinder: { at: rv(R, s.at), axis: rv(R, s.axis), r: s.d / 2 + 0.6 * h, span: s.span } } });
                break;
            default: notes.push(`support ${s.id}: kind ${s.kind} not known to the engine; ignored`);
        }
    }
    // loads on regions (weights along gravity, pulls and knocks as forces)
    const g = 9.81;
    const loadDefs = (rec.loads ?? []).filter((l) => l.at).map((l) => {
        const name = l.why ?? `${l.id}`;
        if (l.kind === "weight") {
            const dir = l.dir ? rv(R, l.dir) : [0, 0, -1];
            return { id: l.id, input: (dir[2] === -1 ? { object: { kg: l.kg, on: rRegion(R, l.at), name } } : { pull: { N: l.kg * g, dir, at: rRegion(R, l.at), name } }) };
        }
        return { id: l.id, input: { pull: { N: l.N, dir: rv(R, l.dir), at: rRegion(R, l.at), name } } };
    });
    for (const l of rec.loads ?? [])
        if (!l.at)
            notes.push(`load ${l.id} (${l.kind}) acts on the object, not on a region of the part: used by the insertion and retention checks only`);
    const object = rec.object?.mesh ? { mesh: rMesh(R, rec.object.mesh), kg: rec.object.kg } : undefined;
    const part = { mesh, distance: md.distance, bounds };
    const base = { name: rec.name, part, material: matName, printUp };
    // whole-part requirements: one solve per distinct load set
    const solid = rec.requirements.filter((r) => "holds" in r || "deflection" in r);
    const groups = new Map();
    for (const r of solid) {
        const ids = (r.holds ?? r.deflection).loads;
        const k = ids ? [...ids].sort().join(",") : "*";
        (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
    }
    for (const [k, reqs] of groups) {
        const ts = performance.now();
        const loads = loadDefs.filter((l) => k === "*" || k.split(",").includes(l.id)).map((l) => l.input);
        if (!loads.length) {
            for (const r of reqs)
                unsupported(r, "no load on a region of the part for this requirement");
            continue;
        }
        try {
            const res = check({ ...base, supports, loads, requirements: reqs.map((r) => ("holds" in r ? { holds: { safetyFactor: r.holds.safetyFactor } } : { deflection: { max: r.deflection.max } })), resolution: h, map: true });
            const ms = performance.now() - ts;
            notes.push(...res.notes.map((n) => (k === "*" ? n : `[loads ${k}] ${n}`)));
            const held = res.answers.find((a) => a.requirement === "the part is held");
            const hs = res.answers.filter((a) => /^holds/.test(a.requirement)), ds = res.answers.filter((a) => /^deflects/.test(a.requirement));
            let hi = 0, di = 0;
            for (const r of reqs) {
                const a = held ?? ("holds" in r ? hs[hi++] : ds[di++]);
                if (a)
                    put(r, a, ms, "", a.error);
                else
                    unsupported(r, "the engine returned no answer");
            }
            if (res.solid)
                out.solid = res.solid;
        }
        catch (e) {
            for (const r of reqs)
                unsupported(r, `the whole-part solve failed: ${e.message}`);
        }
    }
    for (const r of rec.requirements) {
        if (out.has(r.id))
            continue;
        const ts = performance.now();
        const key = keyOf(r);
        if (!key) {
            unsupported(r, `requirement keys ${Object.keys(r).join(", ")} are not known to the engine`);
            continue;
        }
        try {
            if (key === "staysIn" || key === "liftsOut" || key === "retains" || key === "escape") {
                if (!object) {
                    unsupported(r, "the record has no object mesh");
                    continue;
                }
                const q = { ...r[key] };
                for (const f of ["axis", "along", "dir", "at"])
                    if (q[f])
                        q[f] = rv(R, q[f]);
                const res = check({ ...base, object, requirements: [{ [key]: q }] });
                put(r, res.answers[0], performance.now() - ts);
                continue;
            }
            const q = r[key];
            const fx = q.flexure ? rec.flexures?.[q.flexure] : undefined;
            if (q.flexure && !fx) {
                unsupported(r, `no flexure named ${q.flexure} in the record`);
                continue;
            }
            if (key === "relaxed") {
                if (fx.kind === "cradle") {
                    const ok = fx.d[1] <= fx.relaxedAbove + 1e-9;
                    put(r, { requirement: `${q.flexure}: closed, it carries no stress`, verdict: ok ? "pass" : "fail", value: `arms at rest clear ${fx.relaxedAbove.toFixed(2)} mm; the largest object is ${fx.d[1].toFixed(2)} mm`, limit: "the closed arms do not touch the largest size",
                        why: "a snap that holds by geometry, not preload: printed PLA relaxes 11-14% within 500 s (S16), so the arms must close back to their printed shape around the object", fix: ok ? undefined : "open the cradle's seat to the largest size plus clearance" }, performance.now() - ts);
                }
                else
                    unsupported(r, `${fx.kind}: a relaxed-closed check applies to snaps and cradles`);
                continue;
            }
            if (fx?.kind === "ribClamp" && (key === "strain" || key === "grips")) {
                const flex = { [q.flexure]: { ribClamp: { bore: fx.bore, wall: fx.wall, height: fx.height, gap: fx.gap, ear: fx.ear, ribs: fx.ribs, pinch: fx.pinch } } };
                const req = key === "strain" ? { strain: { flexure: q.flexure, use: q.use === "held" ? "repeated" : q.use, over: q.over } } : { grips: q };
                const res = check({ ...base, flexures: flex, requirements: [req] });
                put(r, res.answers[0], performance.now() - ts);
                continue;
            }
            if (key === "grips" && fx?.kind === "fingers") {
                const f = fx.finger, mu = m.muSteel[0];
                const at = (y) => snapEngine({ l: f.l, b: f.b, h0: f.h0, h1: f.h1 ?? f.h0, y: Math.max(y, 1e-4), alpha: 30, mu: 0, E: m.E1 });
                const lo = at(f.deflect[0]), hiR = at(f.deflect[1]);
                let value = mu * fx.count * lo.P;
                let why = `${fx.count} fingers (l ${f.l}, h ${f.h0}${f.h1 ? `->${f.h1}` : ""}, b ${f.b} mm), each a nonlinear cantilever pushed back ${f.deflect[0].toFixed(2)} mm by the smallest size (${fx.around[0]} mm): ${lo.P.toFixed(2)} N each (${hiR.P.toFixed(2)} N at the largest); friction ${mu} (lowest measured, S13)`;
                if (q.after) {
                    if (m.relaxLoss && q.after <= (m.relaxSeconds ?? 0)) {
                        value *= 1 - m.relaxLoss[1];
                        why += `; after ${q.after} s: minus ${(100 * m.relaxLoss[1]).toFixed(0)}% (S16)`;
                    }
                    else {
                        put(r, { requirement: `${q.flexure}: grips with at least ${q.min} N after ${q.after} s`, verdict: "unsupported", value: `${value.toFixed(1)} N at assembly; half of it is ${(value / 2).toFixed(1)} N`, limit: `>= ${q.min} N`, why: `${why}. Elastic fingers hold by preload, and no relaxation data beyond ${m.relaxSeconds ?? 0} s exists for printed ${matName} (S16; coupon M4 measures it)`, fix: "add a pinch screw for a months-long hold, or accept re-seating the object now and then" }, performance.now() - ts);
                        continue;
                    }
                }
                put(r, { requirement: `${q.flexure}: grips with at least ${q.min} N over ${fx.around[0]}-${fx.around[1]} mm`, verdict: value >= q.min ? "pass" : "fail", value: `${value.toFixed(1)} N (axial pull)`, limit: `>= ${q.min} N`, why,
                    fix: value >= q.min ? undefined : `more fingers, or fingers ${Math.sqrt(q.min / Math.max(value, 1e-9)).toFixed(2)}x thicker at the root (force grows with h^2 at fixed strain), or a smaller tip circle` }, performance.now() - ts);
                continue;
            }
            if (["strain", "stop", "insertion", "retention"].includes(key)) {
                const arm = fx?.kind === "snap" ? fx : fx?.kind === "cantilever" ? { ...fx, y: fx.deflect[1], alpha: 30, mu: 0.2 } : fx?.kind === "fingers" ? { ...fx.finger, y: fx.finger.deflect[1], alpha: 30, mu: 0.2 } : fx?.kind === "cradle" ? fx.arm : null;
                if (!arm) {
                    unsupported(r, `${fx?.kind}: no beam model for this flexure`);
                    continue;
                }
                const y = key === "stop" ? arm.stopAt ?? arm.y : arm.y;
                const use = key === "stop" ? "once" : q.use === "held" ? "repeated" : q.use ?? "once";
                const snap = { l: arm.l, b: arm.b, h0: arm.h0, h1: arm.h1 ?? arm.h0, y, alpha: arm.alpha, alphaR: arm.alphaR, mu: arm.mu ?? 0.2, ...(arm.plane === "z" ? { E: m.E3 } : {}) };
                const req = key === "insertion" ? { insertion: { flexure: "arm", max: q.max } } : key === "retention" ? { retention: { flexure: "arm", min: q.min } } : { strain: { flexure: "arm", use, plane: arm.plane } };
                const res = check({ ...base, flexures: { arm: { snap } }, requirements: [req] });
                const a = { ...res.answers[0] };
                a.requirement = a.requirement.replace(/^arm/, q.flexure);
                if (key === "stop")
                    a.requirement = `${q.flexure}: cannot be over-bent (strain at its hard stop, ${y.toFixed(2)} mm, within the single-use allowance)`;
                let extra = "";
                if (q.use === "held")
                    extra += " Held under strain: printed PLA relaxes 11-14% within 500 s (S16) and no longer data exists, so a held strain is judged by the repeated-use allowance and the hold itself is not promised.";
                put(r, a, performance.now() - ts, extra);
                continue;
            }
            unsupported(r, `no model for ${key}${fx ? ` on a ${fx.kind}` : ""}`);
        }
        catch (e) {
            unsupported(r, `the check threw: ${e.message}`);
        }
    }
    return done();
}
/** One line per answer, for logs and receipts. */
export function answerText(pa) {
    const lines = [`${pa.name}: ${pa.answers.filter((a) => a.verdict === "pass").length} of ${pa.answers.length} pass (${(pa.ms / 1000).toFixed(1)} s)`];
    for (const a of pa.answers)
        lines.push(`- ${a.verdict.toUpperCase()} [${a.id}] ${a.requirement}: ${a.value} (limit ${a.limit})${a.where ? `\n  - where: ${a.where}` : ""}\n  - why: ${a.why}${a.fix ? `\n  - fix: ${a.fix}` : ""}\n  - ${a.fidelity}, ${a.ms} ms${a.error !== undefined ? `, error estimate ${(100 * a.error).toFixed(1)}%` : ""}`);
    return lines.join("\n");
}
