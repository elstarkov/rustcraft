import { BLOCKS, PLACEABLE } from './blocks.js';
import { ATLAS_TILES, TILE } from './textures.js';

export class HUD {
  constructor(atlasCanvas) {
    this.selected = 0;
    this.crosshair = document.getElementById('crosshair');
    this.debugEl = document.getElementById('debug');
    this.hotbarEl = document.getElementById('hotbar');
    this.slots = [];

    for (const id of PLACEABLE) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.title = BLOCKS[id].name;
      const thumb = document.createElement('canvas');
      thumb.width = TILE;
      thumb.height = TILE;
      const tile = BLOCKS[id].tiles[2]; // side texture reads best
      const sx = (tile % ATLAS_TILES) * TILE;
      const sy = Math.floor(tile / ATLAS_TILES) * TILE;
      thumb.getContext('2d').drawImage(atlasCanvas, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
      slot.appendChild(thumb);
      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    }
    this.select(0);
  }

  select(i) {
    this.selected = (i + PLACEABLE.length) % PLACEABLE.length;
    this.slots.forEach((s, n) => s.classList.toggle('selected', n === this.selected));
  }

  get selectedBlock() {
    return PLACEABLE[this.selected];
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
