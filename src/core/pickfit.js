// On-demand geometry for interactive tools: sharp straight edges under the
// cursor, a local cylinder/arc fit at a clicked triangle (for curved slots or
// holes the automatic pass missed) and a hole defined by three clicked points.

import { buildMesh } from './mesh.js';
import { refineCylinder } from './segment.js';
import { fitCircle2D } from './fit.js';
import { dot, cross, norm, sub, add, scale, len, dist, basis, eigSym3, rad } from './math.js';

/** Indexed mesh + lookups for a triangle soup (cache the result per part). */
export function meshIndex(positions) {
  const mesh = buildMesh(positions);
  const fromOrig = new Int32Array(positions.length / 9).fill(-1);
  for (let t = 0; t < mesh.T; t++) fromOrig[mesh.triOrig[t]] = t;
  return { mesh, fromOrig, sharp: null };
}

const vtx = (mesh, i) => [mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]];
const nrm = (mesh, t) => [mesh.normals[t * 3], mesh.normals[t * 3 + 1], mesh.normals[t * 3 + 2]];

function sharpEdges(index, minAngleDeg = 25) {
  if (index.sharp) return index.sharp;
  const { mesh } = index;
  const cosT = Math.cos(rad(minAngleDeg));
  const byVertex = new Map();
  const edges = [];
  for (let t = 0; t < mesh.T; t++) {
    for (let k = 0; k < 3; k++) {
      const o = mesh.adj[t * 3 + k];
      const a = mesh.tris[t * 3 + k], b = mesh.tris[t * 3 + ((k + 1) % 3)];
      if (o >= 0 && o < t) continue; // each interior edge once
      const sharp = o < 0 || dot(nrm(mesh, t), nrm(mesh, o)) < cosT;
      if (!sharp) continue;
      const id = edges.length;
      edges.push([a, b]);
      for (const v of [a, b]) {
        if (!byVertex.has(v)) byVertex.set(v, []);
        byVertex.get(v).push(id);
      }
    }
  }
  index.sharp = { edges, byVertex };
  return index.sharp;
}

function segDist(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-12, dot(ab, ab))));
  return dist(p, add(a, scale(ab, t)));
}

/**
 * Straight sharp edge nearest to local point p near original triangle triO.
 * Returns {p0, p1} (local coordinates) of the full collinear run, or null.
 */
export function pickEdge(index, triO, p, tol) {
  const { mesh, fromOrig } = index;
  const t0 = fromOrig[triO];
  if (t0 < 0) return null;
  const { edges, byVertex } = sharpEdges(index);
  // candidate vertices: the triangle and its neighbours (two rings)
  const ring = new Set([t0]);
  for (let r = 0; r < 2; r++) {
    for (const t of Array.from(ring)) for (let k = 0; k < 3; k++) {
      const o = mesh.adj[t * 3 + k];
      if (o >= 0) ring.add(o);
    }
  }
  let best = null;
  for (const t of ring) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[t * 3 + k];
      for (const eid of byVertex.get(v) || []) {
        const [a, b] = edges[eid];
        const d = segDist(p, vtx(mesh, a), vtx(mesh, b));
        if (d <= tol && (!best || d < best.d)) best = { d, eid };
      }
    }
  }
  if (!best) return null;
  // extend along collinear sharp edges in both directions
  const [a0, b0] = edges[best.eid];
  const dir = norm(sub(vtx(mesh, b0), vtx(mesh, a0)));
  const cosT = Math.cos(rad(1.5));
  const walk = (start, sign) => {
    let cur = start, prevEdge = best.eid, guard = 0;
    for (;;) {
      if (guard++ > 5000) break;
      let next = -1, nv = -1;
      for (const eid of byVertex.get(cur) || []) {
        if (eid === prevEdge) continue;
        const [x, y] = edges[eid];
        const other = x === cur ? y : x;
        const d = norm(sub(vtx(mesh, other), vtx(mesh, cur)));
        if (dot(d, dir) * sign >= cosT) {
          next = eid;
          nv = other;
          break;
        }
      }
      if (next < 0) break;
      prevEdge = next;
      cur = nv;
    }
    return vtx(mesh, cur);
  };
  return { p0: walk(a0, -1), p1: walk(b0, 1) };
}

