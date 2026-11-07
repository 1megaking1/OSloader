// Builds dist/STL-Assembler.html: a single self-contained file (no server
// needed – double-click to open). Usage: node build.mjs [--watch] [--no-demo]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const target = ['es2020', 'safari15', 'chrome96', 'firefox100'];

function demoModule() {
  if (args.includes('--no-demo')) return 'export const DEMO_KITS = [];';
  const kits = [];
  const fix = path.join(root, 'test', 'fixtures');
  const names = [['splitprop', 'Split blaster demo'], ['bracket', 'Bracket + hinge demo'], ['enclosure', 'Enclosure demo']];
  for (const [dir, label] of names) {
    const d = path.join(fix, dir);
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.stl')).sort().map((f) => ({ name: f, data: fs.readFileSync(path.join(d, f)).toString('base64') }));
    kits.push({ name: label, files });
  }
  return `export const DEMO_KITS = ${JSON.stringify(kits)};`;
}

async function build() {
  const t0 = Date.now();
  const worker = await esbuild.build({
    entryPoints: [path.join(root, 'src/app/worker.js')],
    bundle: true, format: 'iife', minify: true, write: false, platform: 'browser', target, legalComments: 'none',
  });
  const workerCode = worker.outputFiles[0].text;
  const virtual = {
    name: 'virtual',
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path, namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, (a) => {
        if (a.path === 'virtual:worker-src') return { contents: `export default ${JSON.stringify(workerCode)};`, loader: 'js' };
        if (a.path === 'virtual:demo-kits') return { contents: demoModule(), loader: 'js' };
        return null;
      });
    },
  };
  const main = await esbuild.build({
    entryPoints: [path.join(root, 'src/app/main.js')],
    bundle: true, format: 'iife', minify: true, write: false, platform: 'browser', target, legalComments: 'none',
    plugins: [virtual],
  });
  const js = main.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(root, 'src/app/style.css'), 'utf8');
  let html = fs.readFileSync(path.join(root, 'src/app/index.html'), 'utf8');
  html = html.replace('<!--STYLE-->', () => `<style>\n${css}\n</style>`).replace('<!--SCRIPT-->', () => `<script>\n${js}\n</script>`);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = path.join(root, 'dist', 'STL-Assembler.html');
  fs.writeFileSync(out, html);
  console.log(`built ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB) in ${Date.now() - t0} ms`);
}

await build();
if (args.includes('--watch')) {
  let timer = null;
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e.message)), 100);
  });
  console.log('watching src/ …');
}
