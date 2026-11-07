// Debug helper: compare truth pose vs. generated hypotheses for one pair.
//   node test/debug-pair.mjs <kit> <fixedFile> <movingFile>
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../src/core/stl.js';
import { analyzePart } from '../src/core/features.js';
import { pairHypotheses, evalPose, featureMatches } from '../src/core/match.js';
import { mMul, mInvRigid, mPoint } from '../src/core/math.js';
import { sdfSample } from '../src/core/sdf.js';
const [kit, fa, fb] = process.argv.slice(2);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', kit);
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const load = (f) => analyzePart(parseSTL(new Uint8Array(fs.readFileSync(path.join(dir, f)))).positions);
const A = load(fa), B = load(fb);
const errs = (T, G) => {
  const M = mMul(mInvRigid(G), T);
  let s = 0;
  for (let i = 0; i < B.samples.n; i += 4) {
    const p = mPoint(M, [B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
    s += Math.abs(sdfSample(B.sdf, p[0], p[1], p[2]));
  }
  return s / (B.samples.n / 4);
};
const GA = truth.parts[fa].poses[0];
const truths = truth.parts[fb].poses.map((g) => mMul(mInvRigid(GA), g));
for (const G of truths) {
  const e = evalPose(A, B, G);
  const fm = featureMatches(A, B, G);
  console.log('TRUTH', { score: e.score.toFixed(3), contact: e.contact.toFixed(3), pen: e.pen.toFixed(4), feat: fm.score, mates: fm.mates.map((m) => m.type + ':' + m.a + '<-' + m.b + (m.kind ? '/' + m.kind : '')).join(' ') });
}
console.log('A cyls', A.cyls.map((c) => `${c.id}:${c.concave ? 'H' : 'P'}${c.r.toFixed(2)}${c.full ? '' : '~' + Math.round(c.span * 57.3)}`).join(' '));
console.log('B cyls', B.cyls.map((c) => `${c.id}:${c.concave ? 'H' : 'P'}${c.r.toFixed(2)}${c.full ? '' : '~' + Math.round(c.span * 57.3)}`).join(' '));
console.log('A rects', A.rects.map((r) => `${r.id}:${r.concave ? 'H' : 'P'}${r.w1.toFixed(1)}x${r.w2.toFixed(1)}`).join(' '));
console.log('B rects', B.rects.map((r) => `${r.id}:${r.concave ? 'H' : 'P'}${r.w1.toFixed(1)}x${r.w2.toFixed(1)}`).join(' '));
const t0 = Date.now();
const hs = pairHypotheses(A, B, { keep: 12 });
console.log('hyps', hs.length, Date.now() - t0, 'ms');
for (const h of hs) {
  const e = Math.min(...truths.map((G) => errs(h.T, G)));
  console.log(`${h.source.padEnd(11)} score=${h.score.toFixed(3)} c=${h.contact.toFixed(3)} pen=${h.pen.toFixed(4)} feat=${h.feat} err=${e.toFixed(3)} ${JSON.stringify(h.info)}`);
}
