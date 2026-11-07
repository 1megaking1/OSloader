// Generates synthetic STL kits with known assembled poses. Each part is
// modelled in its assembled position, then "laid flat" (random rotation +
// translation like a print-bed layout) before being written out.
//   node test/gen-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getManifold, toSoup } from './manifold-util.mjs';
import { writeSTLBinary } from '../src/core/stl.js';
import { mAxisAngle, mMul, mInvRigid, mPoint, rng, norm } from '../src/core/math.js';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const W = await getManifold();
const { Manifold } = W;

const cube = (s, c = true) => Manifold.cube(s, c);
const cyl = (h, r, seg = 32, c = false) => Manifold.cylinder(h, r, r, seg, c);

function soupTransform(soup, M) {
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const p = mPoint(M, [soup[i], soup[i + 1], soup[i + 2]]);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

function randomRotation(rand) {
  // uniform random rotation via random axis/angle
  const ax = norm([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
  return mAxisAngle(ax, rand() * Math.PI * 2);
}

function layFlat(soup, rand, slot) {
  // random orientation, then move so bbox min z = 0, placed on a bed grid
  let R = randomRotation(rand);
  let s = soupTransform(soup, R);
  let min = [Infinity, Infinity, Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) min[k] = Math.min(min[k], s[i + k]);
  const t = [slot * 90 - min[0] + 300, (slot % 3) * 70 - min[1] - 100, -min[2]];
  const T = mMul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1], R);
  return { soup: soupTransform(soup, T), L: T };
}

function writeKit(name, parts, seed) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const rand = rng(seed);
  const truth = { parts: {} };
  let slot = 0;
  for (const p of parts) {
    const soup = toSoup(p.m);
    const { soup: flat, L } = layFlat(soup, rand, slot++);
    fs.writeFileSync(path.join(dir, p.file), Buffer.from(writeSTLBinary([{ positions: flat }])));
    // truth pose maps FILE coordinates -> assembled coordinates
    const poses = [mInvRigid(L)];
    for (const extra of p.instances || []) poses.push(mMul(extra, mInvRigid(L)));
    truth.parts[p.file] = { poses, role: p.role || 'part', versionOf: p.versionOf || null, note: p.note || '', freeAxis: p.freeAxis || null, symmetricAlt: !!p.symmetricAlt, expectUnplaced: !!p.expectUnplaced };
  }
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truth, null, 1));
  console.log('wrote', name, parts.length, 'parts');
}

