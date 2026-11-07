// Application controller: state, loading pipeline, auto assembly, manual
// mates, alternatives, measuring, undo/redo, export and project files.

import { Viewer } from './viewer.js';
import { WorkerHub } from './workers.js';
import { loadInputs, filesFromDataTransfer, filesFromInput, download, transformSoup, exportBodies, zipFiles, writeSTLBinary } from './io.js';
import { solvePart, worldFeature, getFeature, mateError, MATE_TYPES } from '../core/solver.js';
import { quantityFromName, planPairs } from '../core/assemble.js';
import { mIdentity, mMul, mInvRigid, mPoint, mDir, mTranslation, mAxisAngle, mAlign, dot, sub, add, scale, cross, norm, len, dist, rad, deg, reject } from '../core/math.js';
import { renderParts, renderInspector, renderSummary, featureLabel, mateLabel } from './panels.js';
import { DEMO_KITS } from 'virtual:demo-kits';

const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'stl-assembler-settings-v1';

export const DEFAULT_SETTINGS = {
  autoAssembleOnLoad: true,
  autoInstances: true,
  squareToGrid: true,
  contactTol: 0.45,
  maxClearance: 0.8,
  slotClearance: 1.2,
  penTol: 0.3,
  stackGap: 6,
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const color = (i) => `hsl(${(i * 137.508 + 200) % 360}, 52%, ${58 + ((i * 7) % 3) * 5}%)`;
const clone = (x) => JSON.parse(JSON.stringify(x));

export class App {
  constructor() {
    this.parts = new Map();
    this.order = [];
    this.mates = [];
    this.groups = [];
    this.root = null;
    this.sel = null;
    this.mode = 'select';
    this.undoStack = [];
    this.redoStack = [];
    this.settings = loadSettings();
    this.hover = null;
    this.colorIdx = 0;
    this.pendingProjects = [];
    this.analyzing = 0;
    this.assemblyName = 'assembly';
    this.viewer = new Viewer($('#viewport'));
    this.hub = new WorkerHub();
    this.featCache = new Map();
    this.hypCache = new Map();
    this.hypOptsKey = '';
    this.bind();
    this.render();
    this.status(this.hub.local ? 'Ready (single-threaded mode).' : `Ready – ${this.hub.size} analysis workers.`);
  }

  // =============================================================== events
  bind() {
    const vp = $('#viewport');
    const fileInput = $('#file-input'), folderInput = $('#folder-input');
    $('#btn-open').onclick = $('#btn-open2').onclick = () => fileInput.click();
    $('#btn-folder').onclick = $('#btn-folder2').onclick = () => folderInput.click();
    $('#btn-demo').onclick = () => this.loadDemo();
    fileInput.onchange = () => {
      this.addInputs(filesFromInput(fileInput));
      fileInput.value = '';
    };
    folderInput.onchange = () => {
      this.addInputs(filesFromInput(folderInput));
      folderInput.value = '';
    };
    // drag and drop anywhere
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      vp.classList.add('dragover');
    });
    window.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) vp.classList.remove('dragover');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      vp.classList.remove('dragover');
      const files = await filesFromDataTransfer(e.dataTransfer);
      this.addInputs(files);
    });

    $('#btn-auto').onclick = () => this.autoAssemble();
    $('#btn-review').onclick = () => this.reviewNext();
    $('#btn-undo').onclick = () => this.undo();
    $('#btn-redo').onclick = () => this.redo();
    $('#btn-mate').onclick = () => this.setMode(this.mode === 'mate' ? 'select' : 'mate');
    $('#btn-measure').onclick = () => this.setMode(this.mode === 'measure' ? 'select' : 'measure');
    $('#btn-interf').onclick = () => this.checkInterference();
    $('#btn-fit').onclick = () => this.viewer.fit();
    $('#explode').oninput = (e) => this.viewer.setExplode(+e.target.value / 100);
    $('#btn-section').onclick = () => this.toggleSection();
    $('#sec-axis').onchange = $('#sec-pos').oninput = () => this.updateSection();
    $('#sec-flip').onclick = () => {
      this.secFlip = !this.secFlip;
      this.updateSection();
    };
    $('#btn-features').onclick = (e) => {
      this.viewer.setShowAxes(!this.viewer.showAxes);
      e.target.classList.toggle('active', this.viewer.showAxes);
    };
    const menu = $('#btn-export').parentElement;
    $('#btn-export').onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) menu.classList.remove('open');
    });
    for (const b of document.querySelectorAll('[data-export]')) {
      b.onclick = () => {
        menu.classList.remove('open');
        this.exportAs(b.dataset.export);
      };
    }
    $('#btn-settings').onclick = () => this.showSettings();
    $('#btn-help').onclick = () => this.showHelp();
    $('#modal-close').onclick = () => ($('#modal').hidden = true);
    $('#part-filter').oninput = () => this.renderParts();

    // viewport picking
    const canvas = this.viewer.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || this.viewer.gizmo.dragging) return;
      if (e.button !== 0) return;
      this.onClick(e);
    });
    canvas.addEventListener('dblclick', (e) => {
      const h = this.viewer.pick(e.clientX, e.clientY);
      if (h) this.viewer.fit([h.id]);
    });

    // gizmo
    this.viewer.addEventListener('gizmo-start', (e) => {
      this.snapshot();
      const p = this.parts.get(e.detail.id);
      this._gizmoStartPose = p ? p.pose.slice() : null;
    });
    this.viewer.addEventListener('gizmo', (e) => {
      const p = this.parts.get(e.detail.id);
      if (!p) return;
      p.pose = e.detail.matrix;
      this.viewer.setPose(p.id, p.pose);
    });
    this.viewer.addEventListener('gizmo-end', (e) => {
      const p = this.parts.get(e.detail.id);
      if (!p) return;
      if (p.status === 'unplaced') p.status = 'manual';
      if (this._gizmoStartPose) this.propagate(p.id, mMul(p.pose, mInvRigid(this._gizmoStartPose)));
      this.render();
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod) return;
    const k = e.key;
    if (k === 'Escape') {
      if (this.mode !== 'select') this.setMode('select');
      else this.select(null);
    } else if (k === 'a' || k === 'A') this.autoAssemble();
    else if (k === 'm' || k === 'M') this.setMode(this.mode === 'mate' ? 'select' : 'mate');
    else if (k === 'd' || k === 'D') this.setMode(this.mode === 'measure' ? 'select' : 'measure');
    else if (k === 'f' || k === 'F') this.viewer.fit(this.sel ? [this.sel] : null);
    else if (k === 'r' || k === 'R') this.reviewNext();
    else if (k === 'h' || k === 'H') this.sel && this.setVisible(this.sel, !this.parts.get(this.sel).visible);
    else if (k === 'i' || k === 'I') this.sel && this.isolate(this.sel);
    else if (k === 'g' || k === 'G') this.sel && this.setGizmo(this.gizmoMode === 'translate' ? null : 'translate');
    else if (k === 't' || k === 'T') this.sel && this.setGizmo(this.gizmoMode === 'rotate' ? null : 'rotate');
    else if (k === ']' || k === '[') {
      const p = this.parts.get(this.sel);
      if (p && p.alternatives?.length) {
        const n = p.alternatives.length;
        const k2 = ((p.altIndex ?? 0) + (k === ']' ? 1 : -1) + n) % n;
        this.applyAlternative(p.id, k2);
      }
    } else if (k === 'Enter') {
      const p = this.parts.get(this.sel);
      if (p && p.status === 'ambiguous') {
        p.status = 'placed';
        p.reviewed = true;
        this.render();
        this.reviewNext();
      }
    } else if (k === 'Delete' || k === 'Backspace') {
      if (this.sel) this.setInclude(this.sel, !this.parts.get(this.sel).include);
    }
  }

  // ============================================================== loading
  async addInputs(files) {
    if (!files.length) return;
    const { bodies, projects, skipped } = await loadInputs(files, (m) => this.status(m));
    if (projects.length) this.pendingProjects.push(...projects);
    if (skipped.length) console.info('Skipped files:', skipped);
    if (!bodies.length) {
      if (projects.length) this.tryApplyProjects();
      else this.status(skipped.length ? `No mesh files found (skipped ${skipped.length}).` : 'No mesh files found.');
      return;
    }
    if (!this.parts.size) {
      const first = files[0].path || files[0].name;
      this.assemblyName = (first.includes('/') ? first.split('/')[0] : first.replace(/\.[^.]+$/, '')) || 'assembly';
    }
    this.addBodies(bodies);
  }

  addBodies(bodies) {
    $('#drop-hint').hidden = true;
    const created = [];
    for (const b of bodies) {
      let id = b.name, k = 2;
      while (this.parts.has(id)) id = `${b.name} (${k++})`;
      const part = {
        id,
        name: id,
        base: id,
        path: b.path,
        positions: b.positions,
        an: null,
        color: color(this.colorIdx++),
        visible: true,
        include: true,
        pose: mIdentity(),
        status: 'analyzing',
        alternatives: [],
        locked: false,
        qty: quantityFromName(b.name),
      };
      this.parts.set(id, part);
      this.order.push(id);
      this.viewer.addPart(id, id, b.positions, part.color);
      created.push(part);
    }
    this.layoutLoose(created);
    this.viewer.fit();
    this.render();
    this.analyzeParts(created);
  }

  /** place loose parts side by side (keeps their file orientation) */
  layoutLoose(list) {
    const box = this.viewer.bounds(this.order.filter((id) => !list.some((p) => p.id === id)));
    let x = box.isEmpty() ? 0 : box.max.x + 20;
    let y = box.isEmpty() ? 0 : box.min.y, rowH = 0;
    const startX = x;
    const maxW = Math.max(300, Math.sqrt(list.reduce((s, p) => s + this.localBox(p).size[0] * this.localBox(p).size[1], 0)) * 1.6);
    for (const p of list) {
      const b = this.localBox(p);
      if (x - startX > maxW) {
        x = startX;
        y += rowH + 10;
        rowH = 0;
      }
      p.pose = mTranslation([x - b.min[0], y - b.min[1], -b.min[2]]);
      this.viewer.setPose(p.id, p.pose);
      x += b.size[0] + 10;
      rowH = Math.max(rowH, b.size[1]);
    }
  }

  localBox(p) {
    if (p._box) return p._box;
    const pos = p.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k];
      if (pos[i + k] > max[k]) max[k] = pos[i + k];
    }
    p._box = { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
    return p._box;
  }

  async analyzeParts(list) {
    this.analyzing += list.length;
    let done = 0;
    const t0 = performance.now();
    const total = list.length;
    this.progress(0);
    await Promise.all(
      list.map(async (part) => {
        try {
          let an;
          try {
            an = await this.hub.analyze(part.positions, {}, { id: part.id, name: part.name });
          } catch (err) {
            if (this.hub.local || !/worker|security|script/i.test(String(err.message))) throw err;
            console.warn('Worker failed, switching to main thread', err);
            this.hub.goLocal();
            an = await this.hub.analyze(part.positions, {});
          }
          // keep a light copy (the heavy SDF goes to the assembler worker)
          const light = { ...an, sdf: { o: an.sdf.o, h: an.sdf.h, dims: an.sdf.dims }, samples: { n: an.samples.n, areaPer: an.samples.areaPer } };
          await this.hub.addPart({ id: part.id, name: part.name, an });
          part.an = light;
          part.status = 'unplaced';
          this.updateAxes(part);
        } catch (err) {
          console.error(err);
          part.status = 'error';
          part.error = String(err.message || err);
        }
        done++;
        this.progress(done / total);
        this.status(`Analysed ${done}/${total} parts…`);
        this.renderParts();
      }),
    );
    this.analyzing -= list.length;
    this.progress(null);
    const ms = Math.round(performance.now() - t0);
    this.status(`Analysed ${total} part${total > 1 ? 's' : ''} in ${(ms / 1000).toFixed(1)} s.`);
    if (this.analyzing > 0) return;
    if (this.tryApplyProjects()) return;
    if (this.settings.autoAssembleOnLoad) this.autoAssemble();
    else this.render();
  }

  updateAxes(part) {
    const segs = [];
    for (const c of part.an.cyls) {
      if (c.span < rad(150)) continue;
      const L = c.len / 2 + Math.max(2, c.r);
      segs.push({ a: add(c.c, scale(c.a, -L)), b: add(c.c, scale(c.a, L)), color: c.concave ? 0xff9a3c : 0x5ad18a });
    }
    this.viewer.setAxes(part.id, segs);
  }

  // ========================================================= auto assembly
  matchOptions() {
    const s = this.settings;
    return { contactTol: +s.contactTol, maxClearance: +s.maxClearance, slotClearance: +s.slotClearance, penTol: +s.penTol, stackGap: +s.stackGap };
  }

  async autoAssemble() {
    const ready = this.baseParts().filter((p) => p.an && p.include);
    if (ready.length < 1) return this.status('Add some parts first.');
    if (this.analyzing > 0) return this.status('Still analysing – auto-assembly will start when done.');
    this.snapshot();
    const fixed = {};
    for (const p of ready) if (p.locked) fixed[p.id] = p.pose;
    const root = this.root && this.parts.get(this.root)?.include ? this.root : null;
    if (root && !fixed[root]) fixed[root] = this.parts.get(root).pose;
    this.status('Looking for duplicate versions…');
    this.progress(0);
    $('#btn-auto').disabled = true;
    const t0 = performance.now();
    let res;
    try {
      const ids = ready.map((p) => p.id);
      const match = this.matchOptions();
      const okey = JSON.stringify(match);
      if (okey !== this.hypOptsKey) {
        this.hypCache = new Map();
        this.hypOptsKey = okey;
      }
      const groups = await this.hub.versions(ids);
      const members = new Set(groups.flatMap((g) => g.members.filter((m) => m !== g.rep)));
      const nodes = ready.filter((p) => !members.has(p.id)).map((p) => ({ id: p.id, name: p.name, area: p.an.stats.area }));
      const all = planPairs(nodes);
      const todo = all.filter((t) => !this.hypCache.has(t.key));
      if (todo.length) {
        this.status(`Matching ${todo.length} part pairs on ${this.hub.size} threads…`);
        const out = await this.hub.pairs(todo, { match }, (d, n) => {
          this.progress(d / n);
          this.status(`Matching part pairs ${d}/${n}…`);
        });
        for (const [k, h] of out) this.hypCache.set(k, h);
      }
      const hypsList = all.map((t) => [t.key, this.hypCache.get(t.key)]).filter((x) => x[1]);
      this.status('Placing parts…');
      res = await this.hub.assemble(
        ids,
        { fixed: Object.keys(fixed).length ? fixed : null, autoInstances: this.settings.autoInstances, match, groups },
        (pr) => {
          if (pr.stage === 'matching') {
            this.progress(pr.done / pr.total);
            this.status(`Matching part pairs ${pr.done}/${pr.total}…`);
          } else if (pr.stage === 'placing') this.status(`Placing parts ${pr.done}/${pr.total}…`);
        },
        hypsList,
      );
    } catch (err) {
      console.error(err);
      this.status('Auto-assembly failed: ' + err.message);
      $('#btn-auto').disabled = false;
      this.progress(null);
      return;
    }
    $('#btn-auto').disabled = false;
    this.progress(null);
    this.applyAssembly(res);
    if (this.settings.squareToGrid && !Object.keys(fixed).length) this.squareToGrid(false);
    const ms = Math.round(performance.now() - t0);
    const c = this.counts();
    this.status(`Auto-assembled in ${(ms / 1000).toFixed(1)} s: ${c.placed} placed, ${c.ambiguous} to review, ${c.unplaced} not placed${c.version ? `, ${c.version} versions stacked` : ''}.`);
  }

  applyAssembly(res) {
    // remove previous auto instances
    for (const p of Array.from(this.parts.values())) if (p.instanceOf && p.autoInstance) this.removePart(p.id, false);
    this.root = res.root;
    // instances
    for (const inst of res.instances) {
      const base = this.parts.get(inst.of);
      if (!base) continue;
      this.createInstance(base, inst.id, true);
    }
    for (const [id, W] of Object.entries(res.poses)) {
      const p = this.parts.get(id);
      if (!p) continue;
      const pl = res.placements[id] || {};
      p.pose = W;
      p.status = pl.status || 'placed';
      p.score = pl.score;
      p.margin = pl.margin;
      p.source = pl.source;
      p.from = pl.from;
      p.freeDOF = pl.freeDOF;
      p.alternatives = pl.alternatives || [];
      p.altIndex = 0;
      p.reviewed = false;
      this.viewer.setPose(id, W);
    }
    // version groups
    this.groups = res.groups.map((g) => {
      const old = this.groups.find((o) => o.members.length === g.members.length && o.members.every((m) => g.members.includes(m)));
      return { members: g.members, keep: old?.keep && g.members.includes(old.keep) ? old.keep : g.rep };
    });
    this.applyVersionVisibility();
    // mates: replace automatic ones, keep the user's manual mates
    this.mates = this.mates.filter((m) => !m.auto);
    let k = 0;
    for (const m of res.mates) this.mates.push({ ...m, id: 'm' + Date.now().toString(36) + k++, auto: true, enabled: true });
    for (const p of this.parts.values()) if (p.alternatives?.length > 1) this.collapseFreeAlternatives(p);
    this.viewer.setExplode(this.viewer.explode);
    this.viewer.fit();
    this.render();
  }

  counts() {
    const c = { placed: 0, ambiguous: 0, unplaced: 0, version: 0, total: 0 };
    for (const p of this.parts.values()) {
      c.total++;
      if (p.status === 'ambiguous') c.ambiguous++;
      else if (p.status === 'unplaced') c.unplaced++;
      else if (p.status === 'version') c.version++;
      else c.placed++;
    }
    return c;
  }

  baseParts() {
    return this.order.map((id) => this.parts.get(id)).filter((p) => p && !p.instanceOf);
  }

  /** poses of parts that count as "in the assembly" */
  placedPoses(exceptId = null) {
    const out = {};
    for (const p of this.parts.values()) {
      if (p.id === exceptId || !p.include || !p.an) continue;
      if (p.status === 'unplaced' || p.status === 'analyzing' || p.status === 'error') continue;
      if (p.status === 'version' && !this.isKept(p.id)) continue;
      out[p.id] = p.pose;
    }
    return out;
  }

  // ============================================================== parts
  createInstance(base, id = null, auto = false) {
    if (!id) {
      let k = 2;
      while (this.parts.has(base.id + '#' + k)) k++;
      id = base.id + '#' + k;
    }
    const inst = {
      ...base,
      id,
      name: `${base.name} #${id.split('#')[1]}`,
      instanceOf: base.id,
      autoInstance: auto,
      pose: base.pose.slice(),
      status: 'manual',
      alternatives: [],
      locked: false,
      _box: base._box,
    };
    this.parts.set(id, inst);
    const bi = this.order.indexOf(base.id);
    let at = bi + 1;
    while (at < this.order.length && this.parts.get(this.order[at])?.instanceOf === base.id) at++;
    this.order.splice(at, 0, id);
    this.viewer.addPart(id, base.id, base.positions, base.color);
    this.viewer.setPose(id, inst.pose);
    if (base.an) this.updateAxes(inst);
    return inst;
  }

  async addCopy(baseId) {
    const base = this.parts.get(baseId);
    if (!base || !base.an) return;
    this.snapshot();
    const inst = this.createInstance(base);
    this.status(`Placing a copy of ${base.name}…`);
    await this.autoPlace(inst.id, false);
    this.select(inst.id);
  }

  removePart(id, render = true) {
    const p = this.parts.get(id);
    if (!p) return;
    // instances depending on base
    if (!p.instanceOf) for (const q of Array.from(this.parts.values())) if (q.instanceOf === id) this.removePart(q.id, false);
    this.parts.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.viewer.removePart(id);
    this.mates = this.mates.filter((m) => m.a.part !== id && m.b.part !== id);
    if (!p.instanceOf) {
      this.hub.removePart(id);
      if (this.hypCache) for (const k of Array.from(this.hypCache.keys())) if (k.split('\u0001').includes(id)) this.hypCache.delete(k);
    }
    if (this.sel === id) this.sel = null;
    if (this.root === id) this.root = null;
    this.groups = this.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== id) })).filter((g) => g.members.length > 1);
    for (const g of this.groups) if (!g.members.includes(g.keep)) g.keep = g.members[0];
    if (render) this.render();
  }

  select(id) {
    if (this.sel && this.parts.get(this.sel)) this.viewer.setStyle(this.sel, this.styleFor(this.sel, false));
    this.sel = id;
    if (id) this.viewer.setStyle(id, this.styleFor(id, true));
    this.viewer.clearGhosts();
    if (this.gizmoMode && id) this.viewer.attachGizmo(id, this.gizmoMode);
    else this.viewer.attachGizmo(null);
    this.viewer.overlay('sel', null);
    this.render();
  }

  styleFor(id, selected) {
    const p = this.parts.get(id);
    const dim = p.status === 'version' && !this.isKept(id);
    return { selected, transparent: !p.include, dim };
  }

  setVisible(id, v) {
    const p = this.parts.get(id);
    p.visible = v;
    this.viewer.setVisible(id, v);
    this.renderParts();
  }

  setInclude(id, v) {
    this.snapshot();
    const p = this.parts.get(id);
    p.include = v;
    this.viewer.setStyle(id, this.styleFor(id, id === this.sel));
    this.render();
  }

  isolate(id) {
    const others = Array.from(this.parts.values()).filter((p) => p.id !== id);
    const anyVisible = others.some((p) => p.visible);
    for (const p of others) this.setVisible(p.id, !anyVisible);
    this.viewer.fit(anyVisible ? [id] : null);
  }

  showAll() {
    for (const p of this.parts.values()) this.setVisible(p.id, this.isKept(p.id) || p.status !== 'version');
  }

  setRoot(id) {
    this.snapshot();
    this.root = id;
    for (const p of this.parts.values()) if (p.status === 'root') p.status = 'placed';
    const p = this.parts.get(id);
    p.status = 'root';
    this.render();
    this.status(`${p.name} is now the base part – run Auto-assemble to rebuild around it.`);
  }

  toggleLock(id) {
    this.snapshot();
    const p = this.parts.get(id);
    p.locked = !p.locked;
    this.render();
  }

  isKept(id) {
    const g = this.groups.find((x) => x.members.includes(id));
    return !g || g.keep === id;
  }

  groupOf(id) {
    return this.groups.find((g) => g.members.includes(id));
  }

  setKeep(gidx, id) {
    this.snapshot();
    this.groups[gidx].keep = id;
    this.applyVersionVisibility();
    this.render();
  }

  applyVersionVisibility() {
    for (const g of this.groups) {
      for (const m of g.members) {
        const p = this.parts.get(m);
        if (!p) continue;
        p.include = m === g.keep;
        this.viewer.setStyle(m, this.styleFor(m, m === this.sel));
      }
    }
  }

  ungroup(gidx) {
    this.snapshot();
    const g = this.groups[gidx];
    this.groups.splice(gidx, 1);
    for (const m of g.members) {
      const p = this.parts.get(m);
      p.include = true;
      if (p.status === 'version') p.status = 'placed';
      this.viewer.setStyle(m, this.styleFor(m, m === this.sel));
    }
    this.render();
  }

  async stackAsVersion(id, ontoId) {
    const p = this.parts.get(id), q = this.parts.get(ontoId);
    if (!p || !q || p.instanceOf || q.instanceOf) return;
    this.snapshot();
    this.status(`Registering ${p.name} onto ${q.name}…`);
    const r = await this.hub.register(q.id, p.id);
    p.pose = mMul(q.pose, r.T);
    p.status = 'version';
    this.viewer.setPose(p.id, p.pose);
    let g = this.groupOf(q.id);
    const pg = this.groupOf(p.id);
    if (pg && pg !== g) pg.members = pg.members.filter((m) => m !== p.id);
    this.groups = this.groups.filter((x) => x.members.length > 1);
    if (!g) {
      g = { members: [q.id], keep: q.id };
      this.groups.push(g);
    }
    if (!g.members.includes(p.id)) g.members.push(p.id);
    this.applyVersionVisibility();
    this.status(`Stacked ${p.name} on ${q.name} (shape difference ${r.err.toFixed(2)} mm mean). Pick which version to keep in the parts list.`);
    this.render();
  }

  // ======================================================== alternatives
  previewAlternative(id, k) {
    const p = this.parts.get(id);
    this.viewer.clearGhosts();
    if (p && p.alternatives[k]) this.viewer.ghost(id, p.alternatives[k].W);
  }

  async applyAlternative(id, k) {
    const p = this.parts.get(id);
    const alt = p?.alternatives[k];
    if (!alt) return;
    this.snapshot();
    p.altIndex = k;
    const old = p.pose.slice();
    const snapped = await this.hub.snap(id, alt.W, this.placedPoses(id), { match: this.matchOptions() });
    p.pose = snapped.pose;
    p.freeDOF = snapped.freeDOF;
    this.replaceAutoMates(id, snapped.mates);
    if (p.status === 'unplaced' || p.status === 'manual') p.status = 'placed';
    this.viewer.setPose(id, p.pose);
    this.viewer.clearGhosts();
    this.propagate(id, mMul(p.pose, mInvRigid(old)));
    this.render();
    this.status(`Option ${k + 1}/${p.alternatives.length} applied to ${p.name}. Use [ and ] to cycle, Enter to accept.`);
  }

  /** drop alternatives that differ from an earlier one only by spinning about the part's free axis */
  collapseFreeAlternatives(p) {
    const fa = this.freeAxisOfPose(p);
    if (!fa) return;
    const keep = [];
    for (const alt of p.alternatives) {
      const dupe = keep.some((k) => {
        const M = mMul(alt.W, mInvRigid(k.W));
        // M must be a rotation about the free axis line
        const q = mPoint(M, fa.point), q2 = mPoint(M, add(fa.point, scale(fa.axis, 10)));
        return dist(q, fa.point) < 0.05 && dist(q2, add(fa.point, scale(fa.axis, 10))) < 0.05;
      });
      if (!dupe) keep.push(alt);
    }
    // the free axis is expressed for the current pose; alternatives far away are kept as-is
    if (keep.length < p.alternatives.length) {
      p.alternatives = keep;
      p.altIndex = 0;
      if (keep.length === 1 && p.status === 'ambiguous') p.status = 'placed';
    }
  }

  freeAxisOfPose(p) {
    try {
      return this.freeAxisOf(p.id);
    } catch {
      return null;
    }
  }

  replaceAutoMates(id, mates) {
    this.mates = this.mates.filter((m) => !(m.auto && m.b.part === id));
    let k = 0;
    for (const m of mates) this.mates.push({ ...m, id: 'm' + Date.now().toString(36) + 's' + k++, auto: true, enabled: true });
  }

  async autoPlace(id, record = true) {
    const p = this.parts.get(id);
    if (!p || !p.an) return;
    if (record) this.snapshot();
    this.status(`Searching placements for ${p.name}…`);
    const poses = this.placedPoses(id);
    if (!Object.keys(poses).length) return this.status('Nothing placed yet – run Auto-assemble or set a base part first.');
    const sug = await this.hub.suggest(id, poses, { match: this.matchOptions() });
    if (!sug.length) {
      this.status(`No mating features found for ${p.name}. Use Mate (M) to place it manually, or move it with the gizmo (G/T).`);
      return;
    }
    p.alternatives = sug;
    const best = sug.findIndex((s) => s.pen < 0.04);
    await this.applyAlternative(id, best >= 0 ? best : 0);
    p.status = sug.length > 1 && (sug[0].score - sug[1].score) / Math.max(1e-6, sug[0].score) < 0.12 ? 'ambiguous' : 'placed';
    this.render();
  }

  reviewNext() {
    const list = this.order.filter((id) => this.parts.get(id)?.status === 'ambiguous');
    if (!list.length) {
      this.status('Nothing to review – no ambiguous placements.');
      return;
    }
    const i = list.indexOf(this.sel);
    const next = list[(i + 1) % list.length];
    this.select(next);
    this.viewer.fit([next, ...(this.parts.get(next).from ? [this.parts.get(next).from] : [])]);
    this.status(`Reviewing ${this.parts.get(next).name}: ${this.parts.get(next).alternatives.length} options. Hover to preview, click to apply, [ ] to cycle, Enter to accept.`);
  }

  // ================================================================ mates
  solveCtx() {
    const ctx = { parts: new Map() };
    for (const p of this.parts.values()) if (p.an) ctx.parts.set(p.id, { an: p.an, pose: p.pose });
    return ctx;
  }

  matesOf(id) {
    return this.mates.filter((m) => m.b.part === id || m.a.part === id);
  }

  solve(id, record = true) {
    const p = this.parts.get(id);
    if (!p) return;
    const mates = this.mates.filter((m) => m.enabled !== false && m.b.part === id);
    if (!mates.length) return;
    if (record) this.snapshot();
    const old = p.pose.slice();
    const res = solvePart(this.solveCtx(), id, mates);
    p.pose = res.pose;
    p.freeDOF = res.freeDOF;
    this.viewer.setPose(id, p.pose);
    this.propagate(id, mMul(p.pose, mInvRigid(old)));
  }

  /** after part `id` moved by world delta D, carry its dependants along and re-solve them */
  propagate(id, D) {
    const seen = new Set([id]);
    const queue = [[id, D]];
    while (queue.length) {
      const [pid, delta] = queue.shift();
      const deps = new Set(this.mates.filter((m) => m.enabled !== false && m.a.part === pid && !seen.has(m.b.part)).map((m) => m.b.part));
      for (const did of deps) {
        const d = this.parts.get(did);
        if (!d || d.locked) continue;
        seen.add(did);
        const old = d.pose.slice();
        d.pose = mMul(delta, d.pose);
        const mates = this.mates.filter((m) => m.enabled !== false && m.b.part === did);
        const res = solvePart(this.solveCtx(), did, mates);
        d.pose = res.pose;
        this.viewer.setPose(did, d.pose);
        queue.push([did, mMul(d.pose, mInvRigid(old))]);
      }
    }
  }

  addMate(m) {
    this.snapshot();
    m.id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    m.enabled = true;
    m.auto = false;
    m.priority = 6;
    this.mates.push(m);
    const p = this.parts.get(m.b.part);
    if (p.status === 'unplaced' || p.status === 'manual') p.status = 'placed';
    this.solve(m.b.part, false);
    this.render();
  }

  updateMate(id, patch) {
    const m = this.mates.find((x) => x.id === id);
    if (!m) return;
    this.snapshot();
    Object.assign(m, patch);
    this.solve(m.b.part, false);
    this.render();
  }

  deleteMate(id) {
    this.snapshot();
    this.mates = this.mates.filter((m) => m.id !== id);
    this.render();
  }

  mateErr(m) {
    return mateError(this.solveCtx(), m);
  }

  /** rotate a part about a world axis line (used for free hinge angles) */
  rotatePart(id, axis, angleDeg, point) {
    const p = this.parts.get(id);
    if (!p) return;
    this.snapshot();
    const old = p.pose.slice();
    p.pose = mMul(mAxisAngle(axis, rad(angleDeg), point), p.pose);
    this.viewer.setPose(id, p.pose);
    this.propagate(id, mMul(p.pose, mInvRigid(old)));
    this.render();
  }

  translatePart(id, v) {
    const p = this.parts.get(id);
    if (!p) return;
    this.snapshot();
    const old = p.pose.slice();
    p.pose = mMul(mTranslation(v), p.pose);
    if (p.status === 'unplaced') p.status = 'manual';
    this.viewer.setPose(id, p.pose);
    this.propagate(id, mMul(p.pose, mInvRigid(old)));
    this.render();
  }

  /** the free rotation axis of a part (e.g. a hinge on a single bore) if it has exactly one */
  freeAxisOf(id) {
    const p = this.parts.get(id);
    if (!p || !p.an) return null;
    const mates = this.mates.filter((m) => m.enabled !== false && m.b.part === id);
    if (!mates.length) return null;
    const res = solvePart(this.solveCtx(), id, mates, { iters: 0 });
    if (res.freeDOF.rot.length !== 1) return null;
    const { axis, point } = res.freeDOF.rot[0];
    // prefer the exact bore axis of a coaxial mate when it matches
    for (const m of mates) {
      if (m.type !== 'coaxial') continue;
      const a = this.parts.get(m.a.part);
      const f = a && worldFeature(a.an, m.a.f, a.pose);
      if (f && Math.abs(dot(f.a, axis)) > 0.995) return { axis: f.a, point: f.c, mate: m, slide: res.freeDOF.trans.length > 0 };
    }
    return { axis, point, mate: null, slide: res.freeDOF.trans.length > 0 };
  }

  setGizmo(mode) {
    this.gizmoMode = mode;
    this.viewer.attachGizmo(mode && this.sel ? this.sel : null, mode || 'translate');
    this.renderInspector();
  }

  // ========================================================== assembly ops
  /** rotate the assembly so its dominant flat faces line up with the world axes, largest face down */
  squareToGrid(record = true) {
    const bins = [];
    let biggest = null;
    for (const p of this.parts.values()) {
      if (!p.an || !p.include || p.status === 'unplaced' || p.status === 'analyzing') continue;
      if (p.status === 'version' && !this.isKept(p.id)) continue;
      for (const pl of p.an.planes) {
        const n = mDir(p.pose, pl.n);
        let b = bins.find((x) => Math.abs(dot(x.n, n)) > 0.9995);
        if (!b) bins.push((b = { n, area: 0 }));
        b.area += pl.area;
        if (!biggest || pl.area > biggest.area) biggest = { area: pl.area, n };
      }
    }
    if (!bins.length) return;
    bins.sort((a, b) => b.area - a.area);
    const d1 = bins[0].n;
    const b2 = bins.find((b) => Math.abs(dot(b.n, d1)) < 0.02);
    // largest single face points down
    let z = scale(d1, Math.abs(dot(biggest.n, d1)) > 0.9 ? -Math.sign(dot(biggest.n, d1)) : 1);
    let x = b2 ? norm(reject(b2.n, z)) : norm(reject(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], z));
    const y = cross(z, x);
    // R maps (x, y, z) -> world X, Y, Z
    const R = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1];
    this.transformAll(R, record);
    this.dropToBed(false);
  }

  transformAll(M, record = true) {
    if (record) this.snapshot();
    for (const p of this.parts.values()) {
      p.pose = mMul(M, p.pose);
      if (p.alternatives) p.alternatives = p.alternatives.map((a) => ({ ...a, W: mMul(M, a.W) }));
      this.viewer.setPose(p.id, p.pose);
    }
    this.viewer.setExplode(this.viewer.explode);
    this.viewer.fit();
    this.render();
  }

  rotateAssembly(axisIdx, angle = 90) {
    const box = this.viewer.bounds();
    const c = box.isEmpty() ? [0, 0, 0] : box.getCenter(new (box.min.constructor)()).toArray();
    const ax = [0, 0, 0];
    ax[axisIdx] = 1;
    this.transformAll(mAxisAngle(ax, rad(angle), c));
  }

  dropToBed(record = true) {
    const ids = Array.from(this.parts.values()).filter((p) => p.status !== 'unplaced').map((p) => p.id);
    const box = this.viewer.bounds(ids.length ? ids : null);
    if (box.isEmpty()) return;
    const c = box.getCenter(new (box.min.constructor)());
    this.transformAll(mTranslation([-Math.round(c.x), -Math.round(c.y), -box.min.z]), record);
  }

  // ======================================================= viewport picks
  featureAt(hit) {
    if (!hit) return null;
    const p = this.parts.get(hit.id);
    if (!p || !p.an) return { part: hit.id, f: null, point: hit.point };
    const c = p.an.triCyl[hit.tri], pl = p.an.triPlane[hit.tri];
    const f = c >= 0 ? 'c' + c : pl >= 0 ? 'p' + pl : null;
    return { part: hit.id, f, point: hit.point };
  }

  featureTris(part, f) {
    const key = part.base + '|' + (part.instanceOf || '') + '|' + f;
    const base = part.instanceOf ? this.parts.get(part.instanceOf) : part;
    const ck = base.id + '|' + f;
    if (this.featCache.has(ck)) return this.featCache.get(ck);
    const arr = f[0] === 'c' ? base.an.triCyl : base.an.triPlane;
    const target = +f.slice(1);
    const out = [];
    if (f[0] === 'c' || f[0] === 'p') {
      for (let i = 0; i < arr.length; i++) if (arr[i] === target) out.push(i);
    } else if (f[0] === 's') {
      const pr = base.an.pairs[target];
      for (let i = 0; i < base.an.triPlane.length; i++) if (base.an.triPlane[i] === pr.i || base.an.triPlane[i] === pr.j) out.push(i);
    } else if (f[0] === 'r') {
      const r = base.an.rects[target];
      const planes = new Set();
      for (const pi of r.pairs) {
        planes.add(base.an.pairs[pi].i);
        planes.add(base.an.pairs[pi].j);
      }
      for (let i = 0; i < base.an.triPlane.length; i++) if (planes.has(base.an.triPlane[i])) out.push(i);
    }
    this.featCache.set(ck, out);
    void key;
    return out;
  }

  highlightFeature(partId, f, kind = 'hover', colorHex = 0xffb020) {
    const p = this.parts.get(partId);
    if (!p || !f) return this.viewer.overlay(kind, null);
    this.viewer.overlay(kind, partId, this.featureTris(p, f), colorHex);
  }

  setHover(h) {
    this.hover = h;
    const tip = $('#hover-tip');
    if (!h) {
      this.viewer.overlay('hover', null);
      tip.hidden = true;
      return;
    }
    if (this.mode === 'select') this.viewer.overlay('hover', null);
    else this.highlightFeature(h.part, h.f, 'hover');
  }

  onHover(e) {
    if (this.viewer.gizmo.dragging) return;
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = null;
      const h = this.featureAt(this.viewer.pick(e.clientX, e.clientY));
      const same = this.hover && h && this.hover.part === h.part && this.hover.f === h.f;
      if (!same) this.setHover(h);
      const tip = $('#hover-tip');
      if (h && (this.mode !== 'select' || e.altKey)) {
        const p = this.parts.get(h.part);
        tip.textContent = `${p.name}${h.f ? ' · ' + featureLabel(p, h.f) : ''}`;
        const r = $('#viewport').getBoundingClientRect();
        tip.style.left = e.clientX - r.left + 14 + 'px';
        tip.style.top = e.clientY - r.top + 12 + 'px';
        tip.hidden = false;
      } else tip.hidden = true;
    });
  }

  onClick(e) {
    const hit = this.viewer.pick(e.clientX, e.clientY);
    const h = this.featureAt(hit);
    if (this.mode === 'mate') return this.matePick(h, e);
    if (this.mode === 'measure') return this.measurePick(h);
    if (this.mode === 'face-down') return this.faceDownPick(h);
    this.select(h ? h.part : null);
  }

  setMode(mode) {
    this.mode = mode;
    this.mateA = null;
    this.measureSel = [];
    $('#mate-pop').hidden = true;
    $('#btn-mate').classList.toggle('active', mode === 'mate');
    $('#btn-measure').classList.toggle('active', mode === 'measure');
    this.viewer.overlay('sel', null);
    this.viewer.clearMarks();
    const banner = $('#banner');
    if (mode === 'mate') {
      banner.innerHTML = '<b>Mate:</b> click a bore, peg or face on the part you want to <b>move</b>. Esc to cancel.';
      banner.hidden = false;
    } else if (mode === 'measure') {
      banner.innerHTML = '<b>Measure:</b> click a feature for its size, or two features for distance/angle. Esc to finish.';
      banner.hidden = false;
    } else if (mode === 'face-down') {
      banner.innerHTML = '<b>Lay flat:</b> click a face – the whole assembly is rotated so that face points down.';
      banner.hidden = false;
    } else banner.hidden = true;
  }

  matePick(h, e) {
    if (!h || !h.f) return;
    if (!this.mateA) {
      this.mateA = h;
      this.highlightFeature(h.part, h.f, 'sel', 0x4f9dff);
      $('#banner').innerHTML = `<b>Mate:</b> moving <b>${this.parts.get(h.part).name}</b> · ${featureLabel(this.parts.get(h.part), h.f)}. Now click the feature to mate it <b>to</b> (on another part).`;
      return;
    }
    if (h.part === this.mateA.part) {
      this.mateA = h;
      this.highlightFeature(h.part, h.f, 'sel', 0x4f9dff);
      return;
    }
    this.showMatePopup(this.mateA, h, e);
  }

  /** suggest mate types for feature pair (moving b, reference a) */
  mateOptions(b, a) {
    const pb = this.parts.get(b.part), pa = this.parts.get(a.part);
    const fb = getFeature(pb.an, b.f), fa = getFeature(pa.an, a.f);
    const opts = [];
    const pairOf = (p, pl) => {
      const id = +pl.slice(1);
      const cand = p.an.pairs.filter((x) => x.i === id || x.j === id).sort((x, y) => x.width - y.width);
      return cand[0] ? 's' + cand[0].id : null;
    };
    if (fb.kind === 'cyl' && fa.kind === 'cyl') {
      opts.push({ type: 'coaxial', label: 'Coaxial', a: a.f, b: b.f });
      opts.push({ type: 'coaxial', label: 'Coaxial (fixed orientation)', a: a.f, b: b.f, orient: true });
      opts.push({ type: 'coaxial', label: 'Coaxial (flipped)', a: a.f, b: b.f, orient: true, flip: true });
    } else if (fb.kind === 'plane' && fa.kind === 'plane') {
      opts.push({ type: 'contact', label: 'Contact (touching)', a: a.f, b: b.f });
      opts.push({ type: 'flush', label: 'Flush (coplanar)', a: a.f, b: b.f });
      opts.push({ type: 'parallel', label: 'Parallel only', a: a.f, b: b.f });
      const sa = pairOf(pa, a.f), sb = pairOf(pb, b.f);
      if (sa && sb) opts.push({ type: 'centered', label: 'Centered (even gap)', a: sa, b: sb });
    } else {
      const cyl = fb.kind === 'cyl' ? b : a, pl = fb.kind === 'cyl' ? a : b;
      const cylPart = this.parts.get(cyl.part), plPart = this.parts.get(pl.part);
      opts.push({ type: 'parallel', label: 'Axis ⟂ face', a: a.f, b: b.f });
      const sp = pairOf(plPart, pl.f);
      if (sp) opts.push({ type: 'axisInPlane', label: 'Axis on mid-plane', a: a.part === pl.part ? sp : a.f, b: b.part === pl.part ? sp : b.f });
      void cylPart;
    }
    return opts;
  }

  showMatePopup(b, a, e) {
    const pop = $('#mate-pop');
    const pb = this.parts.get(b.part), pa = this.parts.get(a.part);
    const opts = this.mateOptions(b, a);
    this.highlightFeature(a.part, a.f, 'hover', 0x5ad18a);
    pop.innerHTML = `<h4>Mate ${pb.name} → ${pa.name}</h4>
      <div class="hint">${featureLabel(pb, b.f)} ↔ ${featureLabel(pa, a.f)}</div>
      <div class="opts">${opts.map((o, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}">${o.label}</button>`).join('')}</div>
      <div class="row">Offset <input id="mp-off" type="number" step="0.05" value="0"> mm</div>
      <div class="row"><button id="mp-ok" class="primary">Apply</button><button id="mp-cancel">Cancel</button></div>`;
    const r = $('#viewport').getBoundingClientRect();
    pop.style.left = Math.min(r.width - 300, e.clientX - r.left + 10) + 'px';
    pop.style.top = Math.min(r.height - 200, e.clientY - r.top + 10) + 'px';
    pop.hidden = false;
    let sel = 0;
    pop.querySelectorAll('.opts button').forEach((btn) => {
      btn.onclick = () => {
        sel = +btn.dataset.i;
        pop.querySelectorAll('.opts button').forEach((x) => x.classList.toggle('active', x === btn));
      };
    });
    pop.querySelector('#mp-cancel').onclick = () => this.setMode('select');
    pop.querySelector('#mp-ok').onclick = () => {
      const o = opts[sel];
      const m = { type: o.type, a: { part: a.part, f: o.a }, b: { part: b.part, f: o.b }, offset: +pop.querySelector('#mp-off').value || 0 };
      if (o.orient) m.orient = true;
      if (o.flip) m.flip = true;
      this.setMode('select');
      this.addMate(m);
      this.select(b.part);
      this.status(`Added ${MATE_TYPES[m.type]?.label || m.type} mate.`);
    };
  }

  measurePick(h) {
    if (!h) return;
    this.measureSel = (this.measureSel || []).concat([h]).slice(-2);
    this.viewer.clearMarks();
    const items = this.measureSel.map((x) => {
      const p = this.parts.get(x.part);
      return { ...x, p, w: x.f ? worldFeature(p.an, x.f, p.pose) : null };
    });
    items.forEach((it, i) => it.f && this.highlightFeature(it.part, it.f, i ? 'hover' : 'sel', i ? 0x5ad18a : 0x4f9dff));
    const lines = [];
    const desc = (it) => {
      if (!it.w) return `point (${it.point.map((v) => v.toFixed(2)).join(', ')})`;
      return featureLabel(it.p, it.f, true);
    };
    lines.push(`<b>${items[0].p.name}</b>: ${desc(items[0])}`);
    if (items[1]) {
      lines.push(`<b>${items[1].p.name}</b>: ${desc(items[1])}`);
      const r = measureBetween(items[0], items[1]);
      lines.push(...r.text);
      if (r.line) this.viewer.markLine(r.line[0], r.line[1]);
    }
    this.measureText = lines.join('<br>');
    this.renderInspector();
  }

  faceDownPick(h) {
    if (!h || !h.f || h.f[0] !== 'p') return;
    const p = this.parts.get(h.part);
    const f = worldFeature(p.an, h.f, p.pose);
    const R = mAlign(f.n, [0, 0, -1]);
    this.setMode('select');
    this.transformAll(R);
    this.dropToBed();
  }

  // ============================================================ section
  toggleSection() {
    this.sectionOn = !this.sectionOn;
    $('#btn-section').classList.toggle('active', this.sectionOn);
    $('#section-ctl').hidden = !this.sectionOn;
    this.updateSection();
  }

  updateSection() {
    this.viewer.setSection(this.sectionOn, +$('#sec-axis').value, +$('#sec-pos').value / 1000, !!this.secFlip);
  }

  // ========================================================= interference
  async checkInterference() {
    const poses = {};
    for (const p of this.parts.values()) if (p.include && p.visible && p.an && p.status !== 'unplaced') poses[p.id] = p.pose;
    this.status('Checking collisions…');
    const list = await this.hub.interference(poses, { match: this.matchOptions() });
    this.collisions = list;
    this.status(list.length ? `${list.length} intersecting pair${list.length > 1 ? 's' : ''} found – see the inspector.` : 'No intersecting parts found.');
    this.select(null);
  }

  // ============================================================== export
  exportBodies(includeHidden) {
    const bodies = [];
    const used = new Set();
    for (const id of this.order) {
      const p = this.parts.get(id);
      if (!p || !p.include || (!p.visible && !includeHidden)) continue;
      if (!this.isKept(id)) continue;
      let name = p.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
      let n = name, k = 2;
      while (used.has(n)) n = `${name}_${k++}`;
      used.add(n);
      bodies.push({ name: n, pose: p.pose, positions: p.positions });
    }
    return bodies;
  }

  async exportAs(kind) {
    if (kind === 'project') return this.saveProject(false);
    if (kind === 'project-zip') return this.saveProject(true);
    const raw = this.exportBodies($('#exp-hidden').checked);
    if (!raw.length) return this.status('Nothing to export.');
    let dz = 0;
    if ($('#exp-drop').checked) {
      let minz = Infinity;
      for (const b of raw) {
        const P = b.pose, pos = b.positions;
        for (let i = 0; i < pos.length; i += 3) {
          const z = P[2] * pos[i] + P[6] * pos[i + 1] + P[10] * pos[i + 2] + P[14];
          if (z < minz) minz = z;
        }
      }
      dz = isFinite(minz) ? -minz : 0;
    }
    const bodies = raw.map((b) => ({ name: b.name, positions: transformSoup(b.positions, b.pose, dz) }));
    this.status(`Exporting ${bodies.length} bodies…`);
    await exportBodies(kind, bodies, this.assemblyName);
    this.status(`Exported ${bodies.length} bodies as ${kind.startsWith('3mf') ? '3MF' : kind === 'zip' ? 'ZIP' : 'STL'}.`);
  }

  projectJSON() {
    return {
      format: 'stl-assembler-project',
      version: 1,
      name: this.assemblyName,
      root: this.root,
      parts: this.order.map((id) => {
        const p = this.parts.get(id);
        return { id, name: p.name, path: p.path, instanceOf: p.instanceOf || null, tris: p.positions.length / 9, pose: p.pose, include: p.include, visible: p.visible, locked: p.locked, status: p.status, color: p.color };
      }),
      mates: this.mates,
      groups: this.groups,
    };
  }

  async saveProject(withMeshes) {
    const j = this.projectJSON();
    const name = (this.assemblyName || 'assembly').replace(/[^\w\- .]+/g, '_');
    if (!withMeshes) return download(JSON.stringify(j, null, 1), `${name}.assembly.json`, 'application/json');
    const files = [{ name: 'project.json', data: JSON.stringify(j, null, 1) }];
    for (const p of this.baseParts()) files.push({ name: `parts/${p.id.replace(/[\\/:*?"<>|]+/g, '_')}.stl`, data: new Uint8Array(writeSTLBinary([{ positions: p.positions }])) });
    download(await zipFiles(files), `${name}.assembly.zip`, 'application/zip');
  }

  tryApplyProjects() {
    if (!this.pendingProjects.length || this.analyzing > 0) return false;
    const j = this.pendingProjects.shift();
    this.snapshot();
    const byName = new Map(this.baseParts().map((p) => [p.name, p]));
    let matched = 0;
    for (const sp of j.parts) {
      let p = this.parts.get(sp.id) || (!sp.instanceOf && byName.get(sp.name));
      if (!p && sp.instanceOf) {
        const base = this.parts.get(sp.instanceOf);
        if (base) p = this.createInstance(base, sp.id, false);
      }
      if (!p) continue;
      matched++;
      p.pose = sp.pose;
      p.include = sp.include;
      p.locked = sp.locked;
      p.status = sp.status === 'analyzing' ? 'unplaced' : sp.status;
      p.visible = sp.visible !== false;
      this.viewer.setPose(p.id, p.pose);
      this.viewer.setVisible(p.id, p.visible);
    }
    this.mates = (j.mates || []).filter((m) => this.parts.has(m.a.part) && this.parts.has(m.b.part));
    this.groups = (j.groups || []).filter((g) => g.members.every((m) => this.parts.has(m)));
    this.root = j.root && this.parts.has(j.root) ? j.root : this.root;
    if (j.name) this.assemblyName = j.name;
    for (const p of this.parts.values()) this.viewer.setStyle(p.id, this.styleFor(p.id, p.id === this.sel));
    this.viewer.fit();
    this.render();
    this.status(`Project restored: ${matched}/${j.parts.length} parts matched.`);
    return true;
  }

  // =========================================================== undo/redo
  state() {
    return {
      parts: this.order.map((id) => {
        const p = this.parts.get(id);
        return { id, pose: p.pose.slice(), include: p.include, visible: p.visible, status: p.status, locked: p.locked, instanceOf: p.instanceOf || null, autoInstance: !!p.autoInstance, alternatives: p.alternatives, altIndex: p.altIndex, freeDOF: p.freeDOF };
      }),
      mates: clone(this.mates),
      groups: clone(this.groups),
      root: this.root,
    };
  }

  restore(s) {
    const ids = new Set(s.parts.map((x) => x.id));
    for (const p of Array.from(this.parts.values())) if (p.instanceOf && !ids.has(p.id)) this.removePart(p.id, false);
    for (const sp of s.parts) {
      let p = this.parts.get(sp.id);
      if (!p && sp.instanceOf) {
        const base = this.parts.get(sp.instanceOf);
        if (!base) continue;
        p = this.createInstance(base, sp.id, sp.autoInstance);
      }
      if (!p) continue;
      Object.assign(p, { pose: sp.pose, include: sp.include, visible: sp.visible, status: sp.status, locked: sp.locked, alternatives: sp.alternatives, altIndex: sp.altIndex, freeDOF: sp.freeDOF });
      this.viewer.setPose(p.id, p.pose);
      this.viewer.setVisible(p.id, p.visible);
    }
    this.order = s.parts.map((x) => x.id).filter((id) => this.parts.has(id));
    for (const id of this.parts.keys()) if (!this.order.includes(id)) this.order.push(id);
    this.mates = s.mates;
    this.groups = s.groups;
    this.root = s.root;
    for (const p of this.parts.values()) this.viewer.setStyle(p.id, this.styleFor(p.id, p.id === this.sel));
    this.render();
  }

  snapshot() {
    this.undoStack.push(this.state());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.state());
    this.restore(this.undoStack.pop());
    this.updateUndoButtons();
    this.status('Undone.');
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.state());
    this.restore(this.redoStack.pop());
    this.updateUndoButtons();
    this.status('Redone.');
  }

  updateUndoButtons() {
    $('#btn-undo').disabled = !this.undoStack.length;
    $('#btn-redo').disabled = !this.redoStack.length;
  }

  // ============================================================ modals
  showModal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  }

  showSettings() {
    const s = this.settings;
    const row = (k, label, help, step = 0.05) => `<div class="setting"><label>${label}<small>${help}</small></label><input type="number" step="${step}" data-k="${k}" value="${s[k]}"></div>`;
    const chk = (k, label, help) => `<div class="setting"><label>${label}<small>${help}</small></label><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}></div>`;
    this.showModal(`<h2>Settings</h2>
      ${chk('autoAssembleOnLoad', 'Auto-assemble after loading', 'Run the solver as soon as all dropped parts are analysed.')}
      ${chk('autoInstances', 'Copies from file names', 'Files named like <i>pin_x4.stl</i> or <i>foot (4x).stl</i> are placed 4 times.')}
      ${chk('squareToGrid', 'Square assembly to the grid', 'After auto-assembly, rotate everything so the main flat faces align with X/Y/Z and the biggest face sits on the bed.')}
      <h3>Fit tolerances (mm)</h3>
      ${row('contactTol', 'Contact distance', 'Surfaces closer than this count as touching. Should exceed your print clearance.')}
      ${row('maxClearance', 'Max peg/hole clearance', 'Largest radial gap for a peg to be considered fitting a hole.')}
      ${row('slotClearance', 'Max tab/slot clearance', 'Largest total gap for a tab to be centred in a slot.')}
      ${row('penTol', 'Allowed interference', 'Overlap below this is tolerated (press fits, tessellation).')}
      ${row('stackGap', 'Screw hole gap', 'Max gap between two coaxial holes that a screw can bridge.', 0.5)}
      <div class="btnrow"><button id="set-reset">Reset defaults</button> <button id="set-theme">Toggle light/dark</button></div>
      <p class="hint">Changing tolerances re-runs matching on the next Auto-assemble.</p>`);
    const save = () => {
      for (const el of document.querySelectorAll('#modal-body [data-k]')) s[el.dataset.k] = el.type === 'checkbox' ? el.checked : +el.value;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      } catch {
        /* storage unavailable */
      }
    };
    for (const el of document.querySelectorAll('#modal-body [data-k]')) el.onchange = save;
    $('#set-reset').onclick = () => {
      Object.assign(s, DEFAULT_SETTINGS);
      save();
      this.showSettings();
    };
    $('#set-theme').onclick = () => {
      const cur = document.documentElement.dataset.theme;
      const dark = cur ? cur === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    };
  }

  showHelp() {
    this.showModal(`<h2>STL Assembler – quick guide</h2>
      <ol>
        <li><b>Drop</b> a folder, a .zip or a set of STL/OBJ/3MF files anywhere.</li>
        <li>Every part is analysed for <b>bores, pegs, D-shafts, slots/tabs, rectangular holes/pegs and flat faces</b>. Press <kbd>Axes</kbd> to see detected bore axes (orange = hole, green = peg).</li>
        <li><b>Auto-assemble</b> (<kbd>A</kbd>) mates parts by matching features (two bores ↔ two pegs, rect peg ↔ rect hole, split faces with matching outlines, a bore + rotation search, tabs centred in slots) and scores each pose by contact versus collision.</li>
        <li>Parts with several plausible poses are marked <span class="chip ambiguous">review</span>. Press <kbd>R</kbd> to step through them; hover options to preview, click to apply, <kbd>[</kbd> <kbd>]</kbd> to cycle, <kbd>Enter</kbd> to accept.</li>
        <li>Duplicate <b>versions</b> of a part are stacked in place. Pick which one to keep in the parts list; the others are excluded from export.</li>
        <li><b>Mate</b> (<kbd>M</kbd>): click a feature on the part to move, then the feature to mate it to. Choose coaxial, contact, flush, centred (even gap), parallel, with an optional offset.</li>
        <li>Hinged parts (one bore + mid-plane) keep a <b>free angle</b>: set it in the inspector.</li>
        <li><b>Offsets</b>: move any part by an exact amount, or give any mate an offset in mm.</li>
        <li><b>Export</b> one STL with multiple bodies (each part stays a separate shell, so slicers and tools like Goop can split it), ASCII STL with named solids, or 3MF.</li>
      </ol>
      <p><b>Keys:</b> <kbd>A</kbd> auto · <kbd>R</kbd> review · <kbd>M</kbd> mate · <kbd>D</kbd> measure · <kbd>F</kbd> fit · <kbd>G</kbd> move gizmo · <kbd>T</kbd> rotate gizmo · <kbd>H</kbd> hide · <kbd>I</kbd> isolate · <kbd>Del</kbd> exclude · <kbd>⌘Z</kbd>/<kbd>⌘⇧Z</kbd> undo/redo · double-click to zoom to a part.</p>
      <p class="hint">Everything runs locally in your browser; files never leave your Mac.</p>`);
  }

  async loadDemo() {
    const kit = DEMO_KITS[this._demoIdx = ((this._demoIdx ?? -1) + 1) % DEMO_KITS.length];
    const files = kit.files.map((f) => {
      const bin = atob(f.data);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { name: f.name, path: kit.name + '/' + f.name, file: new File([u8], f.name) };
    });
    this.assemblyName = kit.name;
    await this.addInputs(files);
  }

  // =============================================================== render
  status(msg) {
    $('#status-text').textContent = msg;
  }

  progress(f) {
    const el = $('#progress');
    if (f == null) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    $('#progress-bar').style.width = Math.round(f * 100) + '%';
  }

  render() {
    this.renderParts();
    this.renderInspector();
    this.updateUndoButtons();
  }

  renderParts() {
    renderParts(this);
    renderSummary(this);
    const c = this.counts();
    const rc = $('#review-count');
    rc.textContent = c.ambiguous;
    rc.classList.toggle('zero', !c.ambiguous);
    $('#part-count').textContent = this.parts.size ? `(${this.parts.size})` : '';
    $('#drop-hint').hidden = this.parts.size > 0;
  }

  renderInspector() {
    renderInspector(this);
  }
}

