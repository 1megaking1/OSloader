// Derives reference poses for a real kit from an assembled multi-solid STL
// exported by this tool (triangle order is preserved per part, so each
// solid maps to its source file by exact vertex correspondence).
//   node test/real/make-truth.mjs test/real/nerf-blaster
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../../src/core/stl.js';
import { unzip } from '../../src/core/zip.js';
import { kabsch, mPoint, mRotAngle, deg } from '../../src/core/math.js';

const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'nerf-blaster');
const refDir = path.join(dir, 'reference');
const ref = fs.readdirSync(refDir).find((f) => /\.(stl|zip)$/i.test(f));
let buf = fs.readFileSync(path.join(refDir, ref));
if (/\.zip$/i.test(ref)) {
  const entries = await unzip(new Uint8Array(buf));
  buf = entries.find((e) => /\.stl$/i.test(e.name) && !e.name.includes('__MACOSX')).data;
}
const { positions, solids } = parseSTL(new Uint8Array(buf));
const norm = (s) => s.toLowerCase().replace(/\.stl$/i, '').replace(/[\s_]+/g, '_');
const partFiles = fs.readdirSync(path.join(dir, 'parts')).filter((f) => /\.stl$/i.test(f));
const truth = { reference: ref, parts: {} };
for (const s of solids) {
  const file = partFiles.find((f) => norm(f) === norm(s.name));
  if (!file) {
    console.log('no part file for solid', s.name);
    continue;
  }
  const src = parseSTL(new Uint8Array(fs.readFileSync(path.join(dir, 'parts', file)))).positions;
  if (src.length / 9 !== s.count) {
    console.log('triangle count mismatch', s.name, src.length / 9, s.count);
    continue;
  }
  const P = [], Q = [];
  const step = Math.max(1, Math.floor(src.length / 3 / 4000));
  for (let i = 0; i < src.length / 3; i += step) {
    P.push([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]);
    const j = s.start * 9 + i * 3;
    Q.push([positions[j], positions[j + 1], positions[j + 2]]);
  }
  const T = kabsch(P, Q);
  let rms = 0;
  for (let i = 0; i < P.length; i++) {
    const p = mPoint(T, P[i]);
    rms += (p[0] - Q[i][0]) ** 2 + (p[1] - Q[i][1]) ** 2 + (p[2] - Q[i][2]) ** 2;
  }
  rms = Math.sqrt(rms / P.length);
  truth.parts[file] = { poses: [T], note: 'reference assembled by hand (approximate)' };
  console.log(`${file.padEnd(40)} rms ${rms.toExponential(1)}  rotation ${deg(mRotAngle(T)).toFixed(2)} deg`);
}
for (const f of partFiles) if (!truth.parts[f]) truth.parts[f] = { poses: [], note: 'not in reference assembly' };
fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truth, null, 1));
console.log('wrote', path.join(dir, 'truth.json'));
