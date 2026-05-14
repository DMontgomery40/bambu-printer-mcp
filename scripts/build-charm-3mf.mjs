#!/usr/bin/env node
/**
 * Build a multi-object source .3mf for BambuStudio CLI from two STLs
 * (a "body" and a "face/detail" piece) plus a known-good template 3MF
 * for project_settings.config.
 *
 * Output is an *unsliced project* 3MF. Hand it to BambuStudio CLI:
 *
 *   BambuStudio --slice 0 --debug 2 --export-3mf out.gcode.3mf input.3mf
 *
 * Per the BambuStudio Command-Line-Usage wiki row 1, the CLI consumes
 * the embedded project_settings.config directly when slicing a project.
 *
 * The crucial bit Codex missed: per-object filament/extruder assignment
 * for color separation lives in Metadata/model_settings.config inside
 * the 3MF, NOT in CLI flags. Reproduces the pattern from a real
 * non-min-saved BBL project (huskies.3mf) where each object carries
 * <metadata key="extruder" value="N"/>.
 *
 * Implementation notes:
 *   - Inline meshes in 3D/3dmodel.model (no external part files /
 *     Production Extension). Simpler schema and BambuStudio's CLI
 *     accepts it cleanly.
 *   - Mesh XYZ is preserved EXACTLY as-is from the STLs. We don't
 *     re-center on the bed; the input STLs are expected to already be
 *     at the position you want them printed.
 *   - The "body vs face" decision uses signed-tetrahedron volume
 *     (not triangle count) so it's robust against OpenSCAD's uniform
 *     facet density. Larger volume = body = body-extruder, smaller
 *     volume = face/detail = face-extruder.
 *
 * Usage:
 *   node scripts/build-charm-3mf.mjs \
 *     --stl-a /path/to/one.stl \
 *     --stl-b /path/to/other.stl \
 *     --template /path/to/template.gcode.3mf \
 *     --out /tmp/charm-input.3mf \
 *     [--body-extruder 5 --face-extruder 4]
 *
 * Body extruder defaults to 5 (white, slot 5 1-indexed in the working
 * BARKSIDE charm). Face extruder defaults to 4 (black, slot 4).
 * Override if your template uses a different filament layout.
 */

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import JSZip from "jszip";

/* --- arg parsing ------------------------------------------------------- */

