// Exercises the main UI flows in a headless browser and validates exports.
//   node test/browser-flows.mjs [outdir]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { parseSTL } from '../src/core/stl.js';
import { unzip } from '../src/core/zip.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const out = process.argv[2] || path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.join(root, 'dist', 'STL-Assembler.html'));
const ev = (fn, arg) => page.evaluate(fn, arg);
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

// bracket kit via file input (exercises the normal loading path)
const dir = path.join(root, 'test/fixtures/bracket');
await page.setInputFiles('#file-input', fs.readdirSync(dir).filter((f) => f.endsWith('.stl')).map((f) => path.join(dir, f)));
await page.waitForFunction(() => /Auto-assembled/.test(document.querySelector('#status-text').textContent), null, { timeout: 120000 });
console.log(await page.textContent('#status-text'));
const nParts = await ev(() => window.app.parts.size);
check(nParts === 7, `7 parts loaded (${nParts})`);

// review flow
await page.keyboard.press('r');
await page.waitForTimeout(200);
const selAmb = await ev(() => window.app.sel && window.app.parts.get(window.app.sel).status);
check(selAmb === 'ambiguous', 'review selects an ambiguous part');
await page.screenshot({ path: path.join(out, 'flow-review.png') });
await page.hover('[data-alt="1"]').catch(() => {});
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(out, 'flow-review-preview.png') });
await page.click('[data-alt="1"]').catch(() => {});
await page.waitForTimeout(400);
const altIdx = await ev(() => window.app.parts.get(window.app.sel).altIndex);
check(altIdx === 1, 'alternative #2 applied');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

// undo / redo
const poseBefore = await ev(() => window.app.parts.get('key').pose.slice());
await ev(() => window.app.translatePart('key', [5, 0, 0]));
await page.keyboard.press('Control+z');
const poseUndo = await ev(() => window.app.parts.get('key').pose.slice());
check(Math.abs(poseUndo[12] - poseBefore[12]) < 1e-9, 'undo restores pose');
await page.keyboard.press('Control+Shift+z');
const poseRedo = await ev(() => window.app.parts.get('key').pose.slice());
check(Math.abs(poseRedo[12] - poseBefore[12] - 5) < 1e-6, 'redo re-applies move');
await page.keyboard.press('Control+z');

// hinge: free rotation on the lever
await ev(() => window.app.select('lever'));
await page.waitForTimeout(150);
const hasFree = await page.$('[data-rot="90"]');
check(!!hasFree, 'lever shows a free-rotation control');
if (hasFree) {
  const p0 = await ev(() => window.app.parts.get('lever').pose.slice());
  await page.click('[data-rot="90"]');
  await page.waitForTimeout(200);
  const res = await ev(() => { const a = window.app; return a.mates.filter((m) => m.b.part === 'lever' && m.enabled !== false).map((m) => a.mateErr(m)); });
  const p1 = await ev(() => window.app.parts.get('lever').pose.slice());
  check(p1.some((v, i) => Math.abs(v - p0[i]) > 1e-3) && res.every((e) => e < 0.05), `rotating the hinge keeps its mates satisfied (errors ${res.map((e) => e.toFixed(3)).join(',')})`);
}
await page.screenshot({ path: path.join(out, 'flow-hinge.png') });

// mate mode: click the canvas a few times (no errors expected)
await page.keyboard.press('m');
const box = await page.locator('#viewport canvas').boundingBox();
for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(out, 'flow-mate.png') });
await page.keyboard.press('Escape');

// manual mate via API: un-mate the key and re-mate with a rect mate
const mated = await ev(() => {
  const a = window.app;
  const key = a.parts.get('key'), base = a.parts.get('base');
  a.mates = a.mates.filter((m) => m.b.part !== 'key');
  a.translatePart('key', [30, 10, 5]);
  const rk = key.an.rects.find((r) => !r.concave && Math.abs(r.w1 * r.w2 - 60) < 1);
  const rb = base.an.rects.find((r) => r.concave);
  if (!rk || !rb) return 'missing rect';
  a.addMate({ type: 'rect', a: { part: 'base', f: 'r' + rb.id }, b: { part: 'key', f: 'r' + rk.id } });
  const m = a.mates[a.mates.length - 1];
  return a.mateErr(m);
});
check(typeof mated === 'number' && mated < 0.05, `manual rect mate solves (${mated})`);