// ------------------------------------------------------------------ kit 1
function bracketKit() {
  // base plate, top at z=6
  let base = cube([80, 50, 6], false).translate([-40, -25, 0]);
  // two blind holes for arm pegs
  for (const x of [-20, 20]) base = base.subtract(cyl(4.01, 3.1, 32).translate([x, -10, 2]));
  // rectangular through hole for the key
  base = base.subtract(cube([10.4, 6.4, 20], true).translate([0, 15, 3]));
  // side screw holes (horizontal, into the -y face)
  for (const x of [-25, 25]) base = base.subtract(cyl(10, 1.7, 16).rotate([-90, 0, 0]).translate([x, -25.01, 3]));

  // arm: block 50x12x10 sitting on base top at y=-10, pegs into the blind holes
  let arm = cube([50, 12, 10], false).translate([-25, -16, 6]);
  for (const x of [-20, 20]) arm = arm.add(cyl(4.3, 3.0, 32).translate([x, -10, 2.2]));
  // clevis: two ears on top of arm with a 5.4 gap, bore Ø4.2 through ears (axis y)
  const earT = 4;
  arm = arm.add(cube([12, earT, 14], false).translate([-6, -10 - 2.7 - earT, 15.5]));
  arm = arm.add(cube([12, earT, 14], false).translate([-6, -10 + 2.7, 15.5]));
  arm = arm.subtract(cyl(30, 2.1, 24).rotate([-90, 0, 0]).translate([0, -25, 25]));

  const armV2 = (() => {
    let a = cube([50, 12, 10], false).translate([-25, -16, 6]);
    for (const x of [-20, 20]) a = a.add(cyl(4.3, 2.95, 32).translate([x, -10, 2.2]));
    a = a.add(cube([12, earT, 14], false).translate([-6, -10 - 2.7 - earT, 15.5]));
    a = a.add(cube([12, earT, 14], false).translate([-6, -10 + 2.7, 15.5]));
    a = a.subtract(cyl(30, 2.15, 24).rotate([-90, 0, 0]).translate([0, -25, 25]));
    // v2 has a chamfer-ish notch
    a = a.subtract(cube([6, 30, 3], true).translate([22, -10, 16]));
    return a;
  })();

  // lever: bar 5 thick (y) centred in the 5.4 gap, bore at one end, angled 30 deg
  let lever;
  lever = cube([36, 5, 8], false).translate([-4, -2.5, -4]);
  lever = lever.subtract(cyl(10, 2.1, 24).rotate([-90, 0, 0]).translate([0, -5, 0]));
  lever = lever.add(cube([6, 5, 6], false).translate([26, -2.5, 4])); // handle bump (breaks symmetry)
  lever = lever.rotate([0, -30, 0]).translate([0, -10, 25]);

  // pin through the clevis: Ø4 length 16 centred on the gap
  const pin = cyl(16, 2.0, 20).rotate([-90, 0, 0]).translate([0, -18, 25]);

  // key: cap block on top of base with a rect peg into the rect hole
  const key = cube([16, 12, 4], false).translate([-8, 9, 6]).add(cube([10, 6, 5], false).translate([-5, 12, 1.01]));

  // upright: plate against the -y face of the base, two screw holes aligned
  let up = cube([60, 4, 40], false).translate([-30, -29, -10]);
  for (const x of [-25, 25]) up = up.subtract(cyl(10, 1.7, 16).rotate([-90, 0, 0]).translate([x, -35, 3]));

  return [
    { file: 'base.stl', m: base, role: 'root' },
    { file: 'arm.stl', m: arm },
    { file: 'arm_v2.stl', m: armV2, versionOf: 'arm.stl' },
    { file: 'lever.stl', m: lever, note: 'hinge: angle is user-defined', freeAxis: { p: [0, -10, 25], d: [0, 1, 0] } },
    { file: 'pin.stl', m: pin },
    { file: 'key.stl', m: key, note: 'top/bottom insertion is genuinely ambiguous', symmetricAlt: true },
    { file: 'upright.stl', m: up },
  ];
}