/** Fit a cylinder (or arc) around a clicked triangle; works for partial arcs too. */
export function fitCylinderAt(index, triO) {
  const { mesh, fromOrig } = index;
  const seed = fromOrig[triO];
  if (seed < 0) return null;
  const cosSmooth = Math.cos(rad(35));
  // smooth neighbourhood
  const seen = new Set([seed]);
  const nb = [seed];
  for (let qi = 0; qi < nb.length && nb.length < 80; qi++) {
    const t = nb[qi];
    for (let k = 0; k < 3; k++) {
      const o = mesh.adj[t * 3 + k];
      if (o < 0 || seen.has(o) || dot(nrm(mesh, t), nrm(mesh, o)) < cosSmooth) continue;
      seen.add(o);
      nb.push(o);
    }
  }
  if (nb.length < 3) return null;
  const S = [0, 0, 0, 0, 0, 0];
  let w = 0;
  for (const t of nb) {
    const n = nrm(mesh, t), a = mesh.areas[t];
    S[0] += a * n[0] * n[0];
    S[1] += a * n[0] * n[1];
    S[2] += a * n[0] * n[2];
    S[3] += a * n[1] * n[1];
    S[4] += a * n[1] * n[2];
    S[5] += a * n[2] * n[2];
    w += a;
  }
  const e = eigSym3(S.map((x) => x / w));
  if (e.values[1] < 0.002) return null; // flat
  let a = e.vectors[0];
  const vs = new Set();
  for (const t of nb) for (let k = 0; k < 3; k++) vs.add(mesh.tris[t * 3 + k]);
  let vids = Array.from(vs);
  const [u, v] = basis(a);
  const xy = new Float64Array(vids.length * 2);
  vids.forEach((id, i) => {
    const p = vtx(mesh, id);
    xy[2 * i] = dot(p, u);
    xy[2 * i + 1] = dot(p, v);
  });
  const f = fitCircle2D(xy, vids.length);
  if (!f || f.r > mesh.diag) return null;
  let c = add(scale(u, f.cx), scale(v, f.cy));
  let cyl = refineCylinder(mesh.verts, vids, a, c, f.r, 8);
  a = cyl.a;
  c = cyl.p;
  let r = cyl.r;
  const tol = Math.max(0.03, r * 0.01);
  const on = (id) => {
    const d = sub(vtx(mesh, id), c);
    const s = dot(d, a);
    return Math.abs(len(sub(d, scale(a, s))) - r) <= tol;
  };
  // grow over every connected triangle lying on that cylinder
  const region = [];
  const seen2 = new Set([seed]);
  const q = [seed];
  for (let qi = 0; qi < q.length && region.length < 20000; qi++) {
    const t = q[qi];
    if (![0, 1, 2].every((k) => on(mesh.tris[t * 3 + k]))) continue;
    if (Math.abs(dot(nrm(mesh, t), a)) > 0.3) continue;
    region.push(t);
    for (let k = 0; k < 3; k++) {
      const o = mesh.adj[t * 3 + k];
      if (o >= 0 && !seen2.has(o)) {
        seen2.add(o);
        q.push(o);
      }
    }
  }
  if (region.length < 2) return null;
  const vv = new Set();
  for (const t of region) for (let k = 0; k < 3; k++) vv.add(mesh.tris[t * 3 + k]);
  vids = Array.from(vv);
  cyl = refineCylinder(mesh.verts, vids, a, c, r, 4);
  a = cyl.a;
  c = cyl.p;
  r = cyl.r;
  return describeCylinder(mesh, region, vids, a, c, r);
}

