// Tests for interactive geometry helpers (edge picking, 3-point hole, arc fit).
import { getManifold, toSoup } from './manifold-util.mjs';
import { meshIndex, pickEdge, fitCylinderAt, holeFrom3Points } from '../src/core/pickfit.js';
import { analyzePart } from '../src/core/features.js';

const { Manifold } = await getManifold();
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const nearestTri = (soup, p) => {
  let best = -1, bd = Infinity;
  for (let t = 0; t < soup.length / 9; t++) {
    const c = [0, 1, 2].map((k) => (soup[t * 9 + k] + soup[t * 9 + 3 + k] + soup[t * 9 + 6 + k]) / 3);
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
};

// plate 60x40x6 with a 2 mm hole (12 segments, chamfered by a cone) and a curved slot
let plate = Manifold.cube([60, 40, 6], true);
plate = plate.subtract(Manifold.cylinder(20, 1, 1, 12, true).translate([-20, 0, 0]));
plate = plate.subtract(Manifold.cylinder(1.01, 1, 1.6, 12, false).translate([-20, 0, 2]));
// curved slot: ring sector (r 10..14) around (10,0), 100 degrees
const ring = Manifold.cylinder(20, 14, 14, 96, true).subtract(Manifold.cylinder(22, 10, 10, 96, true));
const sector = Manifold.cube([20, 20, 30], false).translate([0, 0, -15]).intersect(Manifold.cube([20, 20, 30], false).translate([-20, 0, -15]).rotate([0, 0, -10]).add(Manifold.cube([20, 20, 30], false).translate([0, 0, -15])));
plate = plate.subtract(ring.intersect(sector).translate([10, -6, 0]));
const soup = toSoup(plate);
const idx = meshIndex(soup);

// edge: top front edge of the plate (y = -20, z = 3), pick near x = 20
const e = pickEdge(idx, nearestTri(soup, [20, -19.8, 2.9]), [20, -20, 3], 0.5);
ok(e && Math.abs(Math.abs(e.p1[0] - e.p0[0]) - 60) < 1e-3 && Math.abs(e.p0[1] + 20) < 1e-6, `edge pick extends the full 60 mm edge (${e && JSON.stringify(e.p0)} -> ${e && JSON.stringify(e.p1)})`);

// 3-point hole on the 2 mm hole (rim of the bottom face, r = 1)
const pts = [0, 2, 4].map((k) => [-20 + Math.cos(k) * 1, Math.sin(k) * 1, -3]);
const h = holeFrom3Points(idx, pts);
ok(h && Math.abs(h.r - 1) < 0.05 && Math.abs(Math.abs(h.a[2]) - 1) < 1e-3, `3-point hole: r=${h && h.r.toFixed(3)} axis=${h && h.a.map((x) => x.toFixed(2))}`);

// arc fit on the curved slot outer wall (r = 14 about (10,-6))
const pw = [10 + 14 * Math.cos(0.9), -6 + 14 * Math.sin(0.9), 0];
const arc = fitCylinderAt(idx, nearestTri(soup, pw));
ok(arc && Math.abs(arc.r - 14) < 0.1 && !arc.full, `arc fit on curved slot wall: r=${arc && arc.r.toFixed(2)} span=${arc && (arc.span * 57.3).toFixed(0)}°`);

// automatic detection of the small chamfered hole via flat-face loops
const an = analyzePart(soup);
const small = an.cyls.find((c) => c.concave && Math.abs(c.r - 1) < 0.08 && c.full);
ok(!!small, `small chamfered 2 mm hole detected automatically (${an.cyls.filter((c) => c.r < 3).map((c) => (2 * c.r).toFixed(2) + (c.full ? '' : '~')).join(' ')})`);

console.log(fails ? `${fails} failed` : 'all pick tests passed');
process.exit(fails ? 1 : 0);
