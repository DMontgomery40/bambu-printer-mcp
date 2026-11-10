/**
 * Writers and readers: binary STL, minimal 3MF (Open Packaging zip with one model part, 3MF Core
 * Specification 1.3), PNG (RFC 2083). Zip container written by hand (PKWARE APPNOTE 6.3: local headers,
 * central directory, end record); compression is the standard library's raw deflate. CRC-32 is the
 * IEEE 802.3 polynomial, table driven.
 */
import { deflateRawSync, deflateSync } from "node:zlib";
import { Mesh } from "./mesh.js";
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
export function crc32(buf, start = 0xffffffff) {
    let c = start;
    for (let i = 0; i < buf.length; i++)
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
export function writeSTL(mesh, name = "counterpart") {
    const nt = mesh.triangleCount;
    const buf = Buffer.alloc(84 + nt * 50);
    buf.write(name.slice(0, 79), 0, "ascii");
    buf.writeUInt32LE(nt, 80);
    const p = mesh.positions, idx = mesh.indices;
    let o = 84;
    for (let t = 0; t < nt; t++) {
        const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        buf.writeFloatLE(nx, o);
        buf.writeFloatLE(ny, o + 4);
        buf.writeFloatLE(nz, o + 8);
        for (const [k, v] of [[0, a], [1, b], [2, c]]) {
            buf.writeFloatLE(p[v], o + 12 + k * 12);
            buf.writeFloatLE(p[v + 1], o + 16 + k * 12);
            buf.writeFloatLE(p[v + 2], o + 20 + k * 12);
        }
        o += 50;
    }
    return buf;
}
/** Reads binary or ASCII STL into a welded indexed mesh. */
export function readSTL(buf) {
    const isAscii = buf.slice(0, 5).toString("ascii") === "solid" && buf.length !== 84 + buf.readUInt32LE(80) * 50;
    if (isAscii) {
        const text = buf.toString("utf8");
        const nums = [];
        const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
        let m;
        while ((m = re.exec(text)))
            nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
        return Mesh.weld(Float32Array.from(nums));
    }
    const nt = buf.readUInt32LE(80);
    const soup = new Float32Array(nt * 9);
    for (let t = 0; t < nt; t++) {
        const o = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++)
            soup[t * 9 + k] = buf.readFloatLE(o + k * 4);
    }
    return Mesh.weld(soup);
}
export function writeZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, "utf8");
        const comp = deflateRawSync(e.data, { level: 6 });
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12); // 1980-01-01
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, comp);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0, 8);
        cen.writeUInt16LE(8, 10);
        cen.writeUInt16LE(0, 12);
        cen.writeUInt16LE(0x21, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(comp.length, 20);
        cen.writeUInt32LE(e.data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt16LE(0, 30);
        cen.writeUInt16LE(0, 32);
        cen.writeUInt16LE(0, 34);
        cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, name);
        offset += 30 + name.length + comp.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, ...central, end]);
}
/** Minimal valid 3MF: one <object> per body, all placed by a single <build>. Units: millimetres. */
export function write3MF(bodies) {
    const fmt = (x) => {
        const s = x.toFixed(5);
        return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
    };
    const objs = [];
    const items = [];
    bodies.forEach((b, i) => {
        const id = i + 1;
        const p = b.mesh.positions, idx = b.mesh.indices;
        const vs = [];
        for (let v = 0; v < p.length; v += 3)
            vs.push(`<vertex x="${fmt(p[v])}" y="${fmt(p[v + 1])}" z="${fmt(p[v + 2])}"/>`);
        const ts = [];
        for (let t = 0; t < idx.length; t += 3)
            ts.push(`<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>`);
        objs.push(`<object id="${id}" name="${escapeXml(b.name)}" type="model"><mesh><vertices>${vs.join("")}</vertices><triangles>${ts.join("")}</triangles></mesh></object>`);
        items.push(`<item objectid="${id}"/>`);
    });
    const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Counterpart kernel lab</metadata><resources>${objs.join("")}</resources><build>${items.join("")}</build></model>\n`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n`;
    return writeZip([
        { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
        { name: "_rels/.rels", data: Buffer.from(rels) },
        { name: "3D/3dmodel.model", data: Buffer.from(model) },
    ]);
}
function escapeXml(s) {
    return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}
/** RGB 8-bit PNG. */
export function writePNG(width, height, rgb) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
}
