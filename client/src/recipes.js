// Crafting recipes. Order must match server/src/craft.rs — the wire format
// sends the recipe index.

import { GLASS, LOG, PLANKS, SAND } from './blocks.js';

export const RECIPES = [
  { inputs: [[LOG, 1]], output: [PLANKS, 4] },
  { inputs: [[SAND, 1]], output: [GLASS, 1] },
];
