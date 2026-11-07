// Mate constraint solver. Each mate links a feature on a reference part (a)
// with a feature on a moving part (b). The solver adjusts the moving part's
// world pose (Levenberg-Marquardt over a rotation vector + translation) to
// satisfy all of its enabled mates, with weak regularisation so that any
// unconstrained degrees of freedom stay where the user left them.

import {
  add, sub, scale, dot, cross, norm, len, reject, mMul, mPoint, mDir, mExp, mTranslation, mOrtho, eigSym3,
} from './math.js';
import { solveN } from './fit.js';

/** Look up a feature by key ('c3', 'p5', 's2', 'r1') in an analysis. */
export function getFeature(an, key) {
  const k = key[0], i = +key.slice(1);
  if (k === 'c') return an.cyls[i] && { kind: 'cyl', ...an.cyls[i] };
  if (k === 'p') return an.planes[i] && { kind: 'plane', ...an.planes[i] };
  if (k === 's') return an.pairs[i] && { kind: 'pair', ...an.pairs[i] };
  if (k === 'r') return an.rects[i] && { kind: 'rect', ...an.rects[i] };
  return null;
}

/** Feature in world coordinates under pose P. */
export function worldFeature(an, key, P) {
  const f = getFeature(an, key);
  if (!f) return null;
  if (f.kind === 'cyl') return { ...f, a: norm(mDir(P, f.a)), c: mPoint(P, f.c) };
  if (f.kind === 'plane') return { ...f, n: norm(mDir(P, f.n)), c: mPoint(P, f.c), u: mDir(P, f.u), v: mDir(P, f.v) };
  if (f.kind === 'pair') return { ...f, n: norm(mDir(P, f.n)), mid: mPoint(P, f.mid) };
  if (f.kind === 'rect') return { ...f, axis: norm(mDir(P, f.axis)), center: mPoint(P, f.center), d1: norm(mDir(P, f.d1)), d2: norm(mDir(P, f.d2)) };
  return null;
}

export const MATE_TYPES = {
  coaxial: { label: 'Coaxial', needs: ['cyl', 'cyl'] },
  contact: { label: 'Contact (faces touch)', needs: ['plane', 'plane'] },
  flush: { label: 'Flush (coplanar, same side)', needs: ['plane', 'plane'] },
  centered: { label: 'Centered (even gap)', needs: ['pair', 'pair'] },
  rect: { label: 'Rect peg in hole', needs: ['rect', 'rect'] },
  parallel: { label: 'Parallel', needs: ['any', 'any'] },
  axisInPlane: { label: 'Axis on mid-plane', needs: ['cyl', 'pair'] },
};

const dirOf = (f) => (f.kind === 'cyl' ? f.a : f.kind === 'plane' ? f.n : f.kind === 'pair' ? f.n : f.axis);

/** Residual vector for one mate given world features fa (reference) and fb (moving). */
export function mateResiduals(m, fa, fb, out) {
  const off = m.offset || 0;
  switch (m.type) {
    case 'coaxial': {
      const L = Math.max(fb.len || 5, 4);
      const sgn = m.flip ? -1 : 1;
      const b1 = add(fb.c, scale(fb.a, -L / 2)), b2 = add(fb.c, scale(fb.a, L / 2));
      const r1 = reject(sub(b1, fa.c), fa.a), r2 = reject(sub(b2, fa.c), fa.a);
      out.push(...r1, ...r2);
      if (m.axial != null) {
        // axial offset between cylinder centres (signed along A axis)
        out.push(dot(sub(fb.c, fa.c), fa.a) - m.axial);
      }
      if (m.orient) {
        const d = add(fb.a, scale(fa.a, -sgn));
        out.push(...scale(d, L * 0.5));
      }
      return;
    }
    case 'contact': {
      const L = Math.sqrt(Math.max(fb.area || 25, 4));
      out.push(dot(sub(fb.c, fa.c), fa.n) - off);
      out.push(...scale(add(fb.n, fa.n), L));
      return;
    }
    case 'flush': {
      const L = Math.sqrt(Math.max(fb.area || 25, 4));
      out.push(dot(sub(fb.c, fa.c), fa.n) - off);
      out.push(...scale(sub(fb.n, fa.n), L));
      return;
    }
    case 'centered': {
      const L = 10;
      out.push(dot(sub(fb.mid, fa.mid), fa.n) - off);
      out.push(...scale(cross(fb.n, fa.n), L));
      return;
    }
    case 'rect': {
      const L = Math.max(fb.len || 5, 5);
      const sw = m.swap ? 1 : 0;
      const a1 = sw ? fa.d2 : fa.d1, a2 = sw ? fa.d1 : fa.d2;
      const d = sub(fb.center, fa.center);
      out.push(dot(d, a1), dot(d, a2));
      out.push(...scale(cross(fb.d1, a1), L), ...scale(cross(fb.d2, a2), L));
      return;
    }
    case 'parallel': {
      out.push(...scale(cross(dirOf(fb), dirOf(fa)), 10));
      return;
    }
    case 'axisInPlane': {
      // moving cylinder axis lies in the reference pair's mid plane (or vice versa)
      const cyl = fb.kind === 'cyl' ? fb : fa, pr = fb.kind === 'cyl' ? fa : fb;
      out.push(dot(sub(cyl.c, pr.mid), pr.n) - off);
      out.push(dot(cyl.a, pr.n) * 10);
      return;
    }
    default:
      return;
  }
}