// ------------------------------------------------------------------ kit 2
function splitPropKit() {
  // a blaster-ish body: receiver box + barrel + grip + sphere pommel
  let body = cube([110, 30, 40], false).translate([-55, -15, 0]);
  body = body.add(cyl(70, 12, 48).rotate([0, 90, 0]).translate([50, 0, 26]));
  body = body.add(cube([22, 26, 60], false).translate([-50, -13, -45]).rotate([0, -12, 0]));
  body = body.add(Manifold.sphere(16, 40).translate([-36, 0, -52]));
  // hollow channel along barrel (bore)
  body = body.subtract(cyl(140, 5, 32).rotate([0, 90, 0]).translate([-40, 0, 26]));

  const halfL = body.intersect(cube([400, 200, 400], false).translate([-200, 0, -200]));
  const halfR = body.intersect(cube([400, 200, 400], false).translate([-200, -200, -200]));
  // cut barrel tip off as separate piece at x = 100
  const tipCut = cube([200, 200, 200], false).translate([100, -100, -60]);
  let L = halfL.subtract(tipCut);
  let R = halfR.subtract(tipCut);
  // muzzle tip: separate solid piece with a small bore and a spigot into the barrel bore
  let tip = cyl(20, 12, 48).rotate([0, 90, 0]).translate([100, 0, 26]);
  tip = tip.subtract(cyl(30, 3, 24).rotate([0, 90, 0]).translate([95, 0, 26]));
  tip = tip.add(cyl(10.5, 4.9, 32).rotate([0, 90, 0]).translate([90, 0, 26]).subtract(cyl(30, 3, 24).rotate([0, 90, 0]).translate([85, 0, 26])));
  // pin holes in both halves at the cut face y=0
  const pins = [[-48, 30], [20, 6], [-35, -23], [80, 34.5]];
  const hole = (x, z) => cyl(12.02, 1.6, 12, true).rotate([90, 0, 0]).translate([x, 0, z]);
  for (const [x, z] of pins) {
    L = L.subtract(hole(x, z));
    R = R.subtract(hole(x, z));
  }
  // scope with a rect key into a rect pocket on the left half's top
  L = L.subtract(cube([8.3, 4.3, 3], false).translate([-20, 4, 38]));
  let scope = cyl(50, 7, 36).rotate([0, 90, 0]).translate([-40, 6.15, 52]);
  scope = scope.add(cube([20, 8, 7], false).translate([-24, 2.15, 40]));
  scope = scope.add(cube([8, 4, 2.5], false).translate([-19.85, 4.15, 38]));
  // pin: Ø3.0 x 11.6
  const pin = cyl(11.6, 1.5, 12, true).rotate([90, 0, 0]).translate([pins[0][0], 0, pins[0][1]]);
  const pinInst = pins.slice(1).map(([x, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - pins[0][0], 0, z - pins[0][1], 1]);
  return [
    { file: 'receiver_left.stl', m: L, role: 'root' },
    { file: 'receiver_right.stl', m: R },
    { file: 'barrel_tip.stl', m: tip },
    { file: 'scope.stl', m: scope, note: 'pocket is symmetric: 180 deg flip is ambiguous', symmetricAlt: true },
    { file: 'alignment_pin_x4.stl', m: pin, instances: pinInst },
  ];
}


// ------------------------------------------------------------------ kit 3
function enclosureKit() {
  const W = 120, D = 80, H = 40, t = 2;
  // box: open top shell with corner screw bosses, floor pegs, feet holes
  let box = cube([W, D, H], false).translate([-W / 2, -D / 2, 0]);
  box = box.subtract(cube([W - 2 * t, D - 2 * t, H], false).translate([-W / 2 + t, -D / 2 + t, t]));
  const bosses = [[-50, -30], [50, -30], [-50, 30], [50, 30]];
  for (const [x, y] of bosses) {
    box = box.add(cyl(H - t - 3, 4, 48).translate([x, y, t - 0.01]));
    box = box.subtract(cyl(20, 1.25, 16).translate([x, y, 15]));
  }
  // standoff pegs on the floor
  const so = [[-25, -15], [25, -15], [-25, 15], [25, 15]];
  for (const [x, y] of so) box = box.add(cyl(5, 1.4, 24).translate([x, y, t - 0.01]));
  // feet holes in the bottom (blind from below)
  const feet = [[-45, -25], [45, -25], [-45, 25], [45, 25]];
  for (const [x, y] of feet) box = box.subtract(cyl(1.5, 2.1, 24).translate([x, y, -0.01]));
  // side hole for a light pipe
  box = box.subtract(cyl(10, 1.6, 20).rotate([0, 90, 0]).translate([W / 2 - 5, 0, 25]));
  // D-shaft boss on the front wall (outside), axis -y
  let dshaft = cyl(16, 3, 64).rotate([90, 0, 0]).translate([30, -D / 2 + 0.01, 25]);
  dshaft = dshaft.subtract(cube([10, 30, 10], false).translate([30 - 5, -D / 2 - 25, 25 + 2]));
  box = box.add(dshaft);

  // lid: plate with a lip that fits inside the opening (0.2 clearance), 4 countersunk holes, button hole
  const lidOf = (cl) => {
    let lid = cube([W, D, 3], false).translate([-W / 2, -D / 2, H]);
    let lip = cube([W - 2 * t - 2 * cl, D - 2 * t - 2 * cl, 3], false).translate([-W / 2 + t + cl, -D / 2 + t + cl, H - 3 + 0.01]);
    lip = lip.subtract(cube([W - 2 * t - 2 * cl - 3, D - 2 * t - 2 * cl - 3, 10], false).translate([-W / 2 + t + cl + 1.5, -D / 2 + t + cl + 1.5, H - 5]));
    // notch the lip around the bosses
    for (const [x, y] of bosses) lip = lip.subtract(cyl(10, 5, 32).translate([x, y, H - 6]));
    lid = lid.add(lip);
    for (const [x, y] of bosses) {
      lid = lid.subtract(cyl(4, 1.7, 20).translate([x, y, H - 1]));
      lid = lid.subtract(Manifold.cylinder(1.8, 1.7, 3.3, 20).translate([x, y, H + 1.21]));
    }
    lid = lid.subtract(cyl(10, 4.2, 40).translate([0, 0, H - 5]));
    return lid;
  };
  const lid = lidOf(0.2), lidTight = lidOf(0.1);
  // button: shaft Ø8 through the lid hole, flange under the lid
  let button = cyl(9, 4.0, 40).translate([0, 0, H - 0.5]);
  button = button.add(cyl(1.5, 6, 40).translate([0, 0, H - 1.5]));
  // standoffs: Ø6 tube with Ø3 hole sitting on the floor pegs
  const standoff = cyl(8, 3, 32).subtract(cyl(20, 1.5, 24).translate([0, 0, -5])).translate([so[0][0], so[0][1], t]);
  const soInst = so.slice(1).map(([x, y]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - so[0][0], y - so[0][1], 0, 1]);
  // foot: Ø12 disc with Ø4 peg up into the bottom
  const foot = cyl(3, 6, 48).translate([0, 0, -3]).add(cyl(1.3, 2, 24).translate([0, 0, -0.01])).translate([feet[0][0], feet[0][1], 0]);
  const footInst = feet.slice(1).map(([x, y]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - feet[0][0], y - feet[0][1], 0, 1]);
  // knob with a D hole on the D shaft
  let knob = cyl(12, 9, 72).rotate([90, 0, 0]).translate([30, -D / 2 - 8, 25]);
  knob = knob.add(cube([2, 12, 6], false).translate([29, -D / 2 - 20, 31])); // pointer
  let dhole = cyl(9, 3.1, 64).rotate([90, 0, 0]).translate([30, -D / 2 - 7, 25]);
  dhole = dhole.subtract(cube([10, 30, 10], false).translate([25, -D / 2 - 25, 25 + 2.1]));
  knob = knob.subtract(dhole);
  // light pipe through the side hole, with a head outside
  const pipe = cyl(12, 1.5, 20).rotate([0, 90, 0]).translate([W / 2 - 8, 0, 25]).add(cyl(2, 2.5, 24).rotate([0, 90, 0]).translate([W / 2, 0, 25]));
  // badge: organic blob glued on the lid top (no mating features)
  const badge = Manifold.sphere(10, 48).scale([1.5, 0.8, 0.3]).translate([0, 20, H + 3 + 1]).intersect(cube([200, 200, 100], false).translate([-100, -100, H + 3]));
  return [
    { file: 'enclosure_box.stl', m: box, role: 'root' },
    { file: 'lid.stl', m: lid },
    { file: 'lid_tight.stl', m: lidTight, versionOf: 'lid.stl' },
    { file: 'button.stl', m: button, note: 'flange above or below the lid is ambiguous', symmetricAlt: true },
    { file: 'standoff_x4.stl', m: standoff, instances: soInst },
    { file: 'foot (4x).stl', m: foot, instances: footInst },
    { file: 'knob.stl', m: knob },
    { file: 'light_pipe.stl', m: pipe, note: 'also fits the lid screw holes: ambiguous', symmetricAlt: true },
    { file: 'badge.stl', m: badge, note: 'no mating features: expected to stay unplaced', expectUnplaced: true },
  ];
}

fs.mkdirSync(OUT, { recursive: true });
writeKit('bracket', bracketKit(), 7);
writeKit('splitprop', splitPropKit(), 11);
writeKit('enclosure', enclosureKit(), 23);