// ---------------------------------------------------------------- measure
function measureBetween(i1, i2) {
  const text = [];
  const w1 = i1.w, w2 = i2.w;
  const pt = (it) => (it.w ? (it.w.kind === 'cyl' ? it.w.c : it.w.kind === 'plane' ? it.w.c : it.point) : it.point);
  let line = [pt(i1), pt(i2)];
  if (w1 && w2 && w1.kind === 'plane' && w2.kind === 'plane') {
    const ang = deg(Math.acos(Math.min(1, Math.abs(dot(w1.n, w2.n)))));
    text.push(`Angle between faces: <b>${ang.toFixed(2)}°</b>`);
    if (ang < 1) {
      const d = dot(sub(w2.c, w1.c), w1.n);
      text.push(`Gap (perpendicular): <b>${Math.abs(d).toFixed(3)} mm</b>`);
      line = [w2.c, sub(w2.c, scale(w1.n, d))];
    }
  } else if (w1 && w2 && w1.kind === 'cyl' && w2.kind === 'cyl') {
    const ang = deg(Math.acos(Math.min(1, Math.abs(dot(w1.a, w2.a)))));
    text.push(`Angle between axes: <b>${ang.toFixed(2)}°</b>`);
    if (ang < 1) {
      const d = reject(sub(w2.c, w1.c), w1.a);
      text.push(`Axis distance: <b>${len(d).toFixed(3)} mm</b>`);
      text.push(`Diameter difference: <b>${(2 * (w1.r - w2.r)).toFixed(3)} mm</b> (radial clearance ${Math.abs(w1.r - w2.r).toFixed(3)})`);
      line = [w2.c, sub(w2.c, d)];
    } else {
      const n = norm(cross(w1.a, w2.a));
      text.push(`Closest distance between axes: <b>${Math.abs(dot(sub(w2.c, w1.c), n)).toFixed(3)} mm</b>`);
    }
  } else if (w1 && w2 && (w1.kind === 'cyl') !== (w2.kind === 'cyl') && (w1.kind === 'plane' || w2.kind === 'plane')) {
    const c = w1.kind === 'cyl' ? w1 : w2, p = w1.kind === 'plane' ? w1 : w2;
    const ang = deg(Math.acos(Math.min(1, Math.abs(dot(c.a, p.n)))));
    text.push(`Axis to face normal: <b>${ang.toFixed(2)}°</b>`);
    const d = dot(sub(c.c, p.c), p.n);
    text.push(`Axis centre to face: <b>${Math.abs(d).toFixed(3)} mm</b>`);
    line = [c.c, sub(c.c, scale(p.n, d))];
  }
  text.push(`Point distance: <b>${dist(line[0], line[1]).toFixed(3)} mm</b>`);
  return { text, line };
}

export { measureBetween };
