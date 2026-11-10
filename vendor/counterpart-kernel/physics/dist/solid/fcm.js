/**
 * Cut cells ("finite cell" integration): a voxel the part's surface passes through gets a stiffness matrix
 * integrated over the material inside it, not the full cube's matrix scaled by its fill fraction.
 *
 * Why: a 2.4 mm wall on 1 mm voxels spans three partly filled cells. Scaling each cell's full-cube matrix by
 * its fill smears the wall over 3 mm and overstates its bending stiffness by up to about 40% (the second
 * moment of the smeared material), by an amount that depends on how the wall happens to sit against the
 * grid. That is why round 1's thin parts moved 9-18% in deflection between resolutions.
 *
 * How, cheaply: on the unit cube the integrand B^T C B (and the incompatible-mode blocks) is a polynomial of
 * degree <= 2 in each coordinate. So its integral against any material indicator w is exact as
 *   K(w) = sum over the 27 nodes q of {-1, 0, 1}^3 of  mu_q * (B^T C B)(xi_q),   mu_q = (1/8) int w L_q dxi,
 * with L_q the tensor quadratic Lagrange polynomials. Only the 27 "Lagrange moments" mu_q depend on the cell;
 * they come from 4 x 4 x 4 sub-cells, each with a fill fraction from the distance function at its centre and
 * exact Gauss-integrated weights. A full cell reproduces the standard matrix exactly.
 *
 * Wilson's incompatible modes are kept in cut cells with Taylor's correction (the modes' mean strain over the
 * material is removed), so a constant strain still gives zero bubble amplitude (the patch test holds with
 * partial material).
 */
const S = 4; // sub-cells per axis
const LAG = (k, x) => (k === 0 ? 0.5 * x * (x - 1) : k === 1 ? 1 - x * x : 0.5 * x * (x + 1)); // nodes -1, 0, 1
/** Strain-displacement rows at (xi, eta, zeta) for the unit cube (dN/dx = 2 dN/dxi), 6 x 24. */
function Bstd(xi, et, ze) {
    const B = new Float64Array(6 * 24);
    for (let a = 0; a < 8; a++) {
        const sx = (a & 1) ? 1 : -1, sy = (a & 2) ? 1 : -1, sz = (a & 4) ? 1 : -1;
        const dx = 2 * (sx * (1 + sy * et) * (1 + sz * ze)) / 8;
        const dy = 2 * ((1 + sx * xi) * sy * (1 + sz * ze)) / 8;
        const dz = 2 * ((1 + sx * xi) * (1 + sy * et) * sz) / 8;
        fill(B, 24, 3 * a, dx, dy, dz);
    }
    return B;
}
function Binc(xi, et, ze) {
    const G = new Float64Array(6 * 9);
    const d = [[-4 * xi, 0, 0], [0, -4 * et, 0], [0, 0, -4 * ze]];
    for (let m = 0; m < 3; m++)
        fill(G, 9, 3 * m, d[m][0], d[m][1], d[m][2]);
    return G;
}
function fill(B, cols, c, dx, dy, dz) {
    B[c] = dx;
    B[cols + c + 1] = dy;
    B[2 * cols + c + 2] = dz;
    B[3 * cols + c + 1] = dz;
    B[3 * cols + c + 2] = dy;
    B[4 * cols + c] = dz;
    B[4 * cols + c + 2] = dx;
    B[5 * cols + c] = dy;
    B[5 * cols + c + 1] = dx;
}
/** A^T C D for A 6 x ca, D 6 x cd */
function atcd(A, ca, C, D, cd) {
    const CD = new Float64Array(6 * cd), out = new Float64Array(ca * cd);
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < cd; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += C[i * 6 + k] * D[k * cd + j];
            CD[i * cd + j] = s;
        }
    for (let i = 0; i < ca; i++)
        for (let j = 0; j < cd; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += A[k * ca + i] * CD[k * cd + j];
            out[i * cd + j] = s;
        }
    return out;
}
export function fcmTables(C) {
    const P = [], Q = [], R = [], Bq = [], Gq = [];
    for (let q = 0; q < 27; q++) {
        const xi = (q % 3) - 1, et = (Math.floor(q / 3) % 3) - 1, ze = Math.floor(q / 9) - 1;
        const B = Bstd(xi, et, ze), G = Binc(xi, et, ze);
        P.push(atcd(B, 24, C, B, 24));
        Q.push(atcd(B, 24, C, G, 9));
        R.push(atcd(G, 9, C, G, 9));
        Bq.push(B);
        Gq.push(G);
    }
    // sub-cell weights: 2-point Gauss per axis inside each sub-cell (exact for the quadratic L_q)
    const gp = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const W = new Float64Array(S * S * S * 27), centres = new Float64Array(S * S * S * 3);
    const one = []; // per sub-interval and lagrange index: (1/2) int L_k over the sub-interval of [-1,1]
    for (let s = 0; s < S; s++) {
        const a = -1 + (2 * s) / S, b = a + 2 / S, row = [];
        for (let k = 0; k < 3; k++) {
            let v = 0;
            for (const g of gp)
                v += LAG(k, 0.5 * (a + b) + 0.5 * (b - a) * g) * 0.5 * (b - a);
            row.push(v / 2);
        }
        one.push(row);
    }
    for (let sz = 0; sz < S; sz++)
        for (let sy = 0; sy < S; sy++)
            for (let sx = 0; sx < S; sx++) {
                const s = sx + S * (sy + S * sz);
                for (let q = 0; q < 27; q++)
                    W[27 * s + q] = one[sx][q % 3] * one[sy][Math.floor(q / 3) % 3] * one[sz][Math.floor(q / 9)];
                centres[3 * s] = (sx + 0.5) / S;
                centres[3 * s + 1] = (sy + 0.5) / S;
                centres[3 * s + 2] = (sz + 0.5) / S;
            }
    return { C, P, Q, R, Bq, Gq, W, centres };
}
export const SUB = S;
/**
 * Stiffness of one cut cell (unit cube; multiply by h), from its sub-cell fills f (S^3 values in [0, 1]).
 * Returns the condensed 24 x 24 matrix and X = Kaa^-1 Kau (9 x 24) for recovering the bubble amplitudes
 * (alpha = -X u), the Taylor mean of the bubble strains (6 x 9) and the fill.
 */
