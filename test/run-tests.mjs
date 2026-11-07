// End-to-end alignment test on the synthetic kits: analyse every STL, run the
// auto-assembler and compare each part's pose (relative to the root) with the
// ground truth using a symmetry-tolerant surface distance.
//   node test/run-tests.mjs [kit]
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../src/core/stl.js';
import { analyzePart } from '../src/core/features.js';
import { autoAssemble } from '../src/core/assemble.js';
import { mMul, mInvRigid, mPoint, mDir, mAxisAngle, rad } from '../src/core/math.js';
import { sdfSample } from '../src/core/sdf.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const only = process.argv[2];

/** mean |sdf| of B samples placed by E, measured against B placed by G (symmetric-safe) */
function poseError(an, E, G) {
  const M = mMul(mInvRigid(G), E);
  const s = an.samples;
  let sum = 0, mx = 0;
  for (let i = 0; i < s.n; i += 4) {
    const p = mPoint(M, [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]]);
    const d = Math.abs(sdfSample(an.sdf, p[0], p[1], p[2]));
    sum += d;
    mx = Math.max(mx, d);
  }
  return { mean: sum / Math.ceil(s.n / 4), max: mx };
}

let failures = 0, checks = 0;
for (const kit of fs.readdirSync(FIX)) {
  if (only && kit !== only) continue;
  const dir = path.join(FIX, kit);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const parts = [];
  let t0 = Date.now();
  for (const f of Object.keys(truth.parts)) {
    const buf = fs.readFileSync(path.join(dir, f));
    const { positions } = parseSTL(new Uint8Array(buf));
    parts.push({ id: f, name: f, an: analyzePart(positions) });
  }
  const tA = Date.now() - t0;
  t0 = Date.now();
  const res = autoAssemble(parts, {});
  const tM = Date.now() - t0;
  console.log(`\n=== ${kit}: analyse ${tA} ms, assemble ${tM} ms, root=${res.root}`);
  const G = (id) => truth.parts[id].poses[0];
  const rootE = res.poses[res.root], rootG = G(res.root);
  let alts = 0;
  for (const id of res.order.concat(res.unplaced)) {
    const base = id.split('#')[0];
    const an = parts.find((p) => p.id === base).an;
    const tp = truth.parts[base];
    const truthPoses = [];
    for (const g of tp.poses) {
      const Gr = mMul(mInvRigid(rootG), g);
      if (tp.freeAxis) {
        const ip = mInvRigid(rootG);
        const p = mPoint(ip, tp.freeAxis.p), d = mDir(ip, tp.freeAxis.d);
        for (let a = 0; a < 360; a += 1) truthPoses.push(mMul(mAxisAngle(d, rad(a), p), Gr));
      } else truthPoses.push(Gr);
    }
    const errOf = (W) => {
      const E = mMul(mInvRigid(rootE), W);
      let best = null;
      for (const Gr of truthPoses) {
        const e = poseError(an, E, Gr);
        if (!best || e.mean < best.mean) best = e;
      }
      return best;
    };
    const isOk = (e) => e.mean < 0.05 && e.max < 0.6;
    const pl = res.placements[id];
    const e = errOf(res.poses[id]);
    let ok = isOk(e);
    let tag = ok ? 'OK  ' : 'FAIL';
    if (!ok && pl.alternatives) {
      const k = pl.alternatives.findIndex((a) => isOk(errOf(a.W)));
      if (k >= 0) {
        tag = 'ALT' + (k + 1);
        if (tp.symmetricAlt || pl.status === 'ambiguous') {
          ok = true;
          alts++;
        }
      }
    }
    const note = tp.note ? ` (${tp.note})` : '';
    if (id !== res.root) {
      checks++;
      if (!ok) failures++;
    }
    console.log(`${tag} ${id.padEnd(26)} ${String(pl.status).padEnd(9)} err mean=${e.mean.toFixed(3)} max=${e.max.toFixed(3)} score=${(pl.score ?? 0).toFixed(3)} margin=${(pl.margin ?? 0).toFixed(2)} via=${pl.source ?? ''}/${pl.from ?? ''} alts=${pl.alternatives?.length ?? 0}${note}`);
  }
  if (alts) console.log(`(${alts} ambiguous part(s) resolved by an offered alternative)`);
  const mates = res.mates.map((m) => `${m.type}${m.kind ? '(' + m.kind + ')' : ''} ${m.a.part}:${m.a.f} <- ${m.b.part}:${m.b.f}`);
  console.log('mates:', mates.length);
  if (process.env.VERBOSE) for (const m of mates) console.log('   ', m);
}
console.log(`\n${checks - failures}/${checks} parts placed correctly`);
process.exit(failures ? 1 : 0);
