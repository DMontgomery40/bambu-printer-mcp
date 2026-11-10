import { writePNG } from "./io.js";
import { textPolylines } from "./font.js";
export const VIEWS = ["front", "back", "left", "right", "top", "bottom"];
// screen axes (right, up) and view direction (into the screen) for each view
const AXES = {
    front: { r: [1, 0, 0], u: [0, 0, 1], d: [0, 1, 0] },
    back: { r: [-1, 0, 0], u: [0, 0, 1], d: [0, -1, 0] },
    left: { r: [0, -1, 0], u: [0, 0, 1], d: [1, 0, 0] },
    right: { r: [0, 1, 0], u: [0, 0, 1], d: [-1, 0, 0] },
    top: { r: [1, 0, 0], u: [0, 1, 0], d: [0, 0, -1] },
    bottom: { r: [1, 0, 0], u: [0, -1, 0], d: [0, 0, 1] },
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function renderView(mesh, view, size = 420, scale, centre) {
    const { r, u, d } = AXES[view];
    const p = mesh.positions, idx = mesh.indices;
    const b = mesh.bounds();
    const c = centre ?? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const s = scale ?? (size * 0.86) / ext;
    const w = size, h = size;
    const depth = new Float64Array(w * h).fill(Infinity);
    const nrm = new Float32Array(w * h * 3);
    const shade = new Float32Array(w * h);
    // light from the viewer's upper left, slightly in front
    const L = [-0.45 * r[0] + 0.6 * u[0] - 0.65 * d[0], -0.45 * r[1] + 0.6 * u[1] - 0.65 * d[1], -0.45 * r[2] + 0.6 * u[2] - 0.65 * d[2]];
    const ll = Math.hypot(L[0], L[1], L[2]);
    L[0] /= ll;
    L[1] /= ll;
    L[2] /= ll;
    const sx = new Float64Array(3), sy = new Float64Array(3), sz = new Float64Array(3);
    for (let t = 0; t < idx.length; t += 3) {
        const vs = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
        const A = [p[vs[0]], p[vs[0] + 1], p[vs[0] + 2]], B = [p[vs[1]], p[vs[1] + 1], p[vs[1] + 2]], C = [p[vs[2]], p[vs[2] + 1], p[vs[2] + 2]];
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const nl = Math.hypot(n[0], n[1], n[2]);
        if (nl === 0)
            continue;
        n[0] /= nl;
        n[1] /= nl;
        n[2] /= nl;
        if (dot(n, d) >= 0)
            continue; // back face
        const lum = 0.32 + 0.68 * Math.max(0, dot(n, L));
        for (let k = 0; k < 3; k++) {
            const q = [p[vs[k]] - c[0], p[vs[k] + 1] - c[1], p[vs[k] + 2] - c[2]];
            sx[k] = w / 2 + dot(q, r) * s;
            sy[k] = h / 2 - dot(q, u) * s;
            sz[k] = dot(q, d);
        }
        const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2]))), x1 = Math.min(w - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
        const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2]))), y1 = Math.min(h - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
        const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        if (area === 0)
            continue;
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
                const w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0)
                    continue;
                const z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
                const i = y * w + x;
                if (z < depth[i]) {
                    depth[i] = z;
                    shade[i] = lum;
                    nrm[3 * i] = n[0];
                    nrm[3 * i + 1] = n[1];
                    nrm[3 * i + 2] = n[2];
                }
            }
    }
    const rgb = new Uint8Array(w * h * 3);
    const bg = [246, 247, 249], base = [118, 148, 186];
    const dz = 1.2 / s; // depth jump worth outlining: ~1.2 px of model size
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            let col;
            if (depth[i] === Infinity)
                col = bg;
            else {
                const k = shade[i];
                col = [base[0] * k + 40 * (1 - k), base[1] * k + 44 * (1 - k), base[2] * k + 52 * (1 - k)];
            }
            // edges: compare with right and lower neighbours
            let edge = false;
            for (const [ox, oy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
                const X = x + ox, Y = y + oy;
                if (X < 0 || Y < 0 || X >= w || Y >= h)
                    continue;
                const j = Y * w + X;
                const fi = depth[i] !== Infinity, fj = depth[j] !== Infinity;
                if (fi !== fj) {
                    if (fi)
                        edge = true;
                    continue;
                }
                if (!fi)
                    continue;
                if (Math.abs(depth[i] - depth[j]) > dz && depth[i] < depth[j]) {
                    edge = true;
                    continue;
                }
                const nd = nrm[3 * i] * nrm[3 * j] + nrm[3 * i + 1] * nrm[3 * j + 1] + nrm[3 * i + 2] * nrm[3 * j + 2];
                if (nd < 0.82 && (x + y) % 1 === 0 && (ox > 0 || oy > 0))
                    edge = true;
            }
            if (edge)
                col = [28, 32, 40];
            rgb[3 * i] = col[0];
            rgb[3 * i + 1] = col[1];
            rgb[3 * i + 2] = col[2];
        }
    return { w, h, rgb };
}
function drawLabel(img, label, x0, y0, height = 14) {
    const { lines } = textPolylines(label.toUpperCase(), height, 1.6);
    const put = (x, y) => {
        for (let dy = -1; dy <= 0; dy++)
            for (let dx = -1; dx <= 0; dx++) {
                const X = Math.round(x + dx), Y = Math.round(y + dy);
                if (X < 0 || Y < 0 || X >= img.w || Y >= img.h)
                    continue;
                const i = (Y * img.w + X) * 3;
                img.rgb[i] = 40;
                img.rgb[i + 1] = 44;
                img.rgb[i + 2] = 52;
            }
    };
    for (const pl of lines)
        for (let k = 0; k + 1 < pl.length || (pl.length === 1 && k === 0); k++) {
            const a = pl[k], b2 = pl[Math.min(k + 1, pl.length - 1)];
            const n = Math.max(1, Math.ceil(Math.hypot(b2[0] - a[0], b2[1] - a[1]) * 2));
            for (let i = 0; i <= n; i++)
                put(x0 + a[0] + (b2[0] - a[0]) * (i / n), y0 + height - (a[1] + (b2[1] - a[1]) * (i / n)));
            if (pl.length === 1)
                break;
        }
}
/** Renders all six views at one common scale and a 3 x 2 contact sheet; returns PNG buffers. */
export function renderSheet(mesh, size = 420) {
    const b = mesh.bounds();
    const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const s = (size * 0.86) / ext;
    const imgs = VIEWS.map((v) => renderView(mesh, v, size, s));
    const views = Object.fromEntries(VIEWS.map((v, i) => [v, writePNG(imgs[i].w, imgs[i].h, imgs[i].rgb)]));
    const W = size * 3, H = size * 2;
    const sheet = { w: W, h: H, rgb: new Uint8Array(W * H * 3).fill(255) };
    imgs.forEach((im, k) => {
        const ox = (k % 3) * size, oy = Math.floor(k / 3) * size;
        for (let y = 0; y < im.h; y++)
            sheet.rgb.set(im.rgb.subarray(y * im.w * 3, (y + 1) * im.w * 3), ((oy + y) * W + ox) * 3);
        drawLabel(sheet, VIEWS[k], ox + 10, oy + 8);
        // thin separators
        for (let y = oy; y < oy + size; y++) {
            const i = (y * W + ox) * 3;
            sheet.rgb[i] = sheet.rgb[i + 1] = sheet.rgb[i + 2] = 210;
        }
        for (let x = ox; x < ox + size; x++) {
            const i = (oy * W + x) * 3;
            sheet.rgb[i] = sheet.rgb[i + 1] = sheet.rgb[i + 2] = 210;
        }
    });
    return { views, sheet: writePNG(W, H, sheet.rgb) };
}
