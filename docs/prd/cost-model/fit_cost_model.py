#!/usr/bin/env python3
"""Made to Fit research cost model.

Recomputes per-project cost, cost per delivered design, channel net receipts and
margins from inputs.json. Standard library only; makes no network or provider
calls. This is a planning calculator, not product billing code.

Usage: python3 docs/prd/cost-model/fit_cost_model.py
Writes scenarios.csv, pricing.csv and sensitivity.csv next to this file.
"""
import copy
import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = json.loads((ROOT / "inputs.json").read_text())


def img_tokens(px):
    # Square images; Anthropic high-resolution tier patch formula.
    return math.ceil(px / 28) ** 2


def loop_tokens(profile, turns):
    """Token accounting for a multi-turn tool loop with prompt caching.

    Turn 1 writes the (unshared part of the) prefix plus the first request.
    Each later turn reads the whole cached context and writes the previous
    assistant output plus the new tool result/images as a new cache segment.
    """
    p = profile["prefix"]
    hit = profile["shared_prefix_hit"]
    t = profile["turn"]
    new = t["new_text"] + sum(img_tokens(px) for px in t["images_px"])
    out_per_turn = t["output"]
    write = p * (1 - hit) + new
    read = p * hit
    output = out_per_turn
    ctx = p + new
    for _ in range(2, turns + 1):
        read += ctx
        seg = out_per_turn + new
        write += seg
        ctx += seg
        output += out_per_turn
    return {"write": write, "read": read, "output": output}


