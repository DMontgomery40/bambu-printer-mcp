/**
 * Features sized by the physics while they build (round 3). A feature that carries a load or flexes states a
 * small family of candidates (member thicknesses, a rib or brace layout, a root fillet, screw positions, an arm's
 * length and taper), asks the physics engine about each with its fast models (planar frames for trusses and
 * C-shapes, the nonlinear snap arm for flexures, the split ring for clamps) and keeps the lightest candidate that
 * meets its requirement with the model's margin. The run's whole-part proof then confirms it; if the whole part
 * disagrees with the fast model, the runner rebuilds once with the measured correction (SIZING.k), so the worker
 * never has to "fail, thicken, rerun".
 *
 * The engine (physics/dist) is loaded once at import, so features can call it synchronously while they build.
 * Everything here calls only what the engine exports.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PHYS = process.env.COUNTERPART_PHYSICS ?? join(ROOT, "physics", "dist");
async function load() {
    // The engine's thread pool can wait forever: its workers keep the 12 most recently used stencils, and a solve that
    // registers more (contact passes rebuilding coarse levels) can evict one still in use; a worker then waits for a
    // message it already consumed (physics/src/solid/worker.ts; seen 2026-11-10 on two worker runs, all threads parked
    // on futexes). Until the physics lab fixes it, proofs run on the main thread unless COUNTERPART_PHYSICS_THREADS asks.
    process.env.PHYSICS_THREADS = process.env.COUNTERPART_PHYSICS_THREADS ?? process.env.CP_SANDBOX_THREADS ?? "0";
    if (!existsSync(join(PHYS, "beam", "frame2d.js")))
        return null;
    const u = (p) => pathToFileURL(join(PHYS, p)).href;
    try {
        const [fr, sn, ri, ma] = await Promise.all([import(u("beam/frame2d.js")), import(u("beam/snap.js")), import(u("beam/ring.js")), import(u("materials.js"))]);
        let answer;
        if (existsSync(join(PHYS, "record.js"))) {
            try {
                answer = (await import(u("record.js"))).answer;
            }
            catch {
                answer = undefined;
            }
        }
        return { solveFrame: fr.solveFrame, rectElem: fr.rectElem, snapEngine: sn.snapEngine, splitClamp: ri.splitClamp, material: ma.material, answer };
    }
    catch {
        return null;
    }
}
/** The physics engine's exports, or null when physics/dist is not built (features then fall back to their hand rules and say so). */
export const ENGINE = await load();
/**
 * Corrections the runner measured on this run (whole-part SF / fast-model SF, per feature), applied when it
 * rebuilds the script once after a disagreement. Empty on a first build.
 */
