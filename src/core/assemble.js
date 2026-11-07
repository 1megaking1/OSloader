// Global auto-assembly: version grouping, greedy best-first placement using
// pairwise hypotheses re-scored against everything already placed, mate
// inference + snapping, alternatives for ambiguous parts, multiple instances
// for parts whose file name says "x4" etc.

import { mIdentity, mMul, mInvRigid, mPoint, mDir, mFromBasis, mTranslation, kabsch, norm, cross, dot, sub, add, scale, dist, rad, len } from './math.js';
import { pairHypotheses, evalPose, featureMatches, samePlace, cylCompat, DEFAULTS } from './match.js';
import { planeOverlap } from './features.js';
import { solvePart, mateError, worldFeature } from './solver.js';
import { sdfSample, sdfSampleGrad } from './sdf.js';

// ------------------------------------------------------------ names

export function quantityFromName(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const re = /(?:^|[^a-z0-9])(?:x\s?(\d{1,3})|(\d{1,3})\s?x|qty\s?(\d{1,3})|(\d{1,3})\s?(?:pcs|pc|pieces|stk))(?=$|[^a-z0-9])/i;
  const m = base.match(re);
  if (!m) return 1;
  const q = +(m[1] || m[2] || m[3] || m[4]);
  return q >= 2 && q <= 200 ? q : 1;
}

const SIDE = /(?:^|[^a-z])(left|right|lh|rh|l|r|top|bottom|front|back|upper|lower|inner|outer|a|b)(?=$|[^a-z])/gi;

export function baseName(name) {
  let s = name.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  s = s.replace(/\(\d+\)/g, ' ');
  s = s.replace(/(?:^|[^a-z])(v|ver|version|rev|r)\s?\d+[a-z]?(?=$|[^a-z0-9])/g, ' ');
  s = s.replace(/(?:^|[^a-z])(copy|final|new|old|fixed|fix|alt|alternate|alternative|tight|loose|test|updated|update|optional|opt|remix|mod|modified|tolerance|tol)(?=$|[^a-z])/g, ' ');
  s = s.replace(/[_\-.\s]+/g, ' ').replace(/\s\d+$/, '').trim();
  return s;
}

function sideTokens(name) {
  const out = [];
  let m;
  const re = new RegExp(SIDE.source, 'gi');
  while ((m = re.exec(name.toLowerCase().replace(/\.[a-z0-9]+$/, '')))) out.push(m[1]);
  return out.sort().join(',');
}

export function namesLikeVersions(a, b) {
  if (sideTokens(a) !== sideTokens(b)) return false;
  return baseName(a) === baseName(b) && baseName(a).length > 0;
}

// ------------------------------------------------------- registration

/** Rigid registration of B onto A (shape similarity) using A's SDF. */
export function registerShapes(A, B) {
  const inits = [];
  const ea = A.pca.axes, eb = B.pca.axes;
  const dimsA = A.pca.dims, dimsB = B.pca.dims;
  const perms = [[0, 1, 2]];
  const near = (x, y) => Math.abs(x - y) < 0.08 * Math.max(x, y) + 0.5;
  if (near(dimsA[0], dimsA[1]) || near(dimsA[1], dimsA[2])) perms.push([1, 0, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]);
  for (const pm of perms) {
    for (const s0 of [1, -1]) {
      for (const s1 of [1, -1]) {
        const xa = scale(ea[pm[0]], s0), ya = scale(ea[pm[1]], s1);
        const za = cross(xa, ya);
        const FA = mFromBasis(xa, ya, za, A.pca.center);
        const FB = mFromBasis(eb[0], eb[1], cross(eb[0], eb[1]), B.pca.center);
        inits.push(mMul(FA, mInvRigid(FB)));
      }
    }
  }
  let best = null;
  for (const T0 of inits) {
    const r = icpSDF(A, B, T0, 12, 160);
    if (!best || r.err < best.err) best = r;
  }
  const fin = icpSDF(A, B, best.T, 20, 600);
  // symmetric error
  const back = residualStats(B, A, mInvRigid(fin.T));
  return { T: fin.T, err: Math.max(fin.err, back.mean), p90: Math.max(fin.p90, back.p90) };
}

