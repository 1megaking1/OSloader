// Renders the app's auto-assembly of a real kit to a PNG.
//   node test/real/shot-real.mjs <kitdir> <out.png> [cameraJSON]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir, out, cam] = process.argv.slice(2);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const files = fs.readdirSync(path.join(dir, 'parts')).filter((f) => /\.stl$/i.test(f)).map((f) => path.resolve(dir, 'parts', f));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.join(root, 'dist', 'STL-Assembler.html'));
await page.setInputFiles('#file-input', files);
await page.waitForFunction(() => /Auto-assembled|failed/.test(document.querySelector('#status-text').textContent), null, { timeout: 900000 });
console.log(await page.textContent('#status-text'));
if (cam) await page.evaluate((c) => { const v = window.app.viewer; v.camera.position.set(...JSON.parse(c)); }, cam);
await page.evaluate(() => { const a = window.app; a.viewer.fit(a.order.filter((id) => a.parts.get(id).status !== 'unplaced')); });
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log(await page.evaluate(() => Array.from(window.app.parts.values()).map((p) => `${p.name}:${p.status}`).join(', ')));
console.log('errors', errors);
await browser.close();
