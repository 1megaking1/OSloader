// DOM rendering for the parts list and the inspector panel.

import { getFeature, MATE_TYPES } from '../core/solver.js';
import { rad, deg } from '../core/math.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (x) => (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2));

const SOURCE = {
  'aligned bores': 'bores (square to the axes)',
  'matching faces': 'same-shape faces',
  'bore-pair': 'two bores/pegs',
  'bore+angle': 'bore + rotation search',
  rect: 'rectangular peg/hole',
  face: 'matching faces',
};

const CHIP = {
  analyzing: 'analysing…',
  unplaced: 'not placed',
  placed: 'placed',
  ambiguous: 'review',
  root: 'base',
  locked: 'locked',
  version: 'version',
  manual: 'manual',
  error: 'error',
};

export function featureLabel(part, f, long = false) {
  if (!f || !part.an) return 'surface';
  if (f.startsWith('e:')) {
    const g = getFeature(part.an, f);
    return `edge ${f2(g.len)} mm`;
  }
  if (f.includes('+')) {
    const g = getFeature(part.an, f);
    return g ? `mid-plane of 2 faces (${f2(g.width)} mm apart)` : 'mid-plane';
  }
  const g = getFeature(part.an, f);
  if (!g) return f;
  if (g.kind === 'cyl') {
    const what = (g.src === 'user' ? 'marked ' : '') + (g.cone ? (g.countersink ? 'countersink' : 'tapered ') : '') + (g.countersink ? '' : g.concave ? 'hole' : 'peg');
    const partial = g.full ? '' : g.span > rad(240) ? ' (D/partial)' : ` (${Math.round(deg(g.span))}° arc)`;
    return `Ø${f2(2 * g.r)} ${what}${partial}${long ? `, length ${f2(g.len)} mm` : ''}`;
  }
  if (g.kind === 'plane') return `face ${f2(g.area)} mm²${long ? `, normal (${g.n.map((v) => v.toFixed(2)).join(', ')})` : ''}`;
  if (g.kind === 'pair') return `${g.concave ? 'slot' : 'tab'} ${f2(g.width)} mm`;
  if (g.kind === 'rect') return `rect ${g.concave ? 'hole' : 'peg'} ${f2(g.w1)}×${f2(g.w2)}`;
  return f;
}

export function mateLabel(app, m) {
  const pa = app.parts.get(m.a.part), pb = app.parts.get(m.b.part);
  const t = MATE_TYPES[m.type]?.label || m.type;
  return { title: t + (m.kind === 'insert' ? ' (peg in hole)' : m.kind === 'stack' ? ' (aligned holes)' : ''), detail: `${pb ? featureLabel(pb, m.b.f) : '?'} → ${pa ? esc(pa.name) : '?'} · ${pa ? featureLabel(pa, m.a.f) : '?'}` };
}

