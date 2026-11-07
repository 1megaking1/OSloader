// Headless browser smoke test of the built single-file app.
//   node test/browser-smoke.mjs [outdir]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import path from 'node:path';
import fs from 'node:fs';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const out = process.argv[2] || path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.join(root, 'dist', 'STL-Assembler.html'));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, '0-empty.png') });
const kits = +(process.env.KITS || 1);
for (let k = 0; k < kits; k++) {
  if (k > 0) await page.evaluate(() => { for (const id of Array.from(window.app.parts.keys())) window.app.removePart(id); });
  await page.click('#btn-demo').catch(async () => { await page.evaluate(() => window.app.loadDemo()); });
  // wait for auto assembly to finish
  await page.waitForFunction(() => /Auto-assembled/.test(document.querySelector('#status-text').textContent), null, { timeout: 120000 });
  const status = await page.textContent('#status-text');
  console.log('kit', k, status);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `kit${k}-assembled.png`) });
}
// select first ambiguous part, if any, and screenshot the inspector
const amb = await page.evaluate(() => Array.from(window.app.parts.values()).find((p) => p.status === 'ambiguous')?.id || null);
if (amb) {
  await page.evaluate((id) => window.app.select(id), amb);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'ambiguous-selected.png') });
}
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
