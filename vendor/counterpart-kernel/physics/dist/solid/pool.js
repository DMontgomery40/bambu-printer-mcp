/**
 * A small pool of worker threads that applies an assembled stencil operator in parallel: each worker owns a
 * contiguous range of node rows and writes them straight into a shared output (rows are independent, so
 * there is no summation step). Shared memory, Atomics.wait/notify for the hand-off; workers are created once
 * and reused. Size: PHYSICS_THREADS, default min(6, cores/2 - 1), so the engine with its main thread uses at
 * most half the machine.
 */
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
const nWorkers = (() => {
    const env = Number(process.env.PHYSICS_THREADS);
    if (Number.isFinite(env) && env >= 0)
        return Math.floor(env);
    return Math.max(0, Math.min(6, Math.floor(cpus().length / 2) - 1));
})();
let workers = [];
let ctrl = null; // [generation, done, stencilId]
let nextId = 1;
export function poolSize() { return nWorkers; }
function ensure() {
    if (workers.length || nWorkers === 0)
        return;
    ctrl = new Int32Array(new SharedArrayBuffer(4 * 4));
    for (let w = 0; w < nWorkers; w++) {
        const wk = new Worker(new URL("./worker.js", import.meta.url), { workerData: { ctrl: ctrl.buffer, index: w, count: nWorkers } });
        wk.unref();
        workers.push(wk);
    }
}
/** Copy a stencil into shared memory and hand it to the workers. */
export function shareStencil(nbr, val, nNode) {
    if (nWorkers === 0)
        return null;
    ensure();
    const sNbr = new Int32Array(new SharedArrayBuffer(nbr.byteLength));
    sNbr.set(nbr);
    const sVal = val instanceof Float32Array ? new Float32Array(new SharedArrayBuffer(val.byteLength)) : new Float64Array(new SharedArrayBuffer(val.byteLength));
    sVal.set(val);
    const t = { nbr: sNbr, val: sVal, X: new Float64Array(new SharedArrayBuffer(24 * nNode)), Y: new Float64Array(new SharedArrayBuffer(24 * nNode)), F: new Uint8Array(new SharedArrayBuffer(3 * nNode)), nNode, id: nextId++ };
    for (const wk of workers)
        wk.postMessage({ id: t.id, nbr: sNbr.buffer, val: sVal.buffer, f32: val instanceof Float32Array, X: t.X.buffer, Y: t.Y.buffer, F: t.F.buffer, nNode });
    return t;
}
/** y = (D A D + (I - D)) x, D zeroing `fixed`: the workers mask and fill the fixed rows themselves. */
export function parallelApply(t, x, fixed, y) {
    if (t.lastFixed !== fixed) {
        t.F.set(fixed);
        t.lastFixed = fixed;
    }
    t.X.set(x);
    Atomics.store(ctrl, 1, 0);
    Atomics.store(ctrl, 2, t.id);
    Atomics.add(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    while (Atomics.load(ctrl, 1) < nWorkers)
        Atomics.wait(ctrl, 1, Atomics.load(ctrl, 1), 50);
    y.set(t.Y.subarray(0, y.length));
}
