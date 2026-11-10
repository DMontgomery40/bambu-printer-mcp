/**
 * Plane-based polyhedral booleans with exact predicates.
 *
 * A polygon is a support plane S plus a cycle of vertices and, for each edge, the plane the edge lies on
 * (besides S). Splitting a polygon by a plane T creates vertices S ∩ E ∩ T from existing planes only, so no
 * new numbers are ever made and every classification is exact (`predicates.ts`). The set operations are
 * the polygon-clipping BSP of Thibault & Naylor 1987 in the arrangement of csg.js (clip each solid's
 * polygons by the other's tree, invert for subtraction), which is correct when the classification is
 * exact, coplanar faces included. After Bernstein & Fussell 2009 and Campen & Kobbelt 2010.
 *
 * Input: vertex polygons in mm. Vertices are snapped to a 2^-16 mm grid; each face gets the exact integer
 * plane through its snapped vertices; a face that is no longer exactly planar or convex after snapping is
 * triangulated (every triangle is exactly planar). Edge planes of input faces are the planes through the
 * edge parallel to the axis that dominates the face normal (small integer coefficients).
 *
 * Output: vertices that are the same exact point are welded (combinatorial identity first, exact rational
 * comparison for near candidates), vertices lying exactly inside another polygon's edge are inserted
 * (T-junctions, exact on-edge test), and each convex polygon is ear-clipped using exact collinearity, so
 * no triangle is degenerate.
 */