// measure mode
await page.keyboard.press('d');
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.48);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(out, 'flow-measure.png') });
await page.keyboard.press('Escape');

// section + explode + axes
await page.click('#btn-section');
await page.fill('#sec-pos', '400');
await page.dispatchEvent('#sec-pos', 'input');
await page.click('#btn-features');
await page.screenshot({ path: path.join(out, 'flow-section.png') });
await page.click('#btn-section');
await page.fill('#explode', '60');
await page.dispatchEvent('#explode', 'input');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(out, 'flow-explode.png') });
await page.fill('#explode', '0');
await page.dispatchEvent('#explode', 'input');

// collisions
await page.click('#btn-interf');
await page.waitForFunction(() => /collision|intersect/i.test(document.querySelector('#status-text').textContent), null, { timeout: 30000 });
console.log(await page.textContent('#status-text'));

// exports
const expectBodies = await ev(() => window.app.exportBodies(false).length);
const expectTris = await ev(() => window.app.exportBodies(false).reduce((s, b) => s + b.positions.length / 9, 0));
async function grab(kind) {
  await page.click('#btn-export');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export="${kind}"]`)]);
  const file = path.join(out, 'export-' + kind + '-' + dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}
const stlBin = await grab('stl-bin');
const pb = parseSTL(new Uint8Array(fs.readFileSync(stlBin)));
check(pb.positions.length / 9 === expectTris, `binary STL has ${expectTris} triangles (${pb.positions.length / 9})`);
const stlA = await grab('stl-ascii');
const pa = parseSTL(new Uint8Array(fs.readFileSync(stlA)));
check(pa.solids.length === expectBodies, `ASCII STL has ${expectBodies} named solids (${pa.solids.length}: ${pa.solids.map((s) => s.name).join(', ')})`);
const tmf = await grab('3mf-objects');
const z = await unzip(new Uint8Array(fs.readFileSync(tmf)));
const model = new TextDecoder().decode(z.find((e) => e.name === '3D/3dmodel.model').data);
check((model.match(/<object /g) || []).length === expectBodies, `3MF has ${expectBodies} objects`);
const tmfA = await grab('3mf-assembly');
check(fs.statSync(tmfA).size > 1000, '3MF assembly written');
const zp = await grab('zip');
check((await unzip(new Uint8Array(fs.readFileSync(zp)))).length === expectBodies, 'zip has one STL per body');
const proj = await grab('project');
const pj = JSON.parse(fs.readFileSync(proj, 'utf8'));
check(pj.format === 'stl-assembler-project' && pj.parts.length === nParts, 'project json saved');

// settings / help modals
await page.click('#btn-settings');
await page.screenshot({ path: path.join(out, 'flow-settings.png') });
await page.click('#modal-close');
await page.click('#btn-help');
await page.screenshot({ path: path.join(out, 'flow-help.png') });
await page.click('#modal-close');

// split a multi-body file? reload project onto fresh page
const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page2.on('pageerror', (e) => errors.push('page2: ' + e));
await page2.goto('file://' + path.join(root, 'dist', 'STL-Assembler.html'));
await page2.setInputFiles('#file-input', [...fs.readdirSync(dir).filter((f) => f.endsWith('.stl')).map((f) => path.join(dir, f)), proj]);
await page2.waitForFunction(() => /Project restored/.test(document.querySelector('#status-text').textContent), null, { timeout: 120000 });
const restored = await page2.evaluate(() => window.app.parts.get('key').pose.slice());
const orig = await ev(() => window.app.parts.get('key').pose.slice());
check(restored.every((v, i) => Math.abs(v - orig[i]) < 1e-6), 'project restores poses');
console.log('console errors:', errors.length ? errors : 'none');
if (errors.length) process.exitCode = 1;
await browser.close();
