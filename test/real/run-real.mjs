// Auto-assembles a real kit and compares each part with the (hand-made,
// approximate) reference assembly.
//   node test/real/run-real.mjs [kitdir] [--root=<file>]
// Relative rotations of the reference are snapped to the nearest 90-degree
// multiple when within 6 degrees (the reference was aligned by hand).
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../../src/core/stl.js';
import { analyzePart } from '../../src/core/features.js';
import { autoAssemble } from '../../src/core/assemble.js';
import { mMul, mInvRigid, mPoint, mRotAngle, deg, dist } from '../../src/core/math.js';
import { sdfSample } from '../../src/core/sdf.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || path.join(path.dirname(new URL(import.meta.url).pathname), 'nerf-blaster');
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const files = fs.readdirSync(path.join(dir, 'parts')).filter((f) => /\.stl$/i.test(f)).sort();

const cube = [];
const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
for (const x of axes) for (const y of axes) {
  if (Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) > 0.5) continue;
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  cube.push([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
}
const rotOnly = (M) => [M[0], M[1], M[2], 0, M[4], M[5], M[6], 0, M[8], M[9], M[10], 0, 0, 0, 0, 1];
function snap(M, c) {
  let best = null;
  for (const C of cube) {
    const d = deg(mRotAngle(mMul(mInvRigid(C), rotOnly(M))));
    if (!best || d < best.d) best = { d, C };
  }
  if (best.d > 6) return M;
  const p = mPoint(M, c), q = mPoint(best.C, c);
  const out = best.C.slice();
  out[12] = p[0] - q[0];
  out[13] = p[1] - q[1];
  out[14] = p[2] - q[2];
  return out;
}

const parts = [];
let t0 = Date.now();
for (const f of files) {
  const positions = parseSTL(new Uint8Array(fs.readFileSync(path.join(dir, 'parts', f)))).positions;
  parts.push({ id: f, name: f, an: analyzePart(positions) });
}
const tA = Date.now() - t0;
t0 = Date.now();
const root = opt.root || null;
const res = autoAssemble(parts, { root, debug: !!opt.debug });
const tM = Date.now() - t0;
console.log(`analyse ${(tA / 1000).toFixed(1)} s, assemble ${(tM / 1000).toFixed(1)} s, root=${res.root}`);

const refRoot = truth.parts[res.root]?.poses[0] ? res.root : 'Frame_Receiver_V10_reduced.stl';
const G0 = truth.parts[refRoot].poses[0];
const E0 = res.poses[refRoot];
let good = 0, close = 0, bad = 0, n = 0, alts = 0;
for (const id of res.order.concat(res.unplaced)) {
  const base = id.split('#')[0];
  const tp = truth.parts[base];
  const pl = res.placements[id];
  const an = parts.find((p) => p.id === base).an;
  let line = `${id.padEnd(40)} ${String(pl.status).padEnd(9)} via=${(pl.source || '').padEnd(10)} from=${(pl.from || '').slice(0, 26).padEnd(26)}`;
  if (!tp || !tp.poses.length || !E0) {
    console.log('  -   ' + line + ' (no reference)');
    continue;
  }
  const Gr = snap(mMul(mInvRigid(G0), tp.poses[0]), an.stats.centroid);
  const Er = mMul(mInvRigid(E0), res.poses[id]);
  const rot = deg(mRotAngle(mMul(mInvRigid(rotOnly(Gr)), rotOnly(Er))));
  const cd = dist(mPoint(Gr, an.stats.centroid), mPoint(Er, an.stats.centroid));
  // symmetry tolerant surface distance
  const surfErr = (W) => {
    const M = mMul(mInvRigid(Gr), mMul(mInvRigid(E0), W));
    let s = 0, k = 0;
    for (let i = 0; i < an.samples.n; i += 4) {
      const p = mPoint(M, [an.samples.pos[i * 3], an.samples.pos[i * 3 + 1], an.samples.pos[i * 3 + 2]]);
      s += Math.abs(sdfSample(an.sdf, p[0], p[1], p[2]));
      k++;
    }
    return s / k;
  };
  const surf = surfErr(res.poses[id]);
  let altTag = '';
  if (surf >= 0.6 && pl.alternatives) {
    const k = pl.alternatives.findIndex((a) => surfErr(a.W) < 0.6);
    if (k >= 0) altTag = ` (correct pose offered as option #${k + 1})`;
  }
  if (id === refRoot) {
    console.log('ROOT ' + line);
    continue;
  }
  n++;
  const tag = surf < 0.6 ? 'GOOD' : surf < 3 ? 'NEAR' : 'OFF ';
  if (tag === 'GOOD') good++;
  else if (tag === 'NEAR') close++;
  else bad++;
  if (altTag) alts++;
  console.log(`${tag} ${line} surf=${surf.toFixed(2)}mm rot=${rot.toFixed(1)}° centroid=${cd.toFixed(1)}mm${altTag}`);
}
console.log(`\n${good} good, ${close} near, ${bad} off (of ${n} parts with a reference); ${alts} of the misses have the correct pose among their options`);