function residualStats(A, B, T) {
  const s = B.samples;
  const ds = [];
  for (let i = 0; i < s.n; i += 2) {
    const p = mPoint(T, [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]]);
    ds.push(Math.abs(sdfSample(A.sdf, p[0], p[1], p[2])));
  }
  ds.sort((a, b) => a - b);
  return { mean: ds.reduce((x, y) => x + y, 0) / ds.length, p90: ds[Math.floor(ds.length * 0.9)] };
}

function icpSDF(A, B, T0, iters, nPts) {
  let T = T0;
  const s = B.samples;
  const step = Math.max(1, Math.floor(s.n / nPts));
  const g = [0, 0, 0, 0];
  let maxD = Math.max(3, A.stats.diag * 0.1);
  for (let it = 0; it < iters; it++) {
    const P = [], Q = [];
    for (let i = 0; i < s.n; i += step) {
      const b = [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]];
      const p = mPoint(T, b);
      sdfSampleGrad(A.sdf, p[0], p[1], p[2], g);
      const gl2 = g[1] * g[1] + g[2] * g[2] + g[3] * g[3];
      if (Math.abs(g[0]) > maxD || gl2 < 1e-9) continue;
      const k = g[0] / gl2;
      P.push(b);
      Q.push([p[0] - k * g[1], p[1] - k * g[2], p[2] - k * g[3]]);
    }
    if (P.length < 6) break;
    T = kabsch(P, Q);
    maxD = Math.max(maxD * 0.7, 1.0);
  }
  const st = residualStats(A, B, T);
  return { T, err: st.mean, p90: st.p90 };
}

/** Group parts that are versions of each other. */
export function groupVersions(parts, opt = {}) {
  const n = parts.length;
  const parent = parts.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const reg = new Map();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = parts[i].an, B = parts[j].an;
      const nameHint = namesLikeVersions(parts[i].name, parts[j].name);
      if (!nameHint && sideTokens(parts[i].name) !== sideTokens(parts[j].name) && sideTokens(parts[i].name) && sideTokens(parts[j].name)) continue;
      const k = nameHint ? 2 : 1;
      const sa = A.signature, sb = B.signature;
      const vr = sb.volume / sa.volume, ar = sb.area / sa.area;
      if (vr < 1 - 0.18 * k || vr > 1 / (1 - 0.18 * k)) continue;
      if (ar < 1 - 0.18 * k || ar > 1 / (1 - 0.18 * k)) continue;
      let ok = true;
      for (let d = 0; d < 3; d++) if (Math.abs(sa.dims[d] - sb.dims[d]) > 0.08 * k * sa.dims[d] + 1.0) ok = false;
      if (!ok) continue;
      const r = registerShapes(A, B);
      const diag = A.stats.diag;
      const good = r.err < (0.2 + 0.004 * diag) * k && r.p90 < (0.6 + 0.01 * diag) * k;
      if (!good) continue;
      reg.set(i + ',' + j, r);
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // representative: most triangles (usually the most detailed / latest), ties -> name order
    members.sort((a, b) => parts[a].name.localeCompare(parts[b].name, undefined, { numeric: true }));
    const rep = members[0];
    const regs = {};
    for (const m of members) {
      if (m === rep) continue;
      const key = Math.min(rep, m) + ',' + Math.max(rep, m);
      let r = reg.get(key);
      if (!r) r = registerShapes(parts[rep].an, parts[m].an);
      else if (rep > m) r = { ...r, T: mInvRigid(r.T) };
      regs[parts[m].id] = r; // maps member -> rep local
    }
    out.push({ rep: parts[rep].id, members: members.map((i) => parts[i].id), reg: regs });
  }
  return out;
}

// ------------------------------------------------------- world helpers

function worldBox(an, P, pad = 0) {
  const { min, max } = an.stats.bbox;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = mPoint(P, [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k] - pad);
      hi[k] = Math.max(hi[k], p[k] + pad);
    }
  }
  return { lo, hi };
}

