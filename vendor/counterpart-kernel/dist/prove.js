/**
 * One run proves the part: maps a part record (docs/part-record.md) onto the physics engine in physics/
 * (its exported `check()` and beam models) and returns one answer per requirement, by id, in order.
 * The physics lab owns physics/; this adapter only calls what it exports. Kinds the engine does not have
 * yet (fingers, cradle, stop, relaxed, keyhole, adhesive, edge) are mapped onto its models here and say so.
 * If the engine is not built (physics/dist missing), every answer is "unsupported" with that reason.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Mesh } from "./kernel/mesh.js";
import { BVH } from "./kernel/bvh.js";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PHYS = process.env.COUNTERPART_PHYSICS ?? join(ROOT, "physics", "dist");
let physCache = null;
async function physics() {
    if (physCache)
        return physCache;
    if (!existsSync(join(PHYS, "check.js")))
        return null;
    const [check, snap, mat] = await Promise.all([
        import(pathToFileURL(join(PHYS, "check.js")).href), import(pathToFileURL(join(PHYS, "beam", "snap.js")).href), import(pathToFileURL(join(PHYS, "materials.js")).href),
    ]);
    physCache = { check: check.check, snapEngine: snap.snapEngine, material: mat.material };
    return physCache;
}
const pct = (x) => `${(100 * x).toFixed(2)}%`;
const reqKey = (r) => ["holds", "deflection", "staysIn", "liftsOut", "retains", "strain", "stop", "insertion", "retention", "grips", "relaxed"].find((k) => k in r);
/** Voxel size for whole-part checks at each fidelity (the engine's own default is about size / 80, 0.5-1.5 mm). */
function resolutionFor(f, size) {
    if (f === "fast")
        return Math.max(1.5, Math.min(2.5, size / 60));
    if (f === "fine")
        return Math.max(0.5, Math.min(1.0, size / 120));
    return Math.max(0.8, Math.min(1.5, size / 80));
}
/** A flexure's beam as the engine's snap arm (a plain cantilever is a snap with a 30-degree lead and no return). */
function armOf(fx) {
    if (fx.kind === "snap")
        return fx;
    if (fx.kind === "cantilever")
        return { ...fx, y: fx.deflect[1], alpha: 30, mu: 0.2 };
    if (fx.kind === "fingers")
        return { ...fx.finger, y: fx.finger.deflect[1], alpha: 30, mu: 0.2 };
    if (fx.kind === "cradle")
        return fx.arm;
    return null;
}
/**
 * The physics engine reads the record itself since its round 2 (physics/src/record.ts, `answer(record)`): use it
 * when it is built, and keep the adapter below for an engine without it (or COUNTERPART_PROVE=adapter).
 */
