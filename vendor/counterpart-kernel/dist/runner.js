/**
 * Runs a part script: merges parameter overrides into its literal P, calls build(P), meshes every part,
 * checks it, and writes STL (all bodies), 3MF (one object per body), the effective parameters and a
 * result JSON shaped like the code engine's receipt (bounds, volume, solid count, closed/manifold).
 */
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeBuildResult, KernelError } from "./api.js";
import { contour } from "./kernel/mesher.js";
import { decimate } from "./kernel/decimate.js";
import { checkMesh, Mesh } from "./kernel/mesh.js";
import { writeSTL, write3MF } from "./kernel/io.js";
import { renderSheet, VIEWS } from "./kernel/render.js";
import { printability } from "./checks.js";
import { JITTER, ENGINE } from "./exact/bsp.js";
import { isFacts, mergeFacts } from "./facts.js";
import { partRecord } from "./record.js";
import { prove } from "./prove.js";
import { SIZING, OVERRIDES, isSizing } from "./sizing.js";
export function defaultResolution(minFeature) {
    const h = minFeature / 4;
    return Math.min(0.5, Math.max(0.05, Number.isFinite(h) ? h : 0.5));
}
export function validateOverrides(P, overrides, SPEC = {}) {
    for (const [k, v] of Object.entries(overrides)) {
        if (!(k in P))
            throw new KernelError(`Unknown parameter "${k}". The script's parameters are: ${Object.keys(P).join(", ")}.`);
        const t0 = Array.isArray(P[k]) ? "array" : typeof P[k], t1 = Array.isArray(v) ? "array" : typeof v;
        if (t0 !== t1)
            throw new KernelError(`Parameter "${k}" is a ${t0} in the script but the override is a ${t1}.`);
        if (typeof v === "number" && !Number.isFinite(v))
            throw new KernelError(`Parameter "${k}" must be finite.`);
        const sp = SPEC[k];
        if (sp && typeof v === "number") {
            if (sp.min !== undefined && v < sp.min)
                throw new KernelError(`Parameter "${k}" (${sp.label ?? k}) must be at least ${sp.min}${sp.unit ? " " + sp.unit : ""}; got ${v}.`);
            if (sp.max !== undefined && v > sp.max)
                throw new KernelError(`Parameter "${k}" (${sp.label ?? k}) must be at most ${sp.max}${sp.unit ? " " + sp.unit : ""}; got ${v}.`);
        }
        if (sp?.options && !sp.options.includes(String(v)))
            throw new KernelError(`Parameter "${k}" must be one of ${sp.options.join(", ")}; got ${v}.`);
    }
}
/**
 * Polyhedral result to a verified mesh. The exact engine welds, repairs T-junctions and triangulates
 * without tolerances, once; then coplanar BSP fragments are merged (zero-error collapses only, vertices
 * never move off the faces). Round 1's float BSP (ENGINE.exact off) still tries a few weld tolerances.
 */
