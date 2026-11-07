// Surface segmentation: planar region growing on the triangle graph followed
// by merging of narrow facet strips into cylinders (bores, pegs, bosses,
// fillets). Works on CAD style tessellations where vertices lie exactly on the
// true surface.

import { cross, dot, norm, eigSym3, basis, rad } from './math.js';
import { fitCircle2D } from './fit.js';

/**
 * @returns {{triPatch: Int32Array, patches: object[]}}
 */
export function segmentPlanar(mesh, opts = {}) {
  const { T, tris, verts, normals, areas, adj } = mesh;
  const distTol = opts.distTol ?? Math.max(0.003, mesh.diag * 2e-5);
  const cosTol = Math.cos(rad(opts.angTolDeg ?? 1.0));
  const triPatch = new Int32Array(T).fill(-1);
  const order = new Uint32Array(T);
  for (let i = 0; i < T; i++) order[i] = i;
  order.sort((a, b) => areas[b] - areas[a]);

  // per-triangle sliver flag: normal unreliable
  const sliver = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    let maxE = 0;
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k] * 3, b = tris[t * 3 + ((k + 1) % 3)] * 3;
      const e = Math.hypot(verts[a] - verts[b], verts[a + 1] - verts[b + 1], verts[a + 2] - verts[b + 2]);
      if (e > maxE) maxE = e;
    }
    const h = maxE > 0 ? (2 * areas[t]) / maxE : 0;
    if (h < Math.max(0.002, distTol * 2)) sliver[t] = 1;
  }

  const patches = [];
  const queue = new Int32Array(T);
  for (let oi = 0; oi < T; oi++) {
    const seed = order[oi];
    if (triPatch[seed] >= 0) continue;
    const pid = patches.length;
    let nx = normals[seed * 3], ny = normals[seed * 3 + 1], nz = normals[seed * 3 + 2];
    const s0 = tris[seed * 3] * 3;
    let d0 = nx * verts[s0] + ny * verts[s0 + 1] + nz * verts[s0 + 2];
    let qh = 0, qt = 0;
    queue[qt++] = seed;
    triPatch[seed] = pid;
    const list = [];
    // accumulate area-weighted normal for refinement after the region gets large
    let anx = 0, any = 0, anz = 0, aw = 0;
    let refined = sliver[seed] ? 0 : 1;
    while (qh < qt) {
      const t = queue[qh++];
      list.push(t);
      if (!sliver[t]) {
        anx += normals[t * 3] * areas[t];
        any += normals[t * 3 + 1] * areas[t];
        anz += normals[t * 3 + 2] * areas[t];
        aw += areas[t];
      }
      for (let k = 0; k < 3; k++) {
        const nb = adj[t * 3 + k];
        if (nb < 0 || triPatch[nb] >= 0) continue;
        if (!sliver[nb]) {
          const c = normals[nb * 3] * nx + normals[nb * 3 + 1] * ny + normals[nb * 3 + 2] * nz;
          if (c < cosTol) continue;
        } else if (!refined) {
          // sliver seeding a sliver: be strict, accept only if coplanar by distance
        }
        let ok = true;
        for (let j = 0; j < 3; j++) {
          const v = tris[nb * 3 + j] * 3;
          const d = nx * verts[v] + ny * verts[v + 1] + nz * verts[v + 2] - d0;
          if (d > distTol || d < -distTol) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        triPatch[nb] = pid;
        queue[qt++] = nb;
      }
    }
    if (aw > 0) {
      const l = Math.hypot(anx, any, anz);
      if (l > 0) {
        nx = anx / l;
        ny = any / l;
        nz = anz / l;
      }
    }
    patches.push({ id: pid, tris: list, n: [nx, ny, nz] });
  }

  // patch stats
  const vmark = new Int32Array(mesh.V).fill(-1);
  for (const p of patches) {
    let a = 0, cx = 0, cy = 0, cz = 0;
    const vs = [];
    for (const t of p.tris) {
      const ar = areas[t];
      a += ar;
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k];
        cx += (verts[v * 3] * ar) / 3;
        cy += (verts[v * 3 + 1] * ar) / 3;
        cz += (verts[v * 3 + 2] * ar) / 3;
        if (vmark[v] !== p.id) {
          vmark[v] = p.id;
          vs.push(v);
        }
      }
    }
    p.area = a;
    p.c = a > 0 ? [cx / a, cy / a, cz / a] : [verts[vs[0] * 3], verts[vs[0] * 3 + 1], verts[vs[0] * 3 + 2]];
    p.verts = vs;
  }
  return { triPatch, patches };
}

