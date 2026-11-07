// Per-part analysis: surface features (planes, cylinders, slot/tab plane
// pairs, rectangular holes/pegs), surface samples, signed distance field and
// a shape signature used for version detection.

import { buildMesh, principalAxes } from './mesh.js';
import { segmentPlanar, patchGraph, detectCylinders } from './segment.js';
import { computeSDF } from './sdf.js';
import { dot, cross, norm, sub, add, scale, rad, rng } from './math.js';

const MASK = 48; // plane occupancy raster resolution

export function analyzePart(positions, opts = {}) {
  const t0 = Date.now();
  const mesh = buildMesh(positions);
  const pca = principalAxes(mesh);
  const seg = segmentPlanar(mesh, opts);
  const graph = patchGraph(mesh, seg.triPatch, seg.patches.length);
  const { cyls, inCyl } = detectCylinders(mesh, seg.patches, graph, opts);

  const totalArea = mesh.area;
  const minPlaneArea = Math.max(0.15, totalArea * 5e-5);
  const planes = [];
  const patchPlane = new Int32Array(seg.patches.length).fill(-1);
  for (const p of seg.patches) {
    if (inCyl[p.id] >= 0 || p.area < minPlaneArea) continue;
    const pl = planeFeature(mesh, p, seg.triPatch, rngFor(p.id));
    if (!pl) continue;
    pl.id = planes.length;
    patchPlane[p.id] = pl.id;
    planes.push(pl);
  }

  // cylinder end planes (caps / shoulders) for axial reasoning
  for (const c of cyls) {
    c.ends = [];
    const seen = new Set();
    for (const pid of c.patches) {
      for (const [nb] of graph[pid]) {
        const pl = patchPlane[nb];
        if (pl < 0 || seen.has(pl)) continue;
        const P = planes[pl];
        const al = dot(P.n, c.a);
        if (Math.abs(al) < Math.cos(rad(3))) continue;
        seen.add(pl);
        const t = dot(sub(P.c, c.c), c.a);
        c.ends.push({ plane: pl, side: t > 0 ? 1 : -1, nDotA: al });
      }
    }
  }

  const pairs = findPairs(planes, mesh.diag);
  const rects = findRects(planes, pairs);

  // Thickness estimate from thin convex pairs (walls) to size the SDF voxels.
  let thickness = Infinity;
  for (const pr of pairs) if (!pr.concave && pr.overlap > 0.3 && pr.width > 0.3) thickness = Math.min(thickness, pr.width);
  for (const c of cyls) if (!c.concave && c.full) thickness = Math.min(thickness, 2 * c.r);
  const sdf = computeSDF(mesh, { thickness: isFinite(thickness) ? Math.max(thickness, 0.8) : undefined, ...(opts.sdf || {}) });

  const samples = sampleSurface(mesh, opts.samples ?? 1600, 12345);

  // triangle -> feature maps in ORIGINAL soup order (for picking in the UI)
  const triCount = positions.length / 9;
  const triPlane = new Int32Array(triCount).fill(-1);
  const triCyl = new Int32Array(triCount).fill(-1);
  for (let t = 0; t < mesh.T; t++) {
    const pid = seg.triPatch[t];
    const o = mesh.triOrig[t];
    if (inCyl[pid] >= 0) triCyl[o] = inCyl[pid];
    else if (patchPlane[pid] >= 0) triPlane[o] = patchPlane[pid];
  }

  // strip internal arrays from cylinders
  for (const c of cyls) delete c.patches;

  const holes = cyls.filter((c) => c.concave && c.span > rad(200)).length;
  const pegs = cyls.filter((c) => !c.concave && c.span > rad(200)).length;
  return {
    stats: {
      tris: mesh.T,
      verts: mesh.V,
      area: mesh.area,
      volume: mesh.volume,
      centroid: mesh.centroid,
      bbox: mesh.bbox,
      diag: mesh.diag,
      flipped: mesh.flipped,
      boundaryEdges: mesh.boundaryEdges,
      nonManifoldEdges: mesh.nonManifoldEdges,
      ms: Date.now() - t0,
    },
    pca: { center: pca.center, axes: pca.axes, dims: pca.dims, lo: pca.lo, hi: pca.hi, spread: pca.spread },
    planes,
    cyls,
    pairs,
    rects,
    samples,
    sdf,
    triPlane,
    triCyl,
    signature: {
      volume: mesh.volume,
      area: mesh.area,
      dims: pca.dims.slice().sort((a, b) => b - a),
      holes,
      pegs,
      planes: planes.length,
    },
  };
}

const rngFor = (id) => rng(1000 + id * 7919);

