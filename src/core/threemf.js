// 3MF export (multiple named bodies, either as separate objects or as one
// assembly object made of components) and a lightweight 3MF importer.

import { zipFiles, unzip } from './zip.js';

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (x) => {
  const s = (+x).toPrecision(9);
  return String(parseFloat(s));
};

function meshXML(positions) {
  const map = new Map();
  const vx = [];
  const tri = [];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const key = (x, y, z) => {
    f32[0] = x;
    const a = u32[0];
    f32[0] = y;
    const b = u32[0];
    f32[0] = z;
    return a + ',' + b + ',' + u32[0];
  };
  for (let i = 0; i < positions.length; i += 3) {
    const k = key(positions[i], positions[i + 1], positions[i + 2]);
    let id = map.get(k);
    if (id === undefined) {
      id = vx.length;
      map.set(k, id);
      vx.push(i);
    }
    tri.push(id);
  }
  const parts = ['<mesh><vertices>'];
  for (const i of vx) parts.push(`<vertex x="${num(positions[i])}" y="${num(positions[i + 1])}" z="${num(positions[i + 2])}"/>`);
  parts.push('</vertices><triangles>');
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    if (a === b || b === c || a === c) continue;
    parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  parts.push('</triangles></mesh>');
  return parts.join('');
}

/**
 * @param {{name:string, positions:Float32Array}[]} bodies world-space triangle soups
 * @param {{mode?:'objects'|'assembly', name?:string}} opts
 */
export async function write3MF(bodies, opts = {}) {
  const mode = opts.mode || 'objects';
  const res = [];
  const build = [];
  bodies.forEach((b, i) => {
    res.push(`<object id="${i + 1}" type="model" name="${esc(b.name || 'part' + (i + 1))}">${meshXML(b.positions)}</object>`);
  });
  if (mode === 'assembly') {
    const id = bodies.length + 1;
    res.push(`<object id="${id}" type="model" name="${esc(opts.name || 'Assembly')}"><components>${bodies.map((_, i) => `<component objectid="${i + 1}"/>`).join('')}</components></object>`);
    build.push(`<item objectid="${id}"/>`);
  } else {
    bodies.forEach((_, i) => build.push(`<item objectid="${i + 1}"/>`));
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">STL Assembler</metadata>
 <metadata name="Title">${esc(opts.name || 'Assembly')}</metadata>
 <resources>
${res.join('\n')}
 </resources>
 <build>${build.join('')}</build>
</model>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: CT },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

// ------------------------------------------------------------- import

function attrs(tag) {
  const o = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) o[m[1]] = m[2];
  return o;
}

function parseTransform(s) {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12) return null;
  return v; // row-major 4x3: p' = [x y z 1] * M
}
function mulT(a, b) {
  // apply a then b
  if (!a) return b;
  if (!b) return a;
  const A = [[a[0], a[1], a[2], 0], [a[3], a[4], a[5], 0], [a[6], a[7], a[8], 0], [a[9], a[10], a[11], 1]];
  const B = [[b[0], b[1], b[2], 0], [b[3], b[4], b[5], 0], [b[6], b[7], b[8], 0], [b[9], b[10], b[11], 1]];
  const C = A.map((row) => [0, 1, 2, 3].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j] + row[3] * B[3][j]));
  return [C[0][0], C[0][1], C[0][2], C[1][0], C[1][1], C[1][2], C[2][0], C[2][1], C[2][2], C[3][0], C[3][1], C[3][2]];
}

/** @returns {Promise<{name:string, positions:Float32Array}[]>} one body per mesh instance */
export async function read3MF(buf) {
  const files = await unzip(buf);
  const td = new TextDecoder();
  const models = files.filter((f) => /\.model$/i.test(f.name));
  const objects = new Map(); // key path#id -> {name, verts, tris, comps}
  for (const f of models) {
    const text = td.decode(f.data);
    const path = '/' + f.name.replace(/^\/+/, '');
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let m;
    while ((m = objRe.exec(text))) {
      const a = attrs(m[1]);
      const body = m[2];
      const o = { name: a.name || 'object ' + a.id, verts: null, tris: null, comps: [] };
      const vm = body.match(/<vertices>([\s\S]*?)<\/vertices>/);
      if (vm) {
        const vs = [];
        const vre = /<vertex\b([^>]*)\/?>/g;
        let q;
        while ((q = vre.exec(vm[1]))) {
          const va = attrs(q[1]);
          vs.push(+va.x, +va.y, +va.z);
        }
        const ts = [];
        const tm = body.match(/<triangles>([\s\S]*?)<\/triangles>/);
        if (tm) {
          const tre = /<triangle\b([^>]*)\/?>/g;
          while ((q = tre.exec(tm[1]))) {
            const ta = attrs(q[1]);
            ts.push(+ta.v1, +ta.v2, +ta.v3);
          }
        }
        o.verts = vs;
        o.tris = ts;
      }
      const cre = /<component\b([^>]*)\/?>/g;
      let q;
      while ((q = cre.exec(body))) {
        const ca = attrs(q[1]);
        o.comps.push({ ref: (ca['p:path'] || path) + '#' + ca.objectid, T: parseTransform(ca.transform) });
      }
      objects.set(path + '#' + a.id, o);
    }
  }
  // build items from the root model
  const root = models.find((f) => /3dmodel\.model$/i.test(f.name)) || models[0];
  const rootPath = '/' + root.name.replace(/^\/+/, '');
  const text = td.decode(root.data);
  const items = [];
  const ire = /<item\b([^>]*)\/?>/g;
  let m;
  const buildM = text.match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
  if (buildM) while ((m = ire.exec(buildM[1]))) {
    const a = attrs(m[1]);
    items.push({ ref: (a['p:path'] || rootPath) + '#' + a.objectid, T: parseTransform(a.transform) });
  }
  const bodies = [];
  const emit = (ref, T, nameHint, depth = 0) => {
    const o = objects.get(ref);
    if (!o || depth > 16) return;
    if (o.verts && o.tris && o.tris.length) {
      const pos = new Float32Array(o.tris.length * 3);
      for (let i = 0; i < o.tris.length; i++) {
        const k = o.tris[i] * 3;
        let x = o.verts[k], y = o.verts[k + 1], z = o.verts[k + 2];
        if (T) {
          const nx = x * T[0] + y * T[3] + z * T[6] + T[9];
          const ny = x * T[1] + y * T[4] + z * T[7] + T[10];
          const nz = x * T[2] + y * T[5] + z * T[8] + T[11];
          x = nx;
          y = ny;
          z = nz;
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
      }
      bodies.push({ name: o.name || nameHint, positions: pos });
    }
    for (const c of o.comps) emit(c.ref, mulT(c.T, T), o.name, depth + 1);
  };
  for (const it of items) emit(it.ref, it.T, 'item');
  return bodies;
}
