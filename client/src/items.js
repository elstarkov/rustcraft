// Tools and mining rules. Tools live in the hotbar next to blocks: holding
// the matching tool mines a block class 5x faster, the sword is for fighting.
// There is no inventory or crafting (yet) — every tool is always available.

import {
  COAL_ORE, DIRT, GLASS, GOLD_ORE, GRASS, IRON_ORE, LEAVES, LOG, PLANKS, SAND, STONE, TORCH,
} from './blocks.js';

/// Seconds to break a block bare-handed (or with the wrong tool).
export const HARDNESS = {
  [GRASS]: 0.75,
  [DIRT]: 0.65,
  [SAND]: 0.55,
  [STONE]: 6,
  [COAL_ORE]: 7,
  [IRON_ORE]: 8,
  [GOLD_ORE]: 8,
  [LOG]: 1.8,
  [PLANKS]: 1.6,
  [LEAVES]: 0.3,
  [GLASS]: 0.4,
  [TORCH]: 0.1,
};

// kind doubles as the wire code sent with attack messages.
export const TOOLS = [
  { kind: 'pickaxe', speeds: [STONE, COAL_ORE, IRON_ORE, GOLD_ORE], damage: 3 },
  { kind: 'shovel', speeds: [GRASS, DIRT, SAND], damage: 3 },
  { kind: 'axe', speeds: [LOG, PLANKS, LEAVES], damage: 3 },
  { kind: 'sword', speeds: [], damage: 6 },
];

export const FIST_DAMAGE = 2;
export const TOOL_SPEEDUP = 5;

export function miningTime(blockId, tool) {
  const base = HARDNESS[blockId] ?? 1;
  return tool && tool.speeds.includes(blockId) ? base / TOOL_SPEEDUP : base;
}

// --- Hotbar icons: 16x16 pixel art, fillRect only so it stays crisp ---------

const HANDLE = '#8a5a2b';
const HANDLE_DARK = '#6b4420';
const STEEL = '#c9ccd4';
const STEEL_DARK = '#82878f';

function plot(ctx, pts, color) {
  ctx.fillStyle = color;
  for (const [x, y] of pts) ctx.fillRect(x, y, 1, 1);
}

// Diagonal handle from bottom-left toward top-right.
function handle(ctx, from = [3, 13], len = 9) {
  const pts = [];
  for (let k = 0; k < len; k++) pts.push([from[0] + k, from[1] - k]);
  plot(ctx, pts, HANDLE);
  plot(ctx, pts.map(([x, y]) => [x, y + 1]).slice(0, len - 1), HANDLE_DARK);
}

const ICONS = {
  pickaxe(ctx) {
    handle(ctx, [3, 13], 9);
    plot(ctx, [[4, 3], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 3], [11, 4], [12, 5], [3, 4], [2, 5], [2, 6]], STEEL);
    plot(ctx, [[5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 4], [3, 5]], STEEL_DARK);
  },
  shovel(ctx) {
    handle(ctx, [3, 13], 8);
    ctx.fillStyle = STEEL;
    ctx.fillRect(10, 2, 4, 4);
    plot(ctx, [[9, 4], [10, 6], [11, 6], [12, 6], [13, 6]], STEEL_DARK);
    plot(ctx, [[12, 1], [13, 1], [13, 2]], STEEL);
  },
  axe(ctx) {
    handle(ctx, [3, 13], 9);
    ctx.fillStyle = STEEL;
    ctx.fillRect(7, 2, 4, 3);
    plot(ctx, [[6, 3], [6, 4], [7, 5], [8, 5], [11, 3], [11, 4]], STEEL);
    plot(ctx, [[7, 5], [8, 5], [9, 5], [6, 5]], STEEL_DARK);
  },
  sword(ctx) {
    const blade = [];
    for (let k = 0; k < 9; k++) blade.push([5 + k, 11 - k], [6 + k, 11 - k]);
    plot(ctx, blade, STEEL);
    plot(ctx, blade.filter((_, i) => i % 2 === 0).map(([x, y]) => [x - 1, y]), STEEL_DARK);
    plot(ctx, [[3, 10], [4, 11], [6, 13], [7, 14]], HANDLE_DARK); // crossguard
    plot(ctx, [[3, 13], [2, 14]], HANDLE); // grip
  },
};

export function drawToolIcon(ctx, kind) {
  ICONS[kind]?.(ctx);
}

/// Apple hotbar icon.
export function drawAppleIcon(ctx) {
  ctx.fillStyle = '#c62f2f';
  ctx.fillRect(4, 5, 8, 8);
  plot(ctx, [[3, 6], [3, 7], [3, 8], [3, 9], [12, 6], [12, 7], [12, 8], [12, 9], [5, 4], [10, 4]], '#c62f2f');
  plot(ctx, [[5, 6], [5, 7], [6, 5]], '#e8837d'); // shine
  plot(ctx, [[4, 11], [5, 12], [10, 12], [11, 11]], '#8f1f1f'); // shadow
  plot(ctx, [[7, 3], [8, 3], [8, 2]], '#5a3d1e'); // stem
  plot(ctx, [[9, 2], [10, 2], [10, 1]], '#3f7a2a'); // leaf
}

/// Torch hotbar icon: a stick with a glowing head. The torch has no atlas
/// tile (the mesher never draws it), so its icon is pixel art like the tools.
export function drawTorchIcon(ctx) {
  ctx.fillStyle = HANDLE;
  ctx.fillRect(7, 5, 2, 9);
  ctx.fillStyle = HANDLE_DARK;
  ctx.fillRect(8, 6, 1, 8);
  ctx.fillStyle = '#ffd23e';
  ctx.fillRect(6, 2, 4, 4);
  ctx.fillStyle = '#ff9d2e';
  plot(ctx, [[6, 2], [9, 2], [6, 5], [9, 5]], '#ff9d2e');
  plot(ctx, [[7, 1], [8, 1]], '#fff1a8');
}
