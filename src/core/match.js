// Pairwise mating hypotheses. For a fixed part A and a moving part B, this
// enumerates rigid transforms T (B-local -> A-local) suggested by feature
// correspondences (bore/peg pairs, rectangular holes/pegs, matching planar
// faces, single bore + rotation sweep), resolves the remaining sliding DOF
// with plane contacts / slot centring, and scores every pose with the signed
// distance fields (contact area vs. interpenetration).

import {
  add, sub, scale, dot, cross, norm, len, dist, rad, deg,
  mMul, mInvRigid, mPoint, mDir, mFromBasis, mAxisAngle, mTranslation, mIdentity, mRotAngle,
  reject, kabsch, eigSym3,
} from './math.js';
import { sdfSample, sdfSampleGrad } from './sdf.js';

export const DEFAULTS = {
  contactTol: 0.45, // mm: surfaces closer than this count as touching (covers print clearances)
  penTol: 0.3, // mm: deeper than this counts as interpenetration
  maxClearance: 0.8, // mm: max radial clearance for a peg in a hole
  maxPress: 0.15, // mm: max interference for press fits
  slotClearance: 1.2, // mm: max total clearance tab-in-slot
  angTol: 2, // degrees
  stackGap: 6, // mm: max axial gap between two coaxial bores (screw through both)
  penWeight: 8,
  featWeight: 0.1,
  flatWeight: 0.5, // weight of contact along the single dominant normal direction
};

const _g = [0, 0, 0, 0];

// --------------------------------------------------------------- scoring

/**
 * Score samples of one part against the SDF of the other.
 * T maps sample coordinates into the SDF's frame. Only samples whose grid
 * cells overlap the SDF's box (mapped back into the sample frame) are tested.
 */
function sampleScore(sdf, samples, T, opt, stride = 1) {
  const { pos, nor, grid } = samples;
  let contact = 0, pen = 0, depth = 0, coin = 0;
  const S = [0, 0, 0, 0, 0, 0];
  const ct = opt.contactTol, pt = opt.penTol;
  // SDF box in sample-local coordinates
  const Ti = mInvRigid(T);
  const o = sdf.o, h = sdf.h, dm = sdf.dims;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = mPoint(Ti, [o[0] + (c & 1 ? dm[0] * h : 0), o[1] + (c & 2 ? dm[1] * h : 0), o[2] + (c & 4 ? dm[2] * h : 0)]);
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  const g = grid;
  const r0 = [0, 1, 2].map((k) => Math.max(0, Math.floor((lo[k] - g.o[k]) / g.cs)));
  const r1 = [0, 1, 2].map((k) => Math.min(g.dims[k] - 1, Math.floor((hi[k] - g.o[k]) / g.cs)));
  let tick = 0;
  for (let iz = r0[2]; iz <= r1[2]; iz++) {
    for (let iy = r0[1]; iy <= r1[1]; iy++) {
      for (let ix = r0[0]; ix <= r1[0]; ix++) {
        const cidx = ix + g.dims[0] * (iy + g.dims[1] * iz);
        for (let q = g.start[cidx]; q < g.start[cidx + 1]; q++) {
          if (stride > 1 && tick++ % stride) continue;
          const i = g.idx[q];
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          const px = T[0] * x + T[4] * y + T[8] * z + T[12];
          const py = T[1] * x + T[5] * y + T[9] * z + T[13];
          const pz = T[2] * x + T[6] * y + T[10] * z + T[14];
          const d = sdfSample(sdf, px, py, pz);
          if (d < -pt) {
            pen++;
            depth += Math.min(-d, 5);
          } else if (d < ct) {
            sdfSampleGrad(sdf, px, py, pz, _g);
            const gl = Math.hypot(_g[1], _g[2], _g[3]);
            if (gl > 1e-9) {
              const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
              const wx = T[0] * nx + T[4] * ny + T[8] * nz;
              const wy = T[1] * nx + T[5] * ny + T[9] * nz;
              const wz = T[2] * nx + T[6] * ny + T[10] * nz;
              const cosn = (wx * _g[1] + wy * _g[2] + wz * _g[3]) / gl;
              // same-facing coincident surface: the two solids overlap here
              if (cosn > 0.7 && d > -pt && d < Math.min(ct, 0.2)) coin++;
              if (cosn < -0.5) {
                contact++;
                S[0] += wx * wx;
                S[1] += wx * wy;
                S[2] += wx * wz;
                S[3] += wy * wy;
                S[4] += wy * wz;
                S[5] += wz * wz;
              }
            }
          }
        }
      }
    }
  }
  return { contact: contact * stride, pen: (pen + coin) * stride, coin: coin * stride, depth: depth * stride, S: S.map((v) => v * stride) };
}

