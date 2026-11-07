// Unit tests: file formats, name heuristics, solver basics.
import { parseSTL, writeSTLBinary, writeSTLAscii, parseOBJ } from '../src/core/stl.js';
import { zipFiles, unzip, crc32 } from '../src/core/zip.js';
import { write3MF, read3MF } from '../src/core/threemf.js';
import { quantityFromName, namesLikeVersions, baseName } from '../src/core/assemble.js';
import { splitConnected } from '../src/core/mesh.js';
import { kabsch, mAxisAngle, mMul, mPoint, mInvRigid, eigSymN } from '../src/core/math.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const tri = (o) => new Float32Array([o, 0, 0, o + 1, 0, 0, o, 1, 0, o, 0, 0, o, 1, 0, o, 0, 1]);
const a = { name: 'alpha part', positions: tri(0) }, b = { name: 'beta', positions: tri(5) };

// STL binary
const bin = parseSTL(writeSTLBinary([a, b]));
ok(bin.positions.length === 36 && bin.positions[27] === 5, 'binary STL round trip keeps all triangles');
// STL ASCII multi-solid
const asc = parseSTL(new TextEncoder().encode(writeSTLAscii([a, b])));
ok(asc.solids.length === 2 && asc.solids[0].name === 'alpha_part' && asc.solids[1].count === 2, 'ASCII STL keeps named solids');
ok(Math.abs(asc.positions[27] - 5) < 1e-6, 'ASCII STL coordinates');
// connected components
ok(splitConnected(bin.positions).length === 2, 'split by connectivity finds two bodies');
// OBJ
const obj = parseOBJ(new TextEncoder().encode('o one\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3 4\no two\nf 1 2 4\n').buffer);
ok(obj.solids.length === 2 && obj.positions.length === 27, 'OBJ objects and quad fan triangulation');
// zip
const z = await zipFiles([{ name: 'a.txt', data: 'hello '.repeat(200) }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]);
const uz = await unzip(z);
ok(uz.length === 2 && new TextDecoder().decode(uz[0].data) === 'hello '.repeat(200) && uz[1].data[2] === 3, 'zip round trip (stored + deflated)');
ok(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'crc32 check value');
// 3MF
for (const mode of ['objects', 'assembly']) {
  const m = await write3MF([a, b], { mode, name: 'Test' });
  const bodies = await read3MF(m);
  ok(bodies.length === 2 && bodies[0].name === 'alpha part' && bodies[1].positions.length === 18, `3MF round trip (${mode})`);
}
// names
ok(quantityFromName('pin_x4.stl') === 4, 'qty pin_x4');
ok(quantityFromName('foot (4x).stl') === 4, 'qty foot (4x)');
ok(quantityFromName('clip 6pcs.stl') === 6, 'qty 6pcs');
ok(quantityFromName('M3x8 screw.stl') === 1, 'M3x8 is not a quantity');
ok(quantityFromName('10x10_plate.stl') === 1, '10x10 is not a quantity');
ok(namesLikeVersions('arm.stl', 'arm_v2.stl'), 'arm / arm_v2 are versions');
ok(namesLikeVersions('Lid (1).stl', 'lid.stl'), 'Lid (1) / lid are versions');
ok(namesLikeVersions('grip_tight.stl', 'grip_loose.stl'), 'tight/loose are versions');
ok(!namesLikeVersions('handle_left.stl', 'handle_right.stl'), 'left/right are not versions');
ok(baseName('Receiver_v3_FINAL.stl') === 'receiver', 'baseName strips version tokens');
// math
const R = mAxisAngle([0.3, 0.5, 0.8], 1.1, [3, 4, 5]);
const P = [[0, 0, 0], [10, 0, 0], [0, 7, 0], [1, 2, 9], [5, 5, 5]];
const K = kabsch(P, P.map((p) => mPoint(R, p)));
ok(P.every((p) => { const q = mPoint(K, p), r = mPoint(R, p); return Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]) < 1e-9; }), 'Kabsch recovers a rigid transform');
const I = mMul(R, mInvRigid(R));
ok(Math.abs(I[0] - 1) < 1e-12 && Math.abs(I[12]) < 1e-12, 'rigid inverse');
const e = eigSymN([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
ok(Math.abs(e.values[0] - 1) < 1e-9 && Math.abs(e.values[2] - 5) < 1e-9, 'symmetric eigen solver');
console.log(fails ? `${fails} unit test(s) failed` : 'all unit tests passed');
process.exit(fails ? 1 : 0);