import { Mesh } from "../kernel/mesh.js";
import { GRID, INV_GRID, Plane, Vtx, meet, side, addOn, samePoint, cmpCoord, exactify, gcdNum, STATS } from "./predicates.js";
export { STATS };
const SAFE = 2 ** 53;
export class PPoly {
    S;
    vs;
    es;
    box = null;
    constructor(S, vs, es) {
        this.S = S;
        this.vs = vs;
        this.es = es;
    }
    flipped() {
        const n = this.vs.length;
        const vs = new Array(n), es = new Array(n);
        for (let j = 0; j < n; j++) {
            vs[j] = this.vs[n - 1 - j];
            es[j] = this.es[(2 * n - 2 - j) % n];
        }
        return new PPoly(this.S.flip, vs, es);
    }
}
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
let types = new Int8Array(64);
function splitPolygon(T, poly, cf, cb, front, back) {
    const S0 = poly.S;
    if (S0.id === T.id) {
        (S0 === T ? cf : cb).push(poly);
        return;
    } // same plane (interned): coplanar
    {
        // whole polygon on one side: its box against the plane, with a rigorous margin for the float error
        const b = poly.box ??= polyBox(poly);
        const a = T.a, bb = T.b, c = T.c, d = T.d;
        const lo = a * (a > 0 ? b.x0 : b.x1) + bb * (bb > 0 ? b.y0 : b.y1) + c * (c > 0 ? b.z0 : b.z1) + d;
        const hi = a * (a > 0 ? b.x1 : b.x0) + bb * (bb > 0 ? b.y1 : b.y0) + c * (c > 0 ? b.z1 : b.z0) + d;
        const aa = Math.abs(a), ab = Math.abs(bb), ac = Math.abs(c);
        const m = (aa * Math.max(Math.abs(b.x0), Math.abs(b.x1)) + ab * Math.max(Math.abs(b.y0), Math.abs(b.y1)) + ac * Math.max(Math.abs(b.z0), Math.abs(b.z1)) + Math.abs(d)) * 1e-14 + (aa + ab + ac) * (b.e ?? 0) * 1.001;
        if (lo > m) {
            front.push(poly);
            return;
        }
        if (hi < -m) {
            back.push(poly);
            return;
        }
    }
    const vs = poly.vs, n = vs.length;
    if (types.length < n)
        types = new Int8Array(2 * n);
    const ty = types;
    let type = 0;
    for (let i = 0; i < n; i++) {
        const s = side(vs[i], T);
        const t = s > 0 ? FRONT : s < 0 ? BACK : COPLANAR;
        ty[i] = t;
        type |= t;
    }
    switch (type) {
        case COPLANAR: {
            const S = poly.S;
            (T.a * S.a + T.b * S.b + T.c * S.c > 0 ? cf : cb).push(poly);
            return;
        }
        case FRONT:
            front.push(poly);
            return;
        case BACK:
            back.push(poly);
            return;
    }
    const es = poly.es, S = poly.S;
    const fv = [], fe = [], bv = [], be = [];
    const tl = ty;
    for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const ti = tl[i], tj = tl[j], vi = vs[i];
        if (ti === COPLANAR) {
            fv.push(vi);
            fe.push(tj === BACK ? T : es[i]);
            bv.push(vi);
            be.push(tj === FRONT ? T : es[i]);
            continue;
        }
        if (ti === FRONT) {
            fv.push(vi);
            fe.push(es[i]);
        }
        else {
            bv.push(vi);
            be.push(es[i]);
        }
        if ((ti | tj) === SPANNING) {
            const w = meet(S, es[i], T);
            if (ti === FRONT) {
                fv.push(w);
                fe.push(T);
                bv.push(w);
                be.push(es[i]);
            }
            else {
                bv.push(w);
                be.push(T);
                fv.push(w);
                fe.push(es[i]);
            }
        }
    }
    if (fv.length >= 3)
        front.push(new PPoly(S, fv, fe));
    if (bv.length >= 3)
        back.push(new PPoly(S, bv, be));
}
const SF = [], SB = [];
/** Clips p by the tree: true when p survives whole (nothing pushed); else its surviving pieces are pushed. */
function clipOne(node, p, out) {
    for (;;) {
        if (!node.plane)
            return true;
        SF.length = 0;
        SB.length = 0;
        splitPolygon(node.plane, p, SF, SB, SF, SB);
        if (!SB.length) {
            if (!node.front)
                return true;
            node = node.front;
            continue;
        }
        if (!SF.length) {
            if (!node.back)
                return false;
            node = node.back;
            continue;
        }
        const fp = SF[0], bp = SB[0];
        const fw = node.front ? clipOne(node.front, fp, out) : true;
        const bw = node.back ? clipOne(node.back, bp, out) : false;
        if (fw && bw)
            return true;
        if (fw)
            out.push(fp);
        if (bw)
            out.push(bp);
        return false;
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
        const stack = [this];
        while (stack.length) {
            const n = stack.pop();
            n.polygons = n.polygons.map((p) => p.flipped());
            if (n.plane)
                n.plane = n.plane.flip;
            const t = n.front;
            n.front = n.back;
            n.back = t;
            if (n.front)
                stack.push(n.front);
            if (n.back)
                stack.push(n.back);
        }
    }
    /**
     * Keeps the parts of `polys` outside this tree's solid. A polygon whose pieces all survive comes back
     * whole (not as fragments), as in OpenJSCAD's polygon trees: far fewer fragments and output triangles.
     */
    clipPolygons(polys) {
        const out = [];
        if (!this.plane) {
            for (const p of polys)
                out.push(p);
            return out;
        }
        for (const p of polys)
            if (clipOne(this, p, out))
                out.push(p);
        return out;
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
            this.plane = polys[0].S;
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
function polyBox(p) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, e = 0;
    for (const v of p.vs) {
        if (v.e > e)
            e = v.e;
        if (v.x < x0)
            x0 = v.x;
        if (v.x > x1)
            x1 = v.x;
        if (v.y < y0)
            y0 = v.y;
        if (v.y > y1)
            y1 = v.y;
        if (v.z < z0)
            z0 = v.z;
        if (v.z > z1)
            z1 = v.z;
    }
    return { x0, y0, z0, x1, y1, z1, e };
}
/** Conservative overlap of a polygon with a box (float coordinates are within far less than 1 unit). */
function overlaps(p, R) {
    const b = p.box ??= polyBox(p);
    return b.x1 >= R.x0 - 1 && b.x0 <= R.x1 + 1 && b.y1 >= R.y0 - 1 && b.y0 <= R.y1 + 1 && b.z1 >= R.z0 - 1 && b.z0 <= R.z1 + 1;
}
function solidBox(polys) {
    const R = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (const p of polys) {
        const b = p.box ??= polyBox(p);
        if (b.x0 < R.x0)
            R.x0 = b.x0;
        if (b.y0 < R.y0)
            R.y0 = b.y0;
        if (b.z0 < R.z0)
            R.z0 = b.z0;
        if (b.x1 > R.x1)
            R.x1 = b.x1;
        if (b.y1 > R.y1)
            R.y1 = b.y1;
        if (b.z1 > R.z1)
            R.z1 = b.z1;
    }
    return R;
}
/**
 * A BSP tree of a solid that is valid inside the box R only: six box planes, then the tree of the solid's
 * polygons clipped to R. Every query polygon must lie strictly inside R. When no surface crosses R, R is
 * uniformly inside or outside: the tree is then one leaf, decided by classifying a probe polygon against
 * the solid's full tree.
 */
function localTree(polys, R, probe) {
    const planes = [Plane.fromInts(1, 0, 0, -R.x1), Plane.fromInts(-1, 0, 0, R.x0), Plane.fromInts(0, 1, 0, -R.y1), Plane.fromInts(0, -1, 0, R.y0), Plane.fromInts(0, 0, 1, -R.z1), Plane.fromInts(0, 0, -1, R.z0)];
    let frags = polys.filter((p) => overlaps(p, R));
    const junk = [];
    for (const pl of planes) {
        const next = [];
        for (const p of frags)
            splitPolygon(pl, p, junk, junk, junk, next);
        junk.length = 0;
        frags = next;
    }
    const root = new Node();
    let cur = root, last = root;
    for (const pl of planes) {
        cur.plane = pl;
        cur.back = new Node();
        last = cur;
        cur = cur.back;
    }
    if (frags.length)
        cur.build(frags);
    else {
        // no surface inside R: R is inside or outside as a whole. Encode it with the last box node so that
        // inverting the tree inverts the answer: R behind the plane with no back child is inside; with the
        // plane flipped (R in front, no front child) it is outside.
        last.back = null;
        const outside = new Node(polys).clipPolygons([probe]).length > 0;
        if (outside)
            last.plane = last.plane.flip;
    }
    return root;
}
/** Keeps the parts of `polys` outside the tree's solid; polygons outside `R` are trivially outside it. */
function clipList(polys, tree, R, keepTrivial) {
    if (!R)
        return tree.clipPolygons(polys);
    const work = [], out = [];
    for (const p of polys) {
        if (overlaps(p, R))
            work.push(p);
        else if (keepTrivial)
            out.push(p);
    }
    for (const p of tree.clipPolygons(work))
        out.push(p);
    return out;
}
const flipAll = (ps) => ps.map((p) => p.flipped());
/**
 * Trees for a boolean: the operand with the smaller box gets its full tree (valid everywhere; polygons
 * of the other operand outside its box are trivially outside it), the larger one a tree local to the
 * smaller one's box (all of the smaller operand's polygons are inside that box).
 */
function trees(A, B, invA, invB) {
    const bA = solidBox(A), bB = solidBox(B);
    const vol = (b) => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
    const aSmall = vol(bA) <= vol(bB);
    const sm = aSmall ? bA : bB;
    const M = 8;
    const R = { x0: Math.floor(sm.x0) - M, y0: Math.floor(sm.y0) - M, z0: Math.floor(sm.z0) - M, x1: Math.ceil(sm.x1) + M, y1: Math.ceil(sm.y1) + M, z1: Math.ceil(sm.z1) + M };
    let tA, tB;
    if (aSmall) {
        tA = new Node(A);
        tB = localTree(B, R, A[0]);
    }
    else {
        tB = new Node(B);
        tA = localTree(A, R, B[0]);
    }
    if (invA)
        tA.invert();
    if (invB)
        tB.invert();
    // R for trivial tests: polygons of the larger operand outside R are outside the smaller one
    return { tA, tB, RA: aSmall ? R : null, RB: aSmall ? null : R };
}
/** A closed polyhedron as plane-based convex polygons. */
export class PSolid {
    polys;
    constructor(polys) {
        this.polys = polys;
    }
    static fromInput(polys) { return new PSolid(fromInput(polys)); }
    // csg.js's set operations, written on polygon lists: clip(X, tree) keeps the parts of X outside the tree's solid
    union(o) {
        const A = this.polys, B = o.polys;
        if (!A.length)
            return o;
        if (!B.length)
            return this;
        const { tA, tB, RA, RB } = trees(A, B, false, false);
        const aOut = clipList(A, tB, RA, true);
        const bOut = clipList(B, tA, RB, true);
        const bFin = flipAll(clipList(flipAll(bOut), tA, RB, true));
        return new PSolid(aOut.concat(bFin));
    }
    subtract(o) {
        const A = this.polys, B = o.polys;
        if (!A.length || !B.length)
            return this;
        const { tA, tB, RA, RB } = trees(A, B, true, false);
        const a1 = clipList(flipAll(A), tB, RA, true);
        const b1 = clipList(B, tA, RB, false);
        const b2 = clipList(flipAll(b1), tA, RB, false);
        return new PSolid(flipAll(a1).concat(b2));
    }
    intersect(o) {
        const A = this.polys, B = o.polys;
        if (!A.length || !B.length)
            return new PSolid([]);
        const { tA, tB, RA, RB } = trees(A, B, true, true);
        const b1 = clipList(B, tA, RB, false);
        const a1 = clipList(flipAll(A), tB, RA, false);
        const b2 = clipList(flipAll(b1), tA, RB, false);
        return new PSolid(flipAll(a1).concat(flipAll(b2)));
    }
    transform(m) { return transformSolid(this, m); }
    toMesh() {
        const { pos, cycles } = weldedCycles(this.polys);
        const tris = [];
        for (const c of cycles)
            earClipRuns(c.ids, c.runs, tris);
        const out = new Float64Array(pos.length);
        for (let i = 0; i < pos.length; i++)
            out[i] = pos[i] * INV_GRID;
        return new Mesh(out, Uint32Array.from(tris));
    }
    /** Float vertex polygons in mm (for statistics and debugging). */
    vertexPolygons() {
        return this.polys.map((p) => p.vs.map((v) => [v.x * INV_GRID, v.y * INV_GRID, v.z * INV_GRID]));
    }
}
// ---------------------------------------------------------------------------------------------------
// input conversion
function orient2(au, av, bu, bv, cu, cv) {
    const ux = bu - au, uy = bv - av, vx = cu - au, vy = cv - av;
    const p = ux * vy, q = uy * vx;
    if (Math.abs(p) < SAFE && Math.abs(q) < SAFE)
        return p > q ? 1 : p < q ? -1 : 0;
    const r = BigInt(ux) * BigInt(vy) - BigInt(uy) * BigInt(vx);
    return r > 0n ? 1 : r < 0n ? -1 : 0;
}
function coord(v, k) { return k === 0 ? v.x : k === 1 ? v.y : v.z; }
/** Exact (integer) normal of a polygon of grid points: sum of (v_i - v0) x (v_{i+1} - v0). */
function polyNormal(vs) {
    const n = vs.length, o = vs[0];
    let D = 0;
    for (const v of vs)
        D = Math.max(D, Math.abs(v.x - o.x), Math.abs(v.y - o.y), Math.abs(v.z - o.z));
    if (2 * D * D * (n - 2) < SAFE) {
        let nx = 0, ny = 0, nz = 0;
        for (let i = 1; i + 1 < n; i++) {
            const ux = vs[i].x - o.x, uy = vs[i].y - o.y, uz = vs[i].z - o.z;
            const wx = vs[i + 1].x - o.x, wy = vs[i + 1].y - o.y, wz = vs[i + 1].z - o.z;
            nx += uy * wz - uz * wy;
            ny += uz * wx - ux * wz;
            nz += ux * wy - uy * wx;
        }
        return [nx + 0, ny + 0, nz + 0];
    }
    let nx = 0n, ny = 0n, nz = 0n;
    for (let i = 1; i + 1 < n; i++) {
        const ux = BigInt(vs[i].x - o.x), uy = BigInt(vs[i].y - o.y), uz = BigInt(vs[i].z - o.z);
        const wx = BigInt(vs[i + 1].x - o.x), wy = BigInt(vs[i + 1].y - o.y), wz = BigInt(vs[i + 1].z - o.z);
        nx += uy * wz - uz * wy;
        ny += uz * wx - ux * wz;
        nz += ux * wy - uy * wx;
    }
    return [nx, ny, nz];
}
/** Plane with normal n through grid point p. */
function planeThrough(n, p) {
    if (typeof n[0] === "number") {
        let [a, b, c] = n;
        const g = gcdNum(gcdNum(Math.abs(a), Math.abs(b)), Math.abs(c));
        if (g > 1) {
            a /= g;
            b /= g;
            c /= g;
        }
        const t1 = a * p.x, t2 = b * p.y, t3 = c * p.z;
        if (Math.abs(t1) + Math.abs(t2) + Math.abs(t3) < SAFE)
            return Plane.fromInts(a, b, c, -(t1 + t2 + t3));
        const A = BigInt(a), B = BigInt(b), C = BigInt(c);
        return Plane.fromBig(A, B, C, -(A * BigInt(p.x) + B * BigInt(p.y) + C * BigInt(p.z)));
    }
    const [A, B, C] = n;
    return Plane.fromBig(A, B, C, -(A * BigInt(p.x) + B * BigInt(p.y) + C * BigInt(p.z)));
}
function dominantAxis(S) {
    const ax = Math.abs(S.a), ay = Math.abs(S.b), az = Math.abs(S.c);
    return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}
export function fromInput(polys) {
    const vmap = new Map();
    const conv = { out: [], edges: new Map(), ids: new Map() };
    const snap = (p) => {
        const x = Math.round(p[0] * GRID) + 0, y = Math.round(p[1] * GRID) + 0, z = Math.round(p[2] * GRID) + 0;
        const key = `${x},${y},${z}`;
        let v = vmap.get(key);
        if (!v) {
            v = Vtx.grid(x, y, z);
            vmap.set(key, v);
            conv.ids.set(v, conv.ids.size);
        }
        return v;
    };
    for (const poly of polys) {
        const vs = [];
        for (const p of poly) {
            const v = snap(p);
            if (vs[vs.length - 1] !== v)
                vs.push(v);
        }
        while (vs.length > 1 && vs[0] === vs[vs.length - 1])
            vs.pop();
        if (vs.length >= 3)
            addFace(vs, conv, 0);
    }
    return conv.out;
}
/** Converts grid-point polygons (closed mesh faces) into plane-based convex polygons. */
export function fromGridPolygons(polys) {
    const conv = { out: [], edges: new Map(), ids: new Map() };
    for (const vs0 of polys) {
        const vs = [];
        for (const v of vs0) {
            if (!conv.ids.has(v))
                conv.ids.set(v, conv.ids.size);
            if (vs[vs.length - 1] !== v)
                vs.push(v);
        }
        while (vs.length > 1 && vs[0] === vs[vs.length - 1])
            vs.pop();
        if (vs.length >= 3)
            addFace(vs, conv, 0);
    }
    return conv.out;
}
function addFace(vs, conv, depth) {
    const n = polyNormal(vs);
    if (n[0] == 0 && n[1] == 0 && n[2] == 0) {
        // zero area (collinear after snapping) or a self-cancelling outline: triangulate if it has any area
        if (vs.length > 3 && depth === 0)
            for (const t of earClip2D(vs, null))
                addFace(t, conv, depth + 1);
        return;
    }
    const S = planeThrough(n, vs[0]);
    let planar = true;
    for (let i = 1; i < vs.length && planar; i++)
        if (side(vs[i], S) !== 0)
            planar = false;
    const k = dominantAxis(S);
    // projection (u, w) with u < w: (y, z) and (x, y) keep the orientation about +x / +z, (x, z) reverses it about +y
    const sgn = ((k === 0 ? S.a : k === 1 ? S.b : S.c) > 0 ? 1 : -1) * (k === 1 ? -1 : 1);
    const u = k === 0 ? 1 : 0, w = k === 2 ? 1 : 2;
    let convex = planar;
    if (convex) {
        const m = vs.length;
        for (let i = 0; i < m && convex; i++) {
            const a = vs[(i + m - 1) % m], b = vs[i], c = vs[(i + 1) % m];
            const o = sgn * orient2(coord(a, u), coord(a, w), coord(b, u), coord(b, w), coord(c, u), coord(c, w));
            if (o < 0)
                convex = false;
            else if (o === 0) {
                // collinear: must continue in the same direction (not a spike)
                const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) + (b.z - a.z) * (c.z - b.z);
                if (!(dot > 0))
                    convex = false;
            }
        }
    }
    if (!convex) {
        if (vs.length === 3) {
            if (!planar)
                throw new Error("pbsp: non-planar triangle");
            return; // a degenerate (spike) triangle has zero area
        }
        for (const t of earClip2D(vs, n))
            addFace(t, conv, depth + 1);
        return;
    }
    const m = vs.length;
    const es = new Array(m);
    for (let i = 0; i < m; i++)
        es[i] = edgePlane(vs[i], vs[(i + 1) % m], k, conv);
    for (let i = 0; i < m; i++) {
        const v = vs[i];
        addOn(v, S);
        addOn(v, es[i]);
        addOn(v, es[(i + m - 1) % m]);
    }
    conv.out.push(new PPoly(S, vs, es));
}
/** The plane through edge pq parallel to axis k (cached per edge and axis, so neighbours share it). */
function edgePlane(p, q, k, conv) {
    const ip = conv.ids.get(p), iq = conv.ids.get(q);
    const key = ip < iq ? `${ip},${iq},${k}` : `${iq},${ip},${k}`;
    const hit = conv.edges.get(key);
    if (hit)
        return hit;
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    // (q - p) x e_k
    const n = k === 0 ? [0, dz, -dy] : k === 1 ? [-dz, 0, dx] : [dy, -dx, 0];
    const pl = planeThrough(n, p);
    conv.edges.set(key, pl);
    return pl;
}
/**
 * Ear clipping of a grid polygon projected along the dominant axis of its (average) normal, exact
 * orientation tests. Ears of zero area are dropped. Returns triangles.
 */