/** rotate symmetric scatter matrix S (6 comps) by rotation part of M: R S R^T */
function rotScatter(S, M) {
  const A = [
    [S[0], S[1], S[2]],
    [S[1], S[3], S[4]],
    [S[2], S[4], S[5]],
  ];
  const R = [
    [M[0], M[4], M[8]],
    [M[1], M[5], M[9]],
    [M[2], M[6], M[10]],
  ];
  const RA = R.map((row) => [0, 1, 2].map((j) => row[0] * A[0][j] + row[1] * A[1][j] + row[2] * A[2][j]));
  const O = RA.map((row) => [0, 1, 2].map((j) => row[0] * R[j][0] + row[1] * R[j][1] + row[2] * R[j][2]));
  return [O[0][0], O[0][1], O[0][2], O[1][1], O[1][2], O[2][2]];
}

/** Score pose T (B -> A). Returns normalised score and raw parts. */
export function evalPose(A, B, T, opt = DEFAULTS, stride = 1) {
  const sB = sampleScore(A.sdf, B.samples, T, opt, stride);
  const Ti = mInvRigid(T);
  const sA = sampleScore(B.sdf, A.samples, Ti, opt, stride);
  const cB = sB.contact * B.samples.areaPer, cA = sA.contact * A.samples.areaPer;
  const pB = sB.pen * B.samples.areaPer, pA = sA.pen * A.samples.areaPer;
  const base = Math.min(A.stats.area, B.stats.area);
  // contact normal scatter in A's frame (B side is already in A frame)
  const SA = rotScatter(sA.S, T);
  // weight each side by sampling density (inverse variance of a counting estimate)
  const wB = 1 / (B.samples.areaPer * B.samples.areaPer), wA = 1 / (A.samples.areaPer * A.samples.areaPer);
  const fB = wB / (wA + wB), fA = wA / (wA + wB);
  const M6 = [0, 1, 2, 3, 4, 5].map((k) => sB.S[k] * B.samples.areaPer * fB + SA[k] * A.samples.areaPer * fA);
  const ev = eigSym3(M6).values; // ascending
  // interlock weighting: contact that all faces one direction is weaker evidence
  const lam = ev.map((v) => Math.max(0, v));
  const weighted = opt.flatWeight * lam[2] + lam[1] + lam[0];
  const raw = cA * fA + cB * fB;
  const contactArea = raw > 0 ? weighted * (raw / Math.max(1e-9, lam[0] + lam[1] + lam[2])) : 0;
  const contact = contactArea / base;
  const pen = Math.max(pA, pB) / base;
  return { contact, pen, contactArea, rawContact: raw / base, penArea: Math.max(pA, pB), score: contact - opt.penWeight * pen };
}

// ------------------------------------------------------------ utilities

/** Typical printed fits are 0.05-0.3 mm radial; looser fits are less likely to be intended. */
export const clearanceWeight = (cl) => (cl <= 0.3 ? 1 : Math.max(0.35, 1 - (cl - 0.3) * 1.2));

const usableCyl = (c) => c.span >= rad(150) && c.r >= 0.4 && c.len >= 0.4;

/** Can B's cylinder sit coaxially with A's cylinder? returns kind or null */
export function cylCompat(cb, ca, opt = DEFAULTS) {
  if (cb.concave !== ca.concave) {
    const hole = cb.concave ? cb : ca, peg = cb.concave ? ca : cb;
    const cl = hole.r - peg.r;
    if (cl < -opt.maxPress || cl > Math.max(opt.maxClearance, 0.06 * hole.r)) return null;
    return 'insert';
  }
  if (cb.concave && ca.concave) {
    if (Math.abs(ca.r - cb.r) <= Math.max(0.6, 0.3 * Math.max(ca.r, cb.r))) return 'stack';
    return null;
  }
  // two pegs coaxial: only partial (split) bosses that close up
  if (!cb.full && !ca.full && Math.abs(ca.r - cb.r) < 0.3) return 'stack';
  return null;
}

