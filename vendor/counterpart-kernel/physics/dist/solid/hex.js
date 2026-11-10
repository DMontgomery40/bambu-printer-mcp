/**
 * Material matrices and the voxel element.
 *
 * Material: transversely isotropic, symmetry axis = print direction (layers are the planes normal to it).
 * Voigt order xx, yy, zz, yz, xz, xy with engineering shear strains. In the print frame (axis 3 = print
 * direction): E1 = E2 = in-layer modulus, E3 = across-layer modulus, nu12 in-layer Poisson ratio, nu31 =
 * strain in-plane per strain along the axis (nu13 / E1 = nu31 / E3), G13 = shear modulus of the layer
 * planes, G12 = E1 / (2 (1 + nu12)).
 *
 * Element: the 8-node hexahedron on a cube of side h, either standard trilinear (2x2x2 Gauss) or with
 * Wilson's nine incompatible bubble modes condensed out (exact pure bending of a cube; on a uniform voxel
 * grid every element is the same cube, so the condensation is done once per material, not per element).
 * Local node a = i + 2 j + 4 k with (i, j, k) in {0, 1}; dofs 3 a + {0, 1, 2}.
 */
import { luSolve } from "../la.js";
export function isotropic(E, nu) {
    return { E1: E, E3: E, nu12: nu, nu31: nu, G13: E / (2 * (1 + nu)) };
}
/** 6x6 stiffness (row-major) in the print frame. */
export function stiffnessPrintFrame(m) {
    const { E1, E3, nu12, nu31, G13 } = m;
    const nu13 = (nu31 * E1) / E3;
    const S = new Float64Array(36);
    S[0] = 1 / E1;
    S[1] = -nu12 / E1;
    S[2] = -nu31 / E3;
    S[6] = -nu12 / E1;
    S[7] = 1 / E1;
    S[8] = -nu31 / E3;
    S[12] = -nu13 / E1;
    S[13] = -nu13 / E1;
    S[14] = 1 / E3;
    S[21] = 1 / G13;
    S[28] = 1 / G13;
    S[35] = (2 * (1 + nu12)) / E1;
    return invert6(S);
}
function invert6(S) {
    const C = new Float64Array(36);
    for (let j = 0; j < 6; j++) {
        const e = new Float64Array(6);
        e[j] = 1;
        const x = luSolve(S, e, 6);
        for (let i = 0; i < 6; i++)
            C[i * 6 + j] = x[i];
    }
    // symmetrize round-off
    for (let i = 0; i < 6; i++)
        for (let j = i + 1; j < 6; j++) {
            const v = (C[i * 6 + j] + C[j * 6 + i]) / 2;
            C[i * 6 + j] = v;
            C[j * 6 + i] = v;
        }
    return C;
}
/**
 * Stiffness in the world frame for a print direction d (unit vector, world coordinates). The print frame's
 * axis 3 is d; the in-plane axes are arbitrary (transverse isotropy makes them irrelevant).
 */