export const SIZING = { k: {}, kd: {}, log: [] };
/** A fix the engine asks for by a parameter's id ("holder.wall": 3.1): features read their members through ov(). */
export const OVERRIDES = {};
export const ov = (id, v) => (OVERRIDES[id] !== undefined ? OVERRIDES[id] : v);
const WARM = new Map();
export function solveFrame2D(spec) {
    if (!ENGINE)
        throw new Error("physics engine not built");
    const t0 = performance.now();
    const nodes = [];
    const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
    const index = new Map();
    const nodeAt = (p) => { const k = key(p); let i = index.get(k); if (i === undefined) {
        i = nodes.length;
        nodes.push(p);
        index.set(k, i);
    } return i; };
    // every pin, contact candidate and load point lies on some member: split members there
    const marks = [...spec.pins.map((p) => p.at), ...spec.loads.map((l) => l.at), ...spec.members.flatMap((m) => [m.from, m.to])];
    const elems = [], owner = [];
    for (const m of spec.members) {
        const n = m.n ?? 8, L = Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]);
        const ts = new Set();
        for (let k = 0; k <= n; k++)
            ts.add(k / n);
        for (const p of marks) {
            // the projection of a mark onto the member, if it lies on it
            const t = ((p[0] - m.from[0]) * (m.to[0] - m.from[0]) + (p[1] - m.from[1]) * (m.to[1] - m.from[1])) / (L * L);
            const q = [m.from[0] + t * (m.to[0] - m.from[0]), m.from[1] + t * (m.to[1] - m.from[1])];
            if (t > 1e-6 && t < 1 - 1e-6 && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-3)
                ts.add(t);
        }
        const tl = [...ts].sort((a, b) => a - b);
        for (let k = 0; k + 1 < tl.length; k++) {
            const pa = [m.from[0] + tl[k] * (m.to[0] - m.from[0]), m.from[1] + tl[k] * (m.to[1] - m.from[1])];
            const pb = [m.from[0] + tl[k + 1] * (m.to[0] - m.from[0]), m.from[1] + tl[k + 1] * (m.to[1] - m.from[1])];
            const tm = (tl[k] + tl[k + 1]) / 2, h = m.h + tm * ((m.h1 ?? m.h) - m.h);
            const i = nodeAt(k === 0 && tl[k] === 0 ? m.from : pa), j = nodeAt(tl[k + 1] === 1 ? m.to : pb);
            if (i === j)
                continue;
            const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
            const bm = m.bOf ? m.bOf(mid) : m.b;
            elems.push(ENGINE.rectElem(i, j, bm, h, spec.E, spec.E / 2.7, true));
            owner.push({ member: m.name, a: pa, b: pb, kt: m.ktOf ? m.ktOf(mid) : 1 });
        }
    }
    const near = (p) => { let best = -1, bd = Infinity; nodes.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) {
        bd = d;
        best = i;
    } }); return best; };
    const pinBcs = spec.pins.flatMap((p) => (p.dofs ?? [0, 1]).map((dof) => ({ node: near(p.at), dof, name: p.name })));
    const loads = spec.loads.map((l) => ({ node: near(l.at), f: [l.f[0], l.f[1], 0] }));
    // contacts: start with every candidate node held along the normal; release those the face would have to pull
    const cand = (spec.contacts ?? []).flatMap((c) => nodes.map((p, i) => ({ c, i, p })).filter((x) => x.c.on(x.p)));
    // warm start: the contact set of the last frame with the same candidate nodes (the sizing loop solves many alike)
    const wkey = `${spec.warm ?? ""}:${cand.length}`;
    let active = WARM.get(wkey)?.slice() ?? cand.map(() => true);
    let st = null;
    for (let it = 0; it < 12; it++) {
        const bcs = [...pinBcs.map(({ node, dof }) => ({ node, dof }))];
        cand.forEach((x, k) => { if (active[k]) {
            const a = Math.abs(x.c.normal[0]) > 0.5 ? 0 : 1;
            bcs.push({ node: x.i, dof: a });
        } });
        st = ENGINE.solveFrame({ nodes, elems, bcs, loads }, { steps: 1 })[0];
        let changed = false;
        cand.forEach((x, k) => {
            const a = Math.abs(x.c.normal[0]) > 0.5 ? 0 : 1, s = Math.sign(x.c.normal[a]);
            if (active[k]) {
                const r = st.reaction[3 * x.i + a] * s;
                if (r < -1e-9) {
                    active[k] = false;
                    changed = true;
                }
            } // face would pull: let go
            else {
                const u = st.u[3 * x.i + a] * s;
                if (u < -1e-9) {
                    active[k] = true;
                    changed = true;
                }
            } // moved into the face: hold
        });
        if (!changed)
            break;
    }
    if (spec.warm)
        WARM.set(wkey, active.slice());
    const stress = [];
    const per = new Map();
    st.elems.forEach((e, k) => {
        const el = elems[k], sN = Math.abs(e.N) / el.A;
        const s1 = sN + (Math.abs(e.M1) * el.c) / el.I, s2 = sN + (Math.abs(e.M2) * el.c) / el.I;
        const sigma = owner[k].kt * Math.max(s1, s2), at = s1 >= s2 ? owner[k].a : owner[k].b;
        const cur = per.get(owner[k].member);
        if (!cur || sigma > cur.sigma)
            per.set(owner[k].member, { sigma, at });
    });
    for (const [member, v] of per)
        stress.push({ member, ...v });
    stress.sort((a, b) => b.sigma - a.sigma);
    const deflection = {};
    spec.loads.forEach((l, k) => { const i = loads[k].node, L = Math.hypot(l.f[0], l.f[1]) || 1; deflection[l.name] = (st.u[3 * i] * l.f[0] + st.u[3 * i + 1] * l.f[1]) / L; });
    const reactions = {};
    for (const b of pinBcs) {
        if (b.dof === 2)
            continue;
        const r = reactions[b.name] ?? [0, 0];
        r[b.dof] += st.reaction[3 * b.node + b.dof];
        reactions[b.name] = r;
    }
    return { stress, peak: stress[0], deflection, reactions, ms: performance.now() - t0 };
}
/** Evaluate candidates from the lightest up and keep the first that meets the requirement (and the few evaluated around it, for the receipt). */
export function lightest(cands, score, keep = 6) {
    const t0 = performance.now();
    const sorted = cands.slice().sort((a, b) => a.massG - b.massG);
    const table = [];
    let chosen = null, n = 0;
    for (const c of sorted) {
        const s = { ...c, ...score(c) };
        n++;
        table.push(s);
        if (s.ok) {
            chosen = s;
            break;
        }
    }
    return { chosen, table: table.slice(-keep), evaluated: n, ms: performance.now() - t0 };
}
/** Attach a sizing report to a solid: `solid.require(sized(report))`. Not run as a mesh check. */
export function sized(r) {
    return { name: `sized: ${r.feature}`, sizing: r, run: () => ({ name: `sized by the physics: ${r.feature}`, pass: true, measured: `${r.chosen} (${r.predicted.massG.toFixed(0)} g${r.predicted.sf !== undefined ? `, SF ${r.predicted.sf.toFixed(1)}` : ""}${r.predicted.defl !== undefined ? `, ${r.predicted.defl.toFixed(2)} mm` : ""}${r.predicted.strain !== undefined ? `, strain ${(100 * r.predicted.strain).toFixed(2)}%` : ""}; ${r.evaluated} candidates by ${r.model} in ${r.ms.toFixed(0)} ms)` }) };
}
export function isSizing(r) { return !!r.sizing; }
/** PLA unless stated; density g/mm3 for masses. */
export function mat(name = "PLA") {
    const m = ENGINE?.material(name);
    return { E: m?.E1 ?? 2680, S: m?.Sxy ?? 39, Sz: m?.Sz ?? 35, rho: (m?.density ?? 1.24) / 1000, once: m?.strainOnce?.[0] ?? 0.017, repeated: m?.strainRepeated?.[0] ?? 0.01, mu: m?.muSteel?.[0] ?? 0.2, raw: m };
}
/** One arm through the engine: fast (no hook push fed back, 2 points) for searching, full for the chosen design. */
export function armAnswer(a, o = {}) {
    if (!ENGINE)
        return null;
    const t0 = performance.now();
    const r = ENGINE.snapEngine({ l: a.l, b: a.b, h0: a.h0, h1: a.h1 ?? a.h0, y: Math.max(a.y, 1e-4), alpha: a.alpha ?? 30, alphaR: a.alphaR, mu: a.mu ?? 0.2, E: mat(o.material).E }, { feedback: !!o.full, points: o.full ? 8 : 2 });
    return { strain: r.strain, P: r.P, W: r.W, Wout: r.Wout ?? null, locks: r.locks, ms: performance.now() - t0 };
}
