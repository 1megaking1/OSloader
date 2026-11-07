// Small, allocation-light linear algebra used by the geometry core.
// Vectors are plain [x, y, z] arrays. Rigid transforms are 4x4 column-major
// arrays (same layout as three.js Matrix4.elements) so they can be handed to
// the viewer directly.

export const EPS = 1e-12;

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const dist = (a, b) => {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
};
export const norm = (a) => {
  const l = len(a);
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Any unit vector perpendicular to n. */
export function perp(n) {
  const a = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  return norm(cross(n, a));
}

/** Orthonormal basis [u, v] such that (u, v, n) is right handed. */
export function basis(n) {
  const u = perp(n);
  const v = cross(n, u);
  return [u, v];
}

/** Remove the component of a along unit n. */
export const reject = (a, n) => addScaled(a, n, -dot(a, n));

export const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

// ---------------------------------------------------------------- matrices

export function mIdentity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Build from 3x3 rotation given as columns (cx, cy, cz) and translation t. */
export function mFromBasis(cx, cy, cz, t = [0, 0, 0]) {
  return [cx[0], cx[1], cx[2], 0, cy[0], cy[1], cy[2], 0, cz[0], cz[1], cz[2], 0, t[0], t[1], t[2], 1];
}

export function mMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function mMulAll(...ms) {
  let o = ms[0];
  for (let i = 1; i < ms.length; i++) o = mMul(o, ms[i]);
  return o;
}

/** Inverse of a rigid (rotation + translation) transform. */
export function mInvRigid(m) {
  // R^T and -R^T t
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r01 = m[4], r11 = m[5], r21 = m[6];
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  return [
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    -(r00 * tx + r10 * ty + r20 * tz),
    -(r01 * tx + r11 * ty + r21 * tz),
    -(r02 * tx + r12 * ty + r22 * tz),
    1,
  ];
}

export const mPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

export const mDir = (m, d) => [
  m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
  m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
  m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
];

export const mTrans = (m) => [m[12], m[13], m[14]];

export function mTranslation(t) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

/** Rotation by angle (rad) about unit axis through point c (default origin). */
export function mAxisAngle(axis, angle, c = null) {
  const [x, y, z] = norm(axis);
  const s = Math.sin(angle), co = Math.cos(angle), t = 1 - co;
  const m = [
    t * x * x + co, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + co, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + co, 0,
    0, 0, 0, 1,
  ];
  if (c) {
    const rc = mDir(m, c);
    m[12] = c[0] - rc[0];
    m[13] = c[1] - rc[1];
    m[14] = c[2] - rc[2];
  }
  return m;
}

/** Rotation that maps unit vector a onto unit vector b (shortest arc). */
export function mAlign(a, b) {
  const c = dot(a, b);
  if (c > 1 - 1e-12) return mIdentity();
  if (c < -1 + 1e-12) return mAxisAngle(perp(a), Math.PI);
  return mAxisAngle(cross(a, b), Math.acos(Math.max(-1, Math.min(1, c))));
}

/** Rotation vector (axis * angle) -> matrix (Rodrigues). */
export function mExp(w) {
  const th = len(w);
  if (th < 1e-14) return mIdentity();
  return mAxisAngle(scale(w, 1 / th), th);
}

/** Re-orthonormalise the rotation part of m (guards drift). */
export function mOrtho(m) {
  let x = norm([m[0], m[1], m[2]]);
  let y = [m[4], m[5], m[6]];
  y = norm(reject(y, x));
  const z = cross(x, y);
  return mFromBasis(x, y, z, [m[12], m[13], m[14]]);
}

/** Rotation angle (rad) of the rotation part of m. */
export function mRotAngle(m) {
  const tr = m[0] + m[5] + m[10];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

/** Frame (origin o, x axis, y axis) -> transform mapping local frame coordinates to world. */
export function mFrame(o, x, y) {
  const xx = norm(x);
  const yy = norm(reject(y, xx));
  return mFromBasis(xx, yy, cross(xx, yy), o);
}

// ------------------------------------------------------------ eigen solver

/**
 * Jacobi eigen-decomposition for symmetric 3x3 matrix given as
 * [a00, a01, a02, a11, a12, a22]. Returns {values:[l0,l1,l2], vectors:[[..],[..],[..]]}
 * sorted ascending by eigenvalue.
 */
export function eigSym3(s) {
  const a = [
    [s[0], s[1], s[2]],
    [s[1], s[3], s[4]],
    [s[2], s[4], s[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: idx.map((i) => a[i][i]),
    vectors: idx.map((i) => norm([v[0][i], v[1][i], v[2][i]])),
  };
}

/** Best rotation (Kabsch) mapping point set P to Q (arrays of [x,y,z]) with weights. Returns 4x4. */
export function kabsch(P, Q, W = null) {
  const n = P.length;
  let wsum = 0;
  const cp = [0, 0, 0], cq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    wsum += w;
    for (let k = 0; k < 3; k++) {
      cp[k] += P[i][k] * w;
      cq[k] += Q[i][k] * w;
    }
  }
  for (let k = 0; k < 3; k++) {
    cp[k] /= wsum;
    cq[k] /= wsum;
  }
  // H = sum (p - cp)(q - cq)^T
  const H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    const p = sub(P[i], cp), q = sub(Q[i], cq);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r * 3 + c] += w * p[r] * q[c];
  }
  const R = rotationFromCovariance(H);
  // R maps p -> q : q = R p + t
  const t = sub(cq, matVec3(R, cp));
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

function matVec3(R, p) {
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
  ];
}

// Row-major helpers for the Kabsch SVD (via eigen decomposition of H^T H).
function rotationFromCovariance(H) {
  // Use Horn's quaternion method: robust and handles reflections properly.
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = H;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const q = largestEigVec4(N);
  const [w, x, y, z] = q;
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
}

function largestEigVec4(N) {
  // Jacobi on 4x4 symmetric
  const a = N.map((r) => r.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += Math.abs(a[p][q]);
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  const q = [v[0][best], v[1][best], v[2][best], v[3][best]];
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Maximum displacement of a set of points between two transforms. */
export function poseDelta(m1, m2, pts) {
  let d = 0;
  for (const p of pts) d = Math.max(d, dist(mPoint(m1, p), mPoint(m2, p)));
  return d;
}