function parseArgs() {
  const out = {
    stlA: null,
    stlB: null,
    template: null,
    outPath: null,
    bodyExtruder: 5,
    faceExtruder: 4,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stl-a" || a === "--body") out.stlA = argv[++i];
    else if (a === "--stl-b" || a === "--face") out.stlB = argv[++i];
    else if (a === "--template") out.template = argv[++i];
    else if (a === "--out") out.outPath = argv[++i];
    else if (a === "--body-extruder") out.bodyExtruder = Number(argv[++i]);
    else if (a === "--face-extruder") out.faceExtruder = Number(argv[++i]);
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  for (const [flag, key] of [["--stl-a", "stlA"], ["--stl-b", "stlB"], ["--template", "template"], ["--out", "outPath"]]) {
    if (!out[key]) { console.error(`Missing ${flag}`); process.exit(2); }
  }
  return out;
}

/* --- STL parsing ------------------------------------------------------- */

/**
 * Parse an ASCII or binary STL into { vertices: Float32Array, indices: Uint32Array }.
 * Vertices and indices use deduplication via a string-keyed map (cheap, fine
 * for charm-size meshes -- a few tens of thousands of triangles).
 */
function parseStl(filePath) {
  const buf = fs.readFileSync(filePath);
  const isAscii =
    buf.slice(0, 5).toString("ascii") === "solid" &&
    !buf.slice(0, 1024).includes(0);
  const tris = isAscii ? parseAsciiStl(buf.toString("utf8")) : parseBinaryStl(buf);

  // Deduplicate vertices.
  const map = new Map();
  const vertices = [];
  const indices = [];
  for (const t of tris) {
    for (const v of t) {
      // Round to 5 decimals to merge near-duplicates (mm precision).
      const key = `${v[0].toFixed(5)},${v[1].toFixed(5)},${v[2].toFixed(5)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = vertices.length / 3;
        vertices.push(v[0], v[1], v[2]);
        map.set(key, idx);
      }
      indices.push(idx);
    }
  }
  return {
    vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(indices),
    triangleCount: tris.length,
  };
}

function parseAsciiStl(text) {
  const tris = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let cur = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    cur.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (cur.length === 3) {
      tris.push(cur);
      cur = [];
    }
  }
  return tris;
}

function parseBinaryStl(buf) {
  const tris = [];
  const triCount = buf.readUInt32LE(80);
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip normal
    const t = [];
    for (let v = 0; v < 3; v++) {
      t.push([buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8)]);
      off += 12;
    }
    off += 2; // attribute byte count
    tris.push(t);
  }
  return tris;
}

/* --- mesh utilities ---------------------------------------------------- */

/** Bounding box and centroid of an indexed triangle mesh. */
function bboxCentroid(verts) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

/**
 * Signed-tetrahedron volume of a closed indexed triangle mesh, in
 * cubic mm. Robust to mesh density (unlike triangle count); positive
 * if normals face outward.
 *
 * V = (1/6) * sum(v0 . (v1 x v2)) over all triangles.
 */
function meshVolume(mesh) {
  const v = mesh.vertices;
  const idx = mesh.indices;
  let sum = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const ax = v[idx[i] * 3], ay = v[idx[i] * 3 + 1], az = v[idx[i] * 3 + 2];
    const bx = v[idx[i + 1] * 3], by = v[idx[i + 1] * 3 + 1], bz = v[idx[i + 1] * 3 + 2];
    const cx = v[idx[i + 2] * 3], cy = v[idx[i + 2] * 3 + 1], cz = v[idx[i + 2] * 3 + 2];
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

/* --- 3MF construction -------------------------------------------------- */

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
const BBLNS = 'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"';
const PNS = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';

/**
 * Build a single 3D/3dmodel.model file with both meshes inline.
 * No external part files / Production Extension / <components> wrapper
 * -- just <object id="N" type="model"><mesh>...</mesh></object> for each.
 * BambuStudio's CLI accepts this and references match cleanly between
 * <resources>, <build>, and Metadata/model_settings.config.
 */
function rootModelXml(objects) {
  const objBlocks = objects.map((o) => {
    const verts = [];
    for (let i = 0; i < o.mesh.vertices.length; i += 3) {
      verts.push(`     <vertex x="${o.mesh.vertices[i]}" y="${o.mesh.vertices[i + 1]}" z="${o.mesh.vertices[i + 2]}"/>`);
    }
    const tris = [];
    for (let i = 0; i < o.mesh.indices.length; i += 3) {
      tris.push(`     <triangle v1="${o.mesh.indices[i]}" v2="${o.mesh.indices[i + 1]}" v3="${o.mesh.indices[i + 2]}"/>`);
    }
    return `  <object id="${o.objId}" type="model">
   <mesh>
    <vertices>
${verts.join("\n")}
    </vertices>
    <triangles>
${tris.join("\n")}
    </triangles>
   </mesh>
  </object>`;
  }).join("\n");
  const buildItems = objects.map(
    (o) => `  <item objectid="${o.objId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NS} ${BBLNS}>
 <metadata name="Application">bambu-printer-mcp build-charm-3mf.mjs</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objBlocks}
 </resources>
 <build>
${buildItems}
 </build>
</model>
`;
}

function modelSettingsConfigXml(objects, opts = {}) {
  const filamentMaps = opts.filamentMaps ?? "1 1 1 1 2 1 1 1";
  const filamentVolumeMaps = opts.filamentVolumeMaps ?? "1 1 1 1 1 1 1 1";

  // Per-object metadata. The crucial key here is "extruder" -- this is
  // the project filament slot (1-indexed) that BambuStudio will assign
  // to the object during slicing.
  const blocks = objects.map((o) => `  <object id="${o.objId}">
    <metadata key="name" value="${o.name}"/>
    <metadata key="extruder" value="${o.extruder}"/>
    <part id="${o.objId}" subtype="normal_part">
      <metadata key="name" value="${o.name}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${o.name}"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat face_count="${o.triangleCount}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>`).join("\n");
  // filament_maps: per-filament-slot nozzle assignment ("1" = nozzle 1,
  //   "2" = nozzle 2). H2D uses two nozzles; the working POP_BARKSIDE
  //   charm uses "1 1 1 1 2 1 1 1" (slot 5 on nozzle 2, rest on nozzle 1).
  // filament_volume_maps: per-filament volume_type index. All "1" means
  //   every filament uses the first declared nozzle_volume_type, which
  //   matches the working charm's "High Flow" x 2 setup.
  // Without these, BambuStudio's H2D code path SIGSEGVs in
  // load_nozzle_infos_with_compatibility (similar shape to upstream #9636).
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
${blocks}
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="${filamentMaps}"/>
    <metadata key="filament_volume_maps" value="${filamentVolumeMaps}"/>
    <metadata key="gcode_file" value=""/>
  </plate>
</config>
`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="config" ContentType="application/octet-stream"/>
 <Default Extension="json" ContentType="application/octet-stream"/>
 <Default Extension="gcode" ContentType="application/octet-stream"/>
 <Default Extension="md5" ContentType="application/octet-stream"/>
 <Default Extension="xml" ContentType="application/octet-stream"/>
</Types>
`;
}

function topRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
}

/* --- main -------------------------------------------------------------- */

async function main() {
  const args = parseArgs();

  // 1. Parse both STLs.
  console.log(`[build] parsing A: ${args.stlA}`);
  const meshA = parseStl(args.stlA);
  console.log(`[build] parsing B: ${args.stlB}`);
  const meshB = parseStl(args.stlB);

  // 2. Compute mesh volume (signed-tetrahedron sum, in mm^3). Whichever
  //    is larger is the body/main color; the smaller is the face/detail.
  //    OpenSCAD STLs have uniform facet density so triangle count is a
  //    poor proxy -- volume is the right signal.
  const volA = meshVolume(meshA);
  const volB = meshVolume(meshB);
  console.log(`[build] volume A: ${volA.toFixed(2)} mm^3 (${meshA.triangleCount} tris)`);
  console.log(`[build] volume B: ${volB.toFixed(2)} mm^3 (${meshB.triangleCount} tris)`);

  let body, face, bodyName, faceName;
  if (volA >= volB) {
    body = meshA; bodyName = path.basename(args.stlA);
    face = meshB; faceName = path.basename(args.stlB);
  } else {
    body = meshB; bodyName = path.basename(args.stlB);
    face = meshA; faceName = path.basename(args.stlA);
  }
  console.log(`[build] body = ${bodyName} (extruder ${args.bodyExtruder})`);
  console.log(`[build] face = ${faceName} (extruder ${args.faceExtruder})`);

  const bodyBox = bboxCentroid(body.vertices);
  const faceBox = bboxCentroid(face.vertices);
  console.log(`[build] body bbox: ${bodyBox.min.map(n=>n.toFixed(2)).join(",")} → ${bodyBox.max.map(n=>n.toFixed(2)).join(",")}`);
  console.log(`[build] face bbox: ${faceBox.min.map(n=>n.toFixed(2)).join(",")} → ${faceBox.max.map(n=>n.toFixed(2)).join(",")}`);

  // 3. Pack into a single-file inline-mesh 3MF.
  const zip = new JSZip();
  const objects = [
    { objId: 1, name: bodyName, mesh: body, extruder: args.bodyExtruder, triangleCount: body.triangleCount },
    { objId: 2, name: faceName, mesh: face, extruder: args.faceExtruder, triangleCount: face.triangleCount },
  ];

  zip.file("[Content_Types].xml", contentTypesXml());
  zip.file("_rels/.rels", topRelsXml());
  zip.file("3D/3dmodel.model", rootModelXml(objects));
  zip.file("Metadata/model_settings.config", modelSettingsConfigXml(objects));

  // 4. Carry project_settings.config from the template.
  console.log(`[build] copying project_settings.config from: ${args.template}`);
  const tplBuf = fs.readFileSync(args.template);
  const tpl = await JSZip.loadAsync(tplBuf);
  const projCfg = await tpl.file("Metadata/project_settings.config")?.async("nodebuffer");
  if (!projCfg) {
    console.error(`Template ${args.template} has no Metadata/project_settings.config`);
    process.exit(1);
  }
  zip.file("Metadata/project_settings.config", projCfg);

  // 5. Write.
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  fs.writeFileSync(args.outPath, out);
  console.log(`[build] wrote ${args.outPath} (${out.length} bytes)`);
  console.log(`[build] next: BambuStudio --slice 0 --debug 2 --export-3mf out.gcode.3mf ${args.outPath}`);
}

main().catch((err) => {
  console.error(`[build] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