/**
 * Solve the pose of one moving part.
 * @param {object} ctx {parts: Map id -> {an, pose}}
 * @param {string} moving part id
 * @param {object[]} mates mates where b.part === moving (others ignored)
 * @returns {{pose:number[], residual:number, perMate:number[], freeDOF:object}}
 */
export function solvePart(ctx, moving, mates, opts = {}) {
  const part = ctx.parts.get(moving);
  const active = mates.filter((m) => m.enabled !== false && (m.b.part === moving || m.a.part === moving));
  const P0 = part.pose;
  const c0 = mPoint(P0, part.an.stats.centroid);
  const lam = opts.reg ?? 1e-3;
  const Lc = Math.max(5, part.an.stats.diag / 2);

  const poseFrom = (x) => {
    const R = mExp([x[0], x[1], x[2]]);
    // rotate about current centroid
    const toC = mTranslation(scale(c0, -1)), back = mTranslation(add(c0, [x[3], x[4], x[5]]));
    return mOrtho(mMul(back, mMul(R, mMul(toC, P0))));
  };
  const resid = (x) => {
    const P = poseFrom(x);
    const out = [];
    for (const m of active) {
      const movingIsB = m.b.part === moving;
      const other = ctx.parts.get(movingIsB ? m.a.part : m.b.part);
      if (!other) continue;
      const fa = movingIsB ? worldFeature(other.an, m.a.f, other.pose) : worldFeature(part.an, m.a.f, P);
      const fb = movingIsB ? worldFeature(part.an, m.b.f, P) : worldFeature(other.an, m.b.f, other.pose);
      if (!fa || !fb) continue;
      mateResiduals(m, fa, fb, out);
    }
    for (let k = 0; k < 3; k++) out.push(lam * Lc * x[k]);
    for (let k = 3; k < 6; k++) out.push(lam * x[k]);
    return out;
  };
  let x = [0, 0, 0, 0, 0, 0];
  let r = resid(x);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let mu = 1e-6;
  for (let it = 0; it < (opts.iters ?? 30); it++) {
    const J = jacobian(resid, x, r);
    const n = 6;
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < r.length; i++) {
      for (let a = 0; a < n; a++) {
        const ja = J[i][a];
        if (ja === 0) continue;
        g[a] += ja * r[i];
        for (let b = 0; b < n; b++) JtJ[a][b] += ja * J[i][b];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + mu) + 1e-12 : v)));
      const step = solveN(A, g.map((v) => -v));
      if (!step) break;
      const xn = x.map((v, i) => v + step[i]);
      const rn = resid(xn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        x = xn;
        r = rn;
        const dc = cost - cn;
        cost = cn;
        mu = Math.max(mu / 3, 1e-9);
        improved = true;
        if (dc < 1e-14) it = 1e9;
        break;
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  const pose = poseFrom(x);
  // per-mate residual magnitudes at solution
  const perMate = active.map((m) => mateError(ctx, m, moving, pose));
  return { pose, perMate, active, cost, freeDOF: freeDOF(resid, x) };
}

function jacobian(f, x, r0) {
  const J = r0.map(() => new Array(x.length).fill(0));
  for (let k = 0; k < x.length; k++) {
    const h = 1e-6;
    const xp = x.slice();
    xp[k] += h;
    const rp = f(xp);
    for (let i = 0; i < r0.length; i++) J[i][k] = (rp[i] - r0[i]) / h;
  }
  return J;
}

/** Error of a single mate (max abs residual, mm-equivalent). */
export function mateError(ctx, m, moving = null, poseOverride = null) {
  const pa = ctx.parts.get(m.a.part), pb = ctx.parts.get(m.b.part);
  if (!pa || !pb) return Infinity;
  const PA = poseOverride && m.a.part === moving ? poseOverride : pa.pose;
  const PB = poseOverride && m.b.part === moving ? poseOverride : pb.pose;
  const fa = worldFeature(pa.an, m.a.f, PA), fb = worldFeature(pb.an, m.b.f, PB);
  if (!fa || !fb) return Infinity;
  const out = [];
  mateResiduals(m, fa, fb, out);
  return out.reduce((s, v) => Math.max(s, Math.abs(v)), 0);
}

/** Free directions of the constraint system (eigen analysis of J^T J without regularisation). */
function freeDOF(f, x) {
  const r0 = f(x);
  const J = jacobian(f, x, r0).slice(0, r0.length - 6);
  const JtJ = (a, b) => J.reduce((s, row) => s + row[a] * row[b], 0);
  const rot = eigSym3([JtJ(0, 0), JtJ(0, 1), JtJ(0, 2), JtJ(1, 1), JtJ(1, 2), JtJ(2, 2)]);
  const tr = eigSym3([JtJ(3, 3), JtJ(3, 4), JtJ(3, 5), JtJ(4, 4), JtJ(4, 5), JtJ(5, 5)]);
  const freeRot = rot.values.map((v, i) => ({ v, d: rot.vectors[i] })).filter((e) => e.v < 1e-6);
  const freeTr = tr.values.map((v, i) => ({ v, d: tr.vectors[i] })).filter((e) => e.v < 1e-6);
  return { rot: freeRot.map((e) => e.d), trans: freeTr.map((e) => e.d), count: freeRot.length + freeTr.length };
}
