/**
 * References for the beam engine, computed here independently of it:
 *  - the elastica of a cantilever with a vertical tip load (exact large deflection), two ways:
 *    (a) shooting on EI theta'' = -P cos(theta), theta(0) = 0, theta'(L) = 0 with RK4;
 *    (b) the first integral EI theta'^2 / 2 = P (sin thetaL - sin theta), integrated by quadrature;
 *  - the pseudo-rigid-body model (Howell): a pivot at (1 - gamma) L with a torsion spring
 *    K = gamma K_Theta EI / L, the fast estimate for a cantilever flexure.
 */
import { solveBracket } from "../la.js";
/** Exact cantilever elastica by shooting. alpha = P L^2 / (E I); returns ratios to L and the tip angle (rad). */
export function elasticaShooting(alpha, n = 4000) {
    // nondimensional: s in [0,1], theta'' = -alpha cos(theta)
    const run = (k0) => {
        let x = 0, y = 0, th = 0, k = k0;
        const h = 1 / n;
        const d = (th, k) => [Math.cos(th), Math.sin(th), k, -alpha * Math.cos(th)];
        for (let i = 0; i < n; i++) {
            const a = d(th, k);
            const b = d(th + 0.5 * h * a[2], k + 0.5 * h * a[3]);
            const c = d(th + 0.5 * h * b[2], k + 0.5 * h * b[3]);
            const e = d(th + h * c[2], k + h * c[3]);
            x += (h / 6) * (a[0] + 2 * b[0] + 2 * c[0] + e[0]);
            y += (h / 6) * (a[1] + 2 * b[1] + 2 * c[1] + e[1]);
            th += (h / 6) * (a[2] + 2 * b[2] + 2 * c[2] + e[2]);
            k += (h / 6) * (a[3] + 2 * b[3] + 2 * c[3] + e[3]);
        }
        return { x, y, th, k };
    };
    const k0 = solveBracket((k0) => run(k0).k, 0, alpha, 1e-13);
    const r = run(k0);
    return { dv: r.y, dh: 1 - r.x, theta: r.th };
}
/** Exact cantilever elastica from the first integral, by Gauss-Legendre quadrature (independent of the shooting). */
export function elasticaQuadrature(alpha) {
    // with theta = thL - t^2: ds = 2 t dt / sqrt(2 alpha (sin thL - sin(thL - t^2)))
    const gl = gaussLegendre(64);
    const integ = (thL, g) => {
        const T = Math.sqrt(thL);
        let s = 0;
        for (let i = 0; i < gl.x.length; i++) {
            const t = 0.5 * T * (gl.x[i] + 1), w = 0.5 * T * gl.w[i];
            const th = thL - t * t;
            const den = Math.sin(thL) - Math.sin(th);
            const ratio = t < 1e-8 ? 2 / Math.sqrt(Math.cos(thL)) : (2 * t) / Math.sqrt(den);
            s += w * ratio * g(th);
        }
        return s; // = integral dtheta g / sqrt(sin thL - sin theta)
    };
    // length condition: 1 = integ(1) / sqrt(2 alpha)
    const thL = solveBracket((th) => integ(th, () => 1) / Math.sqrt(2 * alpha) - 1, 1e-9, Math.PI / 2 - 1e-9, 1e-14);
    const xL = Math.sqrt((2 * Math.sin(thL)) / alpha);
    const yL = integ(thL, (th) => Math.sin(th)) / Math.sqrt(2 * alpha);
    return { dv: yL, dh: 1 - xL, theta: thL };
}
export function gaussLegendre(n) {
    const x = [], w = [];
    for (let i = 1; i <= n; i++) {
        let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5)), pp = 0;
        for (let it = 0; it < 100; it++) {
            let p1 = 1, p2 = 0;
            for (let j = 1; j <= n; j++) {
                const p3 = p2;
                p2 = p1;
                p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
            }
            pp = (n * (z * p1 - p2)) / (z * z - 1);
            const z1 = z;
            z = z1 - p1 / pp;
            if (Math.abs(z - z1) < 1e-15)
                break;
        }
        x.push(z);
        w.push(2 / ((1 - z * z) * pp * pp));
    }
    return { x, w };
}
/**
 * Pseudo-rigid-body model of a cantilever with a vertical end force (Howell): characteristic radius
 * factor gamma, stiffness coefficient K_Theta. Valid while Theta stays below about 64 degrees for
 * gamma = 0.85 (Howell's stated range; beyond it the error grows).
 */
export function prbmCantilever(alpha, gamma = 0.85, KTheta = 2.65) {
    // K Theta = P gamma L cos(Theta), K = gamma KTheta EI / L  ->  KTheta Theta = alpha cos(Theta)
    const Theta = solveBracket((t) => KTheta * t - alpha * Math.cos(t), 0, Math.PI / 2);
    return { Theta, dv: gamma * Math.sin(Theta), dh: gamma * (1 - Math.cos(Theta)), theta: NaN };
}
