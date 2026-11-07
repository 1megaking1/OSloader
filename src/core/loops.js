// Hole / boss detection from circular boundary loops of flat faces.
//
// A hole drilled into a flat face leaves a circular inner loop in that face,
// however its wall is triangulated (decimated meshes, staggered fans, very
// small holes with only 6-8 segments). From each circular loop we grow the
// adjacent wall along the face normal, measure depth and radius profile, and
// report a cylinder or a cone (tapered heat-set insert holes).

import { dot, cross, norm, sub, add, scale, rad, deg } from './math.js';
import { fitCircle2D } from './fit.js';

/**
 * @param mesh indexed mesh (buildMesh)
 * @param seg {triPatch, patches}
 * @param patchPlane Int32Array patch id -> plane feature id (-1 if none)
 * @param planes plane features (with n, c, u, v)
 * @returns {object[]} cylinder-like features (src: 'loop')
 */
export function findLoopHoles(mesh, seg, patchPlane, planes, opts = {}) {
  const { tris, verts, normals, adj } = mesh;
  const { triPatch, patches } = seg;
  const diag = mesh.diag;
  const out = [];
  const minR = opts.minLoopRadius ?? 0.35;
  for (const P of planes) {
    const pid = P.patch;
    if (pid == null) continue;
    const patch = patches[pid];
    // directed boundary edges (follow triangle winding)
    const edges = [];
    for (const t of patch.tris) {
      for (let k = 0; k < 3; k++) {
        const o = adj[t * 3 + k];
        if (o >= 0 && triPatch[o] === pid) continue;
        edges.push({ a: tris[t * 3 + k], b: tris[t * 3 + ((k + 1) % 3)], o, used: false });
      }
    }
    if (edges.length < 5) continue;
    const byStart = new Map();
    edges.forEach((e, i) => {
      if (!byStart.has(e.a)) byStart.set(e.a, []);
      byStart.get(e.a).push(i);
    });
    for (let s = 0; s < edges.length; s++) {
      if (edges[s].used) continue;
      const loop = [];
      let cur = s;
      let guard = 0;
      while (cur >= 0 && !edges[cur].used && guard++ < 20000) {
        edges[cur].used = true;
        loop.push(edges[cur]);
        const nexts = byStart.get(edges[cur].b) || [];
        cur = -1;
        for (const ni of nexts) {
          if (!edges[ni].used) {
            cur = ni;
            break;
          }
        }
      }
      if (loop.length < 5 || loop[loop.length - 1].b !== loop[0].a) continue;
      const f = circularLoop(mesh, P, loop, diag, minR);
      if (!f) continue;
      const w = growWall(mesh, P, f, loop, pid, triPatch);
      if (w) out.push(w);
    }
  }
  return mergeCoaxial(out);
}

/** circle fit of a loop in the plane frame; returns {C, r, area, perim} or null */
function circularLoop(mesh, P, loop, diag, minR) {
  const { verts } = mesh;
  const n = loop.length;
  const xy = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = loop[i].a * 3;
    const p = [verts[v] - P.c[0], verts[v + 1] - P.c[1], verts[v + 2] - P.c[2]];
    xy[2 * i] = dot(p, P.u);
    xy[2 * i + 1] = dot(p, P.v);
  }
  const fit = fitCircle2D(xy, n);
  if (!fit || fit.r < minR || fit.r > diag * 0.5) return null;
  if (fit.max > Math.max(0.05, 0.06 * fit.r)) return null;
  let area = 0, perim = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1];
    perim += Math.hypot(xy[2 * j] - xy[2 * i], xy[2 * j + 1] - xy[2 * i + 1]);
  }
  area /= 2;
  const circ = 2 * Math.PI * fit.r;
  if (Math.abs(perim - circ) > 0.15 * circ) return null;
  if (Math.abs(Math.abs(area) - Math.PI * fit.r * fit.r) > 0.22 * Math.PI * fit.r * fit.r) return null;
  // angular coverage: the vertices must go all the way round
  const angs = [];
  for (let i = 0; i < n; i++) angs.push(Math.atan2(xy[2 * i + 1] - fit.cy, xy[2 * i] - fit.cx));
  angs.sort((a, b) => a - b);
  let maxGap = angs[0] + 2 * Math.PI - angs[n - 1];
  for (let i = 1; i < n; i++) maxGap = Math.max(maxGap, angs[i] - angs[i - 1]);
  if (maxGap > rad(70)) return null;
  const C = add(P.c, add(scale(P.u, fit.cx), scale(P.v, fit.cy)));
  return { C, r: fit.r, area, perim, fitMax: fit.max };
}