// ------------------------------------------------------------ parts list
export function renderParts(app) {
  const el = $('#parts');
  const filter = ($('#part-filter').value || '').toLowerCase();
  const rows = [];
  const inGroup = new Set();
  app.groups.forEach((g) => g.members.forEach((m) => inGroup.add(m)));
  const row = (p, extra = '') => {
    const st = p.status;
    const cls = ['prow', p.id === app.sel ? 'sel' : '', p.include ? '' : 'excluded', p.visible ? '' : 'hiddenp', extra].join(' ');
    const lock = p.locked ? '🔒' : '';
    const qty = !p.instanceOf && p.qty > 1 ? ` <span class="muted">×${p.qty}</span>` : '';
    return `<div class="${cls}" data-id="${esc(p.id)}" title="${esc(p.path || p.name)}${p.error ? '\n' + esc(p.error) : ''}">
      <span class="dot" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}${qty}</span>${lock}
      <span class="chip ${st}">${CHIP[st] || st}</span>
      <span class="icon" data-act="vis" title="Show/hide (H)">${p.visible ? '👁' : '◌'}</span>
    </div>`;
  };
  const match = (p) => !filter || p.name.toLowerCase().includes(filter);
  const done = new Set();
  for (const id of app.order) {
    const p = app.parts.get(id);
    if (!p || done.has(id)) continue;
    if (p.instanceOf && !done.has(p.instanceOf)) continue;
    const gi = app.groups.findIndex((g) => g.members.includes(id));
    if (gi >= 0) {
      const g = app.groups[gi];
      const members = g.members.map((m) => app.parts.get(m)).filter(Boolean);
      members.forEach((m) => done.add(m.id));
      if (!members.some(match)) continue;
      rows.push(`<div class="vgroup"><div class="vhead"><span>versions – keep one</span><button class="link small" data-ungroup="${gi}">ungroup</button></div>`);
      for (const m of members) {
        rows.push(row(m).replace('<span class="dot"', `<input type="radio" name="keep${gi}" data-keep="${gi}" value="${esc(m.id)}" ${g.keep === m.id ? 'checked' : ''} title="Keep this version"><span class="dot"`));
        for (const iid of app.order) {
          const ip = app.parts.get(iid);
          if (ip?.instanceOf === m.id) {
            done.add(iid);
            rows.push(row(ip, 'indent'));
          }
        }
      }
      rows.push('</div>');
      continue;
    }
    done.add(id);
    if (match(p)) rows.push(row(p));
    for (const iid of app.order) {
      const ip = app.parts.get(iid);
      if (ip?.instanceOf === id && !done.has(iid)) {
        done.add(iid);
        if (match(ip) || match(p)) rows.push(row(ip, 'indent'));
      }
    }
  }
  el.innerHTML = rows.join('') || '<div class="hint" style="padding:10px">No parts yet.</div>';
  el.querySelectorAll('.prow').forEach((r) => {
    r.onclick = (e) => {
      const id = r.dataset.id;
      if (e.target.dataset.act === 'vis') {
        e.stopPropagation();
        app.setVisible(id, !app.parts.get(id).visible);
        return;
      }
      if (e.target.dataset.keep != null) return;
      app.select(id);
    };
    r.ondblclick = () => app.viewer.fit([r.dataset.id]);
  });
  el.querySelectorAll('[data-keep]').forEach((inp) => {
    inp.onchange = () => app.setKeep(+inp.dataset.keep, inp.value);
  });
  el.querySelectorAll('[data-ungroup]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      app.ungroup(+b.dataset.ungroup);
    };
  });
}

export function renderSummary(app) {
  const c = app.counts();
  if (!c.total) {
    $('#summary').innerHTML = 'Drop files to begin.';
    return;
  }
  $('#summary').innerHTML = `<span style="color:var(--ok)">● ${c.placed} placed</span> · <span style="color:var(--warn)">● ${c.ambiguous} review</span> · <span style="color:var(--bad)">● ${c.unplaced} not placed</span>${c.version ? ` · <span style="color:var(--ver)">● ${c.version} versions</span>` : ''}
    <div class="btnrow"><button class="small" id="sum-show">Show all</button><button class="small" id="sum-unplaced">Auto-place unplaced</button></div>`;
  $('#sum-show').onclick = () => app.showAll();
  $('#sum-unplaced').onclick = async () => {
    for (const p of Array.from(app.parts.values())) if (p.status === 'unplaced' && p.include) await app.autoPlace(p.id);
  };
}