let recordReader;
async function reader() {
    if (recordReader !== undefined)
        return recordReader;
    recordReader = null;
    if (process.env.COUNTERPART_PROVE !== "adapter" && existsSync(join(PHYS, "record.js"))) {
        try {
            recordReader = (await import(pathToFileURL(join(PHYS, "record.js")).href)).answer ?? null;
        }
        catch {
            recordReader = null;
        }
    }
    return recordReader;
}
/** Answers proved earlier in this process for the same record (the sizing loop and the run share them). */
const proved = new Map();
function recordKey(rec, fidelity) {
    const p = rec.mesh.positions;
    let h = 0;
    for (let i = 0; i < p.length; i += 7)
        h = (h * 31 + Math.round(p[i] * 1000)) | 0;
    return `${fidelity}:${p.length}:${h}:${JSON.stringify({ ...rec, mesh: null })}`;
}
export async function prove(rec, opts = {}) {
    const fidelity0 = opts.fidelity ?? rec.fidelity ?? "fast";
    const key = recordKey(rec, fidelity0);
    const hit = proved.get(key);
    if (hit)
        return hit;
    const ans = await (async () => {
        const rd = await reader();
        if (rd) {
            try {
                const a = rd(rec, { fidelity: fidelity0 });
                return { schema: "counterpart/part-answer@1", name: a.name, notes: [...(a.notes ?? []), `answered by the physics engine's own record reader (${a.engine ?? "physics"})`], ms: a.ms,
                    answers: a.answers.map((x) => ({ id: x.id, requirement: x.requirement, verdict: x.verdict, value: x.value, limit: x.limit, where: x.where, why: x.why, fix: x.fix ?? undefined, fidelity: x.fidelity, ms: x.ms, from: x.from })) };
            }
            catch (e) { /* fall through to the adapter, and say so */
                const a = await proveAdapter(rec, opts);
                a.notes.unshift(`the engine's record reader threw (${e.message}); answered through the kernel's adapter`);
                return a;
            }
        }
        return proveAdapter(rec, opts);
    })();
    proved.set(key, ans);
    return ans;
}
async function proveAdapter(rec, opts = {}) {
    const t0 = performance.now();
    const fidelity = opts.fidelity ?? rec.fidelity ?? "fast";
    const P = await physics();
    const notes = [];
    const name = (r) => `${reqKey(r)}${"flexure" in r[reqKey(r)] ? ` ${r[reqKey(r)].flexure}` : ""}`;
    if (!P) {
        return { schema: "counterpart/part-answer@1", name: rec.name, ms: 0, notes: ["physics engine not built: run `cd physics && npm ci && npm run build`"],
            answers: rec.requirements.map((r) => ({ id: r.id, requirement: name(r), verdict: "unsupported", value: "-", limit: "-", why: "the physics engine (physics/dist) is not built on this machine", fidelity, ms: 0, from: r.from })) };
    }
    const matName = ["PLA", "PETG", "TPU"].includes(rec.material.name) ? rec.material.name : null;
    const m = matName ? P.material(matName) : null;
    const mesh = new Mesh(Float64Array.from(rec.mesh.positions), Uint32Array.from(rec.mesh.indices));
    const bounds = mesh.bounds();
    let bvh = null;
    const distance = (x, y, z) => (bvh ??= new BVH(mesh)).signedDistance(x, y, z);
    const size = Math.max(...bounds.max.map((v, i) => v - bounds.min[i]));
    const down = rec.down ?? [0, 0, -1];
    const g = 9.81;
    // loads: a weight in a frame where "down" is not -z becomes a force along down
    const loadsFor = (ids) => rec.loads.filter((l) => "at" in l && (!ids || ids.includes(l.id))).map((l) => l.kind === "weight"
        ? (down[2] === -1 && !l.dir ? { object: { kg: l.kg, on: l.at, name: l.why ?? `${l.kg} kg ${l.id}` } } : { pull: { N: l.kg * g, dir: l.dir ?? down, at: l.at, name: l.why ?? `${l.kg} kg ${l.id} (weight along ${JSON.stringify(down)})` } })
        : { pull: { N: l.N, dir: l.dir, at: l.at, name: l.why ?? `${l.N} N ${l.kind} ${l.id}` } });
    const supportNotes = [];
    const supports = rec.supports.map((s) => {
        switch (s.kind) {
            case "screw": return { kind: "screw", name: s.id, at: s.at, axis: s.axis, d: s.d, head: s.head };
            case "keyhole":
                supportNotes.push(`${s.id}: a keyhole hangs on a screw head; checked as a screw (it also holds outwards, which a keyhole does only behind its head)`);
                return { kind: "screw", name: s.id, at: s.at, axis: s.axis, d: s.d, head: s.head };
            case "wall": return { kind: "wall", name: s.id, point: s.point, normal: s.normal };
            case "edge": return { kind: "wall", name: s.id, point: s.point, normal: s.normal };
            case "fixed": return { kind: "fixed", name: s.id, where: s.where };
            case "adhesive":
                supportNotes.push(`${s.id}: adhesive pad held as a fixed face (${s.area.toFixed(0)} mm2); the pad's own rating is not modelled`);
                return { kind: "fixed", name: s.id, where: s.where };
            case "pole": return { kind: "fixed", name: s.id, where: { cylinder: { at: s.at, axis: s.axis, r: s.d / 2 + 0.6, span: s.span } } };
        }
        return null;
    }).filter(Boolean);
    notes.push(...supportNotes);
    const object = rec.object ? { mesh: rec.object.mesh, kg: rec.object.kg } : undefined;
    const answers = new Map();
    const put = (r, a, ms, extraWhy = "") => answers.set(r.id, { id: r.id, requirement: a.requirement ?? name(r), verdict: a.verdict, value: a.value, limit: a.limit, where: a.where, why: `${a.why}${extraWhy}`, fix: a.fix, fidelity, ms: a.ms ?? ms, from: r.from });
    const unsupported = (r, why) => put(r, { verdict: "unsupported", value: "-", limit: "-", why }, 0);
    if (!m)
        for (const r of rec.requirements)
            unsupported(r, `material ${rec.material.name}: the physics engine has PLA, PETG and TPU`);
    if (!m)
        return { schema: "counterpart/part-answer@1", name: rec.name, answers: rec.requirements.map((r) => answers.get(r.id)), notes, ms: performance.now() - t0 };
    // whole-part checks: one solve for every holds/deflection requirement with the same loads
    const solidReqs = rec.requirements.filter((r) => "holds" in r || "deflection" in r);
    if (solidReqs.length) {
        const h = resolutionFor(fidelity, size);
        const ts = performance.now();
        // a load stated on a face must find voxel surface: widen thin regions to at least one voxel either side
        const widen = (r) => {
            if (r.plane && r.within) {
                const a = r.plane.normal.findIndex((v) => Math.abs(v) > 0.9);
                if (a >= 0) {
                    const w = r.within.map((x) => x.slice());
                    const c = (w[a][0] + w[a][1]) / 2, hw = Math.max((w[a][1] - w[a][0]) / 2, h);
                    w[a] = [c - hw, c + hw];
                    return { ...r, within: w };
                }
            }
            if (r.box)
                return { box: r.box.map(([a, b]) => (b - a < 2 * h ? [(a + b) / 2 - h, (a + b) / 2 + h] : [a, b])) };
            return r;
        };
        const wideLoads = loadsFor().map((l) => ("object" in l ? { object: { ...l.object, on: widen(l.object.on) } } : { pull: { ...l.pull, at: widen(l.pull.at) } }));
        try {
            const res = P.check({ name: rec.name, part: { mesh: { positions: rec.mesh.positions, indices: rec.mesh.indices }, bounds: { min: bounds.min, max: bounds.max } }, material: matName, printUp: rec.print.up,
                supports, loads: wideLoads, requirements: solidReqs.map((r) => ("holds" in r ? { holds: { safetyFactor: r.holds.safetyFactor } } : { deflection: { max: r.deflection.max } })), resolution: h });
            const ms = performance.now() - ts;
            notes.push(...res.notes.slice(0, 1).map((n) => `${n} [fidelity ${fidelity}: ${h} mm voxels]`), ...res.notes.slice(1).filter((n) => /reaction/.test(n)));
            const fid = fidelity === "fast" ? ` Computed at the fast setting (${h} mm voxels): measured against the normal setting, deflections within 3-9% and safety factors up to 57% high on 2.4 mm walls (9% on a 12 mm bracket); a strength pass needs 1.6x the target at this setting.` : "";
            const held = res.answers.find((a) => a.requirement === "the part is held");
            const hs = res.answers.filter((a) => /^holds/.test(a.requirement)), ds = res.answers.filter((a) => /^deflects/.test(a.requirement));
            let hi = 0, di = 0;
            for (const r of solidReqs) {
                let a = held ?? ("holds" in r ? hs[hi++] : ds[di++]);
                // measured: at 1.5-2.5 mm voxels the peak stress on 2.4 mm walls came out 57% under the 1.0 mm answer (holder
                // T8: SF 10.8 fast vs 6.9 normal); the bracket's was 9% (5.87 vs 5.40); deflections 3-9%. A strength pass at
                // the fast setting needs 1.6x the target to stand; below that it is uncertain until a normal run.
                if (a && fidelity === "fast" && "holds" in r && a.verdict === "pass") {
                    const sf = Number(String(a.value).match(/[\d.]+/)?.[0] ?? NaN), target = r.holds.safetyFactor;
                    if (Number.isFinite(sf) && sf < 1.6 * target)
                        a = { ...a, verdict: "uncertain", fix: `run with --prove normal before printing (the fast setting over-estimated a thin-walled holder's safety factor by 57%); thicken the most stressed section if it fails there` };
                }
                if (a)
                    put(r, a, ms, fid);
                else
                    unsupported(r, "the engine returned no answer");
            }
        }
        catch (e) {
            for (const r of solidReqs)
                unsupported(r, `the whole-part solve failed: ${e.message}`);
        }
    }
    for (const r of rec.requirements) {
        if (answers.has(r.id))
            continue;
        const ts = performance.now();
        try {
            if ("staysIn" in r || "liftsOut" in r || "retains" in r) {
                if (!object) {
                    unsupported(r, "the record has no object");
                    continue;
                }
                const req = "staysIn" in r ? { staysIn: r.staysIn } : "liftsOut" in r ? { liftsOut: r.liftsOut } : { retains: r.retains };
                // the engine judges tilt and pulls with gravity along -z: give it the part in its use frame
                if (down[2] !== -1) {
                    unsupported(r, `the part is used with gravity along ${JSON.stringify(down)} in its print frame; the engine's statics assume -z (use frame = print frame)`);
                    continue;
                }
                const res = P.check({ name: rec.name, part: { distance, bounds: { min: bounds.min, max: bounds.max }, mesh: { positions: rec.mesh.positions, indices: rec.mesh.indices } }, material: matName, object, requirements: [req] });
                put(r, res.answers[0], performance.now() - ts);
                continue;
            }
            const key = reqKey(r);
            const q = r[key];
            const fx = q.flexure ? rec.flexures[q.flexure] : undefined;
            if (q.flexure && !fx) {
                unsupported(r, `no flexure named ${q.flexure} in the record`);
                continue;
            }
            if (key === "relaxed") {
                if (fx.kind === "cradle") {
                    const ok = fx.d[1] <= fx.relaxedAbove + 1e-9;
                    put(r, { requirement: `${q.flexure}: closed, it carries no stress`, verdict: ok ? "pass" : "fail", value: `arms at rest clear ${fx.relaxedAbove.toFixed(2)} mm; the largest object is ${fx.d[1].toFixed(2)} mm`, limit: "the closed arms do not touch the largest size",
                        why: "a snap that holds by geometry, not preload: PLA and PETG relax under held strain (11-14% in 500 s, S16), so the arms close back to their printed shape around the object (survey rule 4)", fix: ok ? undefined : "open the cradle's seat to the largest size plus clearance" }, performance.now() - ts);
                }
                else
                    unsupported(r, `${fx.kind}: a relaxed-closed check applies to snaps and cradles`);
                continue;
            }
            if (key === "strain" && fx?.kind === "ribClamp") {
                const res = P.check({ name: rec.name, part: { distance, bounds: { min: bounds.min, max: bounds.max } }, material: matName,
                    flexures: { [q.flexure]: { ribClamp: { bore: fx.bore, wall: fx.wall, height: fx.height, gap: fx.gap, ear: fx.ear, ribs: fx.ribs, pinch: fx.pinch } } }, requirements: [{ strain: { flexure: q.flexure, use: q.use === "held" ? "repeated" : q.use, over: q.over } }] });
                put(r, res.answers[0], performance.now() - ts);
                continue;
            }
            if (key === "grips" && fx?.kind === "ribClamp") {
                const res = P.check({ name: rec.name, part: { distance, bounds: { min: bounds.min, max: bounds.max } }, material: matName,
                    flexures: { [q.flexure]: { ribClamp: { bore: fx.bore, wall: fx.wall, height: fx.height, gap: fx.gap, ear: fx.ear, ribs: fx.ribs, pinch: fx.pinch } } }, requirements: [{ grips: q }] });
                put(r, res.answers[0], performance.now() - ts);
                continue;
            }
            if (key === "grips" && fx?.kind === "fingers") {
                // each finger is a cantilever pressed back by the object: grip = friction x sum of finger forces at the smallest size
                const f = fx.finger, mu = m.muSteel[0];
                const at = (y) => P.snapEngine({ l: f.l, b: f.b, h0: f.h0, h1: f.h1 ?? f.h0, y: Math.max(y, 1e-4), alpha: 30, mu: 0, E: m.E1 });
                const lo = at(f.deflect[0]), hiR = at(f.deflect[1]);
                const N = fx.count * lo.P, grip = mu * N;
                let value = grip, why = `${fx.count} fingers (l ${f.l}, h ${f.h0}${f.h1 ? `->${f.h1}` : ""}, b ${f.b} mm) pushed back ${f.deflect[0].toFixed(2)} mm by the smallest size (${fx.around[0]} mm): ${lo.P.toFixed(2)} N each, ${hiR.P.toFixed(2)} N at the largest; friction ${mu} (lowest measured, S13)`;
                if (q.after) {
                    if (m.relaxLoss && q.after <= (m.relaxSeconds ?? 0)) {
                        value *= 1 - m.relaxLoss[1];
                        why += `; after ${q.after} s: minus ${(100 * m.relaxLoss[1]).toFixed(0)}% (S16)`;
                    }
                    else {
                        put(r, { requirement: `${q.flexure}: grips with at least ${q.min} N after ${q.after} s`, verdict: "unsupported", value: `${grip.toFixed(1)} N at assembly; half of it is ${(grip / 2).toFixed(1)} N`, limit: `>= ${q.min} N`,
                            why: `${why}. Elastic fingers hold by preload, and no relaxation data beyond ${m.relaxSeconds ?? 0} s exists for printed ${matName} (S16)`, fix: "add a pinch screw for a months-long hold (survey rule 4), or accept re-seating the object now and then" }, performance.now() - ts);
                        continue;
                    }
                }
                put(r, { requirement: `${q.flexure}: grips with at least ${q.min} N over ${fx.around[0]}-${fx.around[1]} mm`, verdict: value >= q.min ? "pass" : "fail", value: `${value.toFixed(1)} N (axial pull)`, limit: `>= ${q.min} N`, why,
                    fix: value >= q.min ? undefined : `more fingers, or fingers ${(Math.sqrt(q.min / Math.max(value, 1e-9))).toFixed(2)}x thicker at the root (force grows with h^2 at fixed strain), or a smaller tip circle` }, performance.now() - ts);
                continue;
            }
            if (["strain", "stop", "insertion", "retention"].includes(key)) {
                const arm = fx ? armOf(fx) : null;
                if (!arm) {
                    unsupported(r, `${fx?.kind}: no beam model for this flexure`);
                    continue;
                }
                const y = key === "stop" ? arm.stopAt ?? arm.y : arm.y;
                const use = key === "stop" ? "once" : q.use === "held" ? "repeated" : q.use ?? "once";
                const snap = { l: arm.l, b: arm.b, h0: arm.h0, h1: arm.h1 ?? arm.h0, y, alpha: arm.alpha, alphaR: arm.alphaR, mu: arm.mu ?? 0.2 };
                const req = key === "insertion" ? { insertion: { flexure: "arm", max: q.max } } : key === "retention" ? { retention: { flexure: "arm", min: q.min } } : { strain: { flexure: "arm", use } };
                const res = P.check({ name: rec.name, part: { distance, bounds: { min: bounds.min, max: bounds.max } }, material: matName, flexures: { arm: { snap } }, requirements: [req] });
                const a = { ...res.answers[0] };
                a.requirement = a.requirement.replace(/^arm/, q.flexure);
                if (key === "stop") {
                    a.requirement = `${q.flexure}: cannot be over-bent (strain at its hard stop, ${y.toFixed(2)} mm, within the single-use allowance)`;
                }
                let extra = arm.plane === "z" ? " This member's length runs along Z (across the layers): judge it against the across-layer limit, which is lower (UltiMaker PLA breaks at 2.0% across layers, S4)." : " Its length lies in the layers (printed flat).";
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
    return { schema: "counterpart/part-answer@1", name: rec.name, answers: rec.requirements.map((r) => answers.get(r.id)), notes, ms: performance.now() - t0 };
}
export function answersText(pa) {
    const lines = [`${pa.name}: ${pa.answers.filter((a) => a.verdict === "pass").length} of ${pa.answers.length} pass (${(pa.ms / 1000).toFixed(1)} s)`];
    for (const a of pa.answers)
        lines.push(`- ${a.verdict.toUpperCase()} [${a.id}] ${a.requirement}: ${a.value} (limit ${a.limit})${a.fix ? `; fix: ${a.fix}` : ""}`);
    return lines.join("\n");
}
