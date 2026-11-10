/** Open-addressing hash map from non-negative integer keys (< 2^53) to dense ids 0..n-1. */
export class IdMap {
    keys;
    ids;
    mask;
    size = 0;
    constructor(capacityHint = 1024) {
        let cap = 1024;
        while (cap < capacityHint * 2)
            cap *= 2;
        this.keys = new Float64Array(cap).fill(-1);
        this.ids = new Int32Array(cap);
        this.mask = cap - 1;
    }
    slot(key) {
        // mix the high and low halves (keys can exceed 2^32)
        const lo = key >>> 0, hi = (key / 4294967296) >>> 0;
        let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return h & this.mask;
    }
    get(key) {
        let s = this.slot(key);
        const keys = this.keys;
        for (;;) {
            const k = keys[s];
            if (k === key)
                return this.ids[s];
            if (k === -1)
                return -1;
            s = (s + 1) & this.mask;
        }
    }
    /** Returns the id for key, inserting `nextId` if absent (caller checks size change). */
    getOrInsert(key) {
        if (this.size * 2 >= this.keys.length)
            this.grow();
        let s = this.slot(key);
        const keys = this.keys;
        for (;;) {
            const k = keys[s];
            if (k === key)
                return this.ids[s];
            if (k === -1) {
                keys[s] = key;
                this.ids[s] = this.size;
                return this.size++;
            }
            s = (s + 1) & this.mask;
        }
    }
    grow() {
        const oldK = this.keys, oldI = this.ids;
        const cap = oldK.length * 2;
        this.keys = new Float64Array(cap).fill(-1);
        this.ids = new Int32Array(cap);
        this.mask = cap - 1;
        for (let i = 0; i < oldK.length; i++) {
            const k = oldK[i];
            if (k === -1)
                continue;
            let s = this.slot(k);
            while (this.keys[s] !== -1)
                s = (s + 1) & this.mask;
            this.keys[s] = k;
            this.ids[s] = oldI[i];
        }
    }
}
/** Growable typed arrays. */
export class F64List {
    data;
    length = 0;
    constructor(cap = 1024) { this.data = new Float64Array(cap); }
    push(v) { if (this.length === this.data.length)
        this.grow(); this.data[this.length++] = v; }
    ensure(n) { while (this.data.length < n)
        this.grow(); }
    grow() { const d = new Float64Array(this.data.length * 2); d.set(this.data); this.data = d; }
    view() { return this.data.subarray(0, this.length); }
}
export class I32List {
    data;
    length = 0;
    constructor(cap = 1024) { this.data = new Int32Array(cap); }
    push(v) { if (this.length === this.data.length)
        this.grow(); this.data[this.length++] = v; }
    grow() { const d = new Int32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    view() { return this.data.subarray(0, this.length); }
}
