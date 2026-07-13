// World generation — a direct port of server/src/world.rs.
//
// The Perlin implementation matches the algorithm of the Rust `noise` crate
// (improved Perlin over a seeded permutation table), but the permutation
// shuffle uses a different RNG, so the same seed produces a world that is
// statistically identical in shape but not block-for-block the same.

export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 64;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;
export const SEA_LEVEL = 26;

export const block = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  LOG: 5,
  LEAVES: 6,
  PLANKS: 7,
  GLASS: 8,
  WATER: 9,

  /** Blocks a client is allowed to place. Water flows only from world gen. */
  placeable(id) {
    return id >= 1 && id <= 8;
  },
};

/** Seeded 2D improved Perlin noise, output roughly in -1..1. */
class Perlin {
  constructor(seed) {
    // Fisher-Yates shuffle of 0..255 driven by a splitmix32-style PRNG.
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    const p = new Uint8Array(512);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rand() % (i + 1);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    this.p = p;
  }

  static fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  static grad(hash, x, y) {
    switch (hash & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }

  get(x, y) {
    const p = this.p;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const X = xf & 255;
    const Y = yf & 255;
    x -= xf;
    y -= yf;
    const u = Perlin.fade(x);
    const v = Perlin.fade(y);
    const a = p[X] + Y;
    const b = p[X + 1] + Y;
    const n00 = Perlin.grad(p[a], x, y);
    const n10 = Perlin.grad(p[b], x - 1, y);
    const n01 = Perlin.grad(p[a + 1], x, y - 1);
    const n11 = Perlin.grad(p[b + 1], x - 1, y - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  }
}

export class Chunk {
  constructor() {
    /** Indexed as (y * CHUNK_SIZE + z) * CHUNK_SIZE + x */
    this.blocks = new Uint8Array(CHUNK_VOLUME);
  }

  static idx(x, y, z) {
    return (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
  }

  get(x, y, z) {
    return this.blocks[Chunk.idx(x, y, z)];
  }

  set(x, y, z, id) {
    this.blocks[Chunk.idx(x, y, z)] = id;
  }
}

export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.noise = new Perlin(seed);
    this.chunks = new Map();
  }

  /** Terrain height (top solid block y) at world column (wx, wz). */
  heightAt(wx, wz) {
    const f = 0.012;
    const x = wx * f;
    const z = wz * f;
    let n = this.noise.get(x, z)
      + 0.5 * this.noise.get(x * 2 + 100, z * 2 + 100)
      + 0.25 * this.noise.get(x * 4 + 200, z * 4 + 200);
    n /= 1.75; // normalize to roughly -1..1
    const h = Math.trunc(26 + n * 14);
    return Math.min(Math.max(h, 4), WORLD_HEIGHT - 12);
  }

  /** Deterministic per-column hash used for tree placement. */
  columnHash(wx, wz) {
    let h = (this.seed ^ 0x9e3779b9) >>> 0;
    for (const v of [wx >>> 0, wz >>> 0]) {
      h = (h ^ Math.imul(v, 0x85ebca6b)) >>> 0;
      h = ((h << 13) | (h >>> 19)) >>> 0;
      h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
    }
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }

  generate(cx, cz) {
    const chunk = new Chunk();

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        const h = this.heightAt(wx, wz);

        const top = Math.min(h, WORLD_HEIGHT - 1);
        for (let y = 0; y <= top; y++) {
          let id;
          if (y === h) {
            id = h <= SEA_LEVEL + 1 ? block.SAND : block.GRASS;
          } else if (y >= h - 3) {
            id = h <= SEA_LEVEL + 1 ? block.SAND : block.DIRT;
          } else {
            id = block.STONE;
          }
          chunk.set(lx, y, lz, id);
        }

        // Fill oceans/lakes up to sea level.
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          if (y >= 0 && y < WORLD_HEIGHT) chunk.set(lx, y, lz, block.WATER);
        }
      }
    }

    // Trees: only where the whole canopy (radius 2) fits inside this chunk,
    // so generation never depends on neighboring chunks.
    for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
      for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        const h = this.heightAt(wx, wz);
        if (h <= SEA_LEVEL + 1) continue; // no trees on beaches or under water
        const hash = this.columnHash(wx, wz);
        if (hash % 97 !== 0) continue;
        const trunkH = 4 + ((hash >>> 8) % 3); // 4..6
        const top = h + trunkH;
        if (top + 2 >= WORLD_HEIGHT) continue;

        for (let dy = 1; dy <= trunkH; dy++) {
          chunk.set(lx, h + dy, lz, block.LOG);
        }
        // Two wide leaf layers below the top, then a small cap.
        for (const [dy, r] of [[-1, 2], [0, 2], [1, 1], [2, 1]]) {
          const y = top + dy;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx === 0 && dz === 0 && dy <= 0) continue; // trunk occupies the center
              if (Math.abs(dx) === r && Math.abs(dz) === r && r === 2) continue; // rounder canopy
              const px = lx + dx;
              const pz = lz + dz;
              if (chunk.get(px, y, pz) === block.AIR) {
                chunk.set(px, y, pz, block.LEAVES);
              }
            }
          }
        }
      }
    }

    return chunk;
  }

  chunk(cx, cz) {
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = this.generate(cx, cz);
      this.chunks.set(key, c);
    }
    return c;
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunk(cx, cz);
    chunk.set(((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, y, ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, id);
    return true;
  }

  /** A safe place to drop a new player: on top of the terrain near origin. */
  spawnPoint() {
    const h = Math.max(this.heightAt(8, 8), SEA_LEVEL);
    return [8.5, h + 2.5, 8.5];
  }
}