const baseOf = (id) => id.split('#')[0];

const boxOverlap = (a, b) => a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] && a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] && a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];

/** contribution of placed part X to the score of B at world pose W */
function contribution(X, PX, B, W, opt) {
  const T = mMul(mInvRigid(PX), W);
  const e = evalPose(X, B, T, opt, 1);
  const fm = featureMatches(X, B, T, opt);
  return { contactArea: e.contactArea, penArea: e.penArea, feat: fm.score };
}

function globalScore(B, acc, opt) {
  const a = B.stats.area;
  return (acc.contactArea - opt.penWeight * acc.penArea) / a + opt.featWeight * acc.feat;
}

// --------------------------------------------------------- mate inference

/** Infer mates between moving part b (at pose W) and placed neighbour parts. */
export function inferMates(ctx, bid, W, neighbourIds, opt = DEFAULTS) {
  const B = ctx.parts.get(bid).an;
  const mates = [];
  const box = worldBox(B, W, 1.0);
  for (const xid of neighbourIds) {
    const X = ctx.parts.get(xid);
    if (!boxOverlap(box, worldBox(X.an, X.pose, 1.0))) continue;
    const T = mMul(mInvRigid(X.pose), W);
    const fm = featureMatches(X.an, B, T, opt);
    const usedPlanesB = new Set(), usedPlanesA = new Set();
    for (const m of fm.mates) {
      const mate = { type: m.type, a: { part: xid, f: m.a }, b: { part: bid, f: m.b }, auto: true, enabled: true };
      if (m.type === 'coaxial') {
        mate.kind = m.kind;
        mate.priority = m.kind === 'insert' ? 5 : 3;
      } else if (m.type === 'centered') {
        mate.priority = 4;
        const pa = X.an.pairs[+m.a.slice(1)], pb = B.pairs[+m.b.slice(1)];
        usedPlanesA.add(pa.i).add(pa.j);
        usedPlanesB.add(pb.i).add(pb.j);
        // offset so that the centred solution keeps current (already centred) state
        mate.offset = 0;
      }
      mates.push(mate);
    }
    // rect pegs
    for (const rb of B.rects) {
      const ax = norm(mDir(T, rb.axis)), cb = mPoint(T, rb.center);
      for (const ra of X.an.rects) {
        if (ra.concave === rb.concave) continue;
        if (Math.abs(dot(ax, ra.axis)) < Math.cos(rad(2))) continue;
        const off = sub(cb, ra.center);
        const perp = sub(off, scale(ra.axis, dot(off, ra.axis)));
        if (len(perp) > 0.3) continue;
        const d1 = norm(mDir(T, rb.d1));
        const swap = Math.abs(dot(d1, ra.d1)) < Math.abs(dot(d1, ra.d2));
        const hole = ra.concave ? ra : rb, peg = ra.concave ? rb : ra;
        const [pw1, pw2] = swap ? [peg.w2, peg.w1] : [peg.w1, peg.w2];
        if (hole.w1 - pw1 < -0.15 || hole.w1 - pw1 > 1.2 || hole.w2 - pw2 < -0.15 || hole.w2 - pw2 > 1.2) continue;
        mates.push({ type: 'rect', a: { part: xid, f: 'r' + ra.id }, b: { part: bid, f: 'r' + rb.id }, swap, auto: true, enabled: true, priority: 4.5 });
        for (const pi of rb.pairs) {
          const pr = B.pairs[pi];
          usedPlanesB.add(pr.i).add(pr.j);
        }
        for (const pi of ra.pairs) {
          const pr = X.an.pairs[pi];
          usedPlanesA.add(pr.i).add(pr.j);
        }
        break;
      }
    }
    // face contacts
    const cosT = Math.cos(rad(1.5));
    for (const pb of B.planes) {
      if (usedPlanesB.has(pb.id) || pb.area < 1) continue;
      const nb = norm(mDir(T, pb.n)), cb = mPoint(T, pb.c);
      for (const pa of X.an.planes) {
        if (usedPlanesA.has(pa.id) || pa.area < 1) continue;
        if (dot(nb, pa.n) > -cosT) continue;
        const d = dot(sub(cb, pa.c), pa.n);
        if (Math.abs(d) > 0.25) continue;
        const ov = Math.max(planeOverlap(pa, pb, T).frac, planeOverlap(pb, pa, mInvRigid(T)).frac);
        if (ov < 0.08) continue;
        const area = Math.min(pa.area, pb.area) * ov;
        mates.push({ type: 'contact', a: { part: xid, f: 'p' + pa.id }, b: { part: bid, f: 'p' + pb.id }, offset: 0, auto: true, enabled: true, priority: 2 + Math.min(1, area / 400), area });
      }
    }
  }
  return mates;
}

