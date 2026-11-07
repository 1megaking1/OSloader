// File intake (drag & drop of files/folders/zips, file pickers) and export
// helpers.

import { parseSTL, parseOBJ, writeSTLBinary, writeSTLAscii } from '../core/stl.js';
import { read3MF, write3MF } from '../core/threemf.js';
import { unzip, zipFiles } from '../core/zip.js';

const MESH_EXT = /\.(stl|obj|3mf)$/i;

/** Walk a DataTransfer (files and folders). Resolves to [{name, path, file}] */
export async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) {
    for (const f of Array.from(dt.files || [])) out.push({ name: f.name, path: f.name, file: f });
    return out;
  }
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ name: file.name, path: prefix + file.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export function filesFromInput(input) {
  return Array.from(input.files || []).map((f) => ({ name: f.name, path: f.webkitRelativePath || f.name, file: f }));
}

/**
 * Expand a list of picked files into mesh bodies and project files.
 * @returns {Promise<{bodies:{name:string, path:string, positions:Float32Array, size:number}[], projects:object[], skipped:string[]}>}
 */
export async function loadInputs(files, onStatus = () => {}) {
  const bodies = [];
  const projects = [];
  const skipped = [];
  const queue = [];
  for (const f of files) queue.push({ name: f.name, path: f.path, get: () => f.file.arrayBuffer() });
  while (queue.length) {
    const f = queue.shift();
    const lower = f.name.toLowerCase();
    if (/(^|\/)(__macosx|\.)/i.test(f.path) && !/\.json$/i.test(f.name)) continue;
    try {
      if (lower.endsWith('.zip')) {
        onStatus(`Unpacking ${f.name}…`);
        const entries = await unzip(new Uint8Array(await f.get()));
        for (const e of entries) {
          const nm = e.name.split('/').pop();
          if (!nm || e.name.includes('__MACOSX')) continue;
          queue.push({ name: nm, path: f.name.replace(/\.zip$/i, '') + '/' + e.name, get: async () => e.data });
        }
      } else if (lower.endsWith('.json')) {
        const text = new TextDecoder().decode(new Uint8Array(await f.get()));
        const j = JSON.parse(text);
        if (j && j.format === 'stl-assembler-project') projects.push(j);
        else skipped.push(f.name);
      } else if (MESH_EXT.test(lower)) {
        onStatus(`Reading ${f.name}…`);
        const buf = await f.get();
        const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const base = f.name.replace(/\.[^.]+$/, '');
        if (lower.endsWith('.stl')) {
          const { positions, solids } = parseSTL(ab);
          if (solids.length > 1) {
            for (const s of solids) bodies.push({ name: `${base} – ${s.name || 'solid'}`, path: f.path + '#' + s.name, positions: positions.slice(s.start * 9, (s.start + s.count) * 9), size: ab.byteLength });
          } else if (positions.length) bodies.push({ name: base, path: f.path, positions, size: ab.byteLength });
        } else if (lower.endsWith('.obj')) {
          const { positions, solids } = parseOBJ(ab);
          if (solids.length > 1) {
            for (const s of solids) bodies.push({ name: `${base} – ${s.name || 'object'}`, path: f.path + '#' + s.name, positions: positions.slice(s.start * 9, (s.start + s.count) * 9), size: ab.byteLength });
          } else if (positions.length) bodies.push({ name: base, path: f.path, positions, size: ab.byteLength });
        } else if (lower.endsWith('.3mf')) {
          const list = await read3MF(new Uint8Array(ab));
          if (list.length === 1) bodies.push({ name: base, path: f.path, positions: list[0].positions, size: ab.byteLength });
          else list.forEach((b, i) => bodies.push({ name: b.name && !/^object \d+$/.test(b.name) ? b.name : `${base} – ${i + 1}`, path: f.path + '#' + i, positions: b.positions, size: ab.byteLength }));
        }
      } else {
        skipped.push(f.name);
      }
    } catch (err) {
      console.error(err);
      skipped.push(`${f.name} (${err.message || err})`);
    }
  }
  return { bodies, projects, skipped };
}

export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Apply a 4x4 (column-major array) to a triangle soup */
export function transformSoup(positions, M, dz = 0) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14] + dz;
  }
  return out;
}

export async function exportBodies(kind, bodies, name) {
  const safe = (name || 'assembly').replace(/[^\w\- .]+/g, '_');
  if (kind === 'stl-bin') return download(writeSTLBinary(bodies, `STL Assembler: ${bodies.length} bodies`), `${safe}.stl`, 'model/stl');
  if (kind === 'stl-ascii') return download(writeSTLAscii(bodies), `${safe}.stl`, 'model/stl');
  if (kind === '3mf-objects') return download(await write3MF(bodies, { mode: 'objects', name }), `${safe}.3mf`, 'model/3mf');
  if (kind === '3mf-assembly') return download(await write3MF(bodies, { mode: 'assembly', name }), `${safe}.3mf`, 'model/3mf');
  if (kind === 'zip') {
    const files = bodies.map((b) => ({ name: `${b.name}.stl`, data: new Uint8Array(writeSTLBinary([b])) }));
    return download(await zipFiles(files), `${safe}_parts.zip`, 'application/zip');
  }
  throw new Error('unknown export ' + kind);
}

export { zipFiles, writeSTLBinary };
