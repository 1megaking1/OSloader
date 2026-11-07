// Captures README screenshots from the built app.
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.goto('file://' + path.join(root, 'dist', 'STL-Assembler.html'));
const waitDone = () => page.waitForFunction(() => /Auto-assembled/.test(document.querySelector('#status-text').textContent), null, { timeout: 120000 });
// enclosure demo (3rd kit)
await page.evaluate(() => { window.app._demoIdx = 1; window.app.loadDemo(); });
await waitDone();
await page.evaluate(() => { const a = window.app; a.viewer.camera.position.set(170, -190, 150); a.viewer.fit(a.order.filter((id) => a.parts.get(id).status !== 'unplaced')); });
await page.fill('#explode', '35');
await page.dispatchEvent('#explode', 'input');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(root, 'docs', 'screenshot-enclosure.png') });
// bracket demo with the hinge selected
await page.evaluate(() => { for (const id of Array.from(window.app.parts.keys())) window.app.removePart(id); window.app._demoIdx = 0; window.app.loadDemo(); });
await waitDone();
await page.fill('#explode', '0');
await page.dispatchEvent('#explode', 'input');
await page.evaluate(() => { const a = window.app; a.select('lever'); a.viewer.camera.position.set(120, -140, 110); a.viewer.fit(); });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(root, 'docs', 'screenshot-hinge.png') });
await browser.close();
console.log('ok');