function planeFeature(mesh, patch, triPatch, rand) {
  const { verts, tris, adj } = mesh;
  const n = norm(patch.n);
  const c = patch.c;
  // 2D second moments in an arbitrary frame
  let u0 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  u0 = norm(sub(u0, scale(n, dot(u0, n))));
  const v0 = cross(n, u0);
  let Suu = 0, Suv = 0, Svv = 0, A = 0;
  const to2 = (vi) => {
    const p = [verts[vi * 3] - c[0], verts[vi * 3 + 1] - c[1], verts[vi * 3 + 2] - c[2]];
    return [dot(p, u0), dot(p, v0)];
  };
  for (const t of patch.tris) {
    const a = to2(tris[t * 3]), b = to2(tris[t * 3 + 1]), d = to2(tris[t * 3 + 2]);
    const ar = Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])) / 2;
    const sx = a[0] + b[0] + d[0], sy = a[1] + b[1] + d[1];
    Suu += (ar / 12) * (a[0] * a[0] + b[0] * b[0] + d[0] * d[0] + sx * sx);
    Svv += (ar / 12) * (a[1] * a[1] + b[1] * b[1] + d[1] * d[1] + sy * sy);
    Suv += (ar / 12) * (a[0] * a[1] + b[0] * b[1] + d[0] * d[1] + sx * sy);
    A += ar;
  }
  if (A <= 0) return null;
  Suu /= A;
  Svv /= A;
  Suv /= A;
  // principal direction
  const th = 0.5 * Math.atan2(2 * Suv, Suu - Svv);
  const ct = Math.cos(th), st = Math.sin(th);
  const u = norm(add(scale(u0, ct), scale(v0, st)));
  const v = cross(n, u);
  const tr = (Suu + Svv) / 2, df = Math.sqrt(((Suu - Svv) / 2) ** 2 + Suv * Suv);
  const m1 = tr + df, m2 = Math.max(0, tr - df);

  // extents in principal frame
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const vi of patch.verts) {
    const p = [verts[vi * 3] - c[0], verts[vi * 3 + 1] - c[1], verts[vi * 3 + 2] - c[2]];
    const pu = dot(p, u), pv = dot(p, v);
    if (pu < umin) umin = pu;
    if (pu > umax) umax = pu;
    if (pv < vmin) vmin = pv;
    if (pv > vmax) vmax = pv;
  }
  const pad = 1e-3 + 0.01 * Math.max(umax - umin, vmax - vmin);
  umin -= pad;
  umax += pad;
  vmin -= pad;
  vmax += pad;

  // occupancy mask
  const mask = new Uint8Array(MASK * MASK);
  const su = (umax - umin) / MASK, sv = (vmax - vmin) / MASK;
  const tri2 = [];
  let perim = 0;
  const bnd = [];
  for (const t of patch.tris) {
    const P = [0, 1, 2].map((k) => {
      const vi = tris[t * 3 + k];
      const p = [verts[vi * 3] - c[0], verts[vi * 3 + 1] - c[1], verts[vi * 3 + 2] - c[2]];
      return [dot(p, u), dot(p, v)];
    });
    tri2.push(P);
    rasterTri(mask, P, umin, vmin, su, sv);
    for (let k = 0; k < 3; k++) {
      const nb = adj[t * 3 + k];
      if (nb >= 0 && triPatch[nb] === patch.id) continue;
      const a = P[k], b = P[(k + 1) % 3];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      perim += L;
      bnd.push([a, b, L]);
    }
  }
  // boundary samples (for 2D ICP), evenly by length
  const maxB = 160;
  const step = Math.max(perim / maxB, 1e-6);
  const boundary = [];
  let acc = 0;
  for (const [a, b, L] of bnd) {
    let s = (step - acc) % step;
    if (s < 0) s += step;
    for (; s <= L; s += step) {
      const f = L > 0 ? s / L : 0;
      boundary.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
    }
    acc = (acc + L) % step;
    if (boundary.length > maxB * 2.2) break;
  }
  // interior samples, area weighted
  const nInt = 48;
  const interior = [];
  const cum = [];
  let ca = 0;
  for (const P of tri2) {
    ca += Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0])) / 2;
    cum.push(ca);
  }
  for (let i = 0; i < nInt; i++) {
    const r = rand() * ca;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < r) lo = m + 1;
      else hi = m;
    }
    const P = tri2[lo];
    let a = rand(), b = rand();
    if (a + b > 1) {
      a = 1 - a;
      b = 1 - b;
    }
    interior.push(P[0][0] + (P[1][0] - P[0][0]) * a + (P[2][0] - P[0][0]) * b, P[0][1] + (P[1][1] - P[0][1]) * a + (P[2][1] - P[0][1]) * b);
  }
  return {
    n,
    c,
    u,
    v,
    area: patch.area,
    m1,
    m2,
    ext: [umin, umax, vmin, vmax],
    mask,
    boundary: new Float32Array(boundary),
    interior: new Float32Array(interior),
    perim,
    tris: patch.tris.length,
  };
}

