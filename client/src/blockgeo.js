import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { tileUV } from './textures.js';

// The apple item as a tiny model (origin at its base). Geometry and
// materials are shared — callers must not dispose them.
const appleGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
const stemGeo = new THREE.BoxGeometry(0.04, 0.09, 0.04);
const appleMat = new THREE.MeshLambertMaterial({ color: 0xc62f2f });
const stemMat = new THREE.MeshLambertMaterial({ color: 0x5a3d1e });

export function makeApple() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(appleGeo, appleMat);
  body.position.y = 0.11;
  const stem = new THREE.Mesh(stemGeo, stemMat);
  stem.position.y = 0.26;
  group.add(body, stem);
  return group;
}

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