// --------------------------------------------------------------- inspector
export function renderInspector(app) {
  const el = $('#inspector');
  const p = app.parts.get(app.sel);
  const out = [];
  if (app.measureText && app.mode === 'measure') out.push(`<div class="sec"><h3>Measurement</h3><div>${app.measureText}</div></div>`);
  if (!p) {
    out.push(assemblySection(app));
    el.innerHTML = out.join('');
    bindAssembly(app);
    return;
  }
  const an = p.an;
  const st = an?.stats;
  const base = p.instanceOf ? app.parts.get(p.instanceOf) : p;
  out.push(`<div class="sec"><h2>${esc(p.name)}</h2>
    <div><span class="chip ${p.status}">${CHIP[p.status] || p.status}</span> ${p.id === app.root ? '<span class="chip root">base part</span>' : ''} ${p.include ? '' : '<span class="chip">excluded</span>'}</div>
    <div class="btnrow">
      <button class="small" data-a="root" title="Use as the fixed base for auto-assembly">Set as base</button>
      <button class="small ${p.locked ? 'active' : ''}" data-a="lock" title="Locked parts keep their pose during auto-assembly">${p.locked ? 'Locked' : 'Lock'}</button>
      <button class="small" data-a="include" title="Include in export (Del)">${p.include ? 'Exclude' : 'Include'}</button>
      <button class="small" data-a="isolate" title="Isolate (I)">Isolate</button>
      <button class="small" data-a="focus" title="Zoom (F)">Zoom</button>
      ${p.instanceOf ? '<button class="small" data-a="remove">Remove copy</button>' : ''}
    </div>
    ${st ? `<div class="kv" style="margin-top:8px">
      <span>Triangles</span><span>${st.tris.toLocaleString()}</span>
      <span>Size</span><span>${an.pca.dims.map((d) => d.toFixed(1)).join(' × ')} mm</span>
      <span>Volume</span><span>${(st.volume / 1000).toFixed(2)} cm³</span>
      <span>Features</span><span>${an.signature.holes} holes · ${an.signature.pegs} pegs · ${an.pairs.filter((x) => x.concave).length} slots · ${an.pairs.filter((x) => !x.concave).length} tabs · ${an.rects.length} rect</span>
      ${st.boundaryEdges ? `<span>Mesh</span><span style="color:var(--warn)">${st.boundaryEdges} open edges</span>` : ''}
    </div>` : `<div class="hint">${p.status === 'error' ? esc(p.error || 'Analysis failed') : 'Analysing…'}</div>`}
  </div>`);

  if (an) {
    // placement
    const conf = p.margin != null ? Math.round(Math.min(1, p.margin / 0.3) * 100) : null;
    let how = '';
    if (p.status === 'root') how = 'Fixed base part – everything else is placed relative to it.';
    else if (p.status === 'version') how = 'Stacked onto another version of this part. Choose which to keep in the parts list.';
    else if (p.status === 'unplaced') how = 'No confident placement found. Try <b>Auto-place</b>, pick an option below, or add mates manually.';
    else if (p.source) {
      const confTxt = conf == null ? '' : p.status === 'ambiguous' ? ' · several near-equal options – please pick one' : ` · confidence ${conf < 34 ? 'low' : conf < 67 ? 'medium' : 'high'}`;
      how = `Placed via <b>${esc(SOURCE[p.source] || p.source)}</b>${p.from ? ` on ${esc(app.parts.get(p.from)?.name || p.from)}` : ''}${confTxt}.`;
    }
    else if (p.status === 'manual') how = 'Positioned manually.';
    out.push(`<div class="sec"><h3>Placement</h3><div class="hint">${how}</div>
      <div class="btnrow"><button class="small" data-a="autoplace" title="Find placements against the parts already placed">Auto-place</button><button class="small" data-a="snap" title="Infer mates with touching neighbours and snap exactly">Snap to neighbours</button>${p.status === 'ambiguous' ? '<button class="small primary" data-a="accept">Accept (Enter)</button>' : ''}${p.alternatives?.length && p.status !== 'unplaced' && p.status !== 'root' ? '<button class="small" data-a="reject" title="None of the options is right: park the part beside the assembly (N)">None of these (N)</button>' : ''}</div>`);
    if (p.alternatives?.length) {
      const max = Math.max(...p.alternatives.map((a) => a.score), 1e-6);
      out.push(`<div style="margin-top:8px">${p.alternatives
        .map(
          (a, i) => `<div class="alt ${i === (p.altIndex ?? 0) ? 'cur' : ''}" data-alt="${i}" title="Hover to preview, click to apply">
          <span class="lbl">#${i + 1}</span><span class="bar"><i style="width:${Math.max(4, (a.score / max) * 100)}%"></i></span>
          <span class="src">${esc(SOURCE[a.source] || a.source || '')}${a.from ? ' · ' + esc(app.parts.get(a.from)?.name || a.from) : ''}</span></div>`,
        )
        .join('')}</div><div class="hint">[ ] cycles options</div>`);
    }
    out.push('</div>');

    // free motion
    const fa = app.freeAxisOf(p.id);
    if (fa) {
      out.push(`<div class="sec"><h3>Free rotation</h3><div class="hint">This part can still spin about ${fa.mate ? 'its bore axis' : 'an axis'} – set the angle you want.</div>
        <div class="btnrow"><input id="fr-ang" type="number" step="5" value="15"> ° <button class="small" data-rot="-1">⟲ −</button><button class="small" data-rot="1">⟳ +</button><button class="small" data-rot="90">+90°</button><button class="small" data-rot="180">180°</button></div></div>`);
    }

    // mates
    const mates = app.mates.filter((m) => m.b.part === p.id);
    const refs = app.mates.filter((m) => m.a.part === p.id).length;
    out.push(`<div class="sec"><h3>Mates (${mates.length})${refs ? ` <span class="muted" title="Mates on other parts that reference this one">+${refs} attached</span>` : ''}</h3>
      ${mates
        .map((m) => {
          const l = mateLabel(app, m);
          const err = app.mateErr(m);
          return `<div class="mate ${m.enabled === false ? 'off' : ''}" data-mate="${m.id}">
            <span class="mt">${esc(l.title)}${m.auto ? ' <span class="muted">auto</span>' : ''}</span>
            <span><button class="small" data-m="toggle" title="Enable/disable">${m.enabled === false ? 'off' : 'on'}</button> <button class="small" data-m="del" title="Delete mate">✕</button></span>
            <span class="md">${l.detail}${isFinite(err) && err > 0.05 ? ` <span class="err">· off by ${err.toFixed(2)}</span>` : ''}</span>
            ${['contact', 'flush', 'centered', 'midplane', 'axisInPlane'].includes(m.type) ? `<span class="mc">Offset <input type="number" step="0.05" value="${m.offset || 0}" data-m="offset"> mm</span>` : ''}
            ${m.type === 'coaxial' ? `<span class="mc"><label><input type="checkbox" data-m="orient" ${m.orient ? 'checked' : ''}> lock direction</label> <label><input type="checkbox" data-m="flip" ${m.flip ? 'checked' : ''}> flip</label></span>` : ''}
          </div>`;
        })
        .join('')}
      <div class="btnrow"><button class="small primary" data-a="addmate">+ Add mate</button><button class="small" data-a="solve">Re-solve</button>${mates.some((m) => m.auto) ? '<button class="small" data-a="clearauto">Clear auto mates</button>' : ''}</div></div>`);

    // adjust
    out.push(`<div class="sec"><h3>Move / rotate</h3>
      <div class="grid3"><input id="mv-x" type="number" step="0.1" value="0" title="X mm"><input id="mv-y" type="number" step="0.1" value="0" title="Y mm"><input id="mv-z" type="number" step="0.1" value="0" title="Z mm"><button class="small" data-a="move">Move</button></div>
      <div class="hint">Offset in mm along world X / Y / Z.</div>
      <div class="btnrow">Rotate <input id="rt-ang" type="number" step="15" value="90"> ° about <button class="small" data-rt="0">X</button><button class="small" data-rt="1">Y</button><button class="small" data-rt="2">Z</button></div>
      <div class="btnrow">Gizmo <button class="small ${app.gizmoMode === 'translate' ? 'active' : ''}" data-g="translate">Move (G)</button><button class="small ${app.gizmoMode === 'rotate' ? 'active' : ''}" data-g="rotate">Rotate (T)</button><button class="small" data-g="off">Off</button></div>
    </div>`);

    // copies & versions
    if (!p.instanceOf) {
      const copies = Array.from(app.parts.values()).filter((q) => q.instanceOf === p.id).length;
      const others = app.baseParts().filter((q) => q.id !== p.id && q.an);
      out.push(`<div class="sec"><h3>Copies &amp; versions</h3>
        <div class="btnrow">Copies in assembly: <b>${copies + 1}</b> <button class="small" data-a="addcopy" title="Add another copy and auto-place it">+ copy</button></div>
        <div class="btnrow">Stack as version of <select id="ver-of">${others.map((q) => `<option value="${esc(q.id)}">${esc(q.name)}</option>`).join('')}</select><button class="small" data-a="stack">Stack</button></div>
      </div>`);
    } else {
      out.push(`<div class="sec"><h3>Copy</h3><div class="hint">Copy of ${esc(base.name)} – shares its geometry.</div></div>`);
    }

    // features
    const feats = [];
    an.cyls.forEach((c) => c.span >= rad(150) && feats.push(['c' + c.id, featureLabel(p, 'c' + c.id)]));
    an.rects.forEach((r) => feats.push(['r' + r.id, featureLabel(p, 'r' + r.id)]));
    an.pairs.slice(0, 30).forEach((q) => feats.push(['s' + q.id, featureLabel(p, 's' + q.id)]));
    out.push(`<div class="sec"><details><summary>Detected features (${feats.length})</summary>${feats.map(([k, l]) => `<div class="feat" data-f="${k}"><span>${l}</span><span class="muted">${k}</span></div>`).join('')}</details></div>`);
  }
  el.innerHTML = out.join('');
  bindPart(app, p);
}