function describeCylinder(mesh, region, vids, a, c, r) {
  let t0 = Infinity, t1 = -Infinity;
  const [u, v] = basis(a);
  const angs = [];
  for (const id of vids) {
    const d = sub(vtx(mesh, id), c);
    const s = dot(d, a);
    t0 = Math.min(t0, s);
    t1 = Math.max(t1, s);
    angs.push(Math.atan2(dot(d, v), dot(d, u)));
  }
  angs.sort((x, y) => x - y);
  let maxGap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
  for (let i = 1; i < angs.length; i++) maxGap = Math.max(maxGap, angs[i] - angs[i - 1]);
  const full = maxGap < rad(40);
  let conv = 0;
  for (const t of region) {
    const tri = [0, 1, 2].map((k) => vtx(mesh, mesh.tris[t * 3 + k]));
    const cen = scale(add(add(tri[0], tri[1]), tri[2]), 1 / 3);
    const d = sub(cen, c);
    conv += dot(sub(d, scale(a, dot(d, a))), nrm(mesh, t)) * mesh.areas[t];
  }
  const tm = (t0 + t1) / 2;
  return {
    a,
    c: add(c, scale(a, tm)),
    r,
    t0: t0 - tm,
    t1: t1 - tm,
    len: Math.max(0.01, t1 - t0),
    span: full ? 2 * Math.PI : 2 * Math.PI - maxGap,
    full,
    concave: conv < 0,
    u,
    v,
    arcMid: 0,
    src: 'user',
    tris: region.map((t) => mesh.triOrig[t]),
  };
}

/** A hole from three clicked local points (on its rim or its wall), refined against the mesh. */
export function holeFrom3Points(index, pts) {
  const { mesh } = index;
  const [p1, p2, p3] = pts;
  const n = norm(cross(sub(p2, p1), sub(p3, p1)));
  if (!isFinite(n[0]) || len(cross(sub(p2, p1), sub(p3, p1))) < 1e-9) return null;
  // circumcentre in the plane of the three points
  const a = sub(p1, p3), b = sub(p2, p3);
  const axb = cross(a, b);
  const cc = add(p3, scale(cross(sub(scale(b, dot(a, a)), scale(a, dot(b, b))), axb), 1 / (2 * dot(axb, axb))));
  const r0 = dist(cc, p1);
  // nearby vertices for refinement
  const vids = [];
  for (let i = 0; i < mesh.V; i++) {
    const d = sub(vtx(mesh, i), cc);
    const s = dot(d, n);
    if (Math.abs(s) > Math.max(3 * r0, 3)) continue;
    const rho = len(sub(d, scale(n, s)));
    if (rho > 0.6 * r0 && rho < 1.4 * r0) vids.push(i);
  }
  let axis = n, c = cc, r = r0;
  if (vids.length >= 8) {
    const f = refineCylinder(mesh.verts, vids, n, cc, r0, 8);
    // accept the refinement only if most of those vertices really are on it
    let on = 0;
    for (const id of vids) {
      const d = sub(vtx(mesh, id), f.p);
      const s = dot(d, f.a);
      if (Math.abs(len(sub(d, scale(f.a, s))) - f.r) < Math.max(0.05, 0.03 * f.r)) on++;
    }
    if (on >= 0.5 * vids.length && Math.abs(dot(f.a, n)) > 0.8 && Math.abs(f.r - r0) < 0.3 * r0) {
      axis = f.a;
      c = f.p;
      r = f.r;
    }
  }
  // wall triangles near the fitted surface (for highlighting / depth)
  const region = [];
  const tol = Math.max(0.08, 0.05 * r);
  for (let t = 0; t < mesh.T; t++) {
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      const d = sub(vtx(mesh, mesh.tris[t * 3 + k]), c);
      const s = dot(d, axis);
      if (Math.abs(s) > Math.max(4 * r, 6) || Math.abs(len(sub(d, scale(axis, s))) - r) > tol) ok = false;
    }
    if (ok) region.push(t);
  }
  const vv = new Set();
  for (const t of region) for (let k = 0; k < 3; k++) vv.add(mesh.tris[t * 3 + k]);
  if (region.length >= 2) return describeCylinder(mesh, region, Array.from(vv), axis, c, r);
  // no wall found: a bare axis through the circle
  return { a: axis, c, r, t0: -0.5, t1: 0.5, len: 1, span: 2 * Math.PI, full: true, concave: true, u: basis(axis)[0], v: basis(axis)[1], arcMid: 0, src: 'user', tris: [] };
}