function cylWorld(c, T) {
  return { a: norm(mDir(T, c.a)), c: mPoint(T, c.c), r: c.r, t0: c.t0, t1: c.t1, len: c.len, concave: c.concave, full: c.full, span: c.span };
}

/** perpendicular distance between B's (world) axis point and A's axis line */
function lineDist(p, ca) {
  const d = sub(p, ca.c);
  return len(reject(d, ca.a));
}

/** Overlap length of two coaxial cylinders along A's axis */
function axialOverlap(cbw, ca) {
  const tb = dot(sub(cbw.c, ca.c), ca.a);
  const lo = Math.max(ca.t0, tb - cbw.len / 2), hi = Math.min(ca.t1, tb + cbw.len / 2);
  return hi - lo;
}

/** Transform mapping frame (oB, xB, zB) in B onto (oA, xA, zA) in A. */
function frameMap(oA, xA, zA, oB, xB, zB) {
  const FA = mFromBasis(xA, cross(zA, xA), zA, oA);
  const FB = mFromBasis(xB, cross(zB, xB), zB, oB);
  return mMul(FA, mInvRigid(FB));
}

/**
 * Count feature level matches under T: coaxial cylinders, centred tabs,
 * touching planes. Returns {count, mates[]}.
 */
export function featureMatches(A, B, T, opt = DEFAULTS) {
  const mates = [];
  const cosT = Math.cos(rad(opt.angTol));
  let score = 0;
  const usedA = new Set();
  for (const cb of B.cyls) {
    if (!usableCyl(cb)) continue;
    const w = cylWorld(cb, T);
    let best = null;
    for (const ca of A.cyls) {
      if (!usableCyl(ca) || usedA.has('c' + ca.id)) continue;
      if (Math.abs(dot(w.a, ca.a)) < cosT) continue;
      const kind = cylCompat(cb, ca, opt);
      if (!kind) continue;
      const d = Math.max(lineDist(w.c, ca), lineDist(add(w.c, scale(w.a, w.len / 2)), ca));
      if (d > 0.3) continue;
      const ov = axialOverlap(w, ca);
      if (kind === 'insert' && ov < Math.min(0.5, 0.3 * Math.min(cb.len, ca.len))) continue;
      if (kind === 'stack' && (ov < -opt.stackGap || ov > 0.3 * Math.min(cb.len, ca.len))) continue;
      const wgt = kind === 'insert' ? 3 * clearanceWeight(Math.abs(ca.r - cb.r)) : 1.5 * Math.exp(-Math.max(0, -ov) / 4);
      if (!best || wgt - d > best.wgt - best.d) best = { ca, d, kind, wgt };
    }
    if (best) {
      usedA.add('c' + best.ca.id);
      mates.push({ type: 'coaxial', a: 'c' + best.ca.id, b: 'c' + cb.id, kind: best.kind, err: best.d });
      score += best.wgt;
    }
  }
  // tab / slot centring
  for (const pb of B.pairs) {
    const nb = norm(mDir(T, pb.n));
    const mb = mPoint(T, pb.mid);
    for (const pa of A.pairs) {
      if (pa.concave === pb.concave) continue;
      if (Math.abs(dot(nb, pa.n)) < cosT) continue;
      const slot = pa.concave ? pa : pb, tab = pa.concave ? pb : pa;
      const cl = slot.width - tab.width;
      if (cl < -opt.maxPress || cl > opt.slotClearance) continue;
      const off = Math.abs(dot(sub(mb, pa.mid), pa.n));
      if (off > Math.max(0.3, cl / 2 + 0.1)) continue;
      // in-plane proximity: tab's mid point should lie within the slot region roughly
      const inPlane = len(reject(sub(mb, pa.mid), pa.n));
      const reach = Math.sqrt(Math.max(A.planes[pa.i].area, B.planes[pb.i].area)) * 1.2 + 2;
      if (inPlane > reach) continue;
      if (usedA.has('s' + pa.id)) continue;
      usedA.add('s' + pa.id);
      mates.push({ type: 'centered', a: 's' + pa.id, b: 's' + pb.id, err: off, clearance: cl });
      score += 1.5;
      break;
    }
  }
  return { score, mates };
}

