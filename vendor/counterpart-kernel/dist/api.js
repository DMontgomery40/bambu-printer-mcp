/**
 * The scripting surface a worker writes against. Millimetres, Z up, named options everywhere.
 *
 *   export const P = { width: 65.8, depth: 28.8, height: 60, wall: 2.4 };
 *   export function build(P) {
 *     const outer = box({ x: [-P.width / 2 - P.wall, P.width / 2 + P.wall], y: [...], z: [0, P.height] });
 *     return part("cup", outer.cut(...));
 *   }
 *
 * Positions: a box, cylinder or cone is placed by giving each axis either a range [from, to] or a
 * single coordinate (the centre). The axis given as a range is a cylinder's axis.
 */
import { AABB, BoxNode, SphereNode, CylinderNode, ConeNode, TreatedExtrudeNode, RevolveNode, TranslateNode, TransformNode, OffsetNode, ChamferUnionNode, RoundUnionNode, unionOf, intersectOf, differenceOf, } from "./kernel/sdf.js";
import { Circle2, Rect2, Strokes2, Union2, Diff2, Intersect2, Offset2, Move2, Mirror2, PathBuilder, polygonOutline, KernelError, } from "./kernel/profile.js";
import { textPolylines } from "./kernel/font.js";
import * as E from "./exact/api.js";
import { XP, rectPolygon, circlePolygon } from "./hybrid.js";
import { contoursToPolygons } from "./kernel/profile.js";
/** Positional requirements carry a `moved` method; others are position-independent. */
import { xform } from "./xform.js";
function movedRequirement(c, x, y, z) {
    const m = c.moved;
    return m ? m(x, y, z) : c;
}
function lazy(f) { let v = null; return () => (v ??= f()); }
function combine(fs, op) {
    if (fs.some((f) => !f))
        return null;
    return lazy(() => { let r = fs[0](); for (const f of fs.slice(1))
        r = op(r, f()); return r; });
}
function matPoly(f, m) { return f ? lazy(() => f().transform(m)) : null; }
export { KernelError };
function fmt(v) { return JSON.stringify(v); }
function num(name, v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        throw new KernelError(`${name} must be a finite number in mm (got ${fmt(v)}).`);
    return v;
}
function range(name, v) {
    if (!Array.isArray(v) || v.length !== 2)
        throw new KernelError(`${name} must be a range [from, to] in mm (got ${fmt(v)}).`);
    const a = num(`${name}[0]`, v[0]), b = num(`${name}[1]`, v[1]);
    if (!(b > a))
        throw new KernelError(`${name} range [${a}, ${b}] is empty: 'to' must be greater than 'from'.`);
    return [a, b];
}
// ------------------------------------------------------------------------------------------------
// Solids
export class Solid {
    sdf;
    label;
    poly;
    whyNoPoly;
    checks;
    /** @internal */
    constructor(sdf, label = "solid", poly = null, whyNoPoly = "", 
    /** requirements the run proves on the final mesh (attached by intent-level features) */
    checks = []) {
        this.sdf = sdf;
        this.label = label;
        this.poly = poly;
        this.whyNoPoly = whyNoPoly;
        this.checks = checks;
    }
    derive(sdf, poly, why, checks = this.checks) { return new Solid(sdf, this.label, poly, poly ? "" : why, checks); }
    /** Attach requirements that the run must prove on the final mesh. */
    require(...reqs) { return new Solid(this.sdf, this.label, this.poly, this.whyNoPoly, [...this.checks, ...reqs]); }
    why(others = []) { return [this, ...others].map((o) => o.whyNoPoly).find((w) => w) ?? ""; }
    /** Union with other solids. */
    add(...others) {
        others.forEach((o) => solidArg("add", o));
        return this.derive(unionOf([this.sdf, ...others.map((o) => o.sdf)]), combine([this.poly, ...others.map((o) => o.poly)], (a, b) => a.union(b)), this.why(others), [this, ...others].flatMap((o) => o.checks));
    }
    /** Subtract other solids (holes, pockets, slots). */
    cut(...others) {
        others.forEach((o) => solidArg("cut", o));
        return this.derive(differenceOf(this.sdf, others.map((o) => o.sdf)), combine([this.poly, ...others.map((o) => o.poly)], (a, b) => a.subtract(b)), this.why(others), [this, ...others].flatMap((o) => o.checks));
    }
    /** Keep only the overlap. */
    intersect(...others) {
        others.forEach((o) => solidArg("intersect", o));
        return this.derive(intersectOf([this.sdf, ...others.map((o) => o.sdf)]), combine([this.poly, ...others.map((o) => o.poly)], (a, b) => a.intersect(b)), this.why(others), [this, ...others].flatMap((o) => o.checks));
    }
    /** Union with a 45-degree bevel of size c where the two meet (inside corners). */
    addChamfered(other, c) { return this.derive(new ChamferUnionNode(this.sdf, solidArg("addChamfered", other).sdf, num("c", c)), null, "addChamfered (blend)"); }
    /** Union with a concave fillet of radius r where the two meet. */
    addFilleted(other, r) { return this.derive(new RoundUnionNode(this.sdf, solidArg("addFilleted", other).sdf, num("r", r)), null, "addFilleted (blend)"); }
    move(x, y = 0, z = 0) {
        return this.derive(new TranslateNode(this.sdf, num("x", x), num("y", y), num("z", z)), matPoly(this.poly, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]), this.whyNoPoly, this.checks.map((c) => movedRequirement(c, x, y, z)));
    }
    /** Rotate by `deg` degrees about an axis through `about` (default origin), right-hand rule. */
    rotate(axis, deg, about = [0, 0, 0]) {
        const a = num("deg", deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        let R;
        if (axis === "x")
            R = [1, 0, 0, 0, c, -s, 0, s, c];
        else if (axis === "y")
            R = [c, 0, s, 0, 1, 0, -s, 0, c];
        else if (axis === "z")
            R = [c, -s, 0, s, c, 0, 0, 0, 1];
        else
            throw new KernelError(`rotate: axis must be "x", "y" or "z" (got ${fmt(axis)}).`);
        return this.derive(rigid(this.sdf, R, about), matPoly(this.poly, fwdMatrix(R, about)), this.whyNoPoly, mapChecks(this.checks, xform(R, about, `rotate("${axis}", ${deg})`)));
    }
    /** Mirror across the plane through the origin normal to `axis`. */
    mirror(axis) {
        const R = axis === "x" ? [-1, 0, 0, 0, 1, 0, 0, 0, 1] : axis === "y" ? [1, 0, 0, 0, -1, 0, 0, 0, 1] : axis === "z" ? [1, 0, 0, 0, 1, 0, 0, 0, -1] : null;
        if (!R)
            throw new KernelError(`mirror: axis must be "x", "y" or "z" (got ${fmt(axis)}).`);
        return this.derive(rigid(this.sdf, R, [0, 0, 0]), matPoly(this.poly, fwdMatrix(R, [0, 0, 0])), this.whyNoPoly, mapChecks(this.checks, xform(R, [0, 0, 0], `mirror("${axis}")`)));
    }
    /** Grow (d > 0) or shrink (d < 0) every surface by d. Exact on single primitives and on outsides of unions. */
    offset(d) { return this.derive(new OffsetNode(this.sdf, num("d", d)), null, "offset of a solid"); }
    /** Hollow the solid, keeping a wall of thickness t inside its surface. */
    shell(t) {
        if (!(num("shell t", t) > 0))
            throw new KernelError("shell: wall thickness t must be > 0.");
        return this.derive(differenceOf(this.sdf, [new OffsetNode(this.sdf, -t)]), null, "shell");
    }
    /** Copies of this solid at each offset, unioned. */
    pattern(offsets) {
        const moved = offsets.map(([x, y, z]) => this.move(x, y, z));
        return moved[0].add(...moved.slice(1));
    }
    bounds() {
        const b = this.sdf.bounds;
        return { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ], size: b.size() };
    }
    /** Signed distance at a point (negative inside): handy for asserting a clearance in a script. */
    distance(x, y, z) { return this.sdf.f(x, y, z); }
    contains(x, y, z) { return this.sdf.f(x, y, z) < 0; }
}
/** After rotate/mirror the positional requirements are gone; say so when that includes what the part must do. */
/**
 * Requirements through a rotation or mirror: mesh checks and facts that know how to map themselves are mapped; any
 * other positional check is dropped, and one receipt line says what was dropped and why (round 2 dropped them all).
 */
