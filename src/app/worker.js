// Web Worker entry. One worker type serves two roles:
//  - analysis (pool): parse + analyse a single part, return features/SDF
//  - assembler (single): holds every part's analysis and runs matching,
//    auto assembly, placement suggestions and interference checks.

import { analyzePart } from '../core/features.js';
import { autoAssemble, suggestPlacements, snapToNeighbours, interference, registerShapes, groupVersions } from '../core/assemble.js';

const parts = new Map();
let hyps = new Map();
let optsKey = '';

function transferList(an) {
  const t = [];
  const add = (a) => a && a.buffer && !t.includes(a.buffer) && t.push(a.buffer);
  add(an.sdf.data);
  add(an.samples.pos);
  add(an.samples.nor);
  add(an.samples.grid.start);
  add(an.samples.grid.idx);
  add(an.triPlane);
  add(an.triCyl);
  return t;
}

export async function handle(type, msg, post) {
  switch (type) {
    case 'analyze': {
      const an = analyzePart(msg.positions, msg.options || {});
      return { result: an, transfer: transferList(an) };
    }
    case 'addPart': {
      parts.set(msg.part.id, msg.part);
      // invalidate cached hypotheses involving this id
      for (const k of Array.from(hyps.keys())) if (k.split('\u0001').includes(msg.part.id)) hyps.delete(k);
      return { result: true };
    }
    case 'removePart': {
      parts.delete(msg.id);
      for (const k of Array.from(hyps.keys())) if (k.split('\u0001').includes(msg.id)) hyps.delete(k);
      return { result: true };
    }
    case 'assemble': {
      const key = JSON.stringify(msg.options?.match || {});
      if (key !== optsKey) {
        hyps = new Map();
        optsKey = key;
      }
      const list = msg.ids.map((id) => parts.get(id)).filter(Boolean);
      const res = autoAssemble(list, {
        ...msg.options,
        hyps,
        onProgress: (p) => post({ progress: p }),
      });
      delete res.hyps;
      return { result: res };
    }
    case 'suggest': {
      const list = Array.from(parts.values());
      return { result: suggestPlacements(list, msg.id, msg.poses, { ...msg.options, hyps }) };
    }
    case 'snap': {
      const list = Array.from(parts.values());
      return { result: snapToNeighbours(list, msg.id, msg.pose, msg.poses, msg.options || {}) };
    }
    case 'interference': {
      return { result: interference(Array.from(parts.values()), msg.poses, msg.options || {}) };
    }
    case 'register': {
      const A = parts.get(msg.a)?.an, B = parts.get(msg.b)?.an;
      if (!A || !B) throw new Error('unknown part');
      return { result: registerShapes(A, B) };
    }
    case 'versions': {
      const list = msg.ids.map((id) => parts.get(id)).filter(Boolean);
      return { result: groupVersions(list) };
    }
    default:
      throw new Error('unknown message ' + type);
  }
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = async (e) => {
    const { rid, type, ...msg } = e.data;
    try {
      const { result, transfer } = await handle(type, msg, (m) => self.postMessage({ rid, ...m }));
      self.postMessage({ rid, ok: true, result }, transfer || []);
    } catch (err) {
      self.postMessage({ rid, ok: false, error: String((err && err.stack) || err) });
    }
  };
}
