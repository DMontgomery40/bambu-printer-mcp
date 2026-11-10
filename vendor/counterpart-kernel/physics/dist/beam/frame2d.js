/**
 * Geometrically exact planar frames: co-rotational two-node beam elements (Crisfield's formulation)
 * with Timoshenko local bending, Newton-Raphson on the full nonlinear equilibrium, load or
 * displacement control with automatic step cutting, follower forces (a hook force that turns with the
 * hook), and penalty contact against rigid circles (a pole inside a ring).
 *
 * Why this method: a flexure the kernel knows (snap arm, clip, split ring, rib) is a slender planar
 * member. Large rotations with small strains are exactly what the co-rotational split handles, it is
 * exact in the limit of fine elements for any deflection (the benchmark measures this against the
 * elastica), and 20 to 80 elements solve in milliseconds with a dense LU.
 *
 * Units: mm, N, MPa (N/mm^2), radians.
 */
import { luSolve } from "../la.js";
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
function assemble(m, u, lambda, wantK) {
    const nd = m.nodes.length * 3;
    const K = new Float64Array(wantK ? nd * nd : 0);
    const f = new Float64Array(nd);
    const elems = [];
    const r = new Float64Array(6), z = new Float64Array(6), B = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
    for (const e of m.elems) {
        const [i, j] = e.n;
        const X1 = m.nodes[i], X2 = m.nodes[j];
        const L0 = Math.hypot(X2[0] - X1[0], X2[1] - X1[1]);
        const b0 = Math.atan2(X2[1] - X1[1], X2[0] - X1[0]);
        const dx = X2[0] + u[3 * j] - X1[0] - u[3 * i], dy = X2[1] + u[3 * j + 1] - X1[1] - u[3 * i + 1];
        const Ln = Math.hypot(dx, dy), c = dx / Ln, s = dy / Ln;
        const beta = Math.atan2(dy, dx);
        const rigid = wrap(beta - b0);
        const ub = Ln - L0;
        const t1 = wrap(u[3 * i + 2] - rigid), t2 = wrap(u[3 * j + 2] - rigid);
        const phi = e.G && e.As ? (12 * e.E * e.I) / (e.G * e.As * L0 * L0) : 0;
        const kb = (e.E * e.I) / (L0 * (1 + phi));
        const D11 = kb * (4 + phi), D12 = kb * (2 - phi);
        const ka = (e.E * e.A) / L0;
        const N = ka * ub, M1 = D11 * t1 + D12 * t2, M2 = D12 * t1 + D11 * t2;
        r.set([-c, -s, 0, c, s, 0]);
        z.set([s, -c, 0, -s, c, 0]);
        for (let a = 0; a < 6; a++) {
            B[0][a] = r[a];
            B[1][a] = -z[a] / Ln;
            B[2][a] = -z[a] / Ln;
        }
        B[1][2] += 1;
        B[2][5] += 1;
        const dofs = [3 * i, 3 * i + 1, 3 * i + 2, 3 * j, 3 * j + 1, 3 * j + 2];
        for (let a = 0; a < 6; a++)
            f[dofs[a]] += B[0][a] * N + B[1][a] * M1 + B[2][a] * M2;
        if (wantK) {
            for (let a = 0; a < 6; a++) {
                const row = dofs[a] * nd;
                for (let b = 0; b < 6; b++) {
                    const mat = B[0][a] * ka * B[0][b]
                        + B[1][a] * (D11 * B[1][b] + D12 * B[2][b]) + B[2][a] * (D12 * B[1][b] + D11 * B[2][b]);
                    const geo = (z[a] * z[b] * N) / Ln + ((r[a] * z[b] + z[a] * r[b]) * (M1 + M2)) / (Ln * Ln);
                    K[row + dofs[b]] += mat + geo;
                }
            }
        }
        const strain = Math.abs(N) / (e.E * e.A) + (Math.max(Math.abs(M1), Math.abs(M2)) * e.c) / (e.E * e.I);
        elems.push({ N, M1, M2, strain, stress: e.E * strain });
    }
    // follower loads: f = lambda * R(theta) f0 ; residual is f_int - f_ext, tangent gets -d f_ext / d theta
    for (const fl of m.followers ?? []) {
        const th = u[3 * fl.node + 2], c = Math.cos(th), s = Math.sin(th);
        const fx = c * fl.f[0] - s * fl.f[1], fy = s * fl.f[0] + c * fl.f[1];
        f[3 * fl.node] -= lambda * fx;
        f[3 * fl.node + 1] -= lambda * fy;
        if (wantK) {
            const dfx = -s * fl.f[0] - c * fl.f[1], dfy = c * fl.f[0] - s * fl.f[1];
            K[(3 * fl.node) * nd + 3 * fl.node + 2] -= lambda * dfx;
            K[(3 * fl.node + 1) * nd + 3 * fl.node + 2] -= lambda * dfy;
        }
    }
    const contact = [];
    for (const ct of m.circles ?? []) {
        // smooth penalty: f(g) = k w softplus(-g / w), w = ct.w (default 1e-4 * r); C-infinity, so Newton
        // does not chatter when contacts open and close
        const wd = ct.w ?? 1e-4 * ct.r;
        for (const n of ct.nodes) {
            const px = m.nodes[n][0] + u[3 * n] - ct.c[0], py = m.nodes[n][1] + u[3 * n + 1] - ct.c[1];
            const rr = ct.r0 === undefined ? ct.r : ct.r0 + lambda * (ct.r - ct.r0);
            const d = Math.hypot(px, py), g = d - (rr + ct.offset);
            const z = -g / wd;
            const fN = z > 40 ? ct.k * (-g) : ct.k * wd * Math.log1p(Math.exp(z));
            const dfN = -ct.k / (1 + Math.exp(-z)); // d fN / d g
            contact.push(fN);
            if (fN < 1e-14 * ct.k * wd)
                continue;
            const nx = px / d, ny = py / d;
            f[3 * n] -= fN * nx;
            f[3 * n + 1] -= fN * ny;
            if (wantK) {
                const a = -dfN, b = -fN / d;
                const kxx = a * nx * nx + b * (1 - nx * nx), kyy = a * ny * ny + b * (1 - ny * ny), kxy = a * nx * ny - b * nx * ny;
                K[(3 * n) * nd + 3 * n] += kxx;
                K[(3 * n) * nd + 3 * n + 1] += kxy;
                K[(3 * n + 1) * nd + 3 * n] += kxy;
                K[(3 * n + 1) * nd + 3 * n + 1] += kyy;
            }
        }
    }
    for (const l of m.loads ?? [])
        for (let a = 0; a < 3; a++)
            f[3 * l.node + a] -= lambda * l.f[a];
    return { K, f, elems, contact };
}
/**
 * Trace the equilibrium path from lambda = 0 to 1 (loads and prescribed values scale with lambda).
 * Returns the state at each of `outputs` (default: every step). Throws if a step cannot converge
 * after `maxCuts` halvings (a limit point under load control, e.g. snap-through).
 */
