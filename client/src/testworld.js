import {
  CHUNK_SIZE, CHUNK_VOLUME, DIRT, GRASS, LEAVES, LOG, SAND, STONE, WATER,
} from './blocks.js';

// Placeholder terrain so the renderer can be developed before the network
// layer lands: sine-wave hills with a pond. Replaced by server chunks later.
export function generateTestChunk(cx, cz) {
  const data = new Uint8Array(CHUNK_VOLUME);
  const idx = (x, y, z) => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
  const SEA = 24;

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const x = cx * CHUNK_SIZE + lx;
      const z = cz * CHUNK_SIZE + lz;
      const h = Math.floor(
        26 + 6 * Math.sin(x * 0.12) * Math.cos(z * 0.1) + 3 * Math.sin((x + z) * 0.05),
      );
      for (let y = 0; y <= h; y++) {
        let id = STONE;
        if (y === h) id = h <= SEA + 1 ? SAND : GRASS;
        else if (y >= h - 3) id = DIRT;
        data[idx(lx, y, lz)] = id;
      }
      for (let y = h + 1; y <= SEA; y++) data[idx(lx, y, lz)] = WATER;

      // A tree on a fixed grid, away from chunk borders.
      if (x % 11 === 5 && z % 13 === 6 && h > SEA + 1 && lx > 1 && lx < 14 && lz > 1 && lz < 14) {
        for (let dy = 1; dy <= 4; dy++) data[idx(lx, h + dy, lz)] = LOG;
        for (let dy = 3; dy <= 5; dy++) {
          const r = dy === 5 ? 1 : 2;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              const i = idx(lx + dx, h + dy, lz + dz);
              if (data[i] === 0) data[i] = LEAVES;
            }
          }
        }
      }
    }
  }
  return data;
}
