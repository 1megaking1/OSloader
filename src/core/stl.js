// STL reading / writing. Reading returns triangle soup positions (9 floats per
// triangle) plus the list of named solids for ASCII files with several
// `solid ... endsolid` blocks.

const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

export function isBinarySTL(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 84) return false;
  const n = dv.getUint32(80, true);
  if (84 + n * 50 === buf.byteLength) return true;
  // Some exporters pad the file; accept if the declared size fits and header
  // does not look like ASCII.
  const head = new Uint8Array(buf, 0, Math.min(256, buf.byteLength));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  if (/^\s*solid[\s\S]*facet/i.test(text)) return false;
  return 84 + n * 50 <= buf.byteLength;
}

/**
 * Parse an STL file.
 * @returns {{positions: Float32Array, solids: {name:string,start:number,count:number}[]}}
 *   start/count are in triangles.
 */
export function parseSTL(buf) {
  if (buf instanceof Uint8Array) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (isBinarySTL(buf)) return parseBinary(buf);
  return parseASCII(buf);
}

function parseBinary(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal; recomputed from winding
    for (let k = 0; k < 9; k++) {
      pos[i * 9 + k] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  // header name (best effort)
  let name = '';
  const head = new Uint8Array(buf, 0, 80);
  for (let i = 0; i < 80 && head[i]; i++) name += String.fromCharCode(head[i]);
  return { positions: pos, solids: [{ name: name.trim(), start: 0, count: n }] };
}

function parseASCII(buf) {
  const text = td ? td.decode(new Uint8Array(buf)) : Buffer.from(buf).toString('latin1');
  const out = [];
  const solids = [];
  let cur = null;
  // Fast scan: split into tokens line by line.
  const re = /(solid|endsolid|vertex)([^\n\r]*)/g;
  let m;
  let triCount = 0;
  let vtx = 0;
  while ((m = re.exec(text))) {
    const kw = m[1];
    if (kw === 'vertex') {
      const p = m[2].trim().split(/\s+/);
      out.push(+p[0], +p[1], +p[2]);
      vtx++;
      if (vtx === 3) {
        vtx = 0;
        triCount++;
      }
    } else if (kw === 'solid') {
      // 'endsolid' also matches 'solid' at offset+3; guard by previous chars
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      if (before === 'end') continue;
      if (cur) cur.count = triCount - cur.start;
      cur = { name: m[2].trim(), start: triCount, count: 0 };
      solids.push(cur);
    } else if (kw === 'endsolid') {
      if (cur) {
        cur.count = triCount - cur.start;
        cur = null;
      }
    }
  }
  if (cur) cur.count = triCount - cur.start;
  if (!solids.length) solids.push({ name: '', start: 0, count: triCount });
  const usable = Math.floor(out.length / 9) * 9;
  return { positions: new Float32Array(out.slice(0, usable)), solids: solids.filter((s) => s.count > 0) };
}

function faceNormal(p, i) {
  const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
  const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/**
 * Binary STL from several bodies (each {positions: Float32Array world coords}).
 * Bodies stay separate shells (no shared vertices), so slicers / Goop can split them.
 */
export function writeSTLBinary(bodies, header = 'STL Assembler multi-body export') {
  let n = 0;
  for (const b of bodies) n += b.positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const h = header.slice(0, 79);
  for (let i = 0; i < h.length; i++) dv.setUint8(i, h.charCodeAt(i) & 0x7f);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const b of bodies) {
    const p = b.positions;
    for (let i = 0; i < p.length; i += 9) {
      const nn = faceNormal(p, i);
      dv.setFloat32(o, nn[0], true);
      dv.setFloat32(o + 4, nn[1], true);
      dv.setFloat32(o + 8, nn[2], true);
      o += 12;
      for (let k = 0; k < 9; k++) {
        dv.setFloat32(o, p[i + k], true);
        o += 4;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buf;
}

const fmt = (x) => {
  // compact but lossless enough for float32
  const s = x.toPrecision(9);
  return s.indexOf('e') >= 0 ? s : String(parseFloat(s));
};

/** ASCII STL with one named `solid` block per body. Returns string. */
export function writeSTLAscii(bodies) {
  const chunks = [];
  for (const b of bodies) {
    const name = (b.name || 'body').replace(/[\r\n]/g, ' ').replace(/\s+/g, '_');
    chunks.push(`solid ${name}\n`);
    const p = b.positions;
    const lines = [];
    for (let i = 0; i < p.length; i += 9) {
      const nn = faceNormal(p, i);
      lines.push(
        `  facet normal ${fmt(nn[0])} ${fmt(nn[1])} ${fmt(nn[2])}\n    outer loop\n` +
          `      vertex ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}\n` +
          `      vertex ${fmt(p[i + 3])} ${fmt(p[i + 4])} ${fmt(p[i + 5])}\n` +
          `      vertex ${fmt(p[i + 6])} ${fmt(p[i + 7])} ${fmt(p[i + 8])}\n` +
          `    endloop\n  endfacet\n`,
      );
      if (lines.length > 4096) {
        chunks.push(lines.join(''));
        lines.length = 0;
      }
    }
    chunks.push(lines.join(''));
    chunks.push(`endsolid ${name}\n`);
  }
  return chunks.join('');
}

/** Parse Wavefront OBJ (positions + faces, triangulated fan). One body per 'o'/'g'. */
export function parseOBJ(buf) {
  const text = td ? td.decode(new Uint8Array(buf)) : Buffer.from(buf).toString('utf8');
  const v = [];
  const out = [];
  const solids = [];
  let cur = { name: '', start: 0, count: 0 };
  solids.push(cur);
  let tri = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/);
      v.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const idx = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((s) => {
          const k = parseInt(s.split('/')[0], 10);
          return k < 0 ? v.length + k : k - 1;
        });
      for (let i = 1; i + 1 < idx.length; i++) {
        const a = v[idx[0]], b = v[idx[i]], c = v[idx[i + 1]];
        if (!a || !b || !c) continue;
        out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        tri++;
      }
    } else if (line.startsWith('o ') || line.startsWith('g ')) {
      cur.count = tri - cur.start;
      cur = { name: line.slice(2).trim(), start: tri, count: 0 };
      solids.push(cur);
    }
  }
  cur.count = tri - cur.start;
  return { positions: new Float32Array(out), solids: solids.filter((s) => s.count > 0) };
}
