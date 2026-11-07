// Primitive fitting helpers.

/**
 * Least squares circle through 2D points (Kasa algebraic fit followed by a few
 * Gauss-Newton iterations on the geometric error).
 * @param {Float64Array|number[]} xy interleaved x,y
 * @returns {{cx:number, cy:number, r:number, rms:number, max:number}|null}
 */
export function fitCircle2D(xy, n = xy.length / 2) {
  if (n < 3) return null;
  // centre the data for numerical stability
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    mx += xy[2 * i];
    my += xy[2 * i + 1];
  }
  mx /= n;
  my /= n;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i] - mx, y = xy[2 * i + 1] - my;
    const z = x * x + y * y;
    Sxx += x * x;
    Sxy += x * y;
    Syy += y * y;
    Sx += x;
    Sy += y;
    Sxz += x * z;
    Syz += y * z;
    Sz += z;
  }
  // Solve [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy n] [D E F]^T = -[Sxz Syz Sz]
  const A = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, n],
  ];
  const b = [-Sxz, -Syz, -Sz];
  const sol = solve3(A, b);
  if (!sol) return null;
  let cx = -sol[0] / 2, cy = -sol[1] / 2;
  let r2 = cx * cx + cy * cy - sol[2];
  if (!(r2 > 0)) return null;
  let r = Math.sqrt(r2);
  // Gauss-Newton refinement
  for (let it = 0; it < 6; it++) {
    let JtJ00 = 0, JtJ01 = 0, JtJ02 = 0, JtJ11 = 0, JtJ12 = 0, JtJ22 = 0, g0 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xy[2 * i] - mx - cx, dy = xy[2 * i + 1] - my - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const j0 = -dx / d, j1 = -dy / d, j2 = -1;
      JtJ00 += j0 * j0;
      JtJ01 += j0 * j1;
      JtJ02 += j0 * j2;
      JtJ11 += j1 * j1;
      JtJ12 += j1 * j2;
      JtJ22 += j2 * j2;
      g0 += j0 * res;
      g1 += j1 * res;
      g2 += j2 * res;
    }
    const step = solve3(
      [
        [JtJ00 + 1e-12, JtJ01, JtJ02],
        [JtJ01, JtJ11 + 1e-12, JtJ12],
        [JtJ02, JtJ12, JtJ22 + 1e-12],
      ],
      [-g0, -g1, -g2],
    );
    if (!step) break;
    cx += step[0];
    cy += step[1];
    r += step[2];
    if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-10 * (1 + r)) break;
  }
  let ss = 0, mxe = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.abs(Math.hypot(xy[2 * i] - mx - cx, xy[2 * i + 1] - my - cy) - r);
    ss += e * e;
    if (e > mxe) mxe = e;
  }
  return { cx: cx + mx, cy: cy + my, r: Math.abs(r), rms: Math.sqrt(ss / n), max: mxe };
}

export function solve3(A, b) {
  const m = [A[0].slice(), A[1].slice(), A[2].slice()];
  const x = b.slice();
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-300) return null;
    if (p !== c) {
      [m[p], m[c]] = [m[c], m[p]];
      [x[p], x[c]] = [x[c], x[p]];
    }
    for (let r = c + 1; r < 3; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 3; k++) m[r][k] -= f * m[c][k];
      x[r] -= f * x[c];
    }
  }
  const out = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < 3; k++) s -= m[r][k] * out[k];
    out[r] = s / m[r][r];
  }
  return out;
}

/** Solve dense n x n system (Gaussian elimination, partial pivoting). A is array of rows. */
export function solveN(A, b) {
  const n = b.length;
  const m = A.map((r) => r.slice());
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-300) return null;
    if (p !== c) {
      [m[p], m[c]] = [m[c], m[p]];
      [x[p], x[c]] = [x[c], x[p]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) m[r][k] -= f * m[c][k];
      x[r] -= f * x[c];
    }
  }
  const out = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * out[k];
    out[r] = s / m[r][r];
  }
  return out;
}