/** grow the wall adjacent to a circular loop; measure depth, radius profile, convexity */
function growWall(mesh, P, f, loop, pid, triPatch) {
  const { tris, verts, normals, adj, T } = mesh;
  const n = P.n;
  const C = f.C;
  const seeds = loop.map((e) => e.o).filter((o) => o >= 0);
  if (seeds.length < 3) return null;
  const centroid = (t) => {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    return [(verts[a] + verts[b] + verts[c]) / 3, (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3, (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3];
  };
  // wall direction: which side of the face the adjacent triangles lie on
  let hsum = 0, conv = 0;
  for (const t of seeds) {
    const c = centroid(t);
    const rel = sub(c, C);
    hsum += dot(rel, n);
    const radial = norm(sub(rel, scale(n, dot(rel, n))));
    conv += dot([normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]], radial);
  }
  if (Math.abs(hsum) < 1e-9) return null;
  const d = hsum > 0 ? n : scale(n, -1);
  const concave = conv < 0;
  const r = f.r;
  const rLo = Math.max(0.05, 0.4 * r - 0.1), rHi = 1.7 * r + 0.3;
  const seen = new Set(seeds);
  const queue = seeds.slice();
  const wall = [];
  const sv = []; // straight-wall (s, rho) samples
  const tv = []; // chamfer / fillet / countersink samples
  let tnA = 0, tnN = 0;
  for (let qi = 0; qi < queue.length && wall.length < 8000; qi++) {
    const t = queue[qi];
    if (triPatch[t] === pid) continue;
    const tn = [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
    const ca = Math.abs(dot(tn, d));
    if (ca > 0.95) continue; // a floor / step face ends the wall
    let ok = true;
    const vs = [];
    for (let k = 0; k < 3 && ok; k++) {
      const vi = tris[t * 3 + k];
      const p = [verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]];
      const rel = sub(p, C);
      const s = dot(rel, d);
      const rho = Math.hypot(...sub(rel, scale(d, s)));
      if (s < -0.05 || rho < rLo || rho > rHi) ok = false;
      vs.push([s, rho]);
    }
    if (!ok) continue;
    const rel = sub(centroid(t), C);
    const radial = norm(sub(rel, scale(d, dot(rel, d))));
    if (dot(tn, radial) < 0 !== concave) continue;
    if (ca > 0.35) {
      // chamfers and fillets are only allowed near the entry
      if (vs.some(([sv0]) => sv0 > 0.6 * r + 1.5)) continue;
      for (const x of vs) tv.push(x);
      tnA += ca;
      tnN++;
    } else for (const x of vs) sv.push(x);
    wall.push(t);
    for (let k = 0; k < 3; k++) {
      const o = adj[t * 3 + k];
      if (o >= 0 && !seen.has(o)) {
        seen.add(o);
        queue.push(o);
      }
    }
  }
  if (wall.length < 3) return null;
  if (sv.length < 6) {
    // only a conical entry (countersink / chamfered blind dimple): still an axis
    if (tv.length < 6) return null;
    let smax = 0, rs = 0;
    for (const [s0, rho] of tv) {
      smax = Math.max(smax, s0);
      rs += rho;
    }
    if (smax < 0.2) return null;
    const half = deg(Math.acos(Math.min(1, tnA / tnN)));
    const rMean = rs / tv.length;
    return {
      a: d, c: add(C, scale(d, smax / 2)), r: rMean, rTop: r, rBottom: Math.max(0.05, r - smax * Math.tan(rad(half))),
      t0: -smax / 2, t1: smax / 2, len: smax, span: 2 * Math.PI, full: true, concave, cone: 90 - half,
      src: 'loop', facePlane: P.id, facets: wall.length, rms: 0, wallTris: wall, area: 0, countersink: true,
    };
  }
  // profile rho(s) = r0 + k s
  let ss = 0, sr = 0, sss = 0, ssr = 0, smax = 0, smin = Infinity;
  for (const [s, rho] of sv) {
    ss += s;
    sr += rho;
    sss += s * s;
    ssr += s * rho;
    smax = Math.max(smax, s);
    smin = Math.min(smin, s);
  }
  const m = sv.length;
  const den = m * sss - ss * ss;
  let k = den > 1e-12 ? (m * ssr - ss * sr) / den : 0;
  let r0 = (sr - k * ss) / m;
  if (smax - smin < 0.25) return null;
  let res = 0;
  for (const [s, rho] of sv) res += (rho - (r0 + k * s)) ** 2;
  res = Math.sqrt(res / m);
  if (res > Math.max(0.06, 0.06 * r)) return null;
  // nearly straight walls are cylinders
  const halfAngle = deg(Math.atan(Math.abs(k)));
  if (halfAngle < 1.2) {
    k = 0;
    r0 = sr / m;
  }
  const L = smax - smin;
  const sMid = (smax + smin) / 2;
  const rMid = r0 + k * sMid;
  return {
    a: d,
    c: add(C, scale(d, sMid)),
    r: rMid,
    rTop: r0 + k * smin,
    rBottom: r0 + k * smax,
    entry: f.r,
    t0: -L / 2,
    t1: L / 2,
    len: L,
    span: 2 * Math.PI,
    full: true,
    concave,
    cone: halfAngle >= 1.2 ? halfAngle * Math.sign(k) : 0,
    src: 'loop',
    facePlane: P.id,
    facets: wall.length,
    rms: res,
    wallTris: wall,
    area: 0,
  };
}

/** merge loop features describing the same bore (e.g. found from both ends of a through hole) */
function mergeCoaxial(list) {
  const out = [];
  for (const f of list) {
    let merged = false;
    for (const g of out) {
      if (Math.abs(dot(f.a, g.a)) < Math.cos(rad(1))) continue;
      if (f.concave !== g.concave) continue;
      const rel = sub(f.c, g.c);
      const off = Math.hypot(...sub(rel, scale(g.a, dot(rel, g.a))));
      if (off > 0.05 + 0.05 * g.r) continue;
      if (Math.abs(f.r - g.r) > 0.1 + 0.1 * g.r) continue;
      // extents along g's axis
      const tf = dot(rel, g.a);
      const lo = Math.min(g.t0, tf - f.len / 2), hi = Math.max(g.t1, tf + f.len / 2);
      const overlapOrTouch = tf - f.len / 2 <= g.t1 + 0.2 && tf + f.len / 2 >= g.t0 - 0.2;
      if (!overlapOrTouch) continue;
      const mid = (lo + hi) / 2;
      g.c = add(g.c, scale(g.a, mid));
      g.t0 = lo - mid;
      g.t1 = hi - mid;
      g.len = hi - lo;
      g.wallTris = g.wallTris.concat(f.wallTris);
      g.facets += f.facets;
      merged = true;
      break;
    }
    if (!merged) out.push({ ...f });
  }
  return out;
}
