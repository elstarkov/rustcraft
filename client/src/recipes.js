// Crafting recipes. Order must match server/src/craft.rs — the wire format
// sends the recipe index.

import { COAL_ORE, GLASS, LOG, PLANKS, SAND, TORCH } from './blocks.js';

export const RECIPES = [
  { inputs: [[LOG, 1]], output: [PLANKS, 4] },
  { inputs: [[SAND, 1]], output: [GLASS, 1] },
  { inputs: [[COAL_ORE, 1], [PLANKS, 1]], output: [TORCH, 4] },
];