export function exactMesh(poly) {
    const merge = (m) => decimate(m, { tolerance: 1e-6, minQuality: 0, minNormalDot: 0.99, maxValence: 60 });
    if (ENGINE.exact) {
        // no retries and no pre-check: the result is checked where it is used (meshPart, the judge)
        return merge(poly.toMesh());
    }
    let last = null;
    for (const tol of [2e-5, 1e-4, 5e-6]) {
        const raw = poly.toMesh(tol);
        const rc = checkMesh(raw);
        if (!(rc.closed && rc.manifold && rc.consistentWinding)) {
            last ??= raw;
            if (process.env.KERNEL_DEBUG)
                console.error("weld", tol, "failed");
            continue;
        }
        return merge(raw);
    }
    return last;
}
export function meshPart(p, opts = {}) {
    // a finished mesh (the scan boolean's output, src/scanfit.ts): used as it is
    const pre = p.solid.premeshed;
    if (pre) {
        const c = checkMesh(pre);
        const stats = { h: 0, leafCells: 0, surfaceCells: 0, evaluations: 0, crossingEdges: 0, vertices: pre.vertexCount, triangles: pre.triangleCount, ms: { octree: 0, corners: 0, edges: 0, qef: 0, faces: 0 } };
        return { name: p.name, engine: "exact", fallback: "", mesh: pre, check: c, resolution: 0, rawTriangles: pre.triangleCount, stats, ms: { mesh: 0, decimate: 0 } };
    }
    const mode = opts.engine ?? "auto";
    let fallback = "";
    if (mode !== "field") {
        if (p.solid.poly) {
            const t0 = performance.now();
            try {
                const poly = p.solid.poly();
                const m = exactMesh(poly);
                const raw = { triangleCount: poly.polygons.length };
                const t1 = performance.now();
                const c = checkMesh(m);
                if (c.closed && c.manifold && c.consistentWinding && c.outward && c.degenerateTriangles === 0) {
                    const stats = { h: 0, leafCells: 0, surfaceCells: 0, evaluations: 0, crossingEdges: 0, vertices: m.vertexCount, triangles: m.triangleCount, ms: { octree: 0, corners: 0, edges: 0, qef: 0, faces: 0 } };
                    return { name: p.name, engine: "exact", fallback: "", mesh: m, check: c, resolution: 0, rawTriangles: raw.triangleCount, stats, ms: { mesh: t1 - t0, decimate: 0 } };
                }
                fallback = `exact result failed checks (boundary ${c.boundaryEdges}, non-manifold ${c.nonManifoldEdges}/${c.nonManifoldVertices}, winding ${c.consistentWinding}, degenerate ${c.degenerateTriangles})`;
            }
            catch (e) {
                fallback = `exact path threw: ${e.message}`;
            }
        }
        else
            fallback = p.solid.whyNoPoly || "no polyhedral form";
        if (mode === "exact")
            throw new KernelError(`Part "${p.name}" has no verified exact form: ${fallback}`);
        if (mode === "exact-only")
            return { name: p.name, engine: "field", fallback, mesh: new Mesh(new Float64Array(0), new Uint32Array(0)), check: checkMesh(new Mesh(new Float64Array(0), new Uint32Array(0))), resolution: 0, rawTriangles: 0, stats: { h: 0, leafCells: 0, surfaceCells: 0, evaluations: 0, crossingEdges: 0, vertices: 0, triangles: 0, ms: { octree: 0, corners: 0, edges: 0, qef: 0, faces: 0 } }, ms: { mesh: 0, decimate: 0 } };
    }
    else
        fallback = "field mesher requested";
    let h = opts.resolution ?? p.options.resolution ?? defaultResolution(p.solid.sdf.minFeature);
    const t0 = performance.now();
    // memory budget: coarsen the cell size until the narrow band fits (about 3 M cells, ~3 GB at most)
    let res = null;
    for (let attempt = 0; attempt < 6 && !res; attempt++) {
        try {
            res = contour(p.solid.sdf, { h });
        }
        catch (e) {
            if (!(e instanceof KernelError) || !/more than/.test(e.message))
                throw e;
            h *= 1.5;
            fallback += `; field resolution coarsened to ${h.toFixed(3)} mm to fit the memory budget`;
        }
    }
    if (!res)
        throw new KernelError(`Part "${p.name}" is too large for the field mesher's memory budget.`);
    const { mesh, stats } = res;
    const t1 = performance.now();
    const tol = opts.tolerance ?? Math.min(0.01, h / 10);
    const out = tol > 0 ? decimate(mesh, { tolerance: tol }) : mesh;
    const t2 = performance.now();
    return { name: p.name, engine: "field", fallback, mesh: out, check: checkMesh(out), resolution: h, rawTriangles: mesh.triangleCount, stats, ms: { mesh: t1 - t0, decimate: t2 - t1 } };
}
/** where the script being run lives (loadMesh reads files beside it on the command line) */
export const RUN_CONTEXT = {};
export async function runScript(scriptPath, opts = {}) {
    const t0 = performance.now();
    RUN_CONTEXT.scriptDir = dirname(resolve(scriptPath));
    const mod = await import(pathToFileURL(scriptPath).href);
    if (!mod.P || typeof mod.P !== "object")
        throw new KernelError("The script must export a parameter object: export const P = { ... }.");
    if (typeof mod.build !== "function")
        throw new KernelError("The script must export function build(P) { ... }.");
    const overrides = opts.overrides ?? {};
    validateOverrides(mod.P, overrides, mod.SPEC ?? {});
    const params = { ...mod.P, ...overrides };
    const tb = performance.now();
    let built;
    try {
        built = mod.build(params);
    }
    catch (e) {
        if (e instanceof KernelError)
            throw e;
        throw new KernelError(`build() threw: ${e.message}`);
    }
    const parts = normalizeBuildResult(built);
    const tBuild = performance.now() - tb;
    const tm = performance.now();
    // exact first; parts whose exact result fails its own check are rebuilt once with every primitive
    // nudged by <= 0.0002 mm (a perturbed retry), and only then fall back to the field mesher
    const mode = opts.engine ?? "auto";
    const results = parts.map((p) => meshPart(p, { resolution: opts.resolution, tolerance: opts.tolerance, engine: mode === "auto" ? "exact-only" : mode }));
    if (mode !== "field") {
        for (let i = 0; i < parts.length; i++) {
            if (results[i].engine === "exact" || !/failed checks|threw/.test(results[i].fallback))
                continue;
            let fixed = null;
            for (const amount of [2e-4, 1e-3]) {
                JITTER.amount = amount;
                JITTER.seed = 7 + i;
                try {
                    const again = normalizeBuildResult(mod.build({ ...params }))[i];
                    const r = meshPart(again, { engine: "exact-only" });
                    if (r.engine === "exact") {
                        fixed = { ...r, fallback: `exact after a perturbed retry (primitives moved by up to ${amount} mm)` };
                    }
                }
                finally {
                    JITTER.amount = 0;
                }
                if (fixed)
                    break;
            }
            if (fixed) {
                fixed.name = parts[i].name;
                results[i] = fixed;
            }
        }
        if (mode === "exact") {
            const bad = results.find((r) => r.engine !== "exact");
            if (bad)
                throw new KernelError(`Part "${bad.name}" has no verified exact form: ${bad.fallback}`);
        }
        for (let i = 0; i < parts.length; i++) {
            if (results[i].engine === "exact")
                continue;
            const why = results[i].fallback;
            results[i] = meshPart(parts[i], { resolution: opts.resolution, tolerance: opts.tolerance, engine: "field" });
            results[i].fallback = why;
        }
    }
    if (opts.verify !== false) {
        parts.forEach((p, i) => {
            const all = [...p.solid.checks, ...(p.options.checks ?? [])];
            const reqs = all.filter((r) => !isFacts(r));
            const fl = all.filter(isFacts).map((r) => r.facts);
            if (fl.length)
                results[i].facts = mergeFacts(fl);
            results[i].checks = reqs.map((r) => { try {
                return r.run(results[i].mesh);
            }
            catch (e) {
                return { name: r.name, pass: false, measured: null, fix: `check failed to run: ${e.message}` };
            } });
            results[i].printability = printability(results[i].mesh);
            results[i].interfaces = reqs.map((r) => r.record).filter(Boolean);
        });
    }
    const tMesh = performance.now() - tm;
    let tPhysics;
    if (opts.prove || opts.record) {
        const tp = performance.now();
        for (let i = 0; i < parts.length; i++) {
            const f = results[i].facts;
            if (!f)
                continue;
            results[i].record = partRecord(parts[i].name, results[i].mesh, f, results[i].interfaces ?? [], { material: parts[i].options.material, fidelity: opts.prove || "fast", features: [...new Set((f.requirements ?? []).map((r) => r.from).filter(Boolean))], params, spec: mod.SPEC });
            if (opts.prove)
                results[i].physics = await prove(results[i].record, { fidelity: opts.prove });
        }
        tPhysics = performance.now() - tp;
    }
    parts.forEach((p, i) => { const reps = [...p.solid.checks, ...(p.options.checks ?? [])].filter(isSizing).map((r) => r.sizing); if (reps.length)
        results[i].sizing = reps; });
    // A feature sized by a fast model (a frame, a beam) is confirmed by the whole-part check. If the two disagree enough
    // that the part fails, or carries more than 1.6x the material its target needs, rebuild once with the measured
    // correction (whole-part SF over the fast model's) and keep whichever passes with less material.
    if (opts.prove && !opts._sizingPass) {
        const tc = performance.now();
        const sfOf = (a) => { const m = a ? String(a.value).match(/[\d.]+/) : null; return m ? Number(m[0]) : NaN; };
        const strengthOf = (r, feature) => r.physics?.answers.find((a) => a.from === feature && /^strength/.test(a.id)) ?? r.physics?.answers.find((a) => /^strength/.test(a.id));
        const redo = [];
        const stiffOf = (r, feature) => r.physics?.answers.find((a) => a.from === feature && /^stiffness/.test(a.id)) ?? r.physics?.answers.find((a) => /^stiffness/.test(a.id));
        results.forEach((r) => (r.sizing ?? []).forEach((rep) => {
            if (rep.need === undefined || rep.predicted.sf === undefined || rep.kUsed === undefined)
                return;
            const a = strengthOf(r, rep.feature), sfw = sfOf(a);
            if (!a || !Number.isFinite(sfw))
                return;
            const st = stiffOf(r, rep.feature), dw = sfOf(st);
            rep.confirmed = { sf: sfw, verdict: a.verdict, defl: Number.isFinite(dw) ? dw : undefined, stiffVerdict: st?.verdict, ms: 0 };
            const stiffFails = !!st && st.verdict !== "pass" && Number.isFinite(dw) && rep.predicted.defl !== undefined && rep.kdUsed !== undefined;
            const kdNew = stiffFails || (Number.isFinite(dw) && rep.predicted.defl && rep.kdUsed !== undefined) ? Math.min(6, Math.max(0.3, (rep.kdUsed * dw) / Math.max(rep.predicted.defl, 1e-9))) : undefined;
            // over-designed only when stiffness has slack too (a part sized by its sag carries strength to spare by design)
            const stiffSlack = !st || !Number.isFinite(dw) || rep.sagMax === undefined || dw < 0.75 * rep.sagMax;
            if (a.verdict !== "pass" || stiffFails || (sfw > 1.6 * rep.need && stiffSlack && !rep.atMinimum))
                redo.push({ rep, sfw, verdict: a.verdict, kNew: Math.min(4, Math.max(0.25, (rep.kUsed * rep.predicted.sf) / sfw)), kdNew });
        }));
        if (redo.length) {
            for (const d of redo) {
                SIZING.k[d.rep.feature] = d.kNew;
                if (d.kdNew !== undefined)
                    SIZING.kd[d.rep.feature] = d.kdNew;
            }
            let again = null;
            try {
                again = await runScript(scriptPath, { ...opts, outDir: undefined, render: false, _sizingPass: true });
            }
            catch {
                again = null;
            }
            finally {
                SIZING.k = {};
                SIZING.kd = {};
            }
            if (again) {
                const passes = (rr) => rr.every((r) => !r.physics || r.physics.answers.filter((a) => /^strength|^stiffness/.test(a.id)).every((a) => a.verdict === "pass"));
                // material is the solid's volume (printed mass with infill ranks thin parts inconsistently)
                const mass = (rr) => rr.reduce((m, r) => m + Math.abs(r.check.volume), 0);
                const minSF = (rr) => Math.min(...rr.map((r) => { const a = r.physics?.answers.find((x) => /^strength/.test(x.id)); return a ? sfOf(a) : Infinity; }));
                const stiffOK = (rr) => rr.every((r) => !r.physics || r.physics.answers.filter((a) => /^stiffness/.test(a.id)).every((a) => a.verdict === "pass"));
                // the rebuild is kept when it passes with no more material, or when neither passes and it is the stronger
                const keepNew = passes(again.parts) ? (!passes(results) || mass(again.parts) <= mass(results) * 0.995)
                    : !passes(results) && stiffOK(again.parts) >= stiffOK(results) && minSF(again.parts) > minSF(results);
                for (const d of redo) {
                    const r2 = again.parts.flatMap((r) => r.sizing ?? []).find((x) => x.feature === d.rep.feature);
                    const a2 = again.parts.map((r) => strengthOf(r, d.rep.feature)).find(Boolean);
                    const s2 = again.parts.map((r) => stiffOf(r, d.rep.feature)).find(Boolean);
                    const rebuilt = { k: d.kNew, kd: d.kdNew, sf: sfOf(a2), defl: Number.isFinite(sfOf(s2)) ? sfOf(s2) : undefined, verdict: a2?.verdict ?? "?", kept: (keepNew ? "rebuilt" : "first") };
                    d.rep.confirmed.rebuilt = rebuilt;
                    d.rep.confirmed.ms = performance.now() - tc;
                    if (r2)
                        r2.confirmed = { ...d.rep.confirmed, rebuilt, ms: performance.now() - tc };
                }
                if (keepNew) {
                    results.splice(0, results.length, ...again.parts);
                }
            }
        }
        // Walls with no fast model (holder, rack): the whole-part proof is the model (the slow path). When the script left
        // the wall to the kernel and the proof shows far more margin than the target needs, scale the wall down by the
        // engine's own answer (SF about t^1.5 for a wall bending under a pull, kept to whole lines and >= 4 lines) and
        // prove once more; keep it if it passes with the band and uses less material.
        for (let i = 0; i < results.length; i++) {
            const r = results[i], rec = r.record, ph = r.physics;
            const wp = rec?.parameters?.find((q) => q.free && (q.id === "holder.wall" || q.id === "rack.wall"));
            if (!rec || !ph || !wp || typeof wp.value !== "number")
                continue;
            const st = ph.answers.find((a) => /^strength/.test(a.id)), sk = ph.answers.find((a) => /^stiffness/.test(a.id));
            const req = rec.requirements.find((q) => q.holds), dreq = rec.requirements.find((q) => q.deflection);
            const sfw = sfOf(st), dw = sfOf(sk), need = (req?.holds?.safetyFactor ?? 3) * 1.25, dmax = dreq?.deflection?.max ?? Infinity;
            if (!st || st.verdict !== "pass" || !(sfw > 1.6 * need) || (Number.isFinite(dw) && dw > 0.5 * dmax))
                continue;
            const t = wp.value, line = 0.42, tNew = Math.max(4 * line, Math.ceil((t * Math.pow((need * 1.15) / sfw, 1 / 1.5)) / line) * line);
            if (tNew > t - 0.2)
                continue;
            const t1 = performance.now();
            const wid = wp.id;
            OVERRIDES[wid] = Number(tNew.toFixed(3));
            let again = null;
            try {
                again = await runScript(scriptPath, { ...opts, outDir: undefined, render: false, _sizingPass: true });
            }
            catch {
                again = null;
            }
            finally {
                delete OVERRIDES[wid];
            }
            const a2 = again?.parts[i], st2 = a2?.physics?.answers.find((a) => /^strength/.test(a.id)), sk2 = a2?.physics?.answers.find((a) => /^stiffness/.test(a.id));
            const keep = !!a2 && st2?.verdict === "pass" && (!sk2 || sk2.verdict === "pass") && Math.abs(a2.check.volume) < Math.abs(r.check.volume) && a2.checks.every((c) => c.pass || !r.checks.find((d) => d.name === c.name)?.pass);
            const rep = { feature: wp.feature ?? "holder", requirement: `holds with SF ${(need / 1.25).toFixed(0)} outside the engine's band (${need.toFixed(2)}), deflects at most ${dmax} mm`,
                model: "the whole-part proof (the slow path: no fast model for a cup's walls), the wall scaled as SF ~ t^1.5 from this run's answer",
                chosen: keep ? `wall ${tNew.toFixed(2)} (from ${t})` : `wall ${t} (a ${tNew.toFixed(2)} mm wall ${st2 ? `proved SF ${sfOf(st2)}${st2.verdict !== "pass" ? `, ${st2.verdict}` : ""}` : "did not build"})`,
                predicted: { massG: 0, sf: need * 1.15 }, table: [], evaluated: 2, ms: performance.now() - t1,
                confirmed: { sf: sfw, verdict: st.verdict, defl: Number.isFinite(dw) ? dw : undefined, rebuilt: { k: 1, sf: sfOf(st2), verdict: st2?.verdict ?? "?", kept: keep ? "rebuilt" : "first" }, ms: performance.now() - t1 } };
            if (keep && again) {
                results[i] = a2;
                (results[i].sizing ??= []).push(rep);
            }
            else
                (r.sizing ??= []).push(rep);
            tPhysics = (tPhysics ?? 0) + (performance.now() - t1);
        }
        tPhysics = (tPhysics ?? 0) + (performance.now() - tc);
    }
    const files = {};
    const te = performance.now();
    if (opts.outDir) {
        mkdirSync(opts.outDir, { recursive: true });
        const name = opts.name ?? basename(scriptPath).replace(/\.[mc]?js$/, "");
        files.stl = join(opts.outDir, `${name}.stl`);
        writeFileSync(files.stl, writeSTL(Mesh.merge(results.map((r) => r.mesh)), name));
        files.threemf = join(opts.outDir, `${name}.3mf`);
        writeFileSync(files.threemf, write3MF(results.map((r) => ({ name: r.name, mesh: r.mesh }))));
        for (const r of results)
            if (results.length > 1)
                writeFileSync(join(opts.outDir, `${name}.${r.name}.stl`), writeSTL(r.mesh, r.name));
        files.params = join(opts.outDir, `${name}.params.json`);
        writeFileSync(files.params, JSON.stringify(params, null, 2));
        files.script = join(opts.outDir, `${name}.mjs`);
        if (scriptPath !== files.script)
            copyFileSync(scriptPath, files.script);
    }
    if (opts.outDir) {
        const name = opts.name ?? basename(scriptPath).replace(/\.[mc]?js$/, "");
        for (const r of results)
            if (r.record)
                writeFileSync(join(opts.outDir, `${name}.${r.name}.record.json`), JSON.stringify(r.record));
    }
    const tExport = performance.now() - te;
    let tRender;
    if (opts.outDir && opts.render) {
        const tr = performance.now();
        const name = opts.name ?? basename(scriptPath).replace(/\.[mc]?js$/, "");
        const { views, sheet } = renderSheet(Mesh.merge(results.map((r) => r.mesh)));
        files.views = {};
        for (const v of VIEWS) {
            const f = join(opts.outDir, `${name}.${v}.png`);
            writeFileSync(f, views[v]);
            files.views[v] = f;
        }
        files.sheet = join(opts.outDir, `${name}.sheet.png`);
        writeFileSync(files.sheet, sheet);
        tRender = performance.now() - tr;
    }
    const res = { ok: true, params, parts: results, ms: { build: tBuild, mesh: tMesh, physics: tPhysics, export: tExport, render: tRender, total: performance.now() - t0 }, files, spec: mod.SPEC };
    if (opts.outDir) {
        files.result = join(opts.outDir, `${opts.name ?? basename(scriptPath).replace(/\.[mc]?js$/, "")}.result.json`);
        writeFileSync(files.result, JSON.stringify(summarize(res), null, 2));
    }
    return res;
}
export function summarize(r) {
    return {
        params: r.params,
        parameters: r.spec ? Object.entries(r.params).map(([k, v]) => ({ name: k, value: v, ...(r.spec[k] ?? {}) })) : undefined,
        ms: r.ms,
        files: r.files,
        solids: r.parts.reduce((s, p) => s + p.check.components, 0),
        parts: r.parts.map((p) => ({
            name: p.name, engine: p.engine, fallback: p.fallback || undefined, resolution_mm: p.resolution, triangles: p.check.triangles, raw_triangles: p.rawTriangles,
            bounds: p.check.bounds, size: p.check.bounds.max.map((v, i) => v - p.check.bounds.min[i]),
            volume_mm3: p.check.volume, closed: p.check.closed, manifold: p.check.manifold,
            consistent_winding: p.check.consistentWinding, outward: p.check.outward, components: p.check.components,
            checks: p.checks, all_checks_pass: p.checks ? p.checks.every((c) => c.pass) : undefined,
            interfaces: p.interfaces,
            sizing: p.sizing,
            physics: p.physics ? { all_pass: p.physics.answers.every((a) => a.verdict === "pass"), answers: p.physics.answers.map(({ id, requirement, verdict, value, limit, where, why, fix, fidelity, from }) => ({ id, requirement, verdict, value, limit, where, why, fix, fidelity, from })), notes: p.physics.notes, ms: Math.round(p.physics.ms) } : undefined,
            printability: p.printability,
            ms: p.ms,
        })),
    };
}