const sMu = new Float64Array(27), sKua = new Float64Array(216), sKaa = new Float64Array(81), sBm = new Float64Array(144), sGm = new Float64Array(54), sCG = new Float64Array(54), sL = new Float64Array(81), sY = new Float64Array(9);
export function cutCellMatrix(T, f, out, X, Gbar) {
    const mu = sMu, Kua = sKua, Kaa = sKaa, Bm = sBm, Gm = sGm, CG = sCG;
    mu.fill(0);
    const nS = S * S * S, W = T.W;
    for (let s = 0; s < nS; s++) {
        const fs = f[s];
        if (fs <= 0)
            continue;
        const o = 27 * s;
        for (let q = 0; q < 27; q++)
            mu[q] += fs * W[o + q];
    }
    let m0 = 0;
    for (let q = 0; q < 27; q++)
        m0 += mu[q];
    out.fill(0);
    Kua.fill(0);
    Kaa.fill(0);
    Bm.fill(0);
    Gm.fill(0);
    for (let q = 0; q < 27; q++) {
        const w = mu[q];
        if (Math.abs(w) < 1e-14)
            continue;
        const P = T.P[q], Q = T.Q[q], R = T.R[q], B = T.Bq[q], G = T.Gq[q];
        for (let i = 0; i < 24; i++) {
            const r = 24 * i;
            for (let j = i; j < 24; j++)
                out[r + j] += w * P[r + j];
        }
        for (let i = 0; i < 216; i++)
            Kua[i] += w * Q[i];
        for (let i = 0; i < 81; i++)
            Kaa[i] += w * R[i];
        for (let i = 0; i < 144; i++)
            Bm[i] += w * B[i];
        for (let i = 0; i < 54; i++)
            Gm[i] += w * G[i];
    }
    for (let i = 0; i < 54; i++)
        Gbar[i] = m0 > 0 ? Gm[i] / m0 : 0;
    const C = T.C;
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < 9; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += C[i * 6 + k] * Gbar[k * 9 + j];
            CG[i * 9 + j] = s;
        }
    for (let i = 0; i < 24; i++)
        for (let j = 0; j < 9; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += Bm[k * 24 + i] * CG[k * 9 + j];
            Kua[i * 9 + j] -= s;
        }
    for (let i = 0; i < 9; i++)
        for (let j = 0; j < 9; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += Gbar[k * 9 + i] * CG[k * 9 + j];
            Kaa[i * 9 + j] -= m0 * s;
        }
    let tr = 0;
    for (let i = 0; i < 9; i++)
        tr += Kaa[10 * i];
    for (let i = 0; i < 9; i++)
        Kaa[10 * i] += 1e-9 * tr + 1e-30;
    // Cholesky of Kaa (9 x 9), then X = Kaa^-1 Kau column by column
    const L = sL;
    L.fill(0);
    for (let j = 0; j < 9; j++) {
        let d = Kaa[9 * j + j];
        for (let k = 0; k < j; k++)
            d -= L[9 * j + k] * L[9 * j + k];
        d = Math.sqrt(Math.max(d, 1e-300));
        L[9 * j + j] = d;
        for (let i = j + 1; i < 9; i++) {
            let v = Kaa[9 * i + j];
            for (let k = 0; k < j; k++)
                v -= L[9 * i + k] * L[9 * j + k];
            L[9 * i + j] = v / d;
        }
    }
    const y = sY;
    for (let c = 0; c < 24; c++) {
        for (let i = 0; i < 9; i++) {
            let v = Kua[c * 9 + i];
            for (let k = 0; k < i; k++)
                v -= L[9 * i + k] * y[k];
            y[i] = v / L[9 * i + i];
        }
        for (let i = 8; i >= 0; i--) {
            let v = y[i];
            for (let k = i + 1; k < 9; k++)
                v -= L[9 * k + i] * y[k];
            y[i] = v / L[9 * i + i];
        }
        for (let i = 0; i < 9; i++)
            X[i * 24 + c] = y[i];
    }
    for (let i = 0; i < 24; i++)
        for (let j = i; j < 24; j++) {
            let s = 0;
            for (let k = 0; k < 9; k++)
                s += Kua[i * 9 + k] * X[k * 24 + j];
            const v = out[24 * i + j] - s;
            out[24 * i + j] = v;
            out[24 * j + i] = v;
        }
    return m0;
}
/** Strain (times h) at (xi, eta, zeta) of a cell with nodal displacements ue and bubble amplitudes alpha. */
export function cellStrain(xi, et, ze, ue, alpha, Gbar, out) {
    const B = Bstd(xi, et, ze);
    for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let a = 0; a < 24; a++)
            s += B[i * 24 + a] * ue[a];
        out[i] = s;
    }
    if (alpha) {
        const G = Binc(xi, et, ze);
        for (let i = 0; i < 6; i++) {
            let s = 0;
            for (let m = 0; m < 9; m++)
                s += (G[i * 9 + m] - (Gbar ? Gbar[i * 9 + m] : 0)) * alpha[m];
            out[i] += s;
        }
    }
}