// ------------------------------------------------------ axial resolution

/**
 * Given T whose remaining freedom is a translation along unit axis ax (A
 * frame), propose shifts that bring planes into contact or centre tabs in
 * slots. `checks` are coaxial correspondences that must stay engaged.
 */
function axialShifts(A, B, T, ax, checks, opt) {
  const cosT = Math.cos(rad(3));
  const shifts = [];
  const Bp = B.planes.map((p) => ({ n: norm(mDir(T, p.n)), c: mPoint(T, p.c), area: p.area }));
  for (const pb of Bp) {
    const ab = dot(pb.n, ax);
    if (Math.abs(ab) < cosT) continue;
    for (const pa of A.planes) {
      const aa = dot(pa.n, ax);
      if (Math.abs(aa) < cosT) continue;
      const s = dot(sub(pa.c, pb.c), pa.n) / aa;
      if (dot(pb.n, pa.n) < 0) shifts.push({ s, kind: 'contact', w: Math.min(pb.area, pa.area) });
      else shifts.push({ s, kind: 'flush', w: 0.3 * Math.min(pb.area, pa.area) });
    }
  }
  for (const qb of B.pairs) {
    const nb = norm(mDir(T, qb.n));
    if (Math.abs(dot(nb, ax)) < cosT) continue;
    const mb = mPoint(T, qb.mid);
    for (const qa of A.pairs) {
      if (qa.concave === qb.concave) continue;
      const aa = dot(qa.n, ax);
      if (Math.abs(aa) < cosT) continue;
      const slot = qa.concave ? qa : qb, tab = qa.concave ? qb : qa;
      const cl = slot.width - tab.width;
      if (cl < -opt.maxPress || cl > opt.slotClearance) continue;
      const s = dot(sub(qa.mid, mb), qa.n) / aa;
      shifts.push({ s, kind: 'centered', w: 1e6 });
    }
  }
  // engagement window from the coaxial checks
  let lo = -Infinity, hi = Infinity;
  for (const ck of checks) {
    const w = cylWorld(ck.cb, T);
    const tb = dot(sub(w.c, ck.ca.c), ck.ca.a) * Math.sign(dot(ck.ca.a, ax) || 1);
    // shift s moves tb by s (along ax, which is parallel to ca.a up to sign)
    const sgn = Math.sign(dot(ck.ca.a, ax) || 1);
    const ta0 = ck.ca.t0 * sgn, ta1 = ck.ca.t1 * sgn;
    let aLo = Math.min(ta0, ta1), aHi = Math.max(ta0, ta1);
    // extend over coaxial sibling bores of A (e.g. both ears of a clevis)
    if (ck.ca.id != null && ck.cb.r != null) {
      for (const sb of A.cyls) {
        if (sb === ck.ca || !usableCyl(sb)) continue;
        if (Math.abs(dot(sb.a, ck.ca.a)) < Math.cos(rad(1))) continue;
        if (lineDist(sb.c, ck.ca) > 0.15) continue;
        if (cylCompat(ck.cb, sb, opt) !== ck.kind) continue;
        const t = dot(sub(sb.c, ck.ca.c), ax);
        aLo = Math.min(aLo, t - sb.len / 2);
        aHi = Math.max(aHi, t + sb.len / 2);
      }
    }
    if (ck.kind === 'insert') {
      const need = Math.min(0.5, 0.3 * Math.min(ck.cb.len, ck.ca.len));
      // overlap of [tb+s-L/2, tb+s+L/2] with [aLo,aHi] >= need
      lo = Math.max(lo, aLo - (tb + w.len / 2) + need);
      hi = Math.min(hi, aHi - (tb - w.len / 2) - need);
    } else {
      lo = Math.max(lo, aLo - (tb + w.len / 2) - opt.stackGap);
      hi = Math.min(hi, aHi - (tb - w.len / 2) + opt.stackGap);
    }
  }
  if (lo > hi) return [];
  let cands = shifts.filter((x) => x.s >= lo - 1e-6 && x.s <= hi + 1e-6);
  // fallbacks: centre of the engagement window
  if (isFinite(lo) && isFinite(hi)) cands.push({ s: (lo + hi) / 2, kind: 'centre', w: 1e5 });
  else if (!cands.length) cands.push({ s: 0, kind: 'none', w: 0 });
  // dedupe
  cands.sort((a, b) => a.s - b.s);
  const out = [];
  for (const c of cands) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.s - c.s) < 0.02) {
      if (c.w > last.w) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

function shiftT(T, ax, s) {
  return mMul(mTranslation(scale(ax, s)), T);
}

// ------------------------------------------------------------ generators

function cylPairs(P, ordered) {
  const cs = P.cyls.filter(usableCyl);
  const out = [];
  const cosT = Math.cos(rad(1.5));
  for (let i = 0; i < cs.length; i++) {
    for (let j = ordered ? i + 1 : 0; j < cs.length; j++) {
      if (i === j) continue;
      const a = cs[i], b = cs[j];
      if (Math.abs(dot(a.a, b.a)) < cosT) continue;
      const dv = reject(sub(b.c, a.c), a.a);
      const d = len(dv);
      if (d < 1.0) continue; // coaxial pair: does not fix rotation
      out.push({ a, b, d, x: scale(dv, 1 / d) });
    }
  }
  return out;
}

function genCylPairs(A, B, opt, push) {
  const pa = cylPairs(A, false), pb = cylPairs(B, true);
  if (!pa.length || !pb.length) return;
  pa.sort((x, y) => x.d - y.d);
  for (const q of pb) {
    const tol = 0.3 + 0.01 * q.d;
    // binary search window on d
    let lo = 0, hi = pa.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (pa[m].d < q.d - tol) lo = m + 1;
      else hi = m;
    }
    for (let k = lo; k < pa.length && pa[k].d <= q.d + tol; k++) {
      const p = pa[k];
      const k1 = cylCompat(q.a, p.a, opt), k2 = cylCompat(q.b, p.b, opt);
      if (!k1 || !k2) continue;
      if (k1 === 'stack' && k2 === 'stack' && q.a.r < 1.0) continue;
      for (const s of [1, -1]) {
        const zA = scale(p.a.a, s);
        const T0 = frameMap(p.a.c, p.x, zA, q.a.c, q.x, q.a.a);
        const checks = [
          { cb: q.a, ca: p.a, kind: k1 },
          { cb: q.b, ca: p.b, kind: k2 },
        ];
        for (const sh of axialShifts(A, B, T0, zA, checks, opt)) {
          push(shiftT(T0, zA, sh.s), 'bore-pair', { shift: sh.kind, cyl: [q.a.id, p.a.id, q.b.id, p.b.id] });
        }
      }
    }
  }
}