function assemblySection(app) {
  const c = app.counts();
  const coll = app.collisions;
  return `<div class="sec"><h3>Assembly</h3>
    ${c.total ? `<div class="kv"><span>Parts</span><span>${c.total}</span><span>Placed</span><span>${c.placed}</span><span>To review</span><span>${c.ambiguous}</span><span>Not placed</span><span>${c.unplaced}</span><span>Mates</span><span>${app.mates.length}</span></div>` : '<div class="hint">Drop STL files, a folder or a zip to start. Or try the demo kit.</div>'}
    <div class="btnrow" style="margin-top:8px">Rotate assembly <button class="small" data-ra="0">X 90°</button><button class="small" data-ra="1">Y 90°</button><button class="small" data-ra="2">Z 90°</button><button class="small" data-flip="1" title="Turn the assembly upside down">Flip</button></div>
    <div class="btnrow"><button class="small" data-a="square" title="Align the main faces with X/Y/Z, biggest face down">Square to grid</button><button class="small" data-a="facedown" title="Click a face to lay the assembly on it">Lay flat on face…</button><button class="small" data-a="drop">Drop to Z=0</button></div>
    <div class="btnrow">Name <input id="asm-name" type="text" value="${esc(app.assemblyName || '')}" style="flex:1"></div>
  </div>
  ${coll ? `<div class="sec"><h3>Collisions (${coll.length})</h3>${coll.length ? coll.map((x, i) => `<div class="feat" data-coll="${i}"><span>${esc(app.parts.get(x.a)?.name)} ↔ ${esc(app.parts.get(x.b)?.name)}</span><span class="muted">${x.penArea.toFixed(1)} mm²</span></div>`).join('') : '<div class="hint">No intersecting parts.</div>'}</div>` : ''}
  <div class="sec"><h3>Tips</h3><div class="hint">
    • Click a part to inspect it; alternatives and mates appear here.<br>
    • <b>R</b> reviews ambiguous parts, <b>[ ]</b> cycles their options.<br>
    • <b>M</b> creates a mate by clicking two features.<br>
    • Hold <b>Alt</b> while hovering to see what a feature is.</div></div>`;
}

