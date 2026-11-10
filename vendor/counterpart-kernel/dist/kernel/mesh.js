/**
 * Indexed triangle meshes and their checks: closed (every edge has two faces), manifold (each edge
 * exactly two faces and each vertex a single fan), consistently wound (each edge used once in each
 * direction), outward oriented (positive signed volume), component count, volume and bounds.
 * Volume uses the divergence theorem over triangles (sum of signed tetrahedra to the origin).
 */
export class Mesh {
    positions;
    indices;
    constructor(positions, indices) {
        this.positions = positions;
        this.indices = indices;
    }
    get vertexCount() { return this.positions.length / 3; }
    get triangleCount() { return this.indices.length / 3; }
    bounds() {
        const p = this.positions;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        // only referenced vertices
        const idx = this.indices;
        for (let t = 0; t < idx.length; t++) {
            const v = idx[t] * 3;
            for (let a = 0; a < 3; a++) {
                const x = p[v + a];
                if (x < min[a])
                    min[a] = x;
                if (x > max[a])
                    max[a] = x;
            }
        }
        return { min, max };
    }
    volume() {
        const p = this.positions, idx = this.indices;
        let v6 = 0;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ax = p[a], ay = p[a + 1], az = p[a + 2];
            const bx = p[b], by = p[b + 1], bz = p[b + 2];
            const cx = p[c], cy = p[c + 1], cz = p[c + 2];
            v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        }
        return v6 / 6;
    }
    area() {
        const p = this.positions, idx = this.indices;
        let s = 0;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            s += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
        }
        return s;
    }
    /** Merge vertices with identical coordinates (STL soup -> indexed mesh). */
    static weld(soup) {
        const map = new Map();
        const pos = [];
        const n = soup.length / 3;
        const idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
            const key = `${x},${y},${z}`;
            let id = map.get(key);
            if (id === undefined) {
                id = pos.length / 3;
                map.set(key, id);
                pos.push(x, y, z);
            }
            idx[i] = id;
        }
        // drop degenerate triangles (two identical vertex ids)
        const out = [];
        for (let t = 0; t < n; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            if (a !== b && b !== c && a !== c)
                out.push(a, b, c);
        }
        return new Mesh(Float64Array.from(pos), Uint32Array.from(out));
    }
    static merge(meshes) {
        let nv = 0, nt = 0;
        for (const m of meshes) {
            nv += m.positions.length;
            nt += m.indices.length;
        }
        const pos = new Float64Array(nv), idx = new Uint32Array(nt);
        let ov = 0, ot = 0;
        for (const m of meshes) {
            pos.set(m.positions, ov);
            const base = ov / 3;
            for (let i = 0; i < m.indices.length; i++)
                idx[ot + i] = m.indices[i] + base;
            ov += m.positions.length;
            ot += m.indices.length;
        }
        return new Mesh(pos, idx);
    }
    transformed(m) {
        const p = this.positions, out = new Float64Array(p.length);
        for (let i = 0; i < p.length; i += 3) {
            const x = p[i], y = p[i + 1], z = p[i + 2];
            out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
            out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
            out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
        }
        return new Mesh(out, this.indices.slice());
    }
}
export function checkMesh(mesh) {
    const idx = mesh.indices, nt = idx.length / 3, nv = mesh.positions.length / 3;
    // directed edge map: key = a * nv + b
    const directed = new Map();
    let degenerate = 0;
    const p = mesh.positions;
    for (let t = 0; t < nt; t++) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        if (a === b || b === c || a === c) {
            degenerate++;
            continue;
        }
        const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
        const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        if (cx * cx + cy * cy + cz * cz === 0)
            degenerate++;
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const k = u * nv + v;
            directed.set(k, (directed.get(k) ?? 0) + 1);
        }
    }
    let boundary = 0, nonManifold = 0, inconsistent = 0;
    for (const [k, cnt] of directed) {
        const u = Math.floor(k / nv), v = k - u * nv;
        const rev = directed.get(v * nv + u) ?? 0;
        if (cnt > 1)
            inconsistent++;
        if (u < v || rev === 0) {
            const total = cnt + rev;
            if (total === 1)
                boundary++;
            else if (total > 2)
                nonManifold++;
            if (rev !== cnt)
                inconsistent++;
        }
    }
    // vertex fans: faces around each vertex must form one connected fan
    const vf = Array.from({ length: nv }, () => []);
    for (let t = 0; t < nt; t++)
        for (let j = 0; j < 3; j++)
            vf[idx[3 * t + j]].push(t);
    let nonManifoldVertices = 0;
    for (let v = 0; v < nv; v++) {
        const faces = vf[v];
        if (faces.length === 0)
            continue;
        // build link edges (opposite vertices) and check single cycle via union-find on link vertices
        const parent = new Map();
        const find = (x) => { let r = x; while (parent.get(r) !== r)
            r = parent.get(r); parent.set(x, r); return r; };
        for (const t of faces) {
            const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
            const [o1, o2] = a === v ? [b, c] : b === v ? [c, a] : [a, b];
            if (!parent.has(o1))
                parent.set(o1, o1);
            if (!parent.has(o2))
                parent.set(o2, o2);
            const r1 = find(o1), r2 = find(o2);
            if (r1 !== r2)
                parent.set(r1, r2);
        }
        const roots = new Set();
        for (const k of parent.keys())
            roots.add(find(k));
        if (roots.size > 1)
            nonManifoldVertices++;
    }
    // components by shared vertices (union-find over vertices of each triangle)
    const par = new Int32Array(nv).map((_, i) => i);
    const f = (x) => { while (par[x] !== x) {
        par[x] = par[par[x]];
        x = par[x];
    } return x; };
    for (let t = 0; t < nt; t++) {
        const a = f(idx[3 * t]), b = f(idx[3 * t + 1]), c = f(idx[3 * t + 2]);
        if (a !== b)
            par[a] = b;
        const b2 = f(b);
        if (f(c) !== b2)
            par[f(c)] = b2;
    }
    const compV = new Map(), compF = new Map();
    const used = new Uint8Array(nv);
    for (let t = 0; t < nt; t++)
        for (let j = 0; j < 3; j++)
            used[idx[3 * t + j]] = 1;
    for (let v = 0; v < nv; v++)
        if (used[v]) {
            const r = f(v);
            compV.set(r, (compV.get(r) ?? 0) + 1);
        }
    for (let t = 0; t < nt; t++) {
        const r = f(idx[3 * t]);
        compF.set(r, (compF.get(r) ?? 0) + 1);
    }
    const genus = [];
    for (const [r, nF] of compF) {
        const V = compV.get(r) ?? 0, E = nF * 3 / 2;
        const chi = V - E + nF;
        genus.push((2 - chi) / 2);
    }
    const volume = mesh.volume();
    return {
        triangles: nt, vertices: nv,
        closed: boundary === 0 && nonManifold === 0,
        manifold: nonManifold === 0 && nonManifoldVertices === 0 && boundary === 0,
        consistentWinding: inconsistent === 0,
        outward: volume > 0,
        components: compF.size,
        boundaryEdges: boundary, nonManifoldEdges: nonManifold, nonManifoldVertices,
        degenerateTriangles: degenerate,
        volume, area: mesh.area(), bounds: mesh.bounds(), genus,
    };
}
