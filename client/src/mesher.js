// THREE-side half of the mesher: turns the worker's typed arrays into
// BufferGeometries and builds the atlas materials. The geometry carries uvs in
// block units plus a per-vertex `tile` attribute; a patch to the Lambert
// shader wraps the uv with fract() inside the chosen atlas tile, which is what
// lets greedy-merged quads tile their texture. Nearest filtering with no
// mipmaps keeps that trick artifact-free.

import * as THREE from 'three';
import { ATLAS_TILES } from './textures.js';

export function buildGeometry(part) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
  geo.setAttribute('tile', new THREE.BufferAttribute(part.tiles, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(part.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(part.indices, 1));
  return geo;
}

function atlasPatch(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tile;\nvarying float vTile;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = tile;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTile;')
      .replace(
        '#include <map_fragment>',
        `vec2 tileLocal = clamp(fract(vMapUv), 0.02, 0.98);
         float tileX = mod(vTile, ${ATLAS_TILES}.0);
         float tileY = floor(vTile / ${ATLAS_TILES}.0);
         vec2 atlasUv = vec2(
           (tileX + tileLocal.x) / ${ATLAS_TILES}.0,
           1.0 - (tileY + 1.0 - tileLocal.y) / ${ATLAS_TILES}.0
         );
         vec4 sampledDiffuseColor = texture2D( map, atlasUv );
         diffuseColor *= sampledDiffuseColor;`,
      );
  };
  return material;
}

export function makeMaterials(atlasTexture) {
  const opaque = atlasPatch(new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
  }));
  const transparent = atlasPatch(new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  return { opaque, transparent };
}
