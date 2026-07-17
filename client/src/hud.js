import { BLOCKS, PLACEABLE, TORCH } from './blocks.js';
import { ATLAS_TILES, TILE } from './textures.js';
import { TOOLS, drawToolIcon, drawTorchIcon } from './items.js';

export class HUD {
  constructor(atlasCanvas) {
    this.selected = 0;
    this.crosshair = document.getElementById('crosshair');
    this.debugEl = document.getElementById('debug');
    this.hotbarEl = document.getElementById('hotbar');
    this.heartsEl = document.getElementById('hearts');
    this.slots = [];
    this.setHealth(20);

    // Blocks first (keys 1-8), then tools; the wheel cycles everything.
    this.items = [
      ...PLACEABLE.map((id) => ({ block: id, name: BLOCKS[id].name })),
      ...TOOLS.map((tool) => ({ tool, name: tool.kind })),
    ];

    this.inventory = new Map(); // block id -> count, mirrors the server

    for (const item of this.items) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.title = item.name;
      const thumb = document.createElement('canvas');
      thumb.width = TILE;
      thumb.height = TILE;
      const ctx = thumb.getContext('2d');
      if (item.block === TORCH) {
        drawTorchIcon(ctx);
        item.countEl = document.createElement('span');
        item.countEl.className = 'count';
        slot.appendChild(item.countEl);
      } else if (item.block != null) {
        const tile = BLOCKS[item.block].tiles[2]; // side texture reads best
        const sx = (tile % ATLAS_TILES) * TILE;
        const sy = Math.floor(tile / ATLAS_TILES) * TILE;
        ctx.drawImage(atlasCanvas, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
        item.countEl = document.createElement('span');
        item.countEl.className = 'count';
        slot.appendChild(item.countEl);
      } else {
        drawToolIcon(ctx, item.tool.kind);
      }
      slot.appendChild(thumb);
      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    }
    this.refreshCounts();
    this.select(0);
  }

  /// Server inventory snapshot: update slot counts, gray out empty ones.
  setInventory(map) {
    this.inventory = map;
    this.refreshCounts();
  }

  stockOf(blockId) {
    return this.inventory.get(blockId) ?? 0;
  }

  /// Optimistic local decrement on place; the server snapshot that follows
  /// overwrites it either way.
  consumeOne(blockId) {
    this.inventory.set(blockId, Math.max(0, this.stockOf(blockId) - 1));
    this.refreshCounts();
  }

  refreshCounts() {
    this.items.forEach((item, i) => {
      if (item.block == null) return; // tools are always available
      const n = this.stockOf(item.block);
      item.countEl.textContent = n > 0 ? n : '';
      this.slots[i].classList.toggle('empty', n === 0);
    });
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
    this.heartsEl.classList.remove('hidden');
  }

  /// 20 hp = ten hearts.
  setHealth(hp) {
    const full = Math.min(10, Math.max(0, Math.ceil(hp / 2)));
    this.heartsEl.innerHTML =
      '♥'.repeat(full) + `<span class="lost">${'♥'.repeat(10 - full)}</span>`;
  }

  setDebug(text) {
    this.debugEl.textContent = text;
  }
}