function genRects(A, B, opt, push) {
  for (const rb of B.rects) {
    for (const ra of A.rects) {
      if (rb.concave === ra.concave) continue;
      const hole = ra.concave ? ra : rb, peg = ra.concave ? rb : ra;
      const fits = (h1, h2, p1, p2) => {
        const c1 = h1 - p1, c2 = h2 - p2;
        return c1 >= -opt.maxPress && c1 <= opt.slotClearance && c2 >= -opt.maxPress && c2 <= opt.slotClearance;
      };
      const assignments = [];
      if (fits(hole.w1, hole.w2, peg === rb ? rb.w1 : ra.w1, peg === rb ? rb.w2 : ra.w2)) assignments.push(false);
      if (fits(hole.w1, hole.w2, peg === rb ? rb.w2 : ra.w2, peg === rb ? rb.w1 : ra.w1)) assignments.push(true);
      // assignment: map rb.d1 -> ra.d1 (false) or rb.d1 -> ra.d2 (true)
      for (const swap of assignments) {
        for (const s1 of [1, -1]) {
          for (const s2 of [1, -1]) {
            const xA = scale(swap ? ra.d2 : ra.d1, s1);
            const yA = scale(swap ? ra.d1 : ra.d2, s2);
            const zA = norm(cross(xA, yA));
            const zB = norm(cross(rb.d1, rb.d2));
            const T0 = frameMap(ra.center, xA, zA, rb.center, rb.d1, zB);
            const ck = {
              cb: { a: rb.axis, c: rb.center, len: rb.len, t0: rb.t0, t1: rb.t1 },
              ca: { a: ra.axis, c: ra.center, len: ra.len, t0: ra.t0, t1: ra.t1 },
              kind: 'insert',
            };
            for (const sh of axialShifts(A, B, T0, zA, [ck], opt)) push(shiftT(T0, zA, sh.s), 'rect', { shift: sh.kind });
          }
        }
      }
    }
  }
}