/** Patch adjacency graph: Map pid -> Map(neighbourPid -> sharedEdgeLength) */
export function patchGraph(mesh, triPatch, P) {
  const { T, tris, verts, adj } = mesh;
  const g = Array.from({ length: P }, () => new Map());
  for (let t = 0; t < T; t++) {
    const pa = triPatch[t];
    for (let k = 0; k < 3; k++) {
      const nb = adj[t * 3 + k];
      if (nb < 0) continue;
      const pb = triPatch[nb];
      if (pb === pa || nb < t) continue;
      const a = tris[t * 3 + k] * 3, b = tris[t * 3 + ((k + 1) % 3)] * 3;
      const L = Math.hypot(verts[a] - verts[b], verts[a + 1] - verts[b + 1], verts[a + 2] - verts[b + 2]);
      g[pa].set(pb, (g[pa].get(pb) || 0) + L);
      g[pb].set(pa, (g[pb].get(pa) || 0) + L);
    }
  }
  return g;
}

function axisFromNormals(ns, ws) {
  const S = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i], w = ws ? ws[i] : 1;
    S[0] += w * n[0] * n[0];
    S[1] += w * n[0] * n[1];
    S[2] += w * n[0] * n[2];
    S[3] += w * n[1] * n[1];
    S[4] += w * n[1] * n[2];
    S[5] += w * n[2] * n[2];
  }
  return eigSym3(S).vectors[0];
}

/** project vertex ids into 2D frame perpendicular to axis */
function project(mesh, vids, u, v, out) {
  const { verts } = mesh;
  for (let i = 0; i < vids.length; i++) {
    const k = vids[i] * 3;
    const x = verts[k], y = verts[k + 1], z = verts[k + 2];
    out[2 * i] = x * u[0] + y * u[1] + z * u[2];
    out[2 * i + 1] = x * v[0] + y * v[1] + z * v[2];
  }
}

/**
 * Merge planar facet patches into cylinders.
 * @returns cylinders: {patches:[pid], a, c, r, t0, t1, span, concave, area, rms}
 */
export function detectCylinders(mesh, patches, graph, opts = {}) {
  const maxDihedral = rad(opts.maxDihedralDeg ?? 46);
  const minDihedral = rad(0.05);
  const perpTol = Math.sin(rad(opts.axisTolDeg ?? 2.5));
  const inCyl = new Int32Array(patches.length).fill(-1);
  const cyls = [];
  const diag = mesh.diag;
  // Big patches are rarely part of a cylinder; process small ones as seeds first.
  const seeds = patches
    .map((p) => p.id)
    .sort((a, b) => patches[a].area - patches[b].area);
  const buf = new Float64Array(2 * mesh.V);

  const tolFor = (r) => Math.max(0.004, r * 1.5e-3, diag * 1e-5);

  for (const sid of seeds) {
    if (inCyl[sid] >= 0) continue;
    const P = patches[sid];
    let found = null;
    for (const [qid] of graph[sid]) {
      if (inCyl[qid] >= 0) continue;
      const Q = patches[qid];
      const cd = dot(P.n, Q.n);
      const ang = Math.acos(Math.max(-1, Math.min(1, cd)));
      if (ang < minDihedral || ang > maxDihedral) continue;
      let a = norm(cross(P.n, Q.n));
      const region = [sid, qid];
      const inRegion = new Set(region);
      let vids = Array.from(new Set([...P.verts, ...Q.verts]));
      let vidSet = new Set(vids);
      let fit = null;
      // frontier: [patch, via]
      const frontier = [];
      const pushNbrs = (pid) => {
        for (const [x] of graph[pid]) if (!inRegion.has(x) && inCyl[x] < 0) frontier.push([x, pid]);
      };
      pushNbrs(sid);
      pushNbrs(qid);
      const tried = new Set();
      while (frontier.length) {
        const [x, via] = frontier.pop();
        if (inRegion.has(x) || inCyl[x] >= 0) continue;
        const key = x;
        if (tried.has(key)) continue;
        const X = patches[x];
        if (Math.abs(dot(X.n, a)) > perpTol) continue;
        const dvia = Math.acos(Math.max(-1, Math.min(1, dot(X.n, patches[via].n))));
        if (dvia < minDihedral || dvia > maxDihedral) continue;
        tried.add(key);
        if (X.verts.length > 4000) continue;
        const cand = vids.concat(X.verts.filter((v) => !vidSet.has(v)));
        if (cand.length > buf.length / 2) continue;
        const [u, v] = basis(a);
        project(mesh, cand, u, v, buf);
        const f = fitCircle2D(buf, cand.length);
        if (!f || f.r > diag * 2) continue;
        if (f.max > tolFor(f.r)) continue;
        // accept
        region.push(x);
        inRegion.add(x);
        vids = cand;
        vidSet = new Set(cand);
        fit = { ...f, u, v };
        // re-estimate axis from all normals
        a = axisFromNormals(
          region.map((p) => patches[p].n),
          region.map((p) => patches[p].area),
        );
        tried.clear();
        pushNbrs(x);
        for (const r of region) pushNbrs(r);
      }
      if (region.length >= 3 && fit) {
        found = { region, a, vids };
        break;
      }
    }
    if (!found) continue;
    const cyl = finishCylinder(mesh, patches, found.region, found.a, found.vids, buf);
    if (!cyl) continue;
    cyl.id = cyls.length;
    for (const p of found.region) inCyl[p] = cyl.id;
    cyls.push(cyl);
  }
  return { cyls, inCyl };
}

