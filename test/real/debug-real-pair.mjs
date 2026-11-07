// node test/real/debug-real-pair.mjs <fixedFile> <movingFile> [kitdir]
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../../src/core/stl.js';
import { analyzePart } from '../../src/core/features.js';
import { pairHypotheses, evalPose, featureMatches } from '../../src/core/match.js';
import { mMul, mInvRigid, mPoint, nearestCube, withRotation } from '../../src/core/math.js';
import { sdfSample } from '../../src/core/sdf.js';
const [fa, fb, kit] = process.argv.slice(2);
const dir = kit || path.join(path.dirname(new URL(import.meta.url).pathname), 'nerf-blaster');
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json')));
const load = (f) => analyzePart(parseSTL(new Uint8Array(fs.readFileSync(path.join(dir, 'parts', f)))).positions);
const A = load(fa), B = load(fb);
let G = mMul(mInvRigid(truth.parts[fa].poses[0]), truth.parts[fb].poses[0]);
const nc = nearestCube(G);
if (nc.angle < 6) G = withRotation(G, nc.C, B.stats.centroid);
const err = (T) => {
  const M = mMul(mInvRigid(G), T);
  let s = 0, k = 0;
  for (let i = 0; i < B.samples.n; i += 4) {
    const p = mPoint(M, [B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
    s += Math.abs(sdfSample(B.sdf, p[0], p[1], p[2]));
    k++;
  }
  return s / k;
};
const e = evalPose(A, B, G), fm = featureMatches(A, B, G);
console.log('REFERENCE (snapped):', { score: (e.score + 0.1 * fm.score).toFixed(3), contact: e.contact.toFixed(3), pen: e.pen.toFixed(4), feat: fm.score.toFixed(2), mates: fm.mates.map((m) => m.type + (m.kind ? '/' + m.kind : '')).join(' ') });
const t0 = Date.now();
const hs = pairHypotheses(A, B, { keep: 12, cube: true, debugTiming: true });
console.log('hyps', hs.length, Date.now() - t0, 'ms');
for (const h of hs) console.log(`${h.source.padEnd(15)} score=${h.score.toFixed(3)} c=${h.contact.toFixed(3)} pen=${h.pen.toFixed(4)} feat=${h.feat.toFixed(2)} err=${err(h.T).toFixed(2)} ${JSON.stringify(h.info).slice(0, 80)}`);