class Model:
    def __init__(self, d):
        self.d = d

    def llm(self, profile_name, turns, model=None):
        prof = self.d["profiles"][profile_name]
        model = model or self.d["role_assignment"][prof["role"]]
        rate = self.d["models"][model]
        tok = loop_tokens(prof, turns)
        usd = (tok["write"] * rate["cache_write"] + tok["read"] * rate["cache_read"]
               + tok["output"] * rate["output"]) / 1e6
        return usd * (1 + self.d["transient_retry_rate"])

    def job(self, name, count=1.0):
        j = self.d["compute_jobs"][name]
        r = self.d["compute_rates"]
        s = j["seconds"] * count
        if j["kind"] == "function":
            usd = s * (j["cores"] * r["modal_function_core_s"] + j["gib"] * r["modal_function_gib_s"])
        elif j["kind"] == "sandbox":
            usd = s * (j["cores"] * r["modal_sandbox_core_s"] + j["gib"] * r["modal_sandbox_gib_s"])
        else:
            usd = s * (r["modal_l4_s"] + j["cores"] * r["modal_function_core_s"]
                       + j["gib"] * r["modal_function_gib_s"])
        return usd * r["modal_broad_region_multiplier"]

    def storage(self):
        s = self.d["storage"]
        return (s["per_project_gb_month"] * s["r2_gb_month"]
                + s["per_project_class_a"] * s["r2_class_a_per_m"] / 1e6
                + s["per_project_class_b"] * s["r2_class_b_per_m"] / 1e6)

    # --- stage costs: (llm_usd, compute_usd) ---
    def capture(self):
        w = self.d["workflow"]
        return 0.0, w["p_scan_cleanup"] * self.job("scan_cleanup") + w["p_photogrammetry"] * self.job("photogrammetry")

    def intake(self):
        return self.llm("intake", self.d["profiles"]["intake"]["turns_typical"]), 0.0

    def template_run(self, turns):
        llm = self.llm("planner", turns) + self.llm("critic", 1)
        cmp = turns * (self.job("template_build") + self.job("validate") + self.job("render"))
        return llm, cmp

    def freeform_run(self, iters, coder=None):
        llm = self.llm("coder", iters, coder) + self.llm("critic", 1)
        cmp = iters * (self.job("freeform_build") + self.job("validate") + self.job("render"))
        return llm, cmp

    def finish(self, cls):
        w = self.d["workflow"][cls]
        llm = w.get("p_llm_revision", 0) * self.llm("revision", 1)
        cmp = self.job("slice") + w["p_fit_key"] * (self.job("template_build") + self.job("slice"))
        cmp += w.get("p_llm_revision", 0) * (self.job("template_build") + self.job("validate") + self.job("slice"))
        return llm, cmp

    def workflow(self, cls, coder=None):
        """Expected (llm, compute, storage) per started project and delivery probability."""
        add = lambda a, b, k=1.0: (a[0] + k * b[0], a[1] + k * b[1])
        p = self.d["profiles"]
        w = self.d["workflow"]
        cost = add(self.capture(), self.intake())
        if cls == "remix":
            cost = add(cost, (0.0, self.job("template_build") + self.job("validate")))
            cost = add(cost, self.finish("remix"))
            deliver = w["remix"].get("p_success", 0.97)
        elif cls == "template":
            t = w["template"]
            ps, esc = t["p_success"], t["p_escalate_on_fail"]
            pf = w["freeform"]["p_success"]
            cost = add(cost, self.template_run(p["planner"]["turns_typical"]), ps)
            cost = add(cost, self.finish("template"), ps)
            cost = add(cost, self.template_run(p["planner"]["turns_cap"]), 1 - ps)
            esc_w = (1 - ps) * esc
            cost = add(cost, self.freeform_run(p["coder"]["turns_typical"], coder), esc_w * pf)
            cost = add(cost, self.finish("freeform"), esc_w * pf)
            cost = add(cost, self.freeform_run(p["coder"]["turns_cap"], coder), esc_w * (1 - pf))
            deliver = ps + esc_w * pf
        elif cls == "freeform":
            pf = w["freeform"]["p_success"]
            cost = add(cost, (self.llm("planner", 1), 0.0))
            cost = add(cost, self.freeform_run(p["coder"]["turns_typical"], coder), pf)
            cost = add(cost, self.finish("freeform"), pf)
            cost = add(cost, self.freeform_run(p["coder"]["turns_cap"], coder), 1 - pf)
            deliver = pf
        else:
            raise ValueError(cls)
        storage = self.storage()
        total = cost[0] + cost[1] + storage
        return {"llm": cost[0], "compute": cost[1], "storage": storage,
                "per_started": total, "p_deliver": deliver,
                "per_delivered": total / deliver if deliver else float("inf")}

    def fixed_monthly(self):
        f = self.d["fixed_monthly"]
        total = 0.0
        for k, v in f.items():
            if k.startswith("_"):
                continue
            if "usd" in v:
                total += v["usd"]
            elif "cu_hours" in v:
                total += v["cu_hours"] * v["rate"]
            else:
                total += v["gb"] * v["rate"]
        return total

    def relay_per_bridge_month(self):
        r = self.d["relay"]
        b = r["per_bridge_month"]
        requests = b["connects"] + b["incoming_msgs"] / b["ws_billing_ratio"]
        gb_s = b["incoming_msgs"] * b["active_ms_per_msg"] / 1000 * b["memory_gb"]
        return requests * r["do_requests_per_m"] / 1e6 + gb_s * r["do_gb_s_per_m"] / 1e6


def net_per_credit(d, price, credits, channel):
    c = d["channels"][channel]
    return (price * (1 - c["pct"]) - c["fixed"]) / credits


