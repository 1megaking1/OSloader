// three.js viewport: part meshes, picking, feature highlight overlays,
// transform gizmo, ghost previews, section plane, explode view, axis glyphs.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const tmpM = new THREE.Matrix4();

export class Viewer extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    el.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(250, -300, 220);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
    this.head = new THREE.DirectionalLight(0xffffff, 1.6);
    this.head.position.set(0.3, 0.4, 1);
    this.camera.add(this.head);
    this.scene.add(this.camera);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, -0.6, -0.4);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(400, 40, 0x556070, 0x3a404c);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);
    this.axesHelper = new THREE.AxesHelper(20);
    this.scene.add(this.axesHelper);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value && this._gizmoTarget) this.dispatchEvent(new CustomEvent('gizmo-end', { detail: { id: this._gizmoTarget } }));
      if (e.value && this._gizmoTarget) this.dispatchEvent(new CustomEvent('gizmo-start', { detail: { id: this._gizmoTarget } }));
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (!this._gizmoTarget) return;
      this.gizmoProxy.updateMatrix();
      const m = this.gizmoProxy.matrix.clone().multiply(tmpM.makeTranslation(-this._pivot[0], -this._pivot[1], -this._pivot[2]));
      this.dispatchEvent(new CustomEvent('gizmo', { detail: { id: this._gizmoTarget, matrix: m.toArray() } }));
    });
    this._pivot = [0, 0, 0];
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmoProxy = new THREE.Object3D();
    this.scene.add(this.gizmoProxy);
    this.scene.add(this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo);

    this.parts = new Map(); // id -> {mesh, mat, pose, color, axes}
    this.geoms = new Map(); // geometry key -> BufferGeometry
    this.explode = 0;
    this.section = null;
    this.showAxes = false;
    this.hoverMesh = null;
    this.selFeatMesh = null;
    this.ghosts = [];
    this.marks = new THREE.Group();
    this.scene.add(this.marks);
    this.raycaster = new THREE.Raycaster();
    this._dirty = true;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(el);
    this.resize();
    const loop = () => {
      if (this._dirty) {
        this._dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  requestRender() {
    this._dirty = true;
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  geometryFor(key, positions) {
    if (this.geoms.has(key)) return this.geoms.get(key);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geoms.set(key, g);
    return g;
  }

  addPart(id, geomKey, positions, color) {
    const geom = this.geometryFor(geomKey, positions);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide, flatShading: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.matrixAutoUpdate = false;
    mesh.userData.id = id;
    this.scene.add(mesh);
    this.parts.set(id, { mesh, mat, pose: new THREE.Matrix4(), color, geomKey, axes: null, visible: true });
    this.requestRender();
  }

  removePart(id) {
    const p = this.parts.get(id);
    if (!p) return;
    this.scene.remove(p.mesh);
    p.mat.dispose();
    if (p.axes) this.scene.remove(p.axes);
    this.parts.delete(id);
    if (this._gizmoTarget === id) this.attachGizmo(null);
    this.requestRender();
  }

  clear() {
    for (const id of Array.from(this.parts.keys())) this.removePart(id);
    for (const g of this.geoms.values()) g.dispose();
    this.geoms.clear();
    this.clearGhosts();
    this.clearMarks();
  }

  setPose(id, arr) {
    const p = this.parts.get(id);
    if (!p) return;
    p.pose.fromArray(arr);
    this.applyMatrix(id);
  }

  applyMatrix(id) {
    const p = this.parts.get(id);
    const m = p.mesh.matrix;
    m.copy(p.pose);
    if (this.explode > 0 && p.explodeOffset) {
      tmpM.makeTranslation(p.explodeOffset.x * this.explode, p.explodeOffset.y * this.explode, p.explodeOffset.z * this.explode);
      m.premultiply(tmpM);
    }
    p.mesh.matrixWorldNeedsUpdate = true;
    if (p.axes) {
      p.axes.matrix.copy(m);
      p.axes.matrixWorldNeedsUpdate = true;
    }
    if (this._gizmoTarget === id && !this.gizmo.dragging) this._syncProxy(p);
    this.requestRender();
  }

  setColor(id, color) {
    const p = this.parts.get(id);
    if (!p) return;
    p.color = color;
    p.mat.color.set(color);
    this.requestRender();
  }

  setVisible(id, v) {
    const p = this.parts.get(id);
    if (!p) return;
    p.visible = v;
    p.mesh.visible = v;
    if (p.axes) p.axes.visible = v && this.showAxes;
    this.requestRender();
  }

  setStyle(id, { selected = false, dim = false, transparent = false } = {}) {
    const p = this.parts.get(id);
    if (!p) return;
    p.mat.emissive.set(selected ? 0x1d4f99 : 0x000000);
    p.mat.transparent = dim || transparent;
    p.mat.opacity = dim ? 0.18 : transparent ? 0.55 : 1;
    p.mat.depthWrite = !(dim || transparent);
    p.mat.needsUpdate = true;
    this.requestRender();
  }

  /** world bbox of visible parts (respecting explode) */
  bounds(ids = null) {
    const box = new THREE.Box3();
    for (const [id, p] of this.parts) {
      if (!p.visible || (ids && !ids.includes(id))) continue;
      const b = p.mesh.geometry.boundingBox.clone().applyMatrix4(p.mesh.matrix);
      box.union(b);
    }
    return box;
  }

  fit(ids = null) {
    const box = this.bounds(ids);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 50;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.5, -0.6, 0.5).normalize();
    const d = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.camera.near = Math.max(0.01, d / 1000);
    this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.updateGrid();
    this.requestRender();
  }

  updateGrid() {
    const box = this.bounds();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const s = Math.max(100, Math.ceil(Math.max(size.x, size.y) * 1.6 / 50) * 50);
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(s, Math.round(s / 10), 0x556070, 0x3a404c);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.45;
    const c = box.getCenter(new THREE.Vector3());
    this.grid.position.set(Math.round(c.x / 10) * 10, Math.round(c.y / 10) * 10, box.min.z - 0.01);
    this.scene.add(this.grid);
  }

  setExplode(f) {
    this.explode = f;
    // offsets from assembly centre
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.visible) box.union(p.mesh.geometry.boundingBox.clone().applyMatrix4(p.pose));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    for (const [id, p] of this.parts) {
      const pc = p.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(p.pose);
      const off = pc.sub(c);
      if (off.length() < 1e-6) off.set(0, 0, 1);
      p.explodeOffset = off.multiplyScalar(1.2).add(off.clone().normalize().multiplyScalar(size * 0.05));
      this.applyMatrix(id);
    }
  }

  // ------------------------------------------------------------ picking
  pick(clientX, clientY, { includeHidden = false } = {}) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [];
    for (const p of this.parts.values()) if (p.visible || includeHidden) meshes.push(p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.section && this.section.plane.distanceToPoint(h.point) < 0) continue;
      return { id: h.object.userData.id, tri: h.faceIndex, point: h.point.toArray() };
    }
    return null;
  }

  /** overlay showing given triangles of a part */
  overlay(kind, id, tris, color = 0xffb020) {
    const p = this.parts.get(id);
    const prop = kind === 'hover' ? 'hoverMesh' : 'selFeatMesh';
    if (this[prop]) {
      this.scene.remove(this[prop]);
      this[prop].geometry.dispose();
      this[prop] = null;
    }
    if (!p || !tris || !tris.length) {
      this.requestRender();
      return;
    }
    const src = p.mesh.geometry.attributes.position.array;
    const out = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => out.set(src.subarray(t * 9, t * 9 + 9), i * 9));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: kind === 'hover' ? 0.55 : 0.75, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(p.mesh.matrix);
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this[prop] = mesh;
    this.requestRender();
  }

  // ------------------------------------------------------------ ghosts
  clearGhosts() {
    for (const g of this.ghosts) {
      this.scene.remove(g);
      g.material.dispose();
    }
    this.ghosts = [];
    this.requestRender();
  }

  ghost(id, poseArr, color = 0x4f9dff) {
    const p = this.parts.get(id);
    if (!p) return;
    const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.25 });
    const mesh = new THREE.Mesh(p.mesh.geometry, m);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(poseArr);
    mesh.renderOrder = 4;
    this.scene.add(mesh);
    this.ghosts.push(mesh);
    this.requestRender();
  }

  // ------------------------------------------------------------ gizmo
  _syncProxy(p) {
    const m = p.pose.clone().multiply(tmpM.makeTranslation(this._pivot[0], this._pivot[1], this._pivot[2]));
    m.decompose(this.gizmoProxy.position, this.gizmoProxy.quaternion, this.gizmoProxy.scale);
    this.gizmoProxy.updateMatrix();
  }

  /** attach the move/rotate gizmo; pivot is in part-local coordinates (usually its centre) */
  attachGizmo(id, mode = 'translate', pivot = null) {
    this._gizmoTarget = id;
    if (!id) {
      this.gizmo.detach();
      this.requestRender();
      return;
    }
    const p = this.parts.get(id);
    if (!p) return;
    this._pivot = pivot || p.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).toArray();
    this._syncProxy(p);
    this.gizmo.attach(this.gizmoProxy);
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    this.requestRender();
  }

  // ------------------------------------------------------------ section
  setSection(on, axis = 2, t = 0.5, flip = false) {
    if (!on) {
      this.section = null;
      this.renderer.clippingPlanes = [];
      this.requestRender();
      return;
    }
    const box = this.bounds();
    const n = new THREE.Vector3();
    n.setComponent(axis, flip ? 1 : -1);
    const lo = box.min.getComponent(axis), hi = box.max.getComponent(axis);
    const pos = lo + (hi - lo) * t;
    const plane = new THREE.Plane(n, flip ? -pos : pos);
    this.section = { plane, axis, t, flip };
    this.renderer.clippingPlanes = [plane];
    this.requestRender();
  }

  // ------------------------------------------------------------ axis glyphs
  setAxes(id, segments) {
    const p = this.parts.get(id);
    if (!p) return;
    if (p.axes) this.scene.remove(p.axes);
    const pos = [], col = [];
    for (const s of segments) {
      pos.push(...s.a, ...s.b);
      const c = new THREE.Color(s.color);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    l.matrixAutoUpdate = false;
    l.matrix.copy(p.mesh.matrix);
    l.renderOrder = 6;
    l.visible = this.showAxes && p.visible;
    p.axes = l;
    this.scene.add(l);
  }

  setShowAxes(v) {
    this.showAxes = v;
    for (const p of this.parts.values()) if (p.axes) p.axes.visible = v && p.visible;
    this.requestRender();
  }

  // ------------------------------------------------------------ marks
  clearMarks() {
    for (const c of Array.from(this.marks.children)) {
      this.marks.remove(c);
      c.geometry?.dispose();
    }
    this.requestRender();
  }

  markLine(a, b, color = 0xffd04f) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 7;
    this.marks.add(l);
    this.requestRender();
  }

  /** highlighted straight edge under the cursor (edge tool) */
  hoverLine(seg) {
    if (this._hoverLine) {
      this.scene.remove(this._hoverLine);
      this._hoverLine.geometry.dispose();
      this._hoverLine = null;
    }
    if (seg) {
      const g = new THREE.BufferGeometry().setFromPoints(seg.map((p) => new THREE.Vector3(...p)));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffc400, depthTest: false, linewidth: 2 }));
      l.renderOrder = 8;
      this._hoverLine = l;
      this.scene.add(l);
    }
    this.requestRender();
  }

  /** persistent coloured overlay of some triangles of a part (kept until clearMarks) */
  markFeature(id, tris, color) {
    const p = this.parts.get(id);
    if (!p || !tris || !tris.length) return;
    const src = p.mesh.geometry.attributes.position.array;
    const out = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => out.set(src.subarray(t * 9, t * 9 + 9), i * 9));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(p.mesh.matrix);
    mesh.renderOrder = 5;
    this.marks.add(mesh);
    this.requestRender();
  }

  markPoint(p, color = 0xffd04f, size = 1) {
    const g = new THREE.SphereGeometry(size, 12, 8);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(...p);
    m.renderOrder = 7;
    this.marks.add(m);
    this.requestRender();
  }

  focusOn(ids) {
    this.fit(ids);
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
