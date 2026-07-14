// Web worker wrapper around the greedy mesher: chunk snapshot in, transferable
// geometry arrays out. Prefers the Rust mesher compiled to wasm (~5x faster,
// byte-identical output — see mesher-wasm/) and falls back to the JS port in
// mesh-core.js if instantiation fails.

import { meshChunkData } from './mesh-core.js';
import { CHUNK_VOLUME } from './blocks.js';
import wasmUrl from './mesher.wasm?url';

const BORDER_BYTES = 1024; // 16 x 64 neighbor slice
const PART_ARRAYS = ['positions', 'normals', 'uvs', 'tiles', 'colors', 'indices'];

const wasmReady = (async () => {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports;
})().catch(() => null);

wasmReady.then((w) => self.postMessage({ backend: w ? 'wasm' : 'js' }));

function meshWithWasm(w, cx, cz, blocks, borders) {
  const base = w.input_ptr() >>> 0;
  new Uint8Array(w.memory.buffer).set(blocks, base);
  let flags = 0;
  ['nx', 'px', 'nz', 'pz'].forEach((k, i) => {
    if (borders[k]) {
      flags |= 1 << i;
      new Uint8Array(w.memory.buffer).set(borders[k], base + CHUNK_VOLUME + i * BORDER_BYTES);
    }
  });
  w.mesh(cx, cz, flags);

  // Twelve (ptr, len) pairs; copy out of wasm memory so the buffers can be
  // transferred to the main thread.
  const header = new Uint32Array(w.memory.buffer, w.header_ptr() >>> 0, 24);
  const read = (o) => {
    const part = {};
    for (let i = 0; i < PART_ARRAYS.length; i++) {
      const [ptr, len] = [header[o + i * 2], header[o + i * 2 + 1]];
      part[PART_ARRAYS[i]] = i === 5
        ? new Uint32Array(w.memory.buffer, ptr, len).slice()
        : new Float32Array(w.memory.buffer, ptr, len).slice();
    }
    return part.indices.length ? part : null;
  };
  return { opaque: read(0), transparent: read(12) };
}

self.onmessage = async (e) => {
  const { key, cx, cz, blocks, borders } = e.data;
  const w = await wasmReady;
  const { opaque, transparent } = w
    ? meshWithWasm(w, cx, cz, blocks, borders)
    : meshChunkData(cx, cz, blocks, borders);
  const transfer = [];
  for (const part of [opaque, transparent]) {
    if (!part) continue;
    transfer.push(...PART_ARRAYS.map((name) => part[name].buffer));
  }
  self.postMessage({ key, opaque, transparent }, transfer);
};
