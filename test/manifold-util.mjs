// Helpers to build test geometry with manifold-3d (dev only).
import Module from 'manifold-3d';
let wasm = null;
export async function getManifold() {
  if (!wasm) {
    wasm = await Module();
    wasm.setup();
  }
  return wasm;
}
/** Manifold -> triangle soup Float32Array (9 floats / tri) */
export function toSoup(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties, tv = mesh.triVerts;
  const out = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    out[i * 3] = vp[tv[i] * np];
    out[i * 3 + 1] = vp[tv[i] * np + 1];
    out[i * 3 + 2] = vp[tv[i] * np + 2];
  }
  return out;
}
