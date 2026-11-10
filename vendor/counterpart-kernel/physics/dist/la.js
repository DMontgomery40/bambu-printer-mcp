/**
 * Small dense linear algebra: LU with partial pivoting for the beam engine (a few hundred unknowns),
 * vector helpers, and a deterministic PRNG for the robustness runs. Standard library only.
 */
/** Solve A x = b for a dense row-major n x n matrix (LU with partial pivoting). Returns null if singular.
 * When the matrix is banded (chains of beam elements), only the band is eliminated: O(n b^2) instead of O(n^3). */
export function luSolve(A, b, n) {
    let bl = 0, bu = 0;
    for (let i = 0; i < n; i++) {
        const r = i * n;
        for (let j = 0; j < i - bl; j++)
            if (A[r + j] !== 0) {
                bl = i - j;
                break;
            }
        for (let j = n - 1; j > i + bu; j--)
            if (A[r + j] !== 0) {
                bu = j - i;
                break;
            }
    }
    if (bl + bu < n / 3)
        return bandSolve(A, b, n, bl, bu);
    const a = A.slice(), x = b.slice();
    const piv = new Int32Array(n);
    for (let k = 0; k < n; k++) {
        let p = k, best = Math.abs(a[k * n + k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.abs(a[i * n + k]);
            if (v > best) {
                best = v;
                p = i;
            }
        }
        if (best < 1e-300)
            return null;
        piv[k] = p;
        if (p !== k) {
            for (let j = 0; j < n; j++) {
                const t = a[k * n + j];
                a[k * n + j] = a[p * n + j];
                a[p * n + j] = t;
            }
            const t = x[k];
            x[k] = x[p];
            x[p] = t;
        }
        const inv = 1 / a[k * n + k];
        for (let i = k + 1; i < n; i++) {
            const f = a[i * n + k] * inv;
            if (f === 0)
                continue;
            a[i * n + k] = f;
            const ri = i * n, rk = k * n;
            for (let j = k + 1; j < n; j++)
                a[ri + j] -= f * a[rk + j];
            x[i] -= f * x[k];
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        for (let j = i + 1; j < n; j++)
            s -= a[i * n + j] * x[j];
        x[i] = s / a[i * n + i];
    }
    return x;
}
/** Banded LU with partial pivoting on dense storage: pivoting widens the upper band to bu + bl. */
function bandSolve(A, b, n, bl, bu) {
    const a = A.slice(), x = b.slice(), w = bu + bl;
    for (let k = 0; k < n; k++) {
        const iEnd = Math.min(n - 1, k + bl), jEnd = Math.min(n - 1, k + w);
        let p = k, best = Math.abs(a[k * n + k]);
        for (let i = k + 1; i <= iEnd; i++) {
            const v = Math.abs(a[i * n + k]);
            if (v > best) {
                best = v;
                p = i;
            }
        }
        if (best < 1e-300)
            return null;
        if (p !== k) {
            for (let j = k; j <= jEnd; j++) {
                const t = a[k * n + j];
                a[k * n + j] = a[p * n + j];
                a[p * n + j] = t;
            }
            const t = x[k];
            x[k] = x[p];
            x[p] = t;
        }
        const inv = 1 / a[k * n + k];
        for (let i = k + 1; i <= iEnd; i++) {
            const f = a[i * n + k] * inv;
            if (f === 0)
                continue;
            const ri = i * n, rk = k * n;
            for (let j = k + 1; j <= jEnd; j++)
                a[ri + j] -= f * a[rk + j];
            x[i] -= f * x[k];
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        const jEnd = Math.min(n - 1, i + w);
        for (let j = i + 1; j <= jEnd; j++)
            s -= a[i * n + j] * x[j];
        x[i] = s / a[i * n + i];
    }
    return x;
}
export function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
export function norm(a) { return Math.sqrt(dot(a, a)); }
/** Mulberry32: tiny deterministic PRNG (seeded), so robustness runs repeat exactly. */
export function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Brent-free robust root bracket solve by bisection + secant safeguard. f(a), f(b) must differ in sign. */
export function solveBracket(f, a, b, tol = 1e-12, maxIt = 200) {
    let fa = f(a), fb = f(b);
    if (fa === 0)
        return a;
    if (fb === 0)
        return b;
    if (fa * fb > 0)
        throw new Error(`solveBracket: no sign change on [${a}, ${b}] (${fa}, ${fb})`);
    for (let i = 0; i < maxIt; i++) {
        // secant guess, fall back to bisection if outside the bracket
        let m = b - fb * (b - a) / (fb - fa);
        if (!(m > Math.min(a, b) && m < Math.max(a, b)) || i % 3 === 2)
            m = (a + b) / 2;
        const fm = f(m);
        if (Math.abs(fm) === 0 || Math.abs(b - a) < tol)
            return m;
        if (fa * fm < 0) {
            b = m;
            fb = fm;
        }
        else {
            a = m;
            fa = fm;
        }
    }
    return (a + b) / 2;
}
export const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