export function solveFrame(m, o = {}) {
    const steps = o.steps ?? 10, tol = o.tol ?? 1e-9, maxIter = o.maxIter ?? 40, maxCuts = o.maxCuts ?? 12;
    const nd = m.nodes.length * 3;
    const fixed = new Map();
    for (const b of m.bcs)
        fixed.set(3 * b.node + b.dof, b.value ?? 0);
    let u = new Float64Array(nd);
    let size = 0;
    for (const p of m.nodes)
        for (const q of m.nodes.slice(0, 1))
            size = Math.max(size, Math.hypot(p[0] - q[0], p[1] - q[1]));
    size = Math.max(size, 1);
    let lmax = 0;
    for (const e of m.elems)
        lmax = Math.max(lmax, Math.hypot(m.nodes[e.n[1]][0] - m.nodes[e.n[0]][0], m.nodes[e.n[1]][1] - m.nodes[e.n[0]][1]));
    const outputs = (o.outputs ?? Array.from({ length: steps }, (_, k) => (k + 1) / steps)).slice().sort((a, b) => a - b);
    const states = [];
    let lam = 0, dl = 1 / steps, cuts = 0, oi = 0;
    const loadScale = (() => { let s = 0; for (const l of m.loads ?? [])
        for (const v of l.f)
            s += v * v; for (const fl of m.followers ?? [])
        for (const v of fl.f)
            s += v * v; return Math.sqrt(s); })();
    while (oi < outputs.length) {
        const target = Math.min(lam + dl, outputs[oi]);
        const trial = u.slice();
        for (const [d, v] of fixed)
            trial[d] = target * v;
        let ok = false, it = 0, w = null, e0 = 0;
        for (; it < maxIter; it++) {
            w = assemble(m, trial, target, true);
            for (const d of fixed.keys())
                w.f[d] = 0;
            let rn = 0, fs = 0;
            for (let a = 0; a < nd; a++)
                rn += w.f[a] * w.f[a];
            for (const e of w.elems)
                fs += e.N * e.N + e.M1 * e.M1;
            const scale = Math.max(1e-6, target * loadScale, Math.sqrt(fs) * 1e-3);
            // round-off floor: the largest stiffness times the displacement scale times machine precision
            let kmax = 0;
            for (let a = 0; a < nd; a++)
                kmax = Math.max(kmax, Math.abs(w.K[a * nd + a]));
            const floor = 2e-15 * kmax * lmax * Math.sqrt(nd);
            if (Math.sqrt(rn) <= tol * scale + floor && it > 0) {
                ok = true;
                break;
            }
            for (const d of fixed.keys()) {
                for (let b = 0; b < nd; b++) {
                    w.K[d * nd + b] = 0;
                    w.K[b * nd + d] = 0;
                }
                w.K[d * nd + d] = 1;
            }
            const du = luSolve(w.K, w.f, nd);
            if (!du || du.some((v) => !Number.isFinite(v)))
                break;
            // limit rotation increments to keep Newton inside its basin
            let mx = 0;
            for (let a = 2; a < nd; a += 3)
                mx = Math.max(mx, Math.abs(du[a]));
            const damp = mx > 0.5 ? 0.5 / mx : 1;
            for (let a = 0; a < nd; a++)
                trial[a] -= damp * du[a];
            // energy-norm criterion (round-off floor): |du . r| far below its first-iteration value
            let en = 0;
            for (let a = 0; a < nd; a++)
                en += Math.abs(du[a] * w.f[a]);
            if (it === 0)
                e0 = en;
            if (it > 0 && en <= 1e-18 * e0 && Math.sqrt(rn) <= 1e-4 * scale) {
                ok = true;
                it++;
                w = null;
                break;
            }
        }
        if (!ok) {
            if (++cuts > maxCuts)
                throw new Error(`solveFrame: no equilibrium beyond lambda=${lam.toFixed(4)} (limit point or contact chatter)`);
            dl /= 2;
            continue;
        }
        u = trial;
        lam = target;
        cuts = Math.max(0, cuts - 1);
        if (dl < 1 / steps)
            dl = Math.min(1 / steps, dl * 1.5);
        if (Math.abs(lam - outputs[oi]) < 1e-12) {
            const fin = assemble(m, u, lam, false);
            states.push({ lambda: lam, u: u.slice(), reaction: fin.f, elems: fin.elems, contact: fin.contact, iterations: it });
            oi++;
        }
    }
    return states;
}
/** A straight or tapered strip from p0 to p1 with n elements; rectangular section b x h(s) (h linear from h0 to h1). */
export function strip(o) {
    const h1 = o.h1 ?? o.h0, base = o.start ?? 0;
    const nodes = [], elems = [];
    for (let k = 0; k <= o.n; k++) {
        const t = k / o.n;
        nodes.push([o.from[0] + t * (o.to[0] - o.from[0]), o.from[1] + t * (o.to[1] - o.from[1])]);
    }
    const b1 = o.b1 ?? o.b;
    for (let k = 0; k < o.n; k++) {
        const t = (k + 0.5) / o.n;
        elems.push(rectElem(base + k, base + k + 1, o.b + t * (b1 - o.b), o.h0 + t * (h1 - o.h0), o.E, o.G, o.shear));
    }
    return { nodes, elems };
}
export function rectElem(i, j, b, h, E, G, shear) {
    const e = { n: [i, j], E, A: b * h, I: (b * h * h * h) / 12, c: h / 2 };
    if (shear) {
        e.G = G ?? E / (2 * 1.35);
        e.As = (5 / 6) * b * h;
    }
    return e;
}