function bindAssembly(app) {
  const el = $('#inspector');
  el.querySelectorAll('[data-ra]').forEach((b) => (b.onclick = () => app.rotateAssembly(+b.dataset.ra)));
  el.querySelectorAll('[data-flip]').forEach((b) => (b.onclick = () => {
    app.rotateAssembly(0, 180);
    app.dropToBed(false);
  }));
  const q = (s) => el.querySelector(s);
  if (q('[data-a=facedown]')) q('[data-a=facedown]').onclick = () => app.setMode('face-down');
  if (q('[data-a=drop]')) q('[data-a=drop]').onclick = () => app.dropToBed();
  if (q('[data-a=square]')) q('[data-a=square]').onclick = () => app.squareToGrid();
  if (q('#asm-name')) q('#asm-name').onchange = (e) => (app.assemblyName = e.target.value);
  el.querySelectorAll('[data-coll]').forEach((r) => {
    r.onclick = () => {
      const x = app.collisions[+r.dataset.coll];
      app.viewer.fit([x.a, x.b]);
      app.highlightFeature(x.a, null);
      app.select(x.b);
    };
  });
}

function bindPart(app, p) {
  const el = $('#inspector');
  const on = (sel, fn) => el.querySelectorAll(sel).forEach((b) => (b.onclick = (e) => fn(b, e)));
  on('[data-a]', (b) => {
    const a = b.dataset.a;
    if (a === 'root') app.setRoot(p.id);
    else if (a === 'lock') app.toggleLock(p.id);
    else if (a === 'include') app.setInclude(p.id, !p.include);
    else if (a === 'isolate') app.isolate(p.id);
    else if (a === 'focus') app.viewer.fit([p.id]);
    else if (a === 'remove') app.removePart(p.id);
    else if (a === 'autoplace') app.autoPlace(p.id);
    else if (a === 'snap') snapNow(app, p);
    else if (a === 'reject') {
      app.rejectPlacement(p.id);
      app.reviewNext();
    }
    else if (a === 'accept') {
      p.status = 'placed';
      p.reviewed = true;
      app.render();
      app.reviewNext();
    } else if (a === 'addmate') {
      app.setMode('mate');
    } else if (a === 'solve') {
      app.solve(p.id);
      app.render();
    } else if (a === 'clearauto') {
      app.snapshot();
      app.mates = app.mates.filter((m) => !(m.auto && m.b.part === p.id));
      app.render();
    } else if (a === 'move') {
      const v = ['#mv-x', '#mv-y', '#mv-z'].map((s) => +el.querySelector(s).value || 0);
      app.translatePart(p.id, v);
    } else if (a === 'addcopy') app.addCopy(p.id);
    else if (a === 'stack') {
      const onto = el.querySelector('#ver-of').value;
      if (onto) app.stackAsVersion(p.id, onto);
    }
  });
  on('[data-rt]', (b) => {
    const ax = [0, 0, 0];
    ax[+b.dataset.rt] = 1;
    const c = app.viewer.parts.get(p.id).mesh.geometry.boundingBox.getCenter(new (app.viewer.parts.get(p.id).mesh.position.constructor)()).toArray();
    const P = p.pose;
    const wc = [P[0] * c[0] + P[4] * c[1] + P[8] * c[2] + P[12], P[1] * c[0] + P[5] * c[1] + P[9] * c[2] + P[13], P[2] * c[0] + P[6] * c[1] + P[10] * c[2] + P[14]];
    app.rotatePart(p.id, ax, +el.querySelector('#rt-ang').value || 0, wc);
  });
  on('[data-rot]', (b) => {
    const fa = app.freeAxisOf(p.id);
    if (!fa) return;
    const v = +b.dataset.rot;
    const step = Math.abs(v) === 1 ? (+el.querySelector('#fr-ang').value || 0) * v : v;
    app.rotatePart(p.id, fa.axis, step, fa.point);
  });
  on('[data-g]', (b) => app.setGizmo(b.dataset.g === 'off' ? null : b.dataset.g));
  el.querySelectorAll('[data-alt]').forEach((r) => {
    const k = +r.dataset.alt;
    r.onmouseenter = () => app.previewAlternative(p.id, k);
    r.onmouseleave = () => app.viewer.clearGhosts();
    r.onclick = () => app.applyAlternative(p.id, k);
  });
  el.querySelectorAll('[data-mate]').forEach((row) => {
    const id = row.dataset.mate;
    const m = app.mates.find((x) => x.id === id);
    row.onmouseenter = () => {
      app.highlightFeature(m.a.part, m.a.f, 'hover', 0x5ad18a);
      app.highlightFeature(m.b.part, m.b.f, 'sel', 0x4f9dff);
    };
    row.onmouseleave = () => {
      app.viewer.overlay('hover', null);
      app.viewer.overlay('sel', null);
    };
    row.querySelectorAll('[data-m]').forEach((c) => {
      const k = c.dataset.m;
      if (k === 'toggle') c.onclick = () => app.updateMate(id, { enabled: m.enabled === false });
      else if (k === 'del') c.onclick = () => app.deleteMate(id);
      else if (k === 'offset') c.onchange = () => app.updateMate(id, { offset: +c.value || 0, auto: false });
      else if (k === 'orient') c.onchange = () => app.updateMate(id, { orient: c.checked });
      else if (k === 'flip') c.onchange = () => app.updateMate(id, { flip: c.checked, orient: true });
    });
  });
  el.querySelectorAll('[data-f]').forEach((r) => {
    r.onmouseenter = () => app.highlightFeature(p.id, r.dataset.f, 'sel', 0xffb020);
    r.onmouseleave = () => app.viewer.overlay('sel', null);
  });
}

async function snapNow(app, p) {
  app.snapshot();
  const old = p.pose.slice();
  const s = await app.hub.snap(p.id, p.pose, app.placedPoses(p.id), { match: app.matchOptions() });
  p.pose = s.pose;
  app.replaceAutoMates(p.id, s.mates);
  if (p.status === 'unplaced' || p.status === 'manual') p.status = s.mates.length ? 'placed' : p.status;
  app.viewer.setPose(p.id, p.pose);
  void old;
  app.render();
  app.status(s.mates.length ? `Snapped ${p.name} with ${s.mates.length} inferred mates.` : `No touching features found near ${p.name}.`);
}
