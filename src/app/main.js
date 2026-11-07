import { App } from './app.js';

function start() {
  try {
    window.app = new App();
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<div style="padding:40px;font:15px sans-serif;color:#eee;background:#222;height:100vh">
      <h2>STL Assembler could not start</h2><p>${String(err && err.message || err)}</p>
      <p>This tool needs a browser with WebGL (Chrome, Safari 15+, Edge or Firefox).</p></div>`;
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