function mapChecks(checks, X) {
    const out = [], dropped = [];
    for (const c of checks) {
        const m = c;
        if (m.mapped) {
            const r = m.mapped(X);
            if (r)
                out.push(r);
            else
                dropped.push(`${c.name}${m.whyNot ? `: ${m.whyNot(X)}` : X.axes ? " (a horizontal section that is no longer horizontal)" : " (its axis is no longer along x, y or z)"}`);
        }
        else if (m.moved)
            dropped.push(`${c.name} (positional, no rule to turn it)`);
        else
            out.push(c);
    }
    if (dropped.length) {
        const name = `${X.op} dropped ${dropped.length} requirement${dropped.length > 1 ? "s" : ""}: ${dropped.join("; ")}`;
        out.push({ name, run: () => ({ name, pass: true, measured: "not checked after the turn", expected: "re-state them in the new orientation, or turn by a multiple of 90 degrees" }) });
    }
    return out;
}
function solidArg(op, s) {
    if (!(s instanceof Solid)) {
        if (s instanceof Profile)
            throw new KernelError(`${op}: got a 2D profile; turn it into a solid first with .extrude({ z: [from, to] }) or .revolve().`);
        throw new KernelError(`${op}: expected a solid (box, cylinder, extrude, ...) but got ${fmt(s)}.`);
    }
    return s;
}
function fwdMatrix(R, about) {
    const [ox, oy, oz] = about;
    const t = [ox - (R[0] * ox + R[1] * oy + R[2] * oz), oy - (R[3] * ox + R[4] * oy + R[5] * oz), oz - (R[6] * ox + R[7] * oy + R[8] * oz)];
    return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}