function bigPlanes(P, k, minFrac) {
  return P.planes
    .filter((p) => p.area >= Math.max(20, minFrac * P.stats.area))
    .sort((a, b) => b.area - a.area)
    .slice(0, k);
}

/** 2D rigid ICP of point set S onto D (both interleaved Float arrays). Returns {th, tx, ty, rms, inl} */
function icp2d(S, D, th0, iters = 12) {
  const ns = S.length / 2, nd = D.length / 2;
  let th = th0, tx = 0, ty = 0;
  let rms = Infinity, inl = 0;
  // initial translation: centroid alignment
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < ns; i++) {
    sx += S[2 * i];
    sy += S[2 * i + 1];
  }
  for (let i = 0; i < nd; i++) {
    dx += D[2 * i];
    dy += D[2 * i + 1];
  }
  sx /= ns; sy /= ns; dx /= nd; dy /= nd;
  {
    const c = Math.cos(th), s = Math.sin(th);
    tx = dx - (c * sx - s * sy);
    ty = dy - (s * sx + c * sy);
  }
  const P = new Float64Array(ns * 2), Q = new Float64Array(ns * 2), dd = new Float64Array(ns);
  for (let it = 0; it < iters; it++) {
    const c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < ns; i++) {
      const x = c * S[2 * i] - s * S[2 * i + 1] + tx, y = s * S[2 * i] + c * S[2 * i + 1] + ty;
      let best = Infinity, bx = 0, by = 0;
      for (let j = 0; j < nd; j++) {
        const ex = D[2 * j] - x, ey = D[2 * j + 1] - y;
        const e = ex * ex + ey * ey;
        if (e < best) {
          best = e;
          bx = D[2 * j];
          by = D[2 * j + 1];
        }
      }
      P[2 * i] = S[2 * i];
      P[2 * i + 1] = S[2 * i + 1];
      Q[2 * i] = bx;
      Q[2 * i + 1] = by;
      dd[i] = best;
    }
    // trimmed: use best 80%
    const sorted = Array.from(dd).sort((a, b) => a - b);
    const cut = sorted[Math.floor(sorted.length * 0.8)] + 1e-12;
    let mpx = 0, mpy = 0, mqx = 0, mqy = 0, w = 0;
    for (let i = 0; i < ns; i++) {
      if (dd[i] > cut) continue;
      mpx += P[2 * i]; mpy += P[2 * i + 1]; mqx += Q[2 * i]; mqy += Q[2 * i + 1]; w++;
    }
    mpx /= w; mpy /= w; mqx /= w; mqy /= w;
    let sxx = 0, sxy = 0;
    let ss = 0;
    inl = 0;
    for (let i = 0; i < ns; i++) {
      if (dd[i] > cut) continue;
      const px = P[2 * i] - mpx, py = P[2 * i + 1] - mpy, qx = Q[2 * i] - mqx, qy = Q[2 * i + 1] - mqy;
      sxx += px * qx + py * qy;
      sxy += px * qy - py * qx;
      ss += dd[i];
    }
    for (let i = 0; i < ns; i++) if (dd[i] < 0.25) inl++;
    th = Math.atan2(sxy, sxx);
    const c2 = Math.cos(th), s2 = Math.sin(th);
    tx = mqx - (c2 * mpx - s2 * mpy);
    ty = mqy - (s2 * mpx + c2 * mpy);
    rms = Math.sqrt(ss / w);
  }
  return { th, tx, ty, rms, inl: inl / ns };
}

