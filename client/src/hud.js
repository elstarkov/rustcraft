import { BLOCKS, PLACEABLE } from './blocks.js';
import { ATLAS_TILES, TILE } from './textures.js';
import { TOOLS, drawToolIcon } from './items.js';

export class HUD {
  constructor(atlasCanvas) {
    this.selected = 0;
    this.crosshair = document.getElementById('crosshair');
    this.debugEl = document.getElementById('debug');
    this.hotbarEl = document.getElementById('hotbar');
    this.slots = [];

    // Blocks first (keys 1-8), then tools; the wheel cycles everything.
    this.items = [
      ...PLACEABLE.map((id) => ({ block: id, name: BLOCKS[id].name })),
      ...TOOLS.map((tool) => ({ tool, name: tool.kind })),
    ];

    for (const item of this.items) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.title = item.name;
      const thumb = document.createElement('canvas');
      thumb.width = TILE;
      thumb.height = TILE;
      const ctx = thumb.getContext('2d');
      if (item.block != null) {
        const tile = BLOCKS[item.block].tiles[2]; // side texture reads best
        const sx = (tile % ATLAS_TILES) * TILE;
        const sy = Math.floor(tile / ATLAS_TILES) * TILE;
        ctx.drawImage(atlasCanvas, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
      } else {
        drawToolIcon(ctx, item.tool.kind);
      }
      slot.appendChild(thumb);
      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    }
    this.select(0);
  }

  select(i) {
    this.selected = (i + this.items.length) % this.items.length;
    this.slots.forEach((s, n) => s.classList.toggle('selected', n === this.selected));
  }

  /// Block id when a block is selected, else null (a tool is in hand).
  get selectedBlock() {
    return this.items[this.selected].block ?? null;
  }

  /// Tool definition when a tool is selected, else null.
  get selectedTool() {
    return this.items[this.selected].tool ?? null;
  }

  show() {
    this.crosshair.classList.remove('hidden');
    this.hotbarEl.classList.remove('hidden');
    this.debugEl.classList.remove('hidden');
  }

  setDebug(text) {
    this.debugEl.textContent = text;
  }
}