/** Solve mates for part bid, dropping lowest-priority conflicting mates. */
export function snapPart(ctx, bid, mates, tol = 0.05) {
  let active = mates.filter((m) => m.enabled !== false);
  const dropped = [];
  for (let guard = 0; guard < 40; guard++) {
    if (!active.length) return { pose: ctx.parts.get(bid).pose, mates: [], dropped };
    const res = solvePart(ctx, bid, active);
    const errs = res.perMate;
    let worst = -1;
    for (let i = 0; i < active.length; i++) {
      if (errs[i] > tol && (worst < 0 || (active[i].priority ?? 1) < (active[worst].priority ?? 1))) worst = i;
    }
    if (worst < 0) return { pose: res.pose, mates: active, dropped, freeDOF: res.freeDOF };
    dropped.push(active[worst]);
    active = active.filter((_, i) => i !== worst);
  }
  return { pose: ctx.parts.get(bid).pose, mates: active, dropped };
}

// ------------------------------------------------------------ main entry

export const pairKey = (a, b) => a + '\u0001' + b;

/** Pairs of parts to match: fixed = larger surface area. */
export function planPairs(nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const area = (p) => (p.an ? p.an.stats.area : p.area);
      const [fixed, moving] = area(a) >= area(b) ? [a, b] : [b, a];
      const qty = Math.max(quantityFromName(moving.name), quantityFromName(fixed.name));
      out.push({ key: pairKey(fixed.id, moving.id), fixed: fixed.id, moving: moving.id, keep: qty > 1 ? 16 + qty * 2 : 10 });
    }
  }
  return out;
}

export function computePair(byId, t, opt) {
  const A = byId.get(t.fixed)?.an, B = byId.get(t.moving)?.an;
  if (!A || !B) return [];
  return pairHypotheses(A, B, { ...opt, keep: t.keep });
}

/**
 * @param {{id:string, name:string, an:object}[]} parts
 * @param {object} opts {root?, autoInstances?, onProgress?, hyps? (precomputed Map)}
 */
