// Web worker wrapper around the greedy mesher: chunk snapshot in, transferable
// geometry arrays out. Keeps meshing off the main thread entirely.

import { meshChunkData } from './mesh-core.js';

self.onmessage = (e) => {
  const { key, cx, cz, blocks, borders } = e.data;
  const { opaque, transparent } = meshChunkData(cx, cz, blocks, borders);
  const transfer = [];
  for (const part of [opaque, transparent]) {
    if (!part) continue;
    transfer.push(
      part.positions.buffer, part.normals.buffer, part.uvs.buffer,
      part.tiles.buffer, part.colors.buffer, part.indices.buffer,
    );
  }
  self.postMessage({ key, opaque, transparent }, transfer);
};
