// Indexed mesh construction (vertex welding, edge adjacency) and basic
// mass properties.

import { eigSym3 } from './math.js';

/**
 * Build an indexed mesh from a triangle soup.
 * @param {Float32Array} positions 9 floats per triangle
 */
export function buildMesh(positions) {
  const triCount = positions.length / 9;
  // bbox for weld tolerance
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (z < minz) minz = z;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
    if (z > maxz) maxz = z;
  }
  const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz) || 1;
  const q = Math.max(1e-5, diag * 1e-7);
  const inv = 1 / q;

  const map = new Map();
  const vx = [];
  const tris = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let id = map.get(key);
    if (id === undefined) {
      id = vx.length / 3;
      map.set(key, id);
      vx.push(x, y, z);
    }
    tris[i] = id;
  }
  const verts = new Float64Array(vx);
  const V = verts.length / 3;

  // Drop degenerate triangles (repeated vertex index)
  let keep = 0;
  const triOrig = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    tris[keep * 3] = a;
    tris[keep * 3 + 1] = b;
    tris[keep * 3 + 2] = c;
    triOrig[keep] = t;
    keep++;
  }
  const T = keep;
  const tri = tris.slice(0, T * 3);

  const normals = new Float64Array(T * 3);
  const areas = new Float64Array(T);
  let area = 0, vol6 = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < T; t++) {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const ex = verts[b] - ax, ey = verts[b + 1] - ay, ez = verts[b + 2] - az;
    const fx = verts[c] - ax, fy = verts[c + 1] - ay, fz = verts[c + 2] - az;
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz);
    areas[t] = l / 2;
    area += l / 2;
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;
    // signed volume & centroid
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const qx = verts[c], qy = verts[c + 1], qz = verts[c + 2];
    const v6 = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    vol6 += v6;
    cx += v6 * (ax + bx + qx);
    cy += v6 * (ay + by + qy);
    cz += v6 * (az + bz + qz);
  }
  let volume = vol6 / 6;
  let centroid = Math.abs(vol6) > 1e-12 ? [cx / (4 * vol6), cy / (4 * vol6), cz / (4 * vol6)] : [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2];
  let flipped = false;
  if (volume < 0) {
    // inside-out mesh: flip winding
    flipped = true;
    for (let t = 0; t < T; t++) {
      const b = tri[t * 3 + 1];
      tri[t * 3 + 1] = tri[t * 3 + 2];
      tri[t * 3 + 2] = b;
      normals[t * 3] *= -1;
      normals[t * 3 + 1] *= -1;
      normals[t * 3 + 2] *= -1;
    }
    volume = -volume;
  }

  // Edge adjacency: adj[t*3+k] = neighbour triangle across edge (k, k+1) or -1
  const adj = new Int32Array(T * 3).fill(-1);
  const edgeMap = new Map();
  let nonManifold = 0, boundary = 0;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[t * 3 + k], b = tri[t * 3 + ((k + 1) % 3)];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * V + hi;
      const e = edgeMap.get(key);
      if (e === undefined) edgeMap.set(key, t * 3 + k);
      else if (e >= 0) {
        const t2 = (e / 3) | 0;
        adj[t * 3 + k] = t2;
        adj[e] = t;
        edgeMap.set(key, -2);
      } else {
        nonManifold++;
      }
    }
  }
  for (let i = 0; i < adj.length; i++) if (adj[i] < 0) boundary++;

  return {
    verts,
    tris: tri,
    normals,
    areas,
    adj,
    triOrig,
    V,
    T,
    area,
    volume,
    centroid,
    bbox: { min: [minx, miny, minz], max: [maxx, maxy, maxz] },
    diag,
    flipped,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
  };
}

/** Area weighted principal axes of the surface (orientation-independent shape frame). */
export function principalAxes(mesh) {
  const { verts, tris, areas, T } = mesh;
  let w = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const a = areas[t];
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k] * 3;
      c[0] += (verts[v] * a) / 3;
      c[1] += (verts[v + 1] * a) / 3;
      c[2] += (verts[v + 2] * a) / 3;
    }
    w += a;
  }
  c[0] /= w;
  c[1] /= w;
  c[2] /= w;
  const S = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < T; t++) {
    const a = areas[t] / 3;
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k] * 3;
      const x = verts[v] - c[0], y = verts[v + 1] - c[1], z = verts[v + 2] - c[2];
      S[0] += a * x * x;
      S[1] += a * x * y;
      S[2] += a * x * z;
      S[3] += a * y * y;
      S[4] += a * y * z;
      S[5] += a * z * z;
    }
  }
  const e = eigSym3(S.map((s) => s / w));
  // axes sorted by descending spread
  const axes = [e.vectors[2], e.vectors[1], e.vectors[0]];
  // extents along axes
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.V; i++) {
    const x = verts[i * 3] - c[0], y = verts[i * 3 + 1] - c[1], z = verts[i * 3 + 2] - c[2];
    for (let k = 0; k < 3; k++) {
      const d = x * axes[k][0] + y * axes[k][1] + z * axes[k][2];
      if (d < lo[k]) lo[k] = d;
      if (d > hi[k]) hi[k] = d;
    }
  }
  return { center: c, axes, lo, hi, dims: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], spread: [e.values[2], e.values[1], e.values[0]] };
}

/** Split triangle soup into connected components. Returns array of Float32Array soups. */
export function splitConnected(positions) {
  const mesh = buildMesh(positions);
  const { T, adj } = mesh;
  const comp = new Int32Array(T).fill(-1);
  let nc = 0;
  const stack = [];
  for (let s = 0; s < T; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = nc;
    stack.push(s);
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const n = adj[t * 3 + k];
        if (n >= 0 && comp[n] < 0) {
          comp[n] = nc;
          stack.push(n);
        }
      }
    }
    nc++;
  }
  const groups = new Map();
  for (let t = 0; t < T; t++) {
    if (!groups.has(comp[t])) groups.set(comp[t], []);
    groups.get(comp[t]).push(t);
  }
  const out = [];
  for (const list of groups.values()) {
    const p = new Float32Array(list.length * 9);
    list.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k] * 3;
        p[i * 9 + k * 3] = mesh.verts[v];
        p[i * 9 + k * 3 + 1] = mesh.verts[v + 1];
        p[i * 9 + k * 3 + 2] = mesh.verts[v + 2];
      }
    });
    out.push(p);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}