export function autoAssemble(parts, opts = {}) {
  const opt = { ...DEFAULTS, ...(opts.match || {}) };
  const progress = opts.onProgress || (() => {});
  const byId = new Map(parts.map((p) => [p.id, p]));
  const minScore = opts.minScore ?? 0.05;

  // 1. versions
  progress({ stage: 'versions', done: 0, total: 1 });
  const groups = opts.groups ?? groupVersions(parts);
  const memberOf = new Map();
  for (const g of groups) for (const m of g.members) if (m !== g.rep) memberOf.set(m, g);
  const nodes = parts.filter((p) => !memberOf.has(p.id) && !(opts.exclude || []).includes(p.id));

  // 2. root (or the user's locked parts)
  const fixed = opts.fixed ? new Map(Object.entries(opts.fixed).filter(([id]) => byId.has(id) && !memberOf.has(id))) : new Map();
  const root = fixed.size ? fixed.keys().next().value : opts.root && byId.has(opts.root) && !memberOf.has(opts.root) ? opts.root : nodes.slice().sort((a, b) => b.an.stats.volume - a.an.stats.volume)[0].id;

  // 3. pairwise hypotheses (may be precomputed in parallel by the caller)
  const hyps = opts.hyps || new Map();
  const tasks = planPairs(nodes).filter((t) => !hyps.has(t.key) && !hyps.has(pairKey(t.moving, t.fixed)));
  let done = 0;
  for (const t of tasks) {
    hyps.set(t.key, computePair(byId, t, opt));
    done++;
    if (done % 4 === 0) progress({ stage: 'matching', done, total: tasks.length });
  }
  /** hypotheses for B relative to A (T: B -> A local) */
  const relHyps = (aid, bid) => {
    const h = hyps.get(pairKey(aid, bid));
    if (h) return h;
    const r = hyps.get(pairKey(bid, aid));
    if (!r) return [];
    return r.map((x) => ({ ...x, T: mInvRigid(x.T), inverted: true }));
  };

  // 4. greedy placement
  const ctx = { parts: new Map() };
  for (const p of parts) ctx.parts.set(p.id, { an: p.an, pose: mIdentity() });
  const placed = fixed.size ? new Map(fixed) : new Map([[root, mIdentity()]]);
  for (const [id, P] of placed) ctx.parts.get(id).pose = P;
  const result = { root, placements: {}, groups, order: Array.from(placed.keys()), unplaced: [], instances: [], mates: [] };
  for (const id of placed.keys()) result.placements[id] = { status: id === root ? 'root' : 'locked', score: 1, alternatives: [] };

  const cands = new Map(); // bid -> [{W, from, source, acc, score}]
  const addFrom = (xid) => {
    const PX = placed.get(xid);
    for (const b of nodes) {
      if (placed.has(b.id)) continue;
      const list = cands.get(b.id) || [];
      for (const h of relHyps(baseOf(xid), b.id)) {
        if (h.score < minScore * 0.5) continue;
        const W = mMul(PX, h.T);
        list.push({ W, from: xid, source: h.source, info: h.info, acc: null, pair: h.score, prior: h.prior || 0 });
      }
      cands.set(b.id, list);
    }
  };
  const evalCand = (bid, c) => {
    const B = byId.get(bid).an;
    const box = worldBox(B, c.W, 1);
    const acc = { contactArea: 0, penArea: 0, feat: 0 };
    for (const [xid, PX] of placed) {
      const X = byId.get(xid)?.an || ctx.parts.get(xid).an;
      if (!boxOverlap(box, worldBox(X, PX, 1))) continue;
      const cb = contribution(X, PX, B, c.W, opt);
      acc.contactArea += cb.contactArea;
      acc.penArea += cb.penArea;
      acc.feat += cb.feat;
    }
    c.acc = acc;
    c.score = globalScore(B, acc, opt) + (c.prior || 0);
    c.evaluatedWith = placed.size;
  };
  const addContribution = (bid, c, xid) => {
    const B = byId.get(bid).an;
    const X = ctx.parts.get(xid).an;
    const PX = placed.get(xid);
    if (!boxOverlap(worldBox(B, c.W, 1), worldBox(X, PX, 1))) return;
    const cb = contribution(X, PX, B, c.W, opt);
    c.acc.contactArea += cb.contactArea;
    c.acc.penArea += cb.penArea;
    c.acc.feat += cb.feat;
    c.score = globalScore(B, c.acc, opt) + (c.prior || 0);
  };

  for (const id of placed.keys()) addFrom(id);
  for (const [bid, list] of cands) for (const c of list) evalCand(bid, c);

  const placeOrder = [];
  const ptsCache = new Map();
  const samplePts = (B) => {
    if (!ptsCache.has(B)) {
      const pts = [];
      for (let i = 0; i < B.samples.n; i += Math.max(1, Math.floor(B.samples.n / 64))) pts.push([B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
      ptsCache.set(B, pts);
    }
    return ptsCache.get(B);
  };
  /** best candidate for a part and its margin over the best *distinct* alternative */
  const bestOf = (bid) => {
    const B = byId.get(bid).an;
    let b1 = null;
    for (const c of cands.get(bid) || []) {
      if (c.acc.penArea / B.stats.area > 0.06) continue;
      if (!b1 || c.score > b1.score) b1 = c;
    }
    if (!b1) return null;
    let b2 = 0;
    for (const c of cands.get(bid)) {
      if (c === b1 || c.score <= b2 || c.acc.penArea / B.stats.area > 0.06) continue;
      if (samePlace(B, samplePts(B), c.W, b1.W)) continue;
      b2 = c.score;
    }
    const margin = b1.score > 0 ? Math.max(0, (b1.score - b2) / b1.score) : 0;
    return { c: b1, margin };
  };
  /** update pending candidates with a newly placed part, add its own candidates */
  const afterPlace = (pid) => {
    for (const [oid, list] of cands) {
      if (placed.has(oid)) continue;
      for (const x of list) addContribution(oid, x, pid);
    }
    const before = new Map(Array.from(cands, ([k, v]) => [k, v.length]));
    addFrom(pid);
    for (const [oid, list] of cands) {
      if (placed.has(oid)) continue;
      for (let i = before.get(oid) || 0; i < list.length; i++) evalCand(oid, list[i]);
    }
  };
  /** extra copies for parts named like "pin_x4.stl", placed into free matching spots */
  const placeInstances = (p) => {
    const q = quantityFromName(p.name);
    for (let k = 2; k <= q; k++) {
      const iid = p.id + '#' + k;
      const cl = [];
      for (const [xid, PX] of placed) {
        if (baseOf(xid) === p.id) continue;
        for (const h of relHyps(baseOf(xid), p.id)) cl.push({ W: mMul(PX, h.T), from: xid, source: h.source, info: h.info, prior: h.prior || 0 });
      }
      ctx.parts.set(iid, { an: p.an, pose: mIdentity() });
      byId.set(iid, { id: iid, name: p.name, an: p.an });
      for (const c of cl) evalCand(iid, c);
      const ok = cl.filter((c) => c.acc.penArea / p.an.stats.area < 0.04 && c.score >= minScore).sort((a, b) => b.score - a.score);
      if (!ok.length) {
        ctx.parts.delete(iid);
        byId.delete(iid);
        break;
      }
      const c = ok[0];
      ctx.parts.get(iid).pose = c.W;
      const mates = inferMates(ctx, iid, c.W, Array.from(placed.keys()), opt);
      const snapped = snapPart(ctx, iid, mates);
      ctx.parts.get(iid).pose = snapped.pose;
      placed.set(iid, snapped.pose);
      result.instances.push({ id: iid, of: p.id });
      result.placements[iid] = { status: 'placed', score: c.score, from: c.from, source: c.source, alternatives: [], instanceOf: p.id };
      result.mates.push(...snapped.mates.map((m) => ({ ...m })));
      placeOrder.push(iid);
      afterPlace(iid);
    }
  };
  for (;;) {
    let best = null;
    for (const [bid] of cands) {
      if (placed.has(bid)) continue;
      const bo = bestOf(bid);
      if (!bo || bo.c.score < minScore) continue;
      // prefer confident placements; ambiguous parts wait until more context is placed
      const key = bo.c.score * (0.6 + 0.4 * Math.min(1, bo.margin / 0.3));
      if (!best || key > best.key) best = { bid, c: bo.c, key };
    }
    if (!best) break;
    const { bid, c } = best;
    if (opts.debug) {
      const lines = [];
      for (const [oid] of cands) {
        if (placed.has(oid)) continue;
        const bo = bestOf(oid);
        if (bo) lines.push(`${oid}:${bo.c.score.toFixed(3)}/m${bo.margin.toFixed(2)}/${bo.c.from}`);
      }
      console.log('[place]', bid, c.score.toFixed(3), 'from', c.from, '| pending', lines.join(' '));
    }
    // alternatives: distinct poses for this part
    const B = byId.get(bid).an;
    const pts = samplePts(B);
    const sorted = cands.get(bid).filter((x) => x.acc.penArea / B.stats.area <= 0.1).sort((x, y) => y.score - x.score);
    const alts = [];
    for (const x of sorted) {
      if (alts.some((y) => samePlace(B, pts, x.W, y.W))) continue;
      alts.push(x);
      if (alts.length >= 8) break;
    }
    // snap with inferred mates
    ctx.parts.get(bid).pose = c.W;
    const mates = inferMates(ctx, bid, c.W, Array.from(placed.keys()), opt);
    const snapped = snapPart(ctx, bid, mates);
    let W = snapped.pose;
    // guard: snapping must not make things notably worse
    const check = { W, acc: null };
    evalCand(bid, check);
    if (check.score < c.score - 0.05 || check.acc.penArea > c.acc.penArea + 0.02 * B.stats.area) {
      W = c.W;
    }
    ctx.parts.get(bid).pose = W;
    placed.set(bid, W);
    placeOrder.push(bid);
    const second = alts.length > 1 ? alts[1].score : 0;
    const margin = c.score > 0 ? Math.max(0, (c.score - second) / c.score) : 0;
    result.placements[bid] = {
      status: margin < 0.12 ? 'ambiguous' : 'placed',
      score: c.score,
      margin,
      from: c.from,
      source: c.source,
      info: c.info,
      freeDOF: snapped.freeDOF ? { rot: snapped.freeDOF.rot, trans: snapped.freeDOF.trans } : null,
      alternatives: alts.map((a) => ({ W: a.W, score: a.score, from: a.from, source: a.source, info: a.info })),
    };
    result.mates.push(...snapped.mates.map((m) => ({ ...m })));
    afterPlace(bid);
    if (opts.autoInstances !== false) placeInstances(byId.get(bid));
    progress({ stage: 'placing', done: placed.size, total: nodes.length });
  }
  result.order.push(...placeOrder);

  // 6. versions stacked on their representative
  for (const g of groups) {
    if (!placed.has(g.rep)) continue;
    for (const m of g.members) {
      if (m === g.rep) continue;
      const W = mMul(placed.get(g.rep), g.reg[m].T);
      placed.set(m, W);
      result.placements[m] = { status: 'version', versionOf: g.rep, score: 0, regErr: g.reg[m].err, alternatives: [] };
      result.order.push(m);
    }
  }

  // 7. unplaced: lay out beside the assembly
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [id, P] of placed) {
    const bx = worldBox(ctx.parts.get(id).an, P);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], bx.lo[k]);
      hi[k] = Math.max(hi[k], bx.hi[k]);
    }
  }
  let x = hi[0] + 20;
  for (const p of parts) {
    if (placed.has(p.id)) continue;
    const bx = worldBox(p.an, mIdentity());
    const W = mTranslation([x - bx.lo[0], lo[1] - bx.lo[1], lo[2] - bx.lo[2]]);
    x += bx.hi[0] - bx.lo[0] + 10;
    placed.set(p.id, W);
    result.unplaced.push(p.id);
    result.placements[p.id] = { status: 'unplaced', score: 0, alternatives: (cands.get(p.id) || []).sort((a, b) => b.score - a.score).slice(0, 5).map((a) => ({ W: a.W, score: a.score, from: a.from, source: a.source })) };
  }
  result.poses = Object.fromEntries(placed);
  result.hyps = hyps;
  return result;
}