export function stiffnessWorld(m, d) {
    const Cp = stiffnessPrintFrame(m);
    const n = Math.hypot(...d);
    const e3 = d.map((v) => v / n);
    const ref = Math.abs(e3[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const e1 = normalize(cross(ref, e3)), e2 = cross(e3, e1);
    // R maps print-frame components to world: world = R p, columns e1, e2, e3
    const R = [[e1[0], e2[0], e3[0]], [e1[1], e2[1], e3[1]], [e1[2], e2[2], e3[2]]];
    const M = bond(R);
    // C_world = M C_p M^T (stress Bond matrix)
    const T = new Float64Array(36), Cw = new Float64Array(36);
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += M[i][k] * Cp[k * 6 + j];
            T[i * 6 + j] = s;
        }
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += T[i * 6 + k] * M[j][k];
            Cw[i * 6 + j] = s;
        }
    return Cw;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
/** Bond stress transformation for sigma_world = M sigma_print, Voigt xx yy zz yz xz xy. */
function bond(R) {
    const pairs = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
    const M = [];
    for (let I = 0; I < 6; I++) {
        const [i, j] = pairs[I];
        const row = [];
        for (let J = 0; J < 6; J++) {
            const [k, l] = pairs[J];
            row.push(J < 3 ? R[i][k] * R[j][l] : R[i][k] * R[j][l] + R[i][l] * R[j][k]);
        }
        M.push(row);
    }
    return M;
}
/** Strain-displacement rows at a point (xi, eta, zeta) in [-1,1]^3 for a cube of side 1 (dN/dx = 2 dN/dxi). */
function Bstd(xi, et, ze) {
    const B = new Float64Array(6 * 24);
    for (let a = 0; a < 8; a++) {
        const sx = (a & 1) ? 1 : -1, sy = (a & 2) ? 1 : -1, sz = (a & 4) ? 1 : -1;
        const dx = 2 * (sx * (1 + sy * et) * (1 + sz * ze)) / 8;
        const dy = 2 * ((1 + sx * xi) * sy * (1 + sz * ze)) / 8;
        const dz = 2 * ((1 + sx * xi) * (1 + sy * et) * sz) / 8;
        fillB(B, 24, 3 * a, dx, dy, dz);
    }
    return B;
}
function fillB(B, cols, c, dx, dy, dz) {
    B[0 * cols + c] = dx;
    B[1 * cols + c + 1] = dy;
    B[2 * cols + c + 2] = dz;
    B[3 * cols + c + 1] = dz;
    B[3 * cols + c + 2] = dy;
    B[4 * cols + c] = dz;
    B[4 * cols + c + 2] = dx;
    B[5 * cols + c] = dy;
    B[5 * cols + c + 1] = dx;
}
/** Incompatible modes (1 - xi^2), (1 - eta^2), (1 - zeta^2) for each displacement component: 9 columns. */
function Binc(xi, et, ze) {
    const G = new Float64Array(6 * 9);
    const d = [[-2 * xi * 2, 0, 0], [0, -2 * et * 2, 0], [0, 0, -2 * ze * 2]];
    for (let mode = 0; mode < 3; mode++)
        fillB(G, 9, 3 * mode, d[mode][0], d[mode][1], d[mode][2]);
    return G;
}
const GP = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
function btcb(A, ca, Bm, Cm, Dm, cd, w) {
    // A (ca x cd) += w * B^T C D, B is 6 x ca, D is 6 x cd
    const CD = new Float64Array(6 * cd);
    for (let i = 0; i < 6; i++)
        for (let j = 0; j < cd; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += Cm[i * 6 + k] * Dm[k * cd + j];
            CD[i * cd + j] = s;
        }
    for (let i = 0; i < ca; i++)
        for (let j = 0; j < cd; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++)
                s += Bm[k * ca + i] * CD[k * cd + j];
            A[i * cd + j] += w * s;
        }
}
/** Element stiffness for a unit cube (multiply by h for a cube of side h). */
export function hexStiffness(C, incompatible) {
    const w = 1 / 8; // det J for the unit cube, Gauss weights 1
    const Kuu = new Float64Array(24 * 24), Kua = new Float64Array(24 * 9), Kaa = new Float64Array(81);
    for (const xi of GP)
        for (const et of GP)
            for (const ze of GP) {
                const B = Bstd(xi, et, ze);
                btcb(Kuu, 24, B, C, B, 24, w);
                if (incompatible) {
                    const G = Binc(xi, et, ze);
                    btcb(Kua, 24, B, C, G, 9, w);
                    btcb(Kaa, 9, G, C, G, 9, w);
                }
            }
    if (!incompatible)
        return Kuu;
    // condense: K = Kuu - Kua Kaa^-1 Kau
    const X = new Float64Array(9 * 24); // Kaa^-1 Kau
    for (let j = 0; j < 24; j++) {
        const col = new Float64Array(9);
        for (let i = 0; i < 9; i++)
            col[i] = Kua[j * 9 + i];
        const x = luSolve(Kaa, col, 9);
        for (let i = 0; i < 9; i++)
            X[i * 24 + j] = x[i];
    }
    const K = Kuu.slice();
    for (let i = 0; i < 24; i++)
        for (let j = 0; j < 24; j++) {
            let s = 0;
            for (let k = 0; k < 9; k++)
                s += Kua[i * 9 + k] * X[k * 24 + j];
            K[i * 24 + j] -= s;
        }
    for (let i = 0; i < 24; i++)
        for (let j = i + 1; j < 24; j++) {
            const v = (K[i * 24 + j] + K[j * 24 + i]) / 2;
            K[i * 24 + j] = v;
            K[j * 24 + i] = v;
        }
    return K;
}
/** Centre strain operator (6 x 24) for a cube of side h: strain = Bc u / h. Bubble modes vanish in derivative at the centre. */
export function centreB() { return Bstd(0, 0, 0); }
/** Strain operator at a corner node of the element (for nodal stress recovery); xi etc. in {-1, 1}. */
export function cornerB(a) { return Bstd((a & 1) ? 1 : -1, (a & 2) ? 1 : -1, (a & 4) ? 1 : -1); }
