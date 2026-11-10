/** Worker side of the stencil operator pool (see pool.ts): rows of y = A x for a slice of the nodes. */
import { workerData, parentPort, receiveMessageOnPort } from "node:worker_threads";
const ctrl = new Int32Array(workerData.ctrl);
const index = workerData.index, count = workerData.count;
const sts = new Map();
let gen = 0;
for (;;) {
    Atomics.wait(ctrl, 0, gen);
    gen = Atomics.load(ctrl, 0);
    const id = Atomics.load(ctrl, 2);
    while (!sts.has(id)) {
        const m = receiveMessageOnPort(parentPort);
        if (m) {
            const d = m.message;
            sts.set(d.id, { nbr: new Int32Array(d.nbr), val: d.f32 ? new Float32Array(d.val) : new Float64Array(d.val), X: new Float64Array(d.X), Y: new Float64Array(d.Y), F: new Uint8Array(d.F), nNode: d.nNode });
            // keep the few most recent stencils (a solve, its coarse check, a zoom)
            if (sts.size > 6)
                sts.delete(sts.keys().next().value);
        }
        else
            Atomics.wait(ctrl, 3, 0, 1);
    }
    const t = sts.get(id);
    const r0 = Math.floor((t.nNode * index) / count), r1 = Math.floor((t.nNode * (index + 1)) / count);
    const { nbr, val, X: xm, Y: y, F: fx } = t;
    for (let A = r0; A < r1; A++) {
        let y0 = 0, y1 = 0, y2 = 0;
        const nb = 27 * A, vb = 243 * A;
        for (let s = 0; s < 27; s++) {
            const B = nbr[nb + s];
            if (B < 0)
                continue;
            const o = vb + 9 * s, b3 = 3 * B, x0 = fx[b3] ? 0 : xm[b3], x1 = fx[b3 + 1] ? 0 : xm[b3 + 1], x2 = fx[b3 + 2] ? 0 : xm[b3 + 2];
            y0 += val[o] * x0 + val[o + 1] * x1 + val[o + 2] * x2;
            y1 += val[o + 3] * x0 + val[o + 4] * x1 + val[o + 5] * x2;
            y2 += val[o + 6] * x0 + val[o + 7] * x1 + val[o + 8] * x2;
        }
        const a3 = 3 * A;
        y[a3] = fx[a3] ? xm[a3] : y0;
        y[a3 + 1] = fx[a3 + 1] ? xm[a3 + 1] : y1;
        y[a3 + 2] = fx[a3 + 2] ? xm[a3 + 2] : y2;
    }
    Atomics.add(ctrl, 1, 1);
    Atomics.notify(ctrl, 1);
}