function genFaces(A, B, opt, push) {
  const fb = bigPlanes(B, 10, 0.02), fa = bigPlanes(A, 16, 0.01);
  for (const pb of fb) {
    for (const pa of fa) {
      const ar = pb.area / pa.area;
      if (ar < 0.6 || ar > 1.6) continue;
      const g1 = Math.sqrt(pb.m1 / pa.m1), g2 = Math.sqrt((pb.m2 + 1e-9) / (pa.m2 + 1e-9));
      if (g1 < 0.8 || g1 > 1.25 || g2 < 0.75 || g2 > 1.33) continue;
      const iso = pa.m2 / pa.m1 > 0.8;
      const angles = iso ? Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6) : [0, Math.PI];
      // B face frame: (uB, vB, nB) at cB; target: B normal opposite to A normal.
      // In A's 2D frame, B's (u,v) map to (u', v') with mirror (because the normal flips):
      // B point (x,y) -> A 2D coords (x', y') = R(th) * (x, -y)
      const SB = new Float64Array(pb.boundary.length);
      for (let i = 0; i < pb.boundary.length / 2; i++) {
        SB[2 * i] = pb.boundary[2 * i];
        SB[2 * i + 1] = -pb.boundary[2 * i + 1];
      }
      const results = [];
      for (const th0 of angles) {
        const r = icp2d(SB, pa.boundary, th0);
        results.push(r);
      }
      results.sort((a, b) => a.rms - b.rms);
      const sizeTol = 0.6 + 0.01 * Math.sqrt(pa.area);
      let kept = 0;
      for (const r of results) {
        if (r.rms > sizeTol || r.inl < 0.5) continue;
        if (kept >= 2) break;
        kept++;
        // compose 3D transform: B-local -> B face frame -> mirror -> rotate/translate in A face frame -> A-local
        const FB = mFromBasis(pb.u, pb.v, pb.n, pb.c); // face coords -> B local
        const FA = mFromBasis(pa.u, pa.v, pa.n, pa.c); // face coords -> A local
        const c = Math.cos(r.th), s = Math.sin(r.th);
        // face-2D map: (x,y,z) -> (c x - s(-y) + tx, s x + c(-y) + ty, -z)
        const M = [c, s, 0, 0, s, -c, 0, 0, 0, 0, -1, 0, r.tx, r.ty, 0, 1];
        const T = mMul(FA, mMul(M, mInvRigid(FB)));
        push(T, 'face', { rms: r.rms, faceA: pa.id, faceB: pb.id });
      }
    }
  }
}

const shiftPrior = (k) => (k === 'centre' || k === 'centered' ? 0.02 : k === 'contact' ? 0.01 : 0);

