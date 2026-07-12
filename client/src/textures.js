import * as THREE from 'three';

export const TILE = 16; // pixels per tile
export const ATLAS_TILES = 4; // 4x4 grid

// Tile indices (see blocks.js):
// 0 grass-top, 1 dirt, 2 grass-side, 3 stone, 4 sand,
// 5 log-side, 6 log-top, 7 leaves, 8 planks, 9 glass, 10 water

function px(ctx, x, y, r, g, b, a = 1) {
  ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
  ctx.fillRect(x, y, 1, 1);
}

// Small deterministic PRNG so the atlas looks the same on every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noisyTile(ctx, ox, oy, base, spread, rand) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (rand() - 0.5) * spread;
      px(ctx, ox + x, oy + y, base[0] + d, base[1] + d, base[2] + d);
    }
  }
}

export function buildAtlas() {
  const size = TILE * ATLAS_TILES;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(1337);
  const at = (i) => [(i % ATLAS_TILES) * TILE, Math.floor(i / ATLAS_TILES) * TILE];

  let [ox, oy] = at(0); // grass top
  noisyTile(ctx, ox, oy, [96, 160, 62], 36, rand);

  [ox, oy] = at(1); // dirt
  noisyTile(ctx, ox, oy, [134, 96, 67], 30, rand);

  [ox, oy] = at(2); // grass side: dirt with a grass lip
  noisyTile(ctx, ox, oy, [134, 96, 67], 30, rand);
  for (let x = 0; x < TILE; x++) {
    const depth = 2 + Math.floor(rand() * 3);
    for (let y = 0; y < depth; y++) {
      const d = (rand() - 0.5) * 30;
      px(ctx, ox + x, oy + y, 96 + d, 160 + d, 62 + d);
    }
  }

  [ox, oy] = at(3); // stone
  noisyTile(ctx, ox, oy, [128, 128, 130], 26, rand);

  [ox, oy] = at(4); // sand
  noisyTile(ctx, ox, oy, [219, 206, 160], 22, rand);

  [ox, oy] = at(5); // log side: vertical bark stripes
  for (let x = 0; x < TILE; x++) {
    const stripe = (rand() - 0.5) * 34;
    for (let y = 0; y < TILE; y++) {
      const d = stripe + (rand() - 0.5) * 12;
      px(ctx, ox + x, oy + y, 104 + d, 82 + d, 50 + d);
    }
  }

  [ox, oy] = at(6); // log top: rings
  noisyTile(ctx, ox, oy, [154, 126, 78], 14, rand);
  ctx.strokeStyle = 'rgba(96,74,44,0.9)';
  for (const r of [2, 4, 6]) {
    ctx.strokeRect(ox + 8 - r, oy + 8 - r, r * 2, r * 2);
  }

  [ox, oy] = at(7); // leaves
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (rand() - 0.5) * 44;
      px(ctx, ox + x, oy + y, 52 + d, 118 + d, 38 + d);
    }
  }

  [ox, oy] = at(8); // planks
  noisyTile(ctx, ox, oy, [178, 142, 88], 14, rand);
  ctx.fillStyle = 'rgba(120,92,54,0.9)';
  for (const y of [3, 7, 11, 15]) ctx.fillRect(ox, oy + y, TILE, 1);

  [ox, oy] = at(9); // glass: mostly clear with frame + glints
  ctx.clearRect(ox, oy, TILE, TILE);
  ctx.fillStyle = 'rgba(210,235,245,0.35)';
  ctx.fillRect(ox, oy, TILE, TILE);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeRect(ox + 0.5, oy + 0.5, TILE - 1, TILE - 1);
  px(ctx, ox + 3, oy + 3, 255, 255, 255, 0.8);
  px(ctx, ox + 4, oy + 4, 255, 255, 255, 0.6);

  [ox, oy] = at(10); // water
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (rand() - 0.5) * 26;
      px(ctx, ox + x, oy + y, 40 + d, 94 + d, 190 + d, 0.72);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, canvas };
}

// UV rect for a tile, inset slightly to avoid bleeding between tiles.
export function tileUV(tile) {
  const inv = 1 / ATLAS_TILES;
  const eps = 0.02 * inv;
  const tx = tile % ATLAS_TILES;
  const ty = Math.floor(tile / ATLAS_TILES);
  return {
    u0: tx * inv + eps,
    u1: (tx + 1) * inv - eps,
    v0: 1 - (ty + 1) * inv + eps,
    v1: 1 - ty * inv - eps,
  };
}
