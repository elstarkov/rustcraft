import { BLOCKS } from './blocks.js';
import { ATLAS_TILES, TILE } from './textures.js';
import { RECIPES } from './recipes.js';

// The crafting panel: one clickable row per recipe, grayed out while the
// ingredients aren't there. Opened with E (main.js releases the pointer so
// the rows are clickable).

export class CraftingPanel {
  constructor(atlasCanvas, onCraft) {
    this.atlasCanvas = atlasCanvas;
    this.el = document.getElementById('crafting');
    this.rows = [];

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'crafting — E to close';
    this.el.appendChild(title);

    RECIPES.forEach((recipe, i) => {
      const row = document.createElement('div');
      row.className = 'recipe off';
      for (const [id, n] of recipe.inputs) row.append(this.stack(id, n));
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      row.append(arrow, this.stack(recipe.output[0], recipe.output[1]));
      row.addEventListener('click', () => {
        if (!row.classList.contains('off')) onCraft(i);
      });
      this.el.appendChild(row);
      this.rows.push(row);
    });
  }

  /// "2× [icon] name" fragment for one item stack.
  stack(id, n) {
    const wrap = document.createElement('span');
    wrap.className = 'stack';
    const count = document.createElement('span');
    count.textContent = `${n}×`;
    const icon = document.createElement('canvas');
    icon.width = TILE;
    icon.height = TILE;
    icon.title = BLOCKS[id].name;
    const tile = BLOCKS[id].tiles[2];
    icon.getContext('2d').drawImage(
      this.atlasCanvas,
      (tile % ATLAS_TILES) * TILE, Math.floor(tile / ATLAS_TILES) * TILE, TILE, TILE,
      0, 0, TILE, TILE,
    );
    wrap.append(count, icon);
    return wrap;
  }

  refresh(inventory) {
    RECIPES.forEach((recipe, i) => {
      const ok = recipe.inputs.every(([id, n]) => (inventory.get(id) ?? 0) >= n);
      this.rows[i].classList.toggle('off', !ok);
    });
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  show() {
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }
}