/** Is B (nearly) a solid of revolution about cylinder c's axis? */
export function revolutionSymmetric(B, c) {
  if (B._revCache && B._revCache.has(c.id)) return B._revCache.get(c.id);
  const pts = [];
  const n = B.samples.n;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 96))) pts.push([B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
  let sym = true;
  for (const a of [37, 101, 211]) {
    const R = mAxisAngle(c.a, rad(a), c.c);
    if (!samePlace(B, pts, R, mIdentity(), 0.08)) {
      sym = false;
      break;
    }
  }
  if (!B._revCache) Object.defineProperty(B, '_revCache', { value: new Map(), enumerable: false });
  B._revCache.set(c.id, sym);
  return sym;
}

function genSingleCyl(A, B, opt, push) {
  const cb = B.cyls.filter((c) => usableCyl(c) && (c.full || c.span > rad(240))).sort((x, y) => y.r * y.len - x.r * x.len).slice(0, 3);
  if (!cb.length) return;
  const ca = A.cyls.filter((c) => usableCyl(c));
  const cosT = Math.cos(rad(3));
  for (const b of cb) {
    for (const a of ca) {
      const kind = cylCompat(b, a, opt);
      if (!kind) continue;
      for (const s of [1, -1]) {
        const zA = scale(a.a, s);
        // base transform: axis to axis, centres coincide; angle about axis free
        const xb = b.u, xa = norm(reject(a.u, zA));
        const T0 = frameMap(a.c, xa, zA, b.c, xb, b.a);
        // candidate angles: align B planes (normal perpendicular to axis) with A planes
        const angs = new Set();
        for (let k = 0; k < 12; k++) angs.add(k * 30);
        const Tb = T0;
        for (const pb of B.planes) {
          const nb = mDir(Tb, pb.n);
          if (Math.abs(dot(nb, zA)) > 0.05 || pb.area < 0.02 * B.stats.area) continue;
          for (const pa of A.planes) {
            if (Math.abs(dot(pa.n, zA)) > 0.05 || pa.area < 0.01 * A.stats.area) continue;
            for (const target of [scale(pa.n, -1), pa.n]) {
              // angle about zA rotating nb onto target
              const x1 = norm(reject(nb, zA)), x2 = norm(reject(target, zA));
              const ang = Math.atan2(dot(cross(x1, x2), zA), dot(x1, x2));
              angs.add(Math.round(((deg(ang) + 360) % 360) * 2) / 2);
            }
          }
        }
        // plane-alignment angles first (exact), then the uniform sweep
        const all = Array.from(angs);
        const uniform = all.slice(0, 12), aligned = all.slice(12);
        const angList = revolutionSymmetric(B, b) ? [0] : aligned.slice(0, 36).concat(uniform);
        const local = [];
        for (const ad of angList) {
          const R = mAxisAngle(zA, rad(ad), a.c);
          const T1 = mMul(R, T0);
          const checks = [{ cb: b, ca: a, kind }];
          const shifts = axialShifts(A, B, T1, zA, checks, opt).sort((x, y) => y.w - x.w).slice(0, 6);
          for (const sh of shifts) {
            const T = shiftT(T1, zA, sh.s);
            local.push({ T, ad, sh: sh.kind });
          }
        }
        // cheap prescreen to cap the count for this correspondence
        for (const l of local) l.q = evalPose(A, B, l.T, opt, 12).score + shiftPrior(l.sh);
        local.sort((x, y) => y.q - x.q);
        for (const l of local.slice(0, 8)) push(l.T, 'bore+angle', { angle: l.ad, shift: l.sh, free: 'angle' });
      }
    }
  }
}

// ------------------------------------------------------------- top level

/**
 * All hypotheses for B moving relative to fixed A, best first.
 * @returns {{T:number[], score:number, contact:number, pen:number, source:string, info:object, mates:object[]}[]}
 */
export function pairHypotheses(A, B, opt0 = {}) {
  const opt = { ...DEFAULTS, ...opt0 };
  const raw = [];
  const push = (T, source, info) => raw.push({ T, source, info });
  genCylPairs(A, B, opt, push);
  const nPairHyps = raw.length;
  genRects(A, B, opt, push);
  genFaces(A, B, opt, push);
  // single bore + rotation sweep: for parts that cannot be located by two bores
  const fullB = B.cyls.filter((c) => usableCyl(c) && c.full).length;
  if (fullB < 2 || nPairHyps === 0 || opt.alwaysSweep) genSingleCyl(A, B, opt, push);
  if (!raw.length) return [];
  // prescreen with subsampled scoring plus feature evidence
  for (const h of raw) h.pre = evalPose(A, B, h.T, opt, 4).score + opt.featWeight * featureMatches(A, B, h.T, opt).score;
  raw.sort((a, b) => b.pre - a.pre);
  const top = raw.slice(0, opt.maxFull ?? 48);
  for (const h of top) {
    const e = evalPose(A, B, h.T, opt, 1);
    const fm = featureMatches(A, B, h.T, opt);
    h.contact = e.contact;
    h.pen = e.pen;
    h.contactArea = e.contactArea;
    h.mates = fm.mates;
    h.feat = fm.score;
    h.prior = shiftPrior(h.info && h.info.shift);
    h.score = e.score + opt.featWeight * fm.score + h.prior;
  }
  top.sort((a, b) => b.score - a.score);
  return dedupe(B, top, 0.15).slice(0, opt.keep ?? 8);
}

/** Remove poses that put B into (nearly) the same occupied space. */
export function dedupe(B, hyps, tol = 0.15) {
  const out = [];
  const pts = [];
  const n = B.samples.n;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 64))) pts.push([B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
  for (const h of hyps) {
    let dup = false;
    for (const o of out) {
      if (samePlace(B, pts, h.T, o.T, tol)) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(h);
  }
  return out;
}

export function samePlace(B, pts, T1, T2, tol = 0.15) {
  // quick reject by centroid
  const c = B.stats.centroid;
  if (dist(mPoint(T1, c), mPoint(T2, c)) > 1.0 + B.stats.diag * 0.02) return false;
  const M = mMul(mInvRigid(T2), T1);
  let s = 0;
  for (const p of pts) {
    const q = mPoint(M, p);
    s += Math.abs(sdfSample(B.sdf, q[0], q[1], q[2]));
  }
  return s / pts.length < tol + B.sdf.h * 0.1;
}
