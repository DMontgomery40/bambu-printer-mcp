/**
 * Cantilever snap arm with a hook: the classic design-guide formulae and the engine's nonlinear answer.
 *
 * Geometry (arm along +x from a fixed root, deflects in +y when the mating edge rides up the hook's lead
 * ramp): length l, width b, thickness h0 at the root tapering linearly to h1 at the hook, hook depth
 * (undercut) y, lead angle alpha (insertion), return angle alphaR (retention), friction mu.
 *
 * Design guide (rectangular section, small deflection, from the guide cited in materials/SOURCES.md):
 *   constant section: y = 0.67 eps l^2 / h          tapered to h/2: y = 1.09 eps l^2 / h
 *   deflection force: P = (b h^2 / 6) (Es eps / l)   mating force: W = P (mu + tan a) / (1 - mu tan a)
 * Engine: the co-rotational beam with the tip pushed to y (displacement control) gives P, the tip
 * rotation and the peak strain at any deflection; the ramp turns with the tip, so the effective lead angle
 * is alpha + theta_tip, and the edge's axial push W is fed back onto the hook (offset from the arm's axis
 * by the hook depth) until consistent.
 */
import { solveFrame, strip, rectElem } from "./frame2d.js";
export function snapGuide(a) {
    const tapered = a.h1 !== undefined && Math.abs(a.h1 - a.h0 / 2) < 1e-9 * a.h0;
    const wtaper = a.b1 !== undefined && Math.abs(a.b1 - a.b / 4) < 1e-9 * a.b;
    if (a.h1 !== undefined && !tapered && Math.abs(a.h1 - a.h0) > 1e-12)
        throw new Error("snapGuide: the guide gives constant section, h -> h/2 or b -> b/4 only");
    if (a.b1 !== undefined && !wtaper && Math.abs(a.b1 - a.b) > 1e-12)
        throw new Error("snapGuide: the guide gives constant section, h -> h/2 or b -> b/4 only");
    if (tapered && wtaper)
        throw new Error("snapGuide: the guide has no combined taper");
    const coeff = tapered ? 1.09 : wtaper ? 0.86 : 0.67;
    const strain = (a.y * a.h0) / (coeff * a.l * a.l);
    const P = ((a.b * a.h0 * a.h0) / 6) * (a.E * strain / a.l);
    const wedge = (ang) => { const t = Math.tan((ang * Math.PI) / 180); const d = 1 - a.mu * t; return d <= 0 ? null : (P * (a.mu + t)) / d; };
    return { strain, P, W: wedge(a.alpha) ?? Infinity, Wout: a.alphaR === undefined ? null : wedge(a.alphaR), coeff };
}
function build(a, n) {
    const s = strip({ from: [0, 0], to: [a.l, 0], n, b: a.b, b1: a.b1, h0: a.h0, h1: a.h1 ?? a.h0, E: a.E });
    return { nodes: s.nodes, elems: s.elems, bcs: [{ node: 0, dof: 0 }, { node: 0, dof: 1 }, { node: 0, dof: 2 }] };
}
/** Engine answer: nonlinear arm, ramp turning with the tip, axial push fed back. */
export function snapEngine(a, opts = {}) {
    const t0 = performance.now();
    const n = a.n ?? 40, pts = opts.points ?? 8;
    const curve = [];
    let last = null;
    let locked = null;
    const wedge = (ang, P) => { const t = Math.tan(ang); const d = 1 - a.mu * t; return d <= 1e-9 ? Infinity : (P * (a.mu + t)) / d; };
    for (let k = 1; k <= pts; k++) {
        const v = (a.y * k) / pts;
        let W = 0, P = 0, th = 0, strain = 0, at = 0;
        for (let it = 0; it < (opts.feedback === false ? 1 : 6); it++) {
            const m = build(a, n);
            // the hook: a short stiff lever from the tip to the contact point at the hook depth (below the arm)
            const tip = n, hk = m.nodes.length;
            m.nodes.push([a.l, -((a.h1 ?? a.h0) / 2 + a.y)]);
            m.elems.push(rectElem(tip, hk, a.b, 4 * a.h0, a.E * 100));
            m.bcs.push({ node: hk, dof: 1, value: v });
            // the edge's axial push on the hook (towards the root) as a dead load scaled with the step
            m.loads = [{ node: hk, f: [-W, 0, 0] }];
            let st;
            try {
                st = solveFrame(m, { steps: 4 })[3];
            }
            catch { // no equilibrium: the push turns the hook past self-locking (or the arm snaps through)
                locked = { at: v, angleDeg: a.alpha + Math.abs(th * 180 / Math.PI) };
                W = Infinity;
                break;
            }
            P = st.reaction[3 * hk + 1];
            th = st.u[3 * tip + 2];
            let best = 0, bi = 0;
            st.elems.slice(0, n).forEach((e, i) => { if (e.strain > best) {
                best = e.strain;
                bi = i;
            } });
            strain = best;
            at = ((bi + 0.5) / n) * a.l;
            const Wn = opts.feedback === false ? wedge((a.alpha * Math.PI) / 180, P) : wedge((a.alpha * Math.PI) / 180 + Math.abs(th), P);
            if (!Number.isFinite(Wn)) {
                W = Infinity;
                locked = { at: v, angleDeg: a.alpha + Math.abs((th * 180) / Math.PI) };
                break;
            }
            if (Math.abs(Wn - W) < 1e-6 * Math.max(1, Wn)) {
                W = Wn;
                break;
            }
            W = Wn;
        }
        if (locked && !Number.isFinite(W))
            break;
        curve.push([v, P, W]);
        last = { P, W, strain, at, th };
    }
    if (locked || !last) {
        const L0 = last ?? { P: NaN, W: Infinity, strain: NaN, at: NaN, th: NaN };
        return { P: L0.P, W: Infinity, Wout: null, strain: L0.strain, at: L0.at, tipRotationDeg: (L0.th * 180) / Math.PI, curve, ms: performance.now() - t0, locks: locked ?? { at: 0, angleDeg: a.alpha } };
    }
    const L = last;
    const Wout = a.alphaR === undefined ? null : (() => {
        const w = wedge((a.alphaR * Math.PI) / 180 - Math.abs(L.th), L.P);
        return Number.isFinite(w) ? w : null;
    })();
    return { P: L.P, W: L.W, Wout, strain: L.strain, at: L.at, tipRotationDeg: (L.th * 180) / Math.PI, curve, ms: performance.now() - t0 };
}
