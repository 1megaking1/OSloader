// Worker pool client. Analysis runs on a pool of workers (one per core, up
// to 6); matching/assembly runs on a dedicated assembler worker that keeps
// every part's signed distance field. Falls back to the main thread when
// workers are unavailable.

import WORKER_SRC from 'virtual:worker-src';
import { handle } from './worker.js';

class Client {
  constructor(worker) {
    this.w = worker;
    this.rid = 0;
    this.pending = new Map();
    this.busy = 0;
    worker.onmessage = (e) => {
      const { rid, ok, result, error, progress } = e.data;
      const p = this.pending.get(rid);
      if (!p) return;
      if (progress) {
        p.onProgress && p.onProgress(progress);
        return;
      }
      this.pending.delete(rid);
      this.busy--;
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
      this.pending.clear();
    };
  }
  call(type, msg = {}, transfer = [], onProgress = null) {
    const rid = ++this.rid;
    this.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject, onProgress });
      this.w.postMessage({ rid, type, ...msg }, transfer);
    });
  }
}

class LocalClient {
  constructor() {
    this.busy = 0;
  }
  async call(type, msg = {}, _transfer, onProgress = null) {
    this.busy++;
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { result } = await handle(type, structuredCloneSafe(msg), (m) => m.progress && onProgress && onProgress(m.progress));
      return result;
    } finally {
      this.busy--;
    }
  }
}

function structuredCloneSafe(m) {
  return m;
}

export class WorkerHub {
  constructor() {
    this.local = false;
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      this.pool = Array.from({ length: n }, () => new Client(new Worker(url)));
      this.asm = new Client(new Worker(url));
    } catch (err) {
      console.warn('Web Workers unavailable, running on the main thread', err);
      this.local = true;
      const lc = new LocalClient();
      this.pool = [lc];
      this.asm = lc;
    }
  }
  goLocal() {
    if (this.local) return;
    this.local = true;
    for (const c of [...this.pool, this.asm]) c.w && c.w.terminate();
    const lc = new LocalClient();
    this.pool = [lc];
    this.asm = lc;
  }
  get size() {
    return this.pool.length;
  }
  async analyze(positions, options, meta = null) {
    const c = this.pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    // send a copy: the main thread keeps the original for rendering
    const an = await c.call('analyze', { positions: positions.slice(), options, keepAs: this.local ? null : meta });
    if (meta) an._worker = this.pool.indexOf(c);
    return an;
  }
  /** register a part with the assembler (transfer) and the other pool workers (copies) */
  addPart(part) {
    const an = part.an;
    const jobs = [];
    if (!this.local) {
      const from = an._worker;
      delete an._worker;
      this.pool.forEach((c, i) => {
        if (i !== from) jobs.push(c.call('addPart', { part }));
      });
    }
    const transfer = this.local ? [] : [an.sdf.data.buffer, an.samples.pos.buffer, an.samples.nor.buffer, an.samples.grid.start.buffer, an.samples.grid.idx.buffer];
    jobs.push(this.asm.call('addPart', { part }, transfer));
    return Promise.all(jobs);
  }
  removePart(id) {
    if (!this.local) for (const c of this.pool) c.call('removePart', { id });
    return this.asm.call('removePart', { id });
  }
  addFeature(id, cyl) {
    if (!this.local) for (const c of this.pool) c.call('addFeature', { id, cyl });
    return this.asm.call('addFeature', { id, cyl });
  }
  /** compute pair hypotheses on the pool in parallel */
  async pairs(tasks, options, onProgress) {
    if (this.local) return this.asm.call('pairs', { tasks, options });
    const chunks = [];
    const size = Math.max(1, Math.min(6, Math.ceil(tasks.length / (this.pool.length * 4))));
    for (let i = 0; i < tasks.length; i += size) chunks.push(tasks.slice(i, i + size));
    let done = 0;
    const out = [];
    let next = 0;
    const runWorker = async (c) => {
      while (next < chunks.length) {
        const ch = chunks[next++];
        const res = await c.call('pairs', { tasks: ch, options });
        out.push(...res);
        done += ch.length;
        onProgress && onProgress(done, tasks.length);
      }
    };
    await Promise.all(this.pool.map(runWorker));
    return out;
  }
  versions(ids) {
    return this.asm.call('versions', { ids });
  }
  assemble(ids, options, onProgress, hypsList = null) {
    return this.asm.call('assemble', { ids, options, hypsList }, [], onProgress);
  }
  suggest(id, poses, options) {
    return this.asm.call('suggest', { id, poses, options });
  }
  snap(id, pose, poses, options) {
    return this.asm.call('snap', { id, pose, poses, options });
  }
  interference(poses, options) {
    return this.asm.call('interference', { poses, options });
  }
  register(a, b) {
    return this.asm.call('register', { a, b });
  }
}
