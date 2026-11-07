// Signed distance field on a regular grid: inside/outside by ray parity voting
// along three axes, far-field distances by separable Euclidean distance
// transform, exact point-triangle distances in a narrow band around the
// surface. Negative = inside material.

const INF = 1e20;

export function computeSDF(mesh, opts = {}) {
  const { verts, tris, T } = mesh;
  const min = mesh.bbox.min, max = mesh.bbox.max;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const maxCells = opts.maxCells ?? 400000;
  const hardCap = opts.hardCap ?? 1600000;
  const vol = Math.max(1e-9, (size[0] + 1) * (size[1] + 1) * (size[2] + 1));
  let h = Math.cbrt(vol / maxCells);
  if (opts.thickness) h = Math.min(h, opts.thickness / 1.6);
  h = Math.max(h, opts.minVoxel ?? 0.25);
  const pad = 3;
  let dims;
  for (;;) {
    dims = size.map((s) => Math.max(1, Math.ceil(s / h)) + 2 * pad);
    if (dims[0] * dims[1] * dims[2] <= hardCap) break;
    h *= 1.1;
  }
  const [nx, ny, nz] = dims;
  const o = [min[0] - pad * h + (size[0] - (nx - 2 * pad) * h) / 2, min[1] - pad * h + (size[1] - (ny - 2 * pad) * h) / 2, min[2] - pad * h + (size[2] - (nz - 2 * pad) * h) / 2];
  const N = nx * ny * nz;
  const idx = (i, j, k) => i + nx * (j + ny * k);

  // ---- occupancy by parity along each axis, majority vote
  const votes = new Uint8Array(N);
  const jit = [0.000137, 0.000271, 0.000419];
  for (let axis = 0; axis < 3; axis++) {
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    const n1 = dims[a1], n2 = dims[a2], na = dims[axis];
    const cols = new Array(n1 * n2);
    for (let t = 0; t < T; t++) {
      const A = tris[t * 3] * 3, B = tris[t * 3 + 1] * 3, C = tris[t * 3 + 2] * 3;
      const p1 = [verts[A + a1], verts[B + a1], verts[C + a1]];
      const p2 = [verts[A + a2], verts[B + a2], verts[C + a2]];
      const pa = [verts[A + axis], verts[B + axis], verts[C + axis]];
      const lo1 = Math.min(p1[0], p1[1], p1[2]), hi1 = Math.max(p1[0], p1[1], p1[2]);
      const lo2 = Math.min(p2[0], p2[1], p2[2]), hi2 = Math.max(p2[0], p2[1], p2[2]);
      const i0 = Math.max(0, Math.ceil((lo1 - o[a1]) / h - 0.5 - jit[axis]));
      const i1 = Math.min(n1 - 1, Math.floor((hi1 - o[a1]) / h - 0.5 - jit[axis]));
      const j0 = Math.max(0, Math.ceil((lo2 - o[a2]) / h - 0.5 - jit[(axis + 1) % 3]));
      const j1 = Math.min(n2 - 1, Math.floor((hi2 - o[a2]) / h - 0.5 - jit[(axis + 1) % 3]));
      if (i0 > i1 || j0 > j1) continue;
      const den = (p2[1] - p2[2]) * (p1[0] - p1[2]) + (p1[2] - p1[1]) * (p2[0] - p2[2]);
      if (Math.abs(den) < 1e-18) continue;
      for (let i = i0; i <= i1; i++) {
        const x = o[a1] + (i + 0.5 + jit[axis]) * h;
        for (let j = j0; j <= j1; j++) {
          const y = o[a2] + (j + 0.5 + jit[(axis + 1) % 3]) * h;
          const l0 = ((p2[1] - p2[2]) * (x - p1[2]) + (p1[2] - p1[1]) * (y - p2[2])) / den;
          const l1 = ((p2[2] - p2[0]) * (x - p1[2]) + (p1[0] - p1[2]) * (y - p2[2])) / den;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const z = l0 * pa[0] + l1 * pa[1] + l2 * pa[2];
          const ci = i + n1 * j;
          (cols[ci] || (cols[ci] = [])).push(z);
        }
      }
    }
    const coord = [0, 0, 0];
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < n1; i++) {
        const list = cols[i + n1 * j];
        if (!list || list.length < 2) continue;
        list.sort((p, q) => p - q);
        coord[a1] = i;
        coord[a2] = j;
        for (let s = 0; s + 1 < list.length; s += 2) {
          const za = list[s], zb = list[s + 1];
          const k0 = Math.max(0, Math.ceil((za - o[axis]) / h - 0.5));
          const k1 = Math.min(na - 1, Math.floor((zb - o[axis]) / h - 0.5));
          for (let k = k0; k <= k1; k++) {
            coord[axis] = k;
            votes[idx(coord[0], coord[1], coord[2])]++;
          }
        }
      }
    }
  }
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = votes[i] >= 2 ? 1 : 0;

  // ---- EDT (squared, voxel units) to nearest voxel of opposite state
  const dIn = edt3(inside, dims, 1); // for inside voxels: distance to outside
  const dOut = edt3(inside, dims, 0); // for outside voxels: distance to inside

  const sd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sd[i] = inside[i] ? -(Math.sqrt(dIn[i]) - 0.5) * h : (Math.sqrt(dOut[i]) - 0.5) * h;
    if (!inside[i] && dOut[i] >= INF) sd[i] = 1e3;
  }

  // ---- exact distances in narrow band
  const band = 1.6 * h;
  const ex = new Float32Array(N).fill(INF);
  const P = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const A = tris[t * 3] * 3, B = tris[t * 3 + 1] * 3, C = tris[t * 3 + 2] * 3;
    const ax = verts[A], ay = verts[A + 1], az = verts[A + 2];
    const bx = verts[B], by = verts[B + 1], bz = verts[B + 2];
    const cx = verts[C], cy = verts[C + 1], cz = verts[C + 2];
    const lo = [Math.min(ax, bx, cx) - band, Math.min(ay, by, cy) - band, Math.min(az, bz, cz) - band];
    const hi = [Math.max(ax, bx, cx) + band, Math.max(ay, by, cy) + band, Math.max(az, bz, cz) + band];
    const i0 = Math.max(0, Math.ceil((lo[0] - o[0]) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((hi[0] - o[0]) / h - 0.5));
    const j0 = Math.max(0, Math.ceil((lo[1] - o[1]) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((hi[1] - o[1]) / h - 0.5));
    const k0 = Math.max(0, Math.ceil((lo[2] - o[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((hi[2] - o[2]) / h - 0.5));
    // triangle plane for a cheap rejection test
    let pnx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let pny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let pnz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const pl = Math.hypot(pnx, pny, pnz);
    const usePlane = pl > 1e-12;
    if (usePlane) {
      pnx /= pl;
      pny /= pl;
      pnz /= pl;
    }
    const pd = pnx * ax + pny * ay + pnz * az;
    for (let k = k0; k <= k1; k++) {
      P[2] = o[2] + (k + 0.5) * h;
      for (let j = j0; j <= j1; j++) {
        P[1] = o[1] + (j + 0.5) * h;
        for (let i = i0; i <= i1; i++) {
          P[0] = o[0] + (i + 0.5) * h;
          if (usePlane) {
            const dp = pnx * P[0] + pny * P[1] + pnz * P[2] - pd;
            if (dp > band || dp < -band) continue;
          }
          const d2 = pointTriDist2(P[0], P[1], P[2], ax, ay, az, bx, by, bz, cx, cy, cz);
          const id = i + nx * (j + ny * k);
          if (d2 < ex[id]) ex[id] = d2;
        }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (ex[i] < band * band) {
      const d = Math.sqrt(ex[i]);
      sd[i] = inside[i] ? -d : d;
    }
  }
  return { o, h, dims, data: sd };
}

/** Separable squared EDT (Felzenszwalb). feature = voxels whose inside != target */
function edt3(inside, dims, target) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const f = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = inside[i] === target ? INF : 0;
  const maxn = Math.max(nx, ny, nz);
  const tmp = new Float32Array(maxn), out = new Float32Array(maxn);
  const v = new Int32Array(maxn), z = new Float64Array(maxn + 1);
  const pass = (n, stride, count, base) => {
    for (let c = 0; c < count; c++) {
      const b0 = base(c);
      for (let q = 0; q < n; q++) tmp[q] = f[b0 + q * stride];
      dt1(tmp, n, out, v, z);
      for (let q = 0; q < n; q++) f[b0 + q * stride] = out[q];
    }
  };
  pass(nx, 1, ny * nz, (c) => c * nx);
  pass(ny, nx, nx * nz, (c) => (c % nx) + Math.floor(c / nx) * nx * ny);
  pass(nz, nx * ny, nx * ny, (c) => c);
  return f;
}

function dt1(f, n, d, v, z) {
  // lower envelope of parabolas rooted at finite samples only
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq >= INF) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    let s;
    for (;;) {
      const p = v[k];
      s = (fq + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]) k--;
      else break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  if (k < 0) {
    for (let q = 0; q < n; q++) d[q] = INF;
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const dq = q - v[j];
    d[q] = dq * dq + f[v[j]];
  }
}

/** squared distance point -> triangle (Ericson, Real-Time Collision Detection 5.1.5) */
export function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx; qy = cy; qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** Trilinear sample. Points outside the grid get a positive distance estimate. */
export function sdfSample(sdf, x, y, z) {
  const { o, h, dims, data } = sdf;
  const nx = dims[0], ny = dims[1], nz = dims[2];
  let fx = (x - o[0]) / h - 0.5, fy = (y - o[1]) / h - 0.5, fz = (z - o[2]) / h - 0.5;
  let outside = 0;
  if (fx < 0) { outside += -fx; fx = 0; } else if (fx > nx - 1) { outside += fx - (nx - 1); fx = nx - 1; }
  if (fy < 0) { outside += -fy; fy = 0; } else if (fy > ny - 1) { outside += fy - (ny - 1); fy = ny - 1; }
  if (fz < 0) { outside += -fz; fz = 0; } else if (fz > nz - 1) { outside += fz - (nz - 1); fz = nz - 1; }
  let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  if (i >= nx - 1) i = nx - 2;
  if (j >= ny - 1) j = ny - 2;
  if (k >= nz - 1) k = nz - 2;
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const b = i + nx * (j + ny * k);
  const sx = 1, sy = nx, sz = nx * ny;
  const c000 = data[b], c100 = data[b + sx], c010 = data[b + sy], c110 = data[b + sx + sy];
  const c001 = data[b + sz], c101 = data[b + sx + sz], c011 = data[b + sy + sz], c111 = data[b + sx + sy + sz];
  const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
  const v = c0 + (c1 - c0) * tz;
  return outside > 0 ? Math.max(v, 0) + outside * h : v;
}

/** Trilinear sample with gradient (returns [d, gx, gy, gz]); gradient un-normalised. */
export function sdfSampleGrad(sdf, x, y, z, out) {
  const { o, h, dims, data } = sdf;
  const nx = dims[0], ny = dims[1], nz = dims[2];
  let fx = (x - o[0]) / h - 0.5, fy = (y - o[1]) / h - 0.5, fz = (z - o[2]) / h - 0.5;
  if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) {
    out[0] = sdfSample(sdf, x, y, z);
    out[1] = out[2] = out[3] = 0;
    return out;
  }
  let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  if (i >= nx - 1) i = nx - 2;
  if (j >= ny - 1) j = ny - 2;
  if (k >= nz - 1) k = nz - 2;
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const b = i + nx * (j + ny * k);
  const sy = nx, sz = nx * ny;
  const c000 = data[b], c100 = data[b + 1], c010 = data[b + sy], c110 = data[b + 1 + sy];
  const c001 = data[b + sz], c101 = data[b + 1 + sz], c011 = data[b + sy + sz], c111 = data[b + 1 + sy + sz];
  const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
  out[0] = c0 + (c1 - c0) * tz;
  // derivatives
  const dx00 = c100 - c000, dx10 = c110 - c010, dx01 = c101 - c001, dx11 = c111 - c011;
  const dx0 = dx00 + (dx10 - dx00) * ty, dx1 = dx01 + (dx11 - dx01) * ty;
  out[1] = (dx0 + (dx1 - dx0) * tz) / h;
  const dy0 = c10 - c00, dy1 = c11 - c01;
  out[2] = (dy0 + (dy1 - dy0) * tz) / h;
  out[3] = (c1 - c0) / h;
  return out;
}