function earClip2D(vs, nrm) {
    let nx, ny, nz;
    if (nrm) {
        nx = Number(nrm[0]);
        ny = Number(nrm[1]);
        nz = Number(nrm[2]);
    }
    else {
        // projection that keeps the most area (Newell normal in floats)
        nx = 0;
        ny = 0;
        nz = 0;
        for (let i = 0; i < vs.length; i++) {
            const a = vs[i], b = vs[(i + 1) % vs.length];
            nx += (a.y - b.y) * (a.z + b.z);
            ny += (a.z - b.z) * (a.x + b.x);
            nz += (a.x - b.x) * (a.y + b.y);
        }
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const k = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const s = ((k === 0 ? nx : k === 1 ? ny : nz) >= 0 ? 1 : -1) * (k === 1 ? -1 : 1);
    const u = k === 0 ? 1 : 0, w = k === 2 ? 1 : 2;
    const P = vs.map((v) => [coord(v, u), coord(v, w)]);
    const or = (i, j, l) => s * orient2(P[i][0], P[i][1], P[j][0], P[j][1], P[l][0], P[l][1]);
    const idx = vs.map((_, i) => i);
    const out = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 100000) {
        let found = false;
        for (let t = 0; t < idx.length; t++) {
            const i = idx[(t + idx.length - 1) % idx.length], j = idx[t], l = idx[(t + 1) % idx.length];
            const o = or(i, j, l);
            if (o < 0)
                continue;
            if (o === 0) {
                // zero-area ear: drop the middle vertex (a collinear point or a spike)
                idx.splice(t, 1);
                found = true;
                break;
            }
            let blocked = false;
            for (const q of idx) {
                if (q === i || q === j || q === l)
                    continue;
                if (vs[q] === vs[i] || vs[q] === vs[j] || vs[q] === vs[l])
                    continue;
                if (or(i, j, q) >= 0 && or(j, l, q) >= 0 && or(l, i, q) >= 0) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            out.push([vs[i], vs[j], vs[l]]);
            idx.splice(t, 1);
            found = true;
            break;
        }
        if (!found) {
            // not simple in projection: fan the rest (best effort)
            for (let t = 1; t + 1 < idx.length; t++)
                out.push([vs[idx[0]], vs[idx[t]], vs[idx[t + 1]]]);
            return out;
        }
    }
    if (idx.length === 3 && or(idx[0], idx[1], idx[2]) !== 0)
        out.push([vs[idx[0]], vs[idx[1]], vs[idx[2]]]);
    return out;
}
// ---------------------------------------------------------------------------------------------------
// output: weld, T-junctions, triangulation
let STAMP = 1;
/** Failures that should never happen (counted, for the bench). */
export const BAD = { earFail: 0 };
/**
 * Welds exactly coincident vertices, inserts vertices lying exactly inside polygon edges, and returns each
 * polygon as a cycle of welded ids with run ids (edges on the same line share a run id; runs[i] is the run
 * of the edge from ids[i] to ids[i+1]). `pos` is in grid units.
 */
export function weldedCycles(polys) {
    const stamp = ++STAMP;
    const all = [];
    let emax = 0;
    for (const p of polys)
        for (const v of p.vs)
            if (v.stamp !== stamp) {
                v.stamp = stamp;
                v.idx = -1;
                if (v.e > 0.01)
                    exactify(v);
                if (v.e > emax)
                    emax = v.e;
                all.push(v);
            }
    // weld: cells of one grid unit; a point near a cell boundary also looks in the neighbouring cell
    const cells = new Map();
    const reps = [];
    for (const v of all) {
        const tol = v.e + emax + 1e-9;
        const bx = Math.round(v.x), by = Math.round(v.y), bz = Math.round(v.z);
        const xs = near(v.x, bx, tol), ys = near(v.y, by, tol), zs = near(v.z, bz, tol);
        let id = -1;
        outer: for (const cx of xs)
            for (const cy of ys)
                for (const cz of zs) {
                    const l = cells.get(`${cx},${cy},${cz}`);
                    if (!l)
                        continue;
                    for (const w of l)
                        if (samePoint(reps[w], v)) {
                            id = w;
                            break outer;
                        }
                }
        if (id < 0) {
            id = reps.length;
            reps.push(v);
            const key = `${bx},${by},${bz}`;
            const l = cells.get(key);
            if (l)
                l.push(id);
            else
                cells.set(key, [id]);
        }
        v.idx = id;
    }
    const pos = new Array(reps.length * 3);
    for (let i = 0; i < reps.length; i++) {
        pos[3 * i] = reps[i].x;
        pos[3 * i + 1] = reps[i].y;
        pos[3 * i + 2] = reps[i].z;
    }
    const raws = [];
    for (const p of polys) {
        let vs = p.vs, es = p.es;
        let dup = false;
        for (let i = 0; i < vs.length; i++)
            if (vs[i].idx === vs[(i + 1) % vs.length].idx) {
                dup = true;
                break;
            }
        if (dup) {
            const v2 = [], e2 = [];
            for (let i = 0; i < vs.length; i++)
                if (vs[i].idx !== vs[(i + 1) % vs.length].idx) {
                    v2.push(vs[i]);
                    e2.push(es[i]);
                }
            vs = v2;
            es = e2;
        }
        if (vs.length >= 3)
            raws.push({ vs, es, S: p.S });
    }
    // T-junctions: welded points exactly inside an edge. Grid cells sized to the vertex density.
    let gx0 = Infinity, gy0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gy1 = -Infinity, gz1 = -Infinity;
    for (let i = 0; i < reps.length; i++) {
        const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
        if (x < gx0)
            gx0 = x;
        if (x > gx1)
            gx1 = x;
        if (y < gy0)
            gy0 = y;
        if (y > gy1)
            gy1 = y;
        if (z < gz0)
            gz0 = z;
        if (z > gz1)
            gz1 = z;
    }
    const vol = Math.max(gx1 - gx0, 1) * Math.max(gy1 - gy0, 1) * Math.max(gz1 - gz0, 1);
    const CS = Math.max(GRID / 4, Math.cbrt(vol / Math.max(reps.length, 1)) * 2);
    const cellKey = (x, y, z) => (x * 1048576 + y) * 1048576 + z; // cells index < 2^20 per axis here
    const grid = new Map();
    for (let i = 0; i < reps.length; i++) {
        const k = cellKey(Math.floor((pos[3 * i] - gx0) / CS), Math.floor((pos[3 * i + 1] - gy0) / CS), Math.floor((pos[3 * i + 2] - gz0) / CS));
        const l = grid.get(k);
        if (l)
            l.push(i);
        else
            grid.set(k, [i]);
    }
    const nv = reps.length;
    const inner = new Map();
    const innerOf = (a, b, S, E) => {
        const lo = a < b ? a : b, hi = a < b ? b : a;
        const key = lo * nv + hi;
        let res = inner.get(key);
        if (!res) {
            res = findInner(lo, hi, S, E);
            inner.set(key, res);
        }
        return a < b ? res : [...res].reverse();
    };
    const findInner = (a, b, S, E) => {
        const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
        const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
        const dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy + dz * dz;
        const res = [];
        const x0 = Math.floor((Math.min(ax, bx) - gx0) / CS - 1e-9), x1 = Math.floor((Math.max(ax, bx) - gx0) / CS + 1e-9);
        const y0 = Math.floor((Math.min(ay, by) - gy0) / CS - 1e-9), y1 = Math.floor((Math.max(ay, by) - gy0) / CS + 1e-9);
        const z0 = Math.floor((Math.min(az, bz) - gz0) / CS - 1e-9), z1 = Math.floor((Math.max(az, bz) - gz0) / CS + 1e-9);
        const cand = (i) => {
            if (i === a || i === b)
                return;
            const px = pos[3 * i] - ax, py = pos[3 * i + 1] - ay, pz = pos[3 * i + 2] - az;
            const t = (px * dx + py * dy + pz * dz) / L2;
            if (t <= -1e-6 || t >= 1 + 1e-6)
                return;
            const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
            const tol = 1e-3 + 2 * (reps[i].e + reps[a].e + reps[b].e);
            if (ex * ex + ey * ey + ez * ez > tol * tol)
                return;
            const p = reps[i];
            if (side(p, S) !== 0 || side(p, E) !== 0)
                return;
            // strictly between a and b along the edge's dominant axis
            const k = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 0 : Math.abs(dy) >= Math.abs(dz) ? 1 : 2;
            const dir = cmpCoord(reps[b], reps[a], k);
            if (cmpCoord(p, reps[a], k) !== dir || cmpCoord(reps[b], p, k) !== dir)
                return;
            res.push({ t, id: i });
        };
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) {
            for (let i = 0; i < nv; i++)
                cand(i);
        }
        else {
            for (let x = x0; x <= x1; x++)
                for (let y = y0; y <= y1; y++)
                    for (let z = z0; z <= z1; z++) {
                        const list = grid.get(cellKey(x, y, z));
                        if (list)
                            for (const i of list)
                                cand(i);
                    }
        }
        if (res.length > 1) {
            // exact order along the edge
            const k = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 0 : Math.abs(dy) >= Math.abs(dz) ? 1 : 2;
            const dir = cmpCoord(reps[b], reps[a], k);
            res.sort((u, v) => dir * cmpCoord(reps[u.id], reps[v.id], k));
        }
        return res.map((r) => r.id);
    };
    // an edge whose reverse is an edge of another polygon is complete on both sides: nothing lies inside it
    const directed = new Set();
    for (const r of raws) {
        const m = r.vs.length;
        for (let i = 0; i < m; i++)
            directed.add(r.vs[i].idx * nv + r.vs[(i + 1) % m].idx);
    }
    const cycles = [];
    for (const r of raws) {
        const { vs, es, S } = r;
        const m = vs.length;
        // flat[i]: vertex i lies on the line of its incoming edge's plane continued (exact)
        const flat = new Array(m);
        let corner0 = -1;
        for (let i = 0; i < m; i++) {
            flat[i] = side(vs[(i + 1) % m], es[(i + m - 1) % m]) === 0;
            if (!flat[i] && corner0 < 0)
                corner0 = i;
        }
        if (corner0 < 0)
            continue; // all collinear: no area
        const runOfEdge = new Array(m);
        let run = 0;
        for (let j = 0; j < m; j++) {
            const i = (corner0 + j) % m;
            runOfEdge[i] = run;
            if (!flat[(i + 1) % m])
                run++;
        }
        const ids = [], runs = [];
        for (let i = 0; i < m; i++) {
            const a = vs[i].idx, b = vs[(i + 1) % m].idx;
            ids.push(a);
            runs.push(runOfEdge[i]);
            if (directed.has(b * nv + a))
                continue;
            for (const t of innerOf(a, b, S, es[i])) {
                ids.push(t);
                runs.push(runOfEdge[i]);
            }
        }
        cycles.push({ ids, runs, S });
    }
    return { pos, reps, cycles };
}
function near(x, b, tol) {
    const f = x - b; // in [-0.5, 0.5]
    if (f > 0.5 - tol)
        return [b, b + 1];
    if (f < -0.5 + tol)
        return [b, b - 1];
    return [b];
}
/**
 * Triangulates a convex polygon whose vertices may include collinear runs, using the exact run ids: an ear
 * at vertex b (neighbours a, c) is cut only when b is a corner (its two edges are on different lines) and
 * a and c are not on one line; the new edge a-c starts a new run. No triangle is degenerate.
 */
