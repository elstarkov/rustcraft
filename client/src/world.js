import { AIR, CHUNK_SIZE, CHUNK_VOLUME, WORLD_HEIGHT } from './blocks.js';

export const chunkKey = (cx, cz) => `${cx},${cz}`;

// Client-side mirror of the world: raw chunk data received from the server.
export class World {
  constructor() {
    this.chunks = new Map(); // "cx,cz" -> Uint8Array(CHUNK_VOLUME)
  }

  hasChunk(cx, cz) {
    return this.chunks.has(chunkKey(cx, cz));
  }

  setChunk(cx, cz, data) {
    if (data.length !== CHUNK_VOLUME) throw new Error('bad chunk size');
    this.chunks.set(chunkKey(cx, cz), data);
  }

  dropChunk(cx, cz) {
    this.chunks.delete(chunkKey(cx, cz));
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return AIR;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    return chunk[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
  }

  // Returns the keys of chunks whose mesh is affected by this edit
  // (the chunk itself, plus neighbors when the block sits on a border).
  setBlock(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return [];
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return [];
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    chunk[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] = id;

    const dirty = [chunkKey(cx, cz)];
    if (lx === 0) dirty.push(chunkKey(cx - 1, cz));
    if (lx === CHUNK_SIZE - 1) dirty.push(chunkKey(cx + 1, cz));
    if (lz === 0) dirty.push(chunkKey(cx, cz - 1));
    if (lz === CHUNK_SIZE - 1) dirty.push(chunkKey(cx, cz + 1));
    return dirty;
  }
}
