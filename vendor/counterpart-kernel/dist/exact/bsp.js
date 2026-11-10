/**
 * Exact-plane polyhedral CSG with BSP trees. Poly3 is the solid type the primitives build; its booleans
 * and meshing run on the exact plane-based engine in pbsp.ts (exact predicates, no tolerances). The float
 * BSP below is round 1's engine, kept behind ENGINE for before/after measurements. Round 1's notes on it:
 *
 * Solids are closed polyhedra whose planar faces are exact; curved primitives are faceted when they are
 * created, to the same chord tolerance build123d uses for its STL (0.01 mm). Booleans are the
 * polygon-clipping form of BSP set operations (Thibault & Naylor 1987, "Set operations on polyhedra
 * using binary space partitioning trees"; Naylor, Amanatides & Thibault 1990), in the arrangement
 * popularised by Evan Wallace's csg.js: clip each solid's polygons by the other's tree, invert for
 * subtraction. Floating point with an epsilon, so it is NOT robust in general; the output has
 * T-junctions, which `toMesh` repairs by splitting edges at vertices lying on them, then ear-clips each
 * convex face into triangles.
 */
import { Mesh } from "../kernel/mesh.js";
import { PSolid } from "./pbsp.js";
/**
 * Which boolean engine Poly3 uses: the exact plane-based BSP with exact predicates (pbsp.ts, the default)
 * or round 1's float BSP below (KERNEL_PBSP=0, kept for before/after measurements).
 */
export const ENGINE = { exact: process.env.KERNEL_PBSP !== "0" };
/** Coplanarity tolerance of the plane classification (mm). Must not exceed the weld tolerance. */
const EPS = 1e-6;
/** Input grid: every primitive vertex is snapped to multiples of 2^-17 mm (exactly representable). */
export const SNAP = 2 ** -17;
// Snapping input vertices independently makes faces non-planar and breaks the BSP (measured): disabled.
export const snap = (v) => v;
/**
 * Perturbed retry: when an exact result fails its own check, the part is rebuilt with every primitive
 * moved by its own tiny random offset (|offset| <= amount, a rigid move, so faces stay planar). That turns
 * accidental near-coincidences between primitives into generic position, which float BSP handles.
 */