def main():
    m = Model(BASE)
    d = BASE
    scen_rows = []
    for coder in d["sensitivity_coder_models"]:
        for cls in ("remix", "template", "freeform"):
            r = m.workflow(cls, coder)
            scen_rows.append({"workflow": cls, "coder_model": coder, **{k: round(v, 4) for k, v in r.items()}})
    with (ROOT / "scenarios.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(scen_rows[0]))
        w.writeheader()
        w.writerows(scen_rows)

    default = {cls: m.workflow(cls) for cls in ("remix", "template", "freeform")}
    pc = d["price_card"]
    claim = pc["fit_guarantee_claim_rate"]
    mix = d["mix"]
    pricing_rows = []
    offers = [(p["name"], p["price"], p["credits"], 1.0) for p in pc["packs"]]
    sub = pc["subscription"]
    offers.append((sub["name"], sub["price"], sub["credits"], sub["expected_utilization"]))
    offers.append((sub["name"] + " (fully used)", sub["price"], sub["credits"], 1.0))
    for name, price, credits, util in offers:
        for ch in d["channels"]:
            if name.startswith("Fit+") and "credits" in ch:
                continue
            if not name.startswith("Fit+") and ch == "google_play_sub":
                continue
            npc = net_per_credit(d, price, credits * util, ch)
            row = {"offer": name, "channel": ch, "price": price, "credits_used": round(credits * util, 2),
                   "net_per_used_credit": round(npc, 4)}
            blended_contrib = 0.0
            blended_rev = 0.0
            for cls in ("remix", "template", "freeform"):
                r = default[cls]
                rev = r["p_deliver"] * pc["credits"][cls] * npc * (1 - claim)
                contrib = rev - r["per_started"]
                row[f"{cls}_margin"] = round(contrib / rev, 4) if rev > 0 else "free"
                blended_contrib += mix[cls] * contrib
                blended_rev += mix[cls] * rev
            row["blended_contribution_per_started_project"] = round(blended_contrib, 4)
            row["blended_margin"] = round(blended_contrib / blended_rev, 4) if blended_rev else None
            pricing_rows.append(row)
    with (ROOT / "pricing.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(pricing_rows[0]))
        w.writeheader()
        w.writerows(pricing_rows)

    sens_rows = []

    def sens(label, mutate):
        dd = copy.deepcopy(BASE)
        mutate(dd)
        mm = Model(dd)
        for cls in ("template", "freeform"):
            r = mm.workflow(cls)
            sens_rows.append({"case": label, "workflow": cls, "per_started": round(r["per_started"], 4),
                              "per_delivered": round(r["per_delivered"], 4), "p_deliver": round(r["p_deliver"], 4)})

    sens("baseline", lambda dd: None)
    sens("coder iterations x2 (typ 8, cap 16)", lambda dd: dd["profiles"]["coder"].update(turns_typical=8, turns_cap=16))
    sens("freeform success 0.45", lambda dd: dd["workflow"]["freeform"].update(p_success=0.45))
    sens("template success 0.70", lambda dd: dd["workflow"]["template"].update(p_success=0.70))
    sens("no shared prompt cache hits", lambda dd: [p.update(shared_prefix_hit=0) for k, p in dd["profiles"].items() if not k.startswith("_")])
    sens("renders at 1568 px", lambda dd: [p["turn"].update(images_px=[1568] * len(p["turn"]["images_px"])) for k, p in dd["profiles"].items() if not k.startswith("_")])
    sens("Opus for planner and critic too", lambda dd: dd["role_assignment"].update(planner="claude-opus-5-5", critic="claude-opus-5-5"))
    sens("all roles GPT-6 Luna", lambda dd: dd["role_assignment"].update(planner="gpt-6-luna", critic="gpt-6-luna", coder="gpt-6-luna"))
    sens("Modal non-preemptible 3x compute", lambda dd: dd["compute_rates"].update(modal_broad_region_multiplier=1.15 * 3))
    with (ROOT / "sensitivity.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(sens_rows[0]))
        w.writeheader()
        w.writerows(sens_rows)

    ft = d["free_tier"]
    free_mau = (ft["free_template_fits_per_month"] * ft["template_fit_uptake"] * default["template"]["per_started"]
                + ft["remixes_per_mau"] * default["remix"]["per_started"])
    fixed = m.fixed_monthly()
    relay = m.relay_per_bridge_month()

    print("Per started project (default roles):")
    for cls, r in default.items():
        print(f"  {cls:9s} llm ${r['llm']:.4f}  compute ${r['compute']:.4f}  storage ${r['storage']:.4f}  "
              f"started ${r['per_started']:.4f}  p_deliver {r['p_deliver']:.3f}  per delivered ${r['per_delivered']:.4f}")
    blended = sum(mix[c] * default[c]["per_started"] for c in default)
    print(f"Blended per started project: ${blended:.4f}")
    print(f"Free-tier cost per free hosted MAU: ${free_mau:.4f}")
    print(f"Lean fixed baseline: ${fixed:.2f}/month; per project at " +
          ", ".join(f"{v}: ${fixed / v:.3f}" for v in d["volumes"]))
    print(f"Relay per connected bridge-month: ${relay:.7f}; 10,000 bridges: ${relay * 10000:.2f} + ${d['relay']['workers_paid_min_month']:.2f} plan minimum")
    print("Wrote scenarios.csv, pricing.csv, sensitivity.csv")


if __name__ == "__main__":
    main()