function finishCylinder(mesh, patches, region, a, vids, buf) {
  const [u, v] = basis(a);
  project(mesh, vids, u, v, buf);
  const f = fitCircle2D(buf, vids.length);
  if (!f) return null;
  const { verts } = mesh;
  // axial extent
  let t0 = Infinity, t1 = -Infinity;
  for (const id of vids) {
    const t = verts[id * 3] * a[0] + verts[id * 3 + 1] * a[1] + verts[id * 3 + 2] * a[2];
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  // centre point on axis at t = 0 then shift to middle
  const base = [u[0] * f.cx + v[0] * f.cy, u[1] * f.cx + v[1] * f.cy, u[2] * f.cx + v[2] * f.cy];
  const tm = (t0 + t1) / 2;
  const c = [base[0] + a[0] * tm, base[1] + a[1] * tm, base[2] + a[2] * tm];
  // angular coverage from vertex angles
  const angs = [];
  for (let i = 0; i < vids.length; i++) angs.push(Math.atan2(buf[2 * i + 1] - f.cy, buf[2 * i] - f.cx));
  angs.sort((x, y) => x - y);
  const gaps = [];
  for (let i = 0; i < angs.length; i++) {
    const g = i + 1 < angs.length ? angs[i + 1] - angs[i] : angs[0] + 2 * Math.PI - angs[i];
    if (g > 1e-6) gaps.push(g);
  }
  gaps.sort((x, y) => x - y);
  const maxGap = gaps.length ? gaps[gaps.length - 1] : 2 * Math.PI;
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const expected = (2 * Math.PI) / Math.max(3, region.length);
  const full = maxGap < Math.PI / 3 && (maxGap <= medGap * 1.6 + 1e-6 || maxGap <= expected * 1.3);
  const span = full ? 2 * Math.PI : 2 * Math.PI - maxGap;
  // the start angle of the arc (for partial cylinders): angle after the biggest gap
  let arcStart = 0;
  if (!full) {
    for (let i = 0; i < angs.length; i++) {
      const g = i + 1 < angs.length ? angs[i + 1] - angs[i] : angs[0] + 2 * Math.PI - angs[i];
      if (Math.abs(g - maxGap) < 1e-9) {
        arcStart = i + 1 < angs.length ? angs[i + 1] : angs[0];
        break;
      }
    }
  }
  // convexity from patch normals vs radial direction
  let conv = 0, area = 0;
  for (const pid of region) {
    const p = patches[pid];
    const rel = [p.c[0] - c[0], p.c[1] - c[1], p.c[2] - c[2]];
    const ax = dot(rel, a);
    const rad = [rel[0] - a[0] * ax, rel[1] - a[1] * ax, rel[2] - a[2] * ax];
    conv += dot(rad, p.n) * p.area;
    area += p.area;
  }
  return {
    patches: region.slice(),
    a,
    c,
    r: f.r,
    t0: t0 - tm,
    t1: t1 - tm,
    len: t1 - t0,
    span,
    full,
    arcMid: full ? 0 : arcStart + span / 2,
    u,
    v,
    concave: conv < 0,
    area,
    rms: f.rms,
    facets: region.length,
  };
}