/**
 * Candidate placements for one part against an existing (partial) assembly.
 * @param parts all parts {id, name, an}
 * @param targetId part to place (may be an instance id 'x#2' sharing base geometry)
 * @param poses {id: worldPose} of already placed parts
 */
export function suggestPlacements(parts, targetId, poses, opts = {}) {
  const opt = { ...DEFAULTS, ...(opts.match || {}) };
  const byId = new Map(parts.map((p) => [p.id, p]));
  const B = byId.get(baseOf(targetId))?.an;
  if (!B) return [];
  const hyps = opts.hyps || new Map();
  const getHyps = (aid, bid) => {
    const k = aid + '\u0001' + bid, k2 = bid + '\u0001' + aid;
    if (hyps.has(k)) return hyps.get(k);
    if (hyps.has(k2)) return hyps.get(k2).map((x) => ({ ...x, T: mInvRigid(x.T) }));
    const A = byId.get(aid).an, Bb = byId.get(bid).an;
    const h = pairHypotheses(A, Bb, { ...opt, keep: 16 });
    hyps.set(k, h);
    return h;
  };
  const cands = [];
  for (const [xid, PX] of Object.entries(poses)) {
    if (xid === targetId || !byId.has(baseOf(xid))) continue;
    if (baseOf(xid) === baseOf(targetId)) continue;
    for (const h of getHyps(baseOf(xid), baseOf(targetId))) cands.push({ W: mMul(PX, h.T), from: xid, source: h.source, info: h.info, prior: h.prior || 0 });
  }
  for (const c of cands) {
    const acc = { contactArea: 0, penArea: 0, feat: 0 };
    const box = worldBox(B, c.W, 1);
    for (const [xid, PX] of Object.entries(poses)) {
      if (xid === targetId) continue;
      const X = byId.get(baseOf(xid))?.an;
      if (!X || !boxOverlap(box, worldBox(X, PX, 1))) continue;
      const cb = contribution(X, PX, B, c.W, opt);
      acc.contactArea += cb.contactArea;
      acc.penArea += cb.penArea;
      acc.feat += cb.feat;
    }
    c.acc = acc;
    c.score = globalScore(B, acc, opt) + c.prior;
    c.pen = acc.penArea / B.stats.area;
  }
  const pts = [];
  for (let i = 0; i < B.samples.n; i += Math.max(1, Math.floor(B.samples.n / 64))) pts.push([B.samples.pos[i * 3], B.samples.pos[i * 3 + 1], B.samples.pos[i * 3 + 2]]);
  cands.sort((a, b) => b.score - a.score - 3 * (b.pen - a.pen));
  const out = [];
  for (const c of cands) {
    if (out.some((o) => samePlace(B, pts, c.W, o.W))) continue;
    out.push(c);
    if (out.length >= (opts.max ?? 10)) break;
  }
  return out.map((c) => ({ W: c.W, score: c.score, pen: c.pen, from: c.from, source: c.source, info: c.info }));
}

