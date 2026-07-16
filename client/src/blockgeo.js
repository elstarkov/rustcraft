import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { tileUV } from './textures.js';

// A cube with each face's uvs mapped into the block's atlas tile —
// top / bottom / side, the same scheme the chunk mesher uses. Used for
// item drops and the first-person held block, not for terrain.
export function blockGeometry(id, size) {
  const geo = new THREE.BoxGeometry(size, size, size);
  const tiles = BLOCKS[id].tiles;
  const uv = geo.attributes.uv;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z; four vertices each.
  for (let face = 0; face < 6; face++) {
    const tile = face === 2 ? tiles[0] : face === 3 ? tiles[1] : tiles[2];
    const { u0, u1, v0, v1 } = tileUV(tile);
    for (let i = face * 4; i < face * 4 + 4; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
  }
  return geo;
}
