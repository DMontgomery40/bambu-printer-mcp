#!/usr/bin/env node
/**
 * counterpart-kernel CLI: run a part script the way the code-engine tool would.
 *   node dist/cli.js run SCRIPT --out DIR [--name NAME] [--set key=value ...] [--engine auto|field|exact] [--no-render]
 * Prints the result receipt (JSON): parameters, per-part engine, bounds, volume, solids, checks, files.
 * Parts whose features state what they must do are proved by the physics engine at its fast setting
 * (--prove normal|fine for a slower, finer check; --no-prove to skip); the record is written beside them.
 */
import { runScript, summarize } from "./runner.js";
import { KernelError } from "./api.js";
const argv = process.argv.slice(2);
if (argv[0] === "feedback") {
    // node dist/cli.js feedback RESULT_JSON INTERFACE_ID "too tight"|"right"|"loose"|"rattles"|"fell out" [note]
    const { readFileSync, appendFileSync } = await import("node:fs");
    const { FEEDBACK_CHOICES } = await import("./fit.js");
    const [, resultPath, id, answer, note] = argv;
    if (!resultPath || !id || !answer) {
        console.error(`usage: cli.js feedback RESULT_JSON INTERFACE_ID "${FEEDBACK_CHOICES.join('"|"')}" [note]`);
        process.exit(2);
    }
    if (!FEEDBACK_CHOICES.includes(answer)) {
        console.error(`answer must be one of: ${FEEDBACK_CHOICES.join(", ")}`);
        process.exit(2);
    }
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const recs = (result.parts ?? []).flatMap((p) => (p.interfaces ?? []).map((r) => ({ part: p.name, ...r })));
    const rec = recs.find((r) => r.id === id);
    if (!rec) {
        console.error(`no interface "${id}" in ${resultPath}; interfaces: ${recs.map((r) => r.id).join(", ")}`);
        process.exit(2);
    }
    const entry = { at: new Date().toISOString(), result: resultPath, interface: { ...rec, feedback: answer }, note };
    const log = resultPath.replace(/\.result\.json$/, "") + ".feedback.jsonl";
    appendFileSync(log, JSON.stringify(entry) + "\n");
    console.log(JSON.stringify({ stored: log, interface: id, answer, modelled_per_side: rec.modelled_per_side }));
    process.exit(0);
}
if (argv[0] === "observe") {
    // node dist/cli.js observe RESULT_JSON COUPON ANSWER... : a coupon's outcome (a count or a word), stored with the coupon's design numbers
    const { readFileSync, appendFileSync } = await import("node:fs");
    const [, resultPath, coupon, ...answer] = argv;
    if (!resultPath || !coupon || !answer.length) {
        console.error("usage: cli.js observe RESULT_JSON COUPON ANSWER (see the plate's KEY.md, e.g. observe out/second-plate/second-plate.result.json A once=5)");
        process.exit(2);
    }
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const parts = (result.parts ?? []).filter((p) => p.name.startsWith(coupon.replace(/\d+$/, "")));
    if (!parts.length) {
        console.error(`no coupon "${coupon}" in ${resultPath}; coupons: ${[...new Set((result.parts ?? []).map((p) => p.name.split(" ")[0]))].join(", ")}`);
        process.exit(2);
    }
    const entry = { at: new Date().toISOString(), result: resultPath, coupon, answer: answer.join(" "), design: parts.map((p) => ({ name: p.name, checks: p.checks })), params: result.params };
    const log = resultPath.replace(/\.result\.json$/, "") + ".observations.jsonl";
    appendFileSync(log, JSON.stringify(entry) + "\n");
    console.log(JSON.stringify({ stored: log, coupon, answer: entry.answer }));
    process.exit(0);
}
if (argv[0] !== "run" || !argv[1]) {
    console.error("usage: cli.js run SCRIPT --out DIR [--name NAME] [--set key=value ...] [--engine auto|field|exact] [--no-render]");
    process.exit(2);
}
const script = argv[1];
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const overrides = {};
// --params FILE: a JSON object of overrides (a host saves them, as the printer MCP saves <name>.parameters.json)
{
    const i = argv.indexOf("--params");
    if (i >= 0) {
        const { readFileSync } = await import("node:fs");
        Object.assign(overrides, JSON.parse(readFileSync(argv[i + 1], "utf8")));
    }
}
argv.forEach((a, i) => {
    if (a !== "--set")
        return;
    const [k, v] = argv[i + 1].split("=");
    overrides[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : v;
});
try {
    const r = await runScript(script, { outDir: get("--out") ?? "out/run", name: get("--name"), overrides, engine: get("--engine") ?? "auto", render: !argv.includes("--no-render"),
        prove: argv.includes("--no-prove") ? false : (get("--prove") ?? "fast") });
    // compact receipt, failures first; the full JSON is in <out>/<name>.result.json
    const full = summarize(r);
    const compact = {
        status: "ok",
        all_requirements_pass: r.parts.every((p) => !p.checks || p.checks.every((c) => c.pass)),
        parts: r.parts.map((p) => ({
            name: p.name, path: p.engine, size_mm: full.parts.find((q) => q.name === p.name).size.map((v) => Number(v.toFixed(3))),
            bounds_min: p.check.bounds.min.map((v) => Number(v.toFixed(3))), volume_mm3: Number(p.check.volume.toFixed(1)),
            closed: p.check.closed, manifold: p.check.manifold, solids: p.check.components,
            fits: (p.interfaces ?? []).map((r) => ({ feature: r.feature, decision: r.reasoning, assumptions: r.assumptions.length ? r.assumptions : undefined })),
            failing: (p.checks ?? []).filter((c) => !c.pass),
            passing: (p.checks ?? []).filter((c) => c.pass && !c.name.startsWith("fit: ")).map((c) => `${c.name}: ${c.measured}`),
            printability: p.printability && { flat_base_mm2: p.printability.base_area_mm2, min_wall_mm: p.printability.min_wall_mm, min_wall_at: p.printability.min_wall_where, supports_needed: p.printability.supports_needed, worst_overhang_deg: p.printability.worst_overhang_deg, longest_bridge_mm: p.printability.longest_bridge_mm,
                overhang_regions: p.printability.overhangs.filter((o) => o.kind === "overhang").slice(0, 3), mass_g: p.printability.mass_g, print_min_estimate: p.printability.print_time_min_estimate },
            physics: p.physics && {
                all_pass: p.physics.answers.every((a) => a.verdict === "pass"),
                not_passing: p.physics.answers.filter((a) => a.verdict !== "pass").map((a) => ({ id: a.id, verdict: a.verdict, requirement: a.requirement, value: a.value, limit: a.limit, where: a.where, why: a.why, fix: a.fix })),
                passing: p.physics.answers.filter((a) => a.verdict === "pass").map((a) => `${a.id}: ${a.requirement}: ${a.value}`),
                fidelity: p.physics.answers[0]?.fidelity, s: Number((p.physics.ms / 1000).toFixed(1)),
            },
            sized: p.sizing?.map((z) => ({ feature: z.feature, chosen: z.chosen, requirement: z.requirement, predicted: z.predicted, by: z.model, candidates: z.evaluated, ms: Math.round(z.ms),
                whole_part: z.confirmed && { sf: z.confirmed.sf, verdict: z.confirmed.verdict, rebuilt: z.confirmed.rebuilt }, notes: z.notes })),
            fallback: p.fallback || undefined,
        })),
        parameters: full.parameters ?? full.params,
        files: { stl: r.files.stl, threemf: r.files.threemf, sheet: r.files.sheet, views: r.files.views ? Object.values(r.files.views) : undefined, full_receipt: r.files.result },
        ms: Math.round(r.ms.total),
    };
    console.log(JSON.stringify(compact, null, 1));
}
catch (e) {
    const err = e;
    console.log(JSON.stringify({ status: "error", code: err instanceof KernelError ? "kernel-error" : "script-error", message: err.message }, null, 2));
    process.exit(1);
}