/** Snap a part at pose W onto its neighbours with inferred mates. */
export function snapToNeighbours(parts, id, W, poses, opts = {}) {
  const ctx = { parts: new Map() };
  for (const p of parts) ctx.parts.set(p.id, { an: p.an, pose: mIdentity() });
  for (const [pid, P] of Object.entries(poses)) {
    const base = parts.find((p) => p.id === baseOf(pid));
    if (base) ctx.parts.set(pid, { an: base.an, pose: P });
  }
  const base = parts.find((p) => p.id === baseOf(id));
  ctx.parts.set(id, { an: base.an, pose: W });
  const mates = inferMates(ctx, id, W, Object.keys(poses).filter((k) => k !== id), { ...DEFAULTS, ...(opts.match || {}) });
  const snapped = snapPart(ctx, id, mates);
  return { pose: snapped.pose, mates: snapped.mates, freeDOF: snapped.freeDOF };
}

/** Pairwise interference between placed parts. */
export function interference(parts, poses, opts = {}) {
  const opt = { ...DEFAULTS, ...(opts.match || {}) };
  const ids = Object.keys(poses);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const A = parts.find((p) => p.id === baseOf(ids[i]))?.an;
    if (!A) continue;
    const ba = worldBox(A, poses[ids[i]]);
    for (let j = i + 1; j < ids.length; j++) {
      const B = parts.find((p) => p.id === baseOf(ids[j]))?.an;
      if (!B || !boxOverlap(ba, worldBox(B, poses[ids[j]]))) continue;
      const T = mMul(mInvRigid(poses[ids[i]]), poses[ids[j]]);
      const e = evalPose(A, B, T, opt, 1);
      if (e.penArea > 0.5) out.push({ a: ids[i], b: ids[j], penArea: e.penArea, frac: e.pen });
    }
  }
  return out.sort((x, y) => y.penArea - x.penArea);
}