function rigid(sdf, R, about) {
    // p' = R (p - o) + o ; inverse p = R^T (p' - o) + o
    const [ox, oy, oz] = about;
    const t = [ox - (R[0] * ox + R[1] * oy + R[2] * oz), oy - (R[3] * ox + R[4] * oy + R[5] * oz), oz - (R[6] * ox + R[7] * oy + R[8] * oz)];
    const fwd = Float64Array.from([R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]]);
    const RT = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const ti = [-(RT[0] * t[0] + RT[1] * t[1] + RT[2] * t[2]), -(RT[3] * t[0] + RT[4] * t[1] + RT[5] * t[2]), -(RT[6] * t[0] + RT[7] * t[1] + RT[8] * t[2])];
    const inv = Float64Array.from([RT[0], RT[1], RT[2], ti[0], RT[3], RT[4], RT[5], ti[1], RT[6], RT[7], RT[8], ti[2]]);
    return new TransformNode(sdf, inv, fwd);
}
/** Box from three ranges, e.g. box({ x: [-10, 10], y: [0, 5], z: [0, 30] }), or box({ size: [w, d, h], center: [x, y, z] }). */
export function box(o) {
    if (o.size) {
        const [w, d, h] = o.size.map((v, i) => num(`size[${i}]`, v));
        if (!(w > 0 && d > 0 && h > 0))
            throw new KernelError(`box: size ${fmt(o.size)} must be positive.`);
        const c = o.center ?? [0, 0, 0];
        const xr = [c[0] - w / 2, c[0] + w / 2], yr = [c[1] - d / 2, c[1] + d / 2], zr = [c[2] - h / 2, c[2] + h / 2];
        return new Solid(new BoxNode(c[0], c[1], c[2], w / 2, d / 2, h / 2), "box", lazy(() => E.box({ x: xr, y: yr, z: zr }).poly));
    }
    if (o.x === undefined || o.y === undefined || o.z === undefined)
        throw new KernelError("box: give x, y and z ranges ({ x: [x0, x1], y: [y0, y1], z: [z0, z1] }) or { size: [w, d, h], center?: [x, y, z] }.");
    const [x0, x1] = range("box x", o.x), [y0, y1] = range("box y", o.y), [z0, z1] = range("box z", o.z);
    return new Solid(new BoxNode((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2), "box", lazy(() => E.box({ x: [x0, x1], y: [y0, y1], z: [z0, z1] }).poly));
}
/** Interpret {x, y, z} where exactly one is a range: returns axis index, range, and the 2 centre coordinates. */
function axial(name, o) {
    const ks = ["x", "y", "z"];
    const ranges = ks.filter((k) => Array.isArray(o[k]));
    if (ranges.length !== 1)
        throw new KernelError(`${name}: give its axis as a range and the other two coordinates as numbers, e.g. { d: 5, x: 0, y: 0, z: [0, 10] } for a vertical one (got x=${fmt(o.x)}, y=${fmt(o.y)}, z=${fmt(o.z)}).`);
    const axis = ks.indexOf(ranges[0]);
    const r = range(`${name} ${ranges[0]}`, o[ranges[0]]);
    const others = ks.filter((k) => k !== ranges[0]).map((k) => (o[k] === undefined ? 0 : num(`${name} ${k}`, o[k])));
    return { axis, r, u: others[0], v: others[1] };
}
function radiusOf(name, o) {
    if (o.d !== undefined && o.r !== undefined)
        throw new KernelError(`${name}: give either d (diameter) or r (radius), not both.`);
    const r = o.d !== undefined ? num(`${name} d`, o.d) / 2 : o.r !== undefined ? num(`${name} r`, o.r) : NaN;
    if (!(r > 0))
        throw new KernelError(`${name}: needs a positive d (diameter) or r (radius).`);
    return r;
}
/** Cylinder: cylinder({ d: 4.5, x: 10, y: [-1, 6], z: 40 }) is a hole-sized rod along Y at x=10, z=40. */
export function cylinder(o) {
    const r = radiusOf("cylinder", o);
    const { axis, r: [a, b], u, v } = axial("cylinder", o);
    const base = new CylinderNode(0, 0, r, a, b);
    const ax = axis === 0 ? { x: [a, b], y: u, z: v } : axis === 1 ? { x: u, y: [a, b], z: v } : { x: u, y: v, z: [a, b] };
    return new Solid(orientZ(base, axis, u, v), "cylinder", lazy(() => E.cylinder({ d: 2 * r, ...ax }).poly));
}
/** Cone or frustum: d1 at the start of the axis range, d2 at its end (either may be 0). */
export function cone(o) {
    const r1 = num("cone d1", o.d1) / 2, r2 = num("cone d2", o.d2) / 2;
    if (r1 < 0 || r2 < 0 || (r1 === 0 && r2 === 0))
        throw new KernelError("cone: d1 and d2 must be >= 0 and not both 0.");
    const { axis, r: [a, b], u, v } = axial("cone", o);
    const ax = axis === 0 ? { x: [a, b], y: u, z: v } : axis === 1 ? { x: u, y: [a, b], z: v } : { x: u, y: v, z: [a, b] };
    return new Solid(orientZ(new ConeNode(0, 0, r1, r2, a, b), axis, u, v), "cone", lazy(() => E.cone({ d1: 2 * r1, d2: 2 * r2, ...ax }).poly));
}
/** Place a Z-axis node (axial range already in its z) so its axis is `axis` through (u, v) of the other two. */
function orientZ(node, axis, u, v) {
    if (axis === 2)
        return new TranslateNode(node, u, v, 0);
    // axis x: local z -> world x; others (y, z) = (u, v)
    if (axis === 0)
        return rigidT(node, [0, 0, 1, 1, 0, 0, 0, 1, 0], [0, u, v]);
    // axis y: local z -> world y; others (x, z) = (u, v)
    return rigidT(node, [0, 1, 0, 0, 0, 1, 1, 0, 0], [u, 0, v]);
}
function rigidT(node, R, t) {
    // world = R local + t
    const fwd = Float64Array.from([R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]]);
    const RT = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const inv = Float64Array.from([RT[0], RT[1], RT[2], -(RT[0] * t[0] + RT[1] * t[1] + RT[2] * t[2]),
        RT[3], RT[4], RT[5], -(RT[3] * t[0] + RT[4] * t[1] + RT[5] * t[2]),
        RT[6], RT[7], RT[8], -(RT[6] * t[0] + RT[7] * t[1] + RT[8] * t[2])]);
    return new TransformNode(node, inv, fwd);
}
export function sphere(o) {
    const r = radiusOf("sphere", o);
    const c = o.center ?? [0, 0, 0];
    const half = path().moveTo(0, -r).arcTo(0, r, { r }).close(); // counter-clockwise half disc, x >= 0
    const lathe = half.revolve({ center: [c[0], c[1]] }).move(0, 0, c[2]);
    return new Solid(new SphereNode(c[0], c[1], c[2], r), "sphere", lathe.poly);
}
export function union(...solids) {
    if (solids.length === 0)
        throw new KernelError("union: needs at least one solid.");
    solids.forEach((s) => solidArg("union", s));
    return solids[0].add(...solids.slice(1));
}
export function difference(base, ...cutters) { return solidArg("difference", base).cut(...cutters); }
export function intersection(...solids) { solids.forEach((s) => solidArg("intersection", s)); return solids[0].intersect(...solids.slice(1)); }
export class Profile {
    shape;
    ex;
    whyNoPoly;
    /** @internal */
    constructor(shape, ex = null, whyNoPoly = "") {
        this.shape = shape;
        this.ex = ex;
        this.whyNoPoly = whyNoPoly;
    }
    xcomb(op, others) {
        if (!this.ex || others.some((o) => !o.ex))
            return null;
        return new XP(null, op, [this.ex, ...others.map((o) => o.ex)]);
    }
    whyAll(others) { return [this, ...others].map((o) => o.whyNoPoly).find((w) => w) ?? ""; }
    add(...others) { others.forEach((o) => profileArg("add", o)); return new Profile(new Union2([this.shape, ...others.map((o) => o.shape)]), this.xcomb("union", others), this.whyAll(others)); }
    cut(...others) { others.forEach((o) => profileArg("cut", o)); return new Profile(new Diff2(this.shape, others.map((o) => o.shape)), this.xcomb("cut", others), this.whyAll(others)); }
    intersect(...others) { others.forEach((o) => profileArg("intersect", o)); return new Profile(new Intersect2([this.shape, ...others.map((o) => o.shape)]), this.xcomb("intersect", others), this.whyAll(others)); }
    /** Grow (d > 0) or shrink (d < 0) the outline by d: clearances are offset(+clearance) on the part being fitted. */
    offset(d) {
        const ex = this.ex ? this.ex.offset(num("offset d", d)) : null;
        return new Profile(new Offset2(this.shape, d), ex, ex ? "" : this.whyNoPoly || "2D offset of a general outline");
    }
    move(x, y) { return new Profile(new Move2(this.shape, 0, num("x", x), num("y", y)), this.ex ? this.ex.transform([1, 0, 0, 1, x, y]) : null, this.whyNoPoly); }
    rotate(deg) {
        const a = num("deg", deg) * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a);
        return new Profile(new Move2(this.shape, deg, 0, 0), this.ex ? this.ex.transform([c, -s2, s2, c, 0, 0]) : null, this.whyNoPoly);
    }
    mirror(axis) {
        const m = axis === "x" ? [-1, 0, 0, 1, 0, 0] : [1, 0, 0, -1, 0, 0];
        return new Profile(new Mirror2(this.shape, axis), this.ex ? this.ex.transform(m) : null, this.whyNoPoly);
    }
    /** Copies at each [dx, dy], unioned. */
    pattern(offsets) { const ms = offsets.map(([x, y]) => this.move(x, y)); return ms[0].add(...ms.slice(1)); }
    bounds() {
        const b = this.shape.bounds2;
        return { min: [b[0], b[1]], max: [b[2], b[3]], size: [b[2] - b[0], b[3] - b[1]] };
    }
    /**
     * Extrude along the axis given as a range: { z: [0, 10] } (sketch x, y = world x, y),
     * { y: [a, b] } (sketch x, y = world x, z: a front view) or { x: [a, b] } (sketch x, y = world y, z).
     * Ends: top/bottom (the high/low end of the range) take { chamfer }, { round } or { flare } (a lead-in
     * that widens the section towards that end, for pocket mouths). round: r rounds both ends.
     */
    extrude(o) {
        const keys = ["x", "y", "z"].filter((k) => o[k] !== undefined);
        if (keys.length !== 1)
            throw new KernelError(`extrude: give exactly one axis range, e.g. { z: [0, 10] } (got ${keys.length ? keys.join(", ") : "none"}).`);
        const axis = ["x", "y", "z"].indexOf(keys[0]);
        const [a, b] = range(`extrude ${keys[0]}`, o[keys[0]]);
        const end = (name, e) => {
            if (!e)
                return null;
            const ks = ["chamfer", "round", "flare"].filter((k) => e[k] !== undefined && e[k] !== 0);
            if (ks.length > 1)
                throw new KernelError(`extrude ${name}: choose one of chamfer, round or flare.`);
            if (ks.length === 0)
                return null;
            const size = num(`extrude ${name}.${ks[0]}`, e[ks[0]]);
            if (!(size > 0))
                throw new KernelError(`extrude ${name}.${ks[0]} must be > 0.`);
            if (size > (b - a) / (ks[0] === "flare" ? 1 : 2) + 1e-9)
                throw new KernelError(`extrude ${name}.${ks[0]} ${size} is larger than the extrusion allows (${b - a} mm long).`);
            return { kind: ks[0], size };
        };
        let lo = end("bottom", o.bottom), hi = end("top", o.top);
        if (o.round !== undefined) {
            if (lo || hi)
                throw new KernelError("extrude: use either round or top/bottom treatments.");
            lo = hi = { kind: "round", size: num("extrude round", o.round) };
        }
        if ((lo?.kind === "round" || hi?.kind === "round") && (lo?.kind === "chamfer" || hi?.kind === "chamfer"))
            throw new KernelError("extrude: mixing round and chamfer ends is not supported yet.");
        const sdf = new TreatedExtrudeNode(this.shape, axis, a, b, lo, hi);
        const ex = this.ex;
        let poly = null, why = this.whyNoPoly || "profile without a polygonal form";
        if (ex) {
            if (!lo && !hi)
                poly = lazy(() => ex.prism(axis, a, b));
            else if (lo?.kind !== "round" && hi?.kind !== "round") {
                // chamfer = loft to the inward offset, flare = loft to the outward offset (exact outline pieces)
                const endOf = (e) => (e ? { size: e.size, delta: e.kind === "flare" ? e.size : -e.size } : undefined);
                const attempt = ex.pieces() ? ex.lofted(axis, a, b, { lo: endOf(lo), hi: endOf(hi) }) : null;
                if (attempt)
                    poly = () => attempt;
                else if ((lo?.kind ?? "chamfer") === "chamfer" && (hi?.kind ?? "chamfer") === "chamfer" && axis === 2 && ex.singleConvex()) {
                    poly = lazy(() => ex.chamfered(a, b, hi?.size ?? 0, lo?.size ?? 0));
                }
                else
                    why = `extrude with ${[lo?.kind, hi?.kind].filter(Boolean).join("/")} ends on an outline whose offset is not representable`;
            }
            else if ((!lo || lo.kind === "round") && (!hi || hi.kind === "round")) {
                const attempt = ex.pieces() ? ex.rounded(axis, a, b, lo?.size ?? 0, hi?.size ?? 0) : null;
                if (attempt)
                    poly = () => attempt;
                else
                    why = "extrude with rounded ends on an outline whose inward offset is not representable";
            }
            else
                why = "extrude mixing rounded and other ends";
        }
        return new Solid(sdf, "extrude", poly, poly ? "" : why);
    }
    /** Revolve about the Z axis: sketch x = radius (>= 0), sketch y = height z. */
    revolve(o = {}) {
        if (this.shape.bounds2[0] < -1e-9)
            throw new KernelError(`revolve: the profile crosses the axis (sketch x down to ${this.shape.bounds2[0].toFixed(3)}); keep x >= 0 (x is the radius).`);
        const c = o.center ?? [0, 0];
        const ex = this.ex;
        const poly = ex && ex.contours ? lazy(() => { const r = ex.lathe(c[0], c[1]); if (!r)
            throw new KernelError("revolve: no polyhedral form"); return r; }) : null;
        return new Solid(new RevolveNode(this.shape, c[0], c[1]), "revolve", poly, poly ? "" : "revolve of a combined profile");
    }
}
/** Outline contours (monotonic arc pieces with traversal flags) as traversal-ordered lines and arcs. */
function toTSegs(o) {
    return o.contours.map((c) => c.map((sg) => sg.kind === 0
        ? { kind: "line", x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 }
        : sg.rev ? { kind: "arc", cx: sg.cx, cy: sg.cy, r: sg.r, a0: sg.a1, a1: sg.a0 } : { kind: "arc", cx: sg.cx, cy: sg.cy, r: sg.r, a0: sg.a0, a1: sg.a1 }));
}
function profileArg(op, p) {
    if (!(p instanceof Profile)) {
        if (p instanceof Solid)
            throw new KernelError(`${op}: got a solid where a 2D profile was expected; combine solids with solid.${op}(...) instead.`);
        throw new KernelError(`${op}: expected a profile (rect, circle, polygon, path) but got ${fmt(p)}.`);
    }
    return p;
}
/** Rectangle: rect({ size: [w, h], center?: [x, y], r?: cornerRadius }) or rect({ x: [x0, x1], y: [y0, y1], r? }). */
export function rect(o) {
    let cx, cy, hw, hh;
    if (o.size) {
        hw = num("rect size[0]", o.size[0]) / 2;
        hh = num("rect size[1]", o.size[1]) / 2;
        [cx, cy] = o.center ?? [0, 0];
    }
    else if (o.x && o.y) {
        const [x0, x1] = range("rect x", o.x), [y0, y1] = range("rect y", o.y);
        cx = (x0 + x1) / 2;
        cy = (y0 + y1) / 2;
        hw = (x1 - x0) / 2;
        hh = (y1 - y0) / 2;
    }
    else
        throw new KernelError("rect: give { size: [w, h], center? } or { x: [x0, x1], y: [y0, y1] }.");
    const r = o.r ?? 0;
    const shape = new Rect2(cx, cy, hw, hh, r);
    return new Profile(shape, XP.leaf([rectPolygon(2 * hw, 2 * hh, cx, cy, r)], { w: 2 * hw, h: 2 * hh, cx, cy, r }));
}
export function circle(o) {
    const r = radiusOf("circle", o);
    const [cx, cy] = o.center ?? [0, 0];
    return new Profile(new Circle2(cx, cy, r), XP.leaf([circlePolygon(cx, cy, r)], undefined, { cx, cy, r }));
}
/** Closed polygon through points; `round` rounds every corner (or give one radius per corner). */
export function polygon(points, o = {}) {
    if (!Array.isArray(points))
        throw new KernelError("polygon: expected an array of [x, y] points.");
    points.forEach((p, i) => { if (!Array.isArray(p) || p.length !== 2)
        throw new KernelError(`polygon: point ${i} must be [x, y] (got ${fmt(p)}).`); num(`polygon point ${i} x`, p[0]); num(`polygon point ${i} y`, p[1]); });
    const outline = polygonOutline(points, o.round ?? 0);
    return new Profile(outline, XP.leaf(contoursToPolygons(outline.contours), undefined, undefined, toTSegs(outline)));
}
/** Outline builder: path().moveTo(0,0).lineTo(10,0).arcTo(10,10,{r:5}).close().toProfile() — see API.md. */
export class Path {
    pb = new PathBuilder();
    moveTo(x, y) { this.pb.moveTo(num("moveTo x", x), num("moveTo y", y)); return this; }
    lineTo(x, y) { this.pb.lineTo(num("lineTo x", x), num("lineTo y", y)); return this; }
    /** Arc to (x, y) with radius r; counter-clockwise unless clockwise: true; the short way unless large: true. */
    arcTo(x, y, o) {
        if (!o || typeof o.r !== "number")
            throw new KernelError("arcTo(x, y, { r, clockwise?, large? }): radius r is required.");
        this.pb.arcTo(num("arcTo x", x), num("arcTo y", y), o.r, o);
        return this;
    }
    /** Arc through a middle point (mx, my) ending at (x, y). */
    arcThrough(mx, my, x, y) { this.pb.arcThrough(mx, my, x, y); return this; }
    /** Arc tangent to the previous segment, ending at (x, y). */
    tangentArcTo(x, y) { this.pb.tangentArcTo(x, y); return this; }
    close() { this.pb.close(); const o = this.pb.build(); return new Profile(o, XP.leaf(contoursToPolygons(o.contours), undefined, undefined, toTSegs(o))); }
}
export function path() { return new Path(); }
/** Stroke text: capitals, digits, - + . / and space. height = outer letter height in mm. */
export function text(s, o) {
    const height = num("text height", o.height);
    const stroke = o.stroke ?? Math.max(height * 0.14, 0.8);
    const { lines, width } = textPolylines(s, height, stroke, o.spacing);
    const [cx, cy] = o.center ?? [0, 0];
    const shifted = lines.map((pl) => pl.map(([x, y]) => [x - width / 2 + cx, y - height / 2 + cy]));
    const ex = E.text(s, { height, stroke, center: [cx, cy] });
    return new Profile(new Strokes2(shifted, stroke), new XP(null, "union", [ex.pts, ...ex.extra].map((c) => XP.leaf([c]))));
}
export class Part {
    name;
    solid;
    options;
    constructor(name, solid, options = {}) {
        this.name = name;
        this.solid = solid;
        this.options = options;
    }
}
/** Name a solid as an output body. */
export function part(name, solid, options = {}) {
    if (typeof name !== "string" || !name)
        throw new KernelError("part: the first argument is the part's name, e.g. part(\"holder\", solid).");
    return new Part(name, solidArg(`part("${name}")`, solid), options);
}
export function normalizeBuildResult(r) {
    if (r instanceof Part)
        return [r];
    if (r instanceof Solid)
        return [new Part("part", r)];
    if (Array.isArray(r))
        return r.flatMap((x, i) => (x instanceof Solid ? [new Part(`part${i + 1}`, x)] : normalizeBuildResult(x)));
    if (r && typeof r === "object") {
        return Object.entries(r).map(([k, v]) => {
            if (v instanceof Solid)
                return new Part(k, v);
            if (v instanceof Part)
                return v;
            throw new KernelError(`build() returned an object whose "${k}" is not a solid.`);
        });
    }
    if (r instanceof Profile)
        throw new KernelError("build() returned a 2D profile; extrude or revolve it into a solid.");
    throw new KernelError(`build() must return a solid, part(...), or an array/object of them (got ${fmt(r)}).`);
}
export { AABB };