export const JITTER = { amount: 0, seed: 1, cur: [0, 0, 0] };
export function beginPrimitive() {
    if (!JITTER.amount) {
        JITTER.cur = [0, 0, 0];
        return;
    }
    const r = () => { JITTER.seed = (JITTER.seed * 1103515245 + 12345) % 2147483648; return JITTER.seed / 2147483648 - 0.5; };
    JITTER.cur = [2 * r() * JITTER.amount, 2 * r() * JITTER.amount, 2 * r() * JITTER.amount];
}
export class Plane {
    nx;
    ny;
    nz;
    w;
    constructor(nx, ny, nz, w) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.w = w;
    }
    static fromPoints(a, b, c) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        return new Plane(nx, ny, nz, nx * a[0] + ny * a[1] + nz * a[2]);
    }
    flipped() { return new Plane(-this.nx, -this.ny, -this.nz, -this.w); }
    dist(p) { return this.nx * p[0] + this.ny * p[1] + this.nz * p[2] - this.w; }
}
export class Polygon {
    vertices;
    plane;
    constructor(vertices, plane) {
        this.vertices = vertices;
        this.plane = plane;
    }
    /** Polygon from input (primitive) vertices: snapped to the input grid first. */
    static input(vertices) { const j = JITTER.cur; return Polygon.of(vertices.map((v) => [snap(v[0] + j[0]), snap(v[1] + j[1]), snap(v[2] + j[2])])); }
    static of(vertices) {
        // Newell normal is robust for nearly degenerate first triples
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i], b = vertices[(i + 1) % vertices.length];
            nx += (a[1] - b[1]) * (a[2] + b[2]);
            ny += (a[2] - b[2]) * (a[0] + b[0]);
            nz += (a[0] - b[0]) * (a[1] + b[1]);
        }
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        let w = 0;
        for (const v of vertices)
            w += nx * v[0] + ny * v[1] + nz * v[2];
        return new Polygon(vertices, new Plane(nx, ny, nz, w / vertices.length));
    }
    flipped() { return new Polygon([...this.vertices].reverse(), this.plane.flipped()); }
}
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
function splitPolygon(plane, poly, cf, cb, front, back) {
    let type = 0;
    const types = [];
    for (const v of poly.vertices) {
        const t = plane.dist(v);
        const ty = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
        type |= ty;
        types.push(ty);
    }
    switch (type) {
        case COPLANAR: {
            const p = poly.plane;
            (plane.nx * p.nx + plane.ny * p.ny + plane.nz * p.nz > 0 ? cf : cb).push(poly);
            break;
        }
        case FRONT:
            front.push(poly);
            break;
        case BACK:
            back.push(poly);
            break;
        default: {
            const f = [], b = [];
            const n = poly.vertices.length;
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const ti = types[i], tj = types[j], vi = poly.vertices[i], vj = poly.vertices[j];
                if (ti !== BACK)
                    f.push(vi);
                if (ti !== FRONT)
                    b.push(vi);
                if ((ti | tj) === SPANNING) {
                    const di = plane.dist(vi), dj = plane.dist(vj);
                    const t = di / (di - dj);
                    const v = [vi[0] + (vj[0] - vi[0]) * t, vi[1] + (vj[1] - vi[1]) * t, vi[2] + (vj[2] - vi[2]) * t];
                    f.push(v);
                    b.push(v);
                }
            }
            if (f.length >= 3)
                front.push(new Polygon(f, poly.plane));
            if (b.length >= 3)
                back.push(new Polygon(b, poly.plane));
        }
    }
}
class Node {
    plane = null;
    front = null;
    back = null;
    polygons = [];
    constructor(polys) { if (polys)
        this.build(polys); }
    invert() {
        // iterative to avoid deep recursion
        const stack = [this];
        while (stack.length) {
            const n = stack.pop();
            n.polygons = n.polygons.map((p) => p.flipped());
            if (n.plane)
                n.plane = n.plane.flipped();
            const t = n.front;
            n.front = n.back;
            n.back = t;
            if (n.front)
                stack.push(n.front);
            if (n.back)
                stack.push(n.back);
        }
    }
    clipPolygons(polys) {
        if (!this.plane)
            return polys.slice();
        let front = [], back = [];
        for (const p of polys)
            splitPolygon(this.plane, p, front, back, front, back);
        if (this.front)
            front = this.front.clipPolygons(front);
        back = this.back ? this.back.clipPolygons(back) : [];
        return front.concat(back);
    }
    clipTo(bsp) {
        const stack = [this];
        while (stack.length) {
            const n = stack.pop();
            n.polygons = bsp.clipPolygons(n.polygons);
            if (n.front)
                stack.push(n.front);
            if (n.back)
                stack.push(n.back);
        }
    }
    allPolygons() {
        const out = [];
        const stack = [this];
        while (stack.length) {
            const n = stack.pop();
            for (const p of n.polygons)
                out.push(p);
            if (n.front)
                stack.push(n.front);
            if (n.back)
                stack.push(n.back);
        }
        return out;
    }
    build(polys) {
        if (!polys.length)
            return;
        if (!this.plane)
            this.plane = polys[0].plane;
        const front = [], back = [];
        for (const p of polys)
            splitPolygon(this.plane, p, this.polygons, this.polygons, front, back);
        if (front.length) {
            if (!this.front)
                this.front = new Node();
            this.front.build(front);
        }
        if (back.length) {
            if (!this.back)
                this.back = new Node();
            this.back.build(back);
        }
    }
}
export class Poly3 {
    _polys;
    _ps;
    constructor(polygons, ps) { this._polys = ps ? null : polygons; this._ps = ps ?? null; }
    /** Vertex polygons (input faces, or the float image of an exact result). */
    get polygons() {
        if (!this._polys)
            this._polys = this._ps.polys.map((p) => {
                const l = Math.hypot(p.S.a, p.S.b, p.S.c);
                const vs = p.vs.map((v) => [v.x * 2 ** -16, v.y * 2 ** -16, v.z * 2 ** -16]);
                return new Polygon(vs, new Plane(p.S.a / l, p.S.b / l, p.S.c / l, -p.S.d / l * 2 ** -16));
            });
        return this._polys;
    }
    set polygons(v) { this._polys = v; this._ps = null; }
    /** The exact plane-based form (input faces are snapped and converted on first use). */
    get exact() { return this._ps ??= PSolid.fromInput(this._polys.map((p) => p.vertices)); }
    union(o) {
        if (ENGINE.exact)
            return new Poly3([], this.exact.union(o.exact));
        const a = new Node(this.polygons), b = new Node(o.polygons);
        a.clipTo(b);
        b.clipTo(a);
        b.invert();
        b.clipTo(a);
        b.invert();
        a.build(b.allPolygons());
        return new Poly3(a.allPolygons());
    }
    subtract(o) {
        if (ENGINE.exact)
            return new Poly3([], this.exact.subtract(o.exact));
        const a = new Node(this.polygons), b = new Node(o.polygons);
        a.invert();
        a.clipTo(b);
        b.clipTo(a);
        b.invert();
        b.clipTo(a);
        b.invert();
        a.build(b.allPolygons());
        a.invert();
        return new Poly3(a.allPolygons());
    }
    intersect(o) {
        if (ENGINE.exact)
            return new Poly3([], this.exact.intersect(o.exact));
        const a = new Node(this.polygons), b = new Node(o.polygons);
        a.invert();
        b.clipTo(a);
        b.invert();
        a.clipTo(b);
        b.clipTo(a);
        a.build(b.allPolygons());
        a.invert();
        return new Poly3(a.allPolygons());
    }
    transform(m) {
        // an exact result is mapped exactly (axis-aligned maps) or re-snapped; input faces stay input faces
        if (ENGINE.exact && this._ps)
            return new Poly3([], this._ps.transform(m));
        const tv = (v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3], m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7], m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11]];
        const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
        return new Poly3(this.polygons.map((p) => {
            const vs = p.vertices.map(tv);
            return ENGINE.exact ? new Polygon(det < 0 ? vs.reverse() : vs, p.plane) : Polygon.of(det < 0 ? vs.reverse() : vs);
        }));
    }
    /** Weld, repair T-junctions, triangulate. */
    toMesh(weldTol = 2e-5) {
        if (ENGINE.exact)
            return this.exact.toMesh();
        // weld by clustering: every pair of points closer than weldTol ends up in one vertex, independent
        // of where a quantisation grid would cut (union-find over a hash of cells of size weldTol)
        const all = [];
        for (const p of this.polygons)
            for (const v of p.vertices)
                all.push(v[0], v[1], v[2]);
        const np = all.length / 3;
        const parent = new Int32Array(np).map((_, i) => i);
        const find = (x) => { while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        } return x; };
        const cellOf = new Map();
        const key = (x, y, z) => `${x},${y},${z}`;
        for (let i = 0; i < np; i++) {
            const cx = Math.floor(all[3 * i] / weldTol), cy = Math.floor(all[3 * i + 1] / weldTol), cz = Math.floor(all[3 * i + 2] / weldTol);
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++) {
                        const l = cellOf.get(key(cx + dx, cy + dy, cz + dz));
                        if (!l)
                            continue;
                        for (const j of l) {
                            const ex = all[3 * i] - all[3 * j], ey = all[3 * i + 1] - all[3 * j + 1], ez = all[3 * i + 2] - all[3 * j + 2];
                            if (ex * ex + ey * ey + ez * ez <= weldTol * weldTol) {
                                const a = find(i), b = find(j);
                                if (a !== b)
                                    parent[a] = b;
                            }
                        }
                    }
            const k = key(cx, cy, cz);
            const l = cellOf.get(k);
            if (l)
                l.push(i);
            else
                cellOf.set(k, [i]);
        }
        const rootId = new Map();
        const pos = [];
        const pointId = new Int32Array(np);
        for (let i = 0; i < np; i++) {
            const r = find(i);
            let id = rootId.get(r);
            if (id === undefined) {
                id = pos.length / 3;
                rootId.set(r, id);
                pos.push(all[3 * r], all[3 * r + 1], all[3 * r + 2]);
            }
            pointId[i] = id;
        }
        let cursor = 0;
        const vid = (_v) => pointId[cursor++];
        let faces = this.polygons.map((p) => {
            const out = [];
            for (const v of p.vertices) {
                const id = vid(v);
                if (out[out.length - 1] !== id)
                    out.push(id);
            }
            while (out.length > 1 && out[0] === out[out.length - 1])
                out.pop();
            return { ids: out, plane: p.plane };
        }).filter((f) => f.ids.length >= 3);
        // spatial hash of vertices for T-junction search
        const nv = pos.length / 3;
        const cell = 1.0;
        const grid = new Map();
        for (let i = 0; i < nv; i++) {
            const k = `${Math.floor(pos[3 * i] / cell)},${Math.floor(pos[3 * i + 1] / cell)},${Math.floor(pos[3 * i + 2] / cell)}`;
            if (!grid.has(k))
                grid.set(k, []);
            grid.get(k).push(i);
        }
        const onSegment = (a, b) => {
            const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
            const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
            const dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy + dz * dz;
            const res = [];
            const x0 = Math.floor(Math.min(ax, bx) / cell - 1e-9), x1 = Math.floor(Math.max(ax, bx) / cell + 1e-9);
            const y0 = Math.floor(Math.min(ay, by) / cell - 1e-9), y1 = Math.floor(Math.max(ay, by) / cell + 1e-9);
            const z0 = Math.floor(Math.min(az, bz) / cell - 1e-9), z1 = Math.floor(Math.max(az, bz) / cell + 1e-9);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 20000)
                return res;
            for (let x = x0; x <= x1; x++)
                for (let y = y0; y <= y1; y++)
                    for (let z = z0; z <= z1; z++) {
                        const list = grid.get(`${x},${y},${z}`);
                        if (!list)
                            continue;
                        for (const i of list) {
                            if (i === a || i === b)
                                continue;
                            const px = pos[3 * i] - ax, py = pos[3 * i + 1] - ay, pz = pos[3 * i + 2] - az;
                            const t = (px * dx + py * dy + pz * dz) / L2;
                            if (t <= 1e-9 || t >= 1 - 1e-9)
                                continue;
                            const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
                            if (ex * ex + ey * ey + ez * ez < weldTol * weldTol * 4)
                                res.push({ t, id: i });
                        }
                    }
            res.sort((u, v) => u.t - v.t);
            return res;
        };
        faces = faces.map((f) => {
            const out = [];
            for (let i = 0; i < f.ids.length; i++) {
                const a = f.ids[i], b = f.ids[(i + 1) % f.ids.length];
                out.push(a);
                for (const s of onSegment(a, b))
                    out.push(s.id);
            }
            return { ids: out, plane: f.plane };
        });
        if (process.env.BSP_DEBUG) {
            const [a, b] = process.env.BSP_DEBUG.split(",").map(Number);
            for (const f of faces)
                if (f.ids.includes(a) && f.ids.includes(b))
                    console.error("face", f.ids.join(" "));
        }
        // ear-clip each (convex, possibly with collinear points) face
        const tris = [];
        for (const f of faces)
            earClip(f.ids, pos, f.plane, tris);
        return new Mesh(Float64Array.from(pos), Uint32Array.from(tris));
    }
}
function earClip(ids, pos, plane, out) {
    const v = ids.slice();
    const area = (a, b, c) => {
        const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
        const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
        return (uy * vz - uz * vy) * plane.nx + (uz * vx - ux * vz) * plane.ny + (ux * vy - uy * vx) * plane.nz;
    };
    let guard = 0;
    while (v.length > 3 && guard++ < 10000) {
        let clipped = false;
        for (let i = 0; i < v.length; i++) {
            const a = v[(i + v.length - 1) % v.length], b = v[i], c = v[(i + 1) % v.length];
            const A = area(a, b, c);
            if (A <= 1e-12)
                continue;
            // no other vertex may lie inside the ear or on its new diagonal (T-junction vertices are collinear)
            let blocked = false;
            for (const q of v) {
                if (q === a || q === b || q === c)
                    continue;
                const w1 = area(b, c, q) / A, w2 = area(c, a, q) / A, w3 = area(a, b, q) / A;
                if (w1 >= -1e-9 && w2 >= -1e-9 && w3 >= -1e-9) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            out.push(a, b, c);
            v.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped)
            return; // all collinear: degenerate sliver, drop
    }
    if (v.length === 3 && area(v[0], v[1], v[2]) > 1e-12)
        out.push(v[0], v[1], v[2]);
}