function earClipRuns(ids0, runs0, out) {
    const n0 = ids0.length;
    if (n0 < 3)
        return;
    const ids = ids0.slice();
    // runIn[i] = run of the edge entering vertex i; runOut[i] = run of the edge leaving it
    const runOut = runs0.slice();
    const runIn = ids.map((_, i) => runs0[(i + n0 - 1) % n0]);
    let nextRun = Math.max(...runs0) + 1;
    let i = 0;
    let idle = 0;
    while (ids.length > 3) {
        const n = ids.length;
        if (idle++ > n + 1) {
            BAD.earFail++;
            return;
        } // a full pass without an ear: cannot happen for a convex polygon
        i %= n;
        const a = (i + n - 1) % n, c = (i + 1) % n;
        if (runIn[i] !== runOut[i] && runIn[a] !== runOut[c]) {
            out.push(ids[a], ids[i], ids[c]);
            const R = nextRun++;
            runOut[a] = R;
            runIn[c] = R;
            ids.splice(i, 1);
            runIn.splice(i, 1);
            runOut.splice(i, 1);
            idle = 0;
            // stay near the cut: the next candidate is the vertex after the removed one (now at index i, or wrapped)
            if (i > a)
                i = a; // keep fan-like order from a
            continue;
        }
        i++;
    }
    if (ids.length === 3) {
        if (runIn[0] !== runOut[0] && runIn[1] !== runOut[1] && runIn[2] !== runOut[2])
            out.push(ids[0], ids[1], ids[2]);
    }
}
// ---------------------------------------------------------------------------------------------------
// transforms
function transformSolid(s, m) {
    // signed permutation (axis-aligned rotations and mirrors) plus a translation: exact
    const perm = [-1, -1, -1], sg = [0, 0, 0];
    let ok = true;
    for (let r = 0; r < 3 && ok; r++) {
        for (let c = 0; c < 3; c++) {
            const x = m[r * 4 + c];
            if (Math.abs(Math.abs(x) - 1) < 1e-12) {
                if (perm[r] >= 0)
                    ok = false;
                perm[r] = c;
                sg[r] = x > 0 ? 1 : -1;
            }
            else if (Math.abs(x) > 1e-12)
                ok = false;
        }
        if (perm[r] < 0)
            ok = false;
    }
    if (ok && new Set(perm).size !== 3)
        ok = false;
    const t = [Math.round(m[3] * GRID) + 0, Math.round(m[7] * GRID) + 0, Math.round(m[11] * GRID) + 0];
    if (ok)
        return permuteSolid(s, perm, sg, t);
    return generalTransform(s, m);
}
function permuteSolid(s, perm, sg, t) {
    // x'_r = sg_r * x_perm[r] + t_r ; plane n.x + d = 0  ->  n'_r = sg_r * n_perm[r], d' = d - n'.t
    let parity = 1;
    for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
            if (perm[i] > perm[j])
                parity = -parity;
    const det = parity * sg[0] * sg[1] * sg[2];
    const pmap = new Map();
    const mapPlane = (p) => {
        let q = pmap.get(p);
        if (q)
            return q;
        const c = [p.a, p.b, p.c];
        const a2 = sg[0] * c[perm[0]], b2 = sg[1] * c[perm[1]], c2 = sg[2] * c[perm[2]];
        const ta = a2 * t[0], tb = b2 * t[1], tc = c2 * t[2];
        if (p.ex && Math.abs(ta) + Math.abs(tb) + Math.abs(tc) + Math.abs(p.d) < SAFE)
            q = Plane.fromInts(a2, b2, c2, p.d - ta - tb - tc);
        else {
            const C = [p.A, p.B, p.C];
            const A2 = BigInt(sg[0]) * C[perm[0]], B2 = BigInt(sg[1]) * C[perm[1]], C2 = BigInt(sg[2]) * C[perm[2]];
            const D2 = p.D - A2 * BigInt(t[0]) - B2 * BigInt(t[1]) - C2 * BigInt(t[2]);
            q = Plane.fromBig(A2, B2, C2, D2);
        }
        pmap.set(p, q);
        pmap.set(p.flip, q.flip);
        return q;
    };
    const vmap = new Map();
    const EPS = 2 ** -53;
    const mapV = (v) => {
        let w = vmap.get(v);
        if (w)
            return w;
        const c = [v.x, v.y, v.z];
        const x = sg[0] * c[perm[0]] + t[0], y = sg[1] * c[perm[1]] + t[1], z = sg[2] * c[perm[2]] + t[2];
        if (v.int) {
            if (!(Math.abs(x) < SAFE && Math.abs(y) < SAFE && Math.abs(z) < SAFE))
                throw new Error("pbsp: coordinates out of range");
            w = Vtx.grid(x, y, z);
        }
        else {
            w = new Vtx(x, y, z, v.e + 4 * EPS * Math.max(Math.abs(x), Math.abs(y), Math.abs(z)), false, mapPlane(v.P), mapPlane(v.Q), mapPlane(v.R));
            if (v.W !== null) {
                const C = [v.X, v.Y, v.Z];
                w.X = BigInt(sg[0]) * C[perm[0]] + BigInt(t[0]) * v.W;
                w.Y = BigInt(sg[1]) * C[perm[1]] + BigInt(t[1]) * v.W;
                w.Z = BigInt(sg[2]) * C[perm[2]] + BigInt(t[2]) * v.W;
                w.W = v.W;
            }
        }
        for (const p of v.on)
            if (!w.on.some((q) => q.id === p.id))
                w.on.push(mapPlane(p));
        vmap.set(v, w);
        return w;
    };
    const polys = s.polys.map((p) => {
        const vs = p.vs.map(mapV), es = p.es.map(mapPlane);
        const q = new PPoly(mapPlane(p.S), vs, es);
        if (det > 0)
            return q;
        // a mirror reverses the winding: reverse the cycle (the mapped normal is already outward)
        const f = q.flipped();
        return new PPoly(q.S, f.vs, f.es);
    });
    return new PSolid(polys);
}
/** Any other rigid map: mesh the polygons (welded, T-junctions repaired), map, re-snap, re-plane. */
function generalTransform(s, m) {
    const { pos, cycles } = weldedCycles(s.polys);
    const n = pos.length / 3;
    const verts = new Array(n);
    const vmap = new Map();
    for (let i = 0; i < n; i++) {
        const x = pos[3 * i] * INV_GRID, y = pos[3 * i + 1] * INV_GRID, z = pos[3 * i + 2] * INV_GRID;
        const X = Math.round((m[0] * x + m[1] * y + m[2] * z + m[3]) * GRID) + 0;
        const Y = Math.round((m[4] * x + m[5] * y + m[6] * z + m[7]) * GRID) + 0;
        const Z = Math.round((m[8] * x + m[9] * y + m[10] * z + m[11]) * GRID) + 0;
        const key = `${X},${Y},${Z}`;
        let v = vmap.get(key);
        if (!v) {
            v = Vtx.grid(X, Y, Z);
            vmap.set(key, v);
        }
        verts[i] = v;
    }
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const polys = cycles.map((c) => { const vs = c.ids.map((i) => verts[i]); return det < 0 ? vs.reverse() : vs; });
    return new PSolid(fromGridPolygons(polys));
}
