// Must match server/src/world.rs
export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 64;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const LOG = 5;
export const LEAVES = 6;
export const PLANKS = 7;
export const GLASS = 8;
export const WATER = 9;
export const COAL_ORE = 10;
export const IRON_ORE = 11;
export const GOLD_ORE = 12;

// Atlas tile index per face: [top, bottom, side]
export const BLOCKS = {
  [GRASS]: { name: 'grass', tiles: [0, 1, 2] },
  [DIRT]: { name: 'dirt', tiles: [1, 1, 1] },
  [STONE]: { name: 'stone', tiles: [3, 3, 3] },
  [SAND]: { name: 'sand', tiles: [4, 4, 4] },
  [LOG]: { name: 'log', tiles: [6, 6, 5] },
  [LEAVES]: { name: 'leaves', tiles: [7, 7, 7] },
  [PLANKS]: { name: 'planks', tiles: [8, 8, 8] },
  [GLASS]: { name: 'glass', tiles: [9, 9, 9], seeThrough: true },
  [WATER]: { name: 'water', tiles: [10, 10, 10], seeThrough: true, liquid: true },
  [COAL_ORE]: { name: 'coal ore', tiles: [11, 11, 11] },
  [IRON_ORE]: { name: 'iron ore', tiles: [12, 12, 12] },
  [GOLD_ORE]: { name: 'gold ore', tiles: [13, 13, 13] },
};

// What the hotbar offers, in slot order. Ores are placeable so mined ore
// isn't a dead item (no crafting yet).
export const PLACEABLE = [
  GRASS, DIRT, STONE, SAND, LOG, LEAVES, PLANKS, GLASS, COAL_ORE, IRON_ORE, GOLD_ORE,
];

// Blocks the player collides with.
export function isSolid(id) {
  return id !== AIR && id !== WATER;
}

// Blocks that don't fully hide the face of a neighboring block.
export function isSeeThrough(id) {
  return id === AIR || BLOCKS[id]?.seeThrough === true;
}