function rasterTri(mask, P, umin, vmin, su, sv) {
  const xs = P.map((p) => (p[0] - umin) / su), ys = P.map((p) => (p[1] - vmin) / sv);
  for (let k = 0; k < 3; k++) {
    const i = Math.min(MASK - 1, Math.max(0, Math.floor(xs[k]))), j = Math.min(MASK - 1, Math.max(0, Math.floor(ys[k])));
    mask[j * MASK + i] = 1;
  }
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(MASK - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(MASK - 1, Math.ceil(Math.max(...ys)));
  const den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
  if (Math.abs(den) < 1e-12) return;
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      // test pixel centre and corners (conservative-ish)
      let hit = false;
      for (const [ox, oy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
        const x = i + ox, y = j + oy;
        const l0 = ((ys[1] - ys[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (y - ys[2])) / den;
        const l1 = ((ys[2] - ys[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (y - ys[2])) / den;
        if (l0 >= -1e-9 && l1 >= -1e-9 && 1 - l0 - l1 >= -1e-9) {
          hit = true;
          break;
        }
      }
      if (hit) mask[j * MASK + i] = 1;
    }
  }
}

/** Is 3D point (already in plane coordinates u,v relative to c) inside plane's occupancy? */
export function planeContains(pl, pu, pv) {
  const [umin, umax, vmin, vmax] = pl.ext;
  if (pu < umin || pu > umax || pv < vmin || pv > vmax) return false;
  const i = Math.min(MASK - 1, Math.floor(((pu - umin) / (umax - umin)) * MASK));
  const j = Math.min(MASK - 1, Math.floor(((pv - vmin) / (vmax - vmin)) * MASK));
  return pl.mask[j * MASK + i] === 1;
}

/**
 * Fraction of plane B's interior samples (transformed by M into A's frame)
 * that land on plane A. Returns {frac, center3D}
 */
export function planeOverlap(A, B, M = null) {
  const s = B.interior;
  let hit = 0;
  const cen = [0, 0, 0];
  const n = s.length / 2;
  for (let i = 0; i < n; i++) {
    let p = add(B.c, add(scale(B.u, s[2 * i]), scale(B.v, s[2 * i + 1])));
    if (M) p = [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
    const r = sub(p, A.c);
    if (planeContains(A, dot(r, A.u), dot(r, A.v))) {
      hit++;
      cen[0] += p[0];
      cen[1] += p[1];
      cen[2] += p[2];
    }
  }
  return { frac: hit / n, center: hit ? scale(cen, 1 / hit) : null };
}

function findPairs(planes, diag) {
  const out = [];
  const cosTol = Math.cos(rad(1.5));
  const big = planes.filter((p) => p.area >= 0.5);
  const perPlane = new Map();
  for (let a = 0; a < big.length; a++) {
    const A = big[a];
    for (let b = a + 1; b < big.length; b++) {
      const B = big[b];
      if (dot(A.n, B.n) > -cosTol) continue;
      const d = dot(sub(B.c, A.c), A.n);
      const width = Math.abs(d);
      if (width < 0.2) continue;
      const concave = d > 0;
      if (width > (concave ? 0.8 : 1.0) * diag) continue;
      // overlap: B's samples projected onto A (ignoring the normal offset)
      const ov1 = planeOverlap(A, B);
      const ov2 = planeOverlap(B, A);
      const overlap = Math.max(ov1.frac, ov2.frac);
      if (overlap < 0.15) continue;
      // centre of overlap on the mid plane
      const cen0 = ov1.frac >= ov2.frac ? ov1.center : ov2.center;
      const mid = add(cen0, scale(A.n, dot(sub(A.c, cen0), A.n) + d / 2));
      const pr = { i: A.id, j: B.id, n: A.n, mid, width, concave, overlap, area: Math.min(A.area, B.area) * overlap };
      out.push(pr);
    }
  }
  // keep, per plane and concavity, the nearest few partners (avoid N^2 blowup)
  out.sort((p, q) => p.width - q.width);
  const keep = [];
  for (const pr of out) {
    const k1 = pr.i + (pr.concave ? 'c' : 'v'), k2 = pr.j + (pr.concave ? 'c' : 'v');
    const c1 = perPlane.get(k1) || 0, c2 = perPlane.get(k2) || 0;
    if (c1 >= 3 && c2 >= 3) continue;
    perPlane.set(k1, c1 + 1);
    perPlane.set(k2, c2 + 1);
    keep.push(pr);
  }
  keep.forEach((p, i) => (p.id = i));
  return keep;
}

function rangeAlong(pl, d) {
  const [umin, umax, vmin, vmax] = pl.ext;
  const cu = (umin + umax) / 2, cv = (vmin + vmax) / 2;
  const hu = (umax - umin) / 2, hv = (vmax - vmin) / 2;
  const ctr = add(pl.c, add(scale(pl.u, cu), scale(pl.v, cv)));
  const m = dot(ctr, d);
  const r = hu * Math.abs(dot(pl.u, d)) + hv * Math.abs(dot(pl.v, d));
  return [m - r, m + r];
}

function findRects(planes, pairs) {
  const out = [];
  const perpTol = Math.sin(rad(2));
  for (let a = 0; a < pairs.length; a++) {
    const P1 = pairs[a];
    for (let b = a + 1; b < pairs.length; b++) {
      const P2 = pairs[b];
      if (P1.concave !== P2.concave) continue;
      if (Math.abs(dot(P1.n, P2.n)) > perpTol) continue;
      const axis = norm(cross(P1.n, P2.n));
      // closure: walls of P1 span P2's width and are centred on P2's mid plane
      const ok = (Pa, Pb) => {
        for (const pid of [Pa.i, Pa.j]) {
          const [lo, hi] = rangeAlong(planes[pid], Pb.n);
          const m = dot(Pb.mid, Pb.n);
          const half = Pb.width / 2;
          const tol = Math.max(0.3, Pb.width * 0.12);
          if (Pa.concave) {
            // walls of a hole run from one wall of Pb to the other
            if (lo > m - half + tol || hi < m + half - tol) return false;
            if (lo < m - half - Math.max(tol, Pb.width * 0.6) && hi > m + half + Math.max(tol, Pb.width * 0.6)) return false;
          } else {
            if (Math.abs(lo - (m - half)) > tol || Math.abs(hi - (m + half)) > tol) return false;
          }
        }
        return true;
      };
      if (!ok(P1, P2) || !ok(P2, P1)) continue;
      // axial overlap of all 4 walls
      let t0 = -Infinity, t1 = Infinity;
      for (const pid of [P1.i, P1.j, P2.i, P2.j]) {
        const [lo, hi] = rangeAlong(planes[pid], axis);
        t0 = Math.max(t0, lo);
        t1 = Math.min(t1, hi);
      }
      if (t1 - t0 < 0.3) continue;
      // centre: intersection of mid planes at middle of the axial range
      const c = lineOfPlanes(P1.n, dot(P1.mid, P1.n), P2.n, dot(P2.mid, P2.n), axis);
      const tc = (t0 + t1) / 2;
      const center = add(c, scale(axis, tc - dot(c, axis)));
      const w1 = P1.width, w2 = P2.width;
      out.push({
        id: out.length,
        axis,
        center,
        d1: P1.n,
        d2: P2.n,
        w1,
        w2,
        t0: t0 - tc,
        t1: t1 - tc,
        len: t1 - t0,
        concave: P1.concave,
        pairs: [P1.id, P2.id],
        square: Math.abs(w1 - w2) < 0.03 * Math.max(w1, w2),
      });
    }
  }
  return out;
}

/** point on the intersection line of planes n1.x=d1, n2.x=d2 closest to origin */
function lineOfPlanes(n1, d1, n2, d2, axis) {
  // x = a n1 + b n2 ; solve n1.x = d1, n2.x = d2
  const c = dot(n1, n2);
  const den = 1 - c * c;
  const a = (d1 - d2 * c) / den, b = (d2 - d1 * c) / den;
  return add(scale(n1, a), scale(n2, b));
}

/** Area-weighted random surface samples with normals. */
export function sampleSurface(mesh, N, seed) {
  const { verts, tris, normals, areas, T } = mesh;
  const rand = rng(seed);
  const cum = new Float64Array(T);
  let a = 0;
  for (let t = 0; t < T; t++) {
    a += areas[t];
    cum[t] = a;
  }
  const pos = new Float32Array(N * 3), nor = new Float32Array(N * 3);
  // stratified: N strata over cumulative area
  for (let i = 0; i < N; i++) {
    const r = ((i + rand()) / N) * a;
    let lo = 0, hi = T - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < r) lo = m + 1;
      else hi = m;
    }
    const t = lo;
    let u = rand(), v = rand();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const A = tris[t * 3] * 3, B = tris[t * 3 + 1] * 3, C = tris[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = verts[A + k] + (verts[B + k] - verts[A + k]) * u + (verts[C + k] - verts[A + k]) * v;
      nor[i * 3 + k] = normals[t * 3 + k];
    }
  }
  return { pos, nor, areaPer: a / N, n: N };
}
