import * as THREE from 'three';
import {
  AIR, BLOCKS, CHUNK_SIZE, WORLD_HEIGHT, isSeeThrough,
} from './blocks.js';
import { tileUV } from './textures.js';

// Face table adapted from the classic three.js voxel geometry pattern.
// Corners are ordered so triangles (0,1,2) and (2,1,3) face outward.
const FACES = [
  { dir: [-1, 0, 0], shade: 0.8, corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]], uvs: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { dir: [1, 0, 0], shade: 0.8, corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]], uvs: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { dir: [0, -1, 0], shade: 0.55, corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]], uvs: [[1, 0], [0, 0], [1, 1], [0, 1]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]], uvs: [[1, 1], [0, 1], [1, 0], [0, 0]] },
  { dir: [0, 0, -1], shade: 0.7, corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { dir: [0, 0, 1], shade: 0.7, corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] },
];

function faceTile(block, dir) {
  const tiles = BLOCKS[block].tiles; // [top, bottom, side]
  if (dir[1] === 1) return tiles[0];
  if (dir[1] === -1) return tiles[1];
  return tiles[2];
}

class GeometryBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.colors = [];
    this.indices = [];
  }

  addFace(face, x, y, z, tile) {
    const start = this.positions.length / 3;
    const { u0, u1, v0, v1 } = tileUV(tile);
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i];
      this.positions.push(x + c[0], y + c[1], z + c[2]);
      this.normals.push(...face.dir);
      const [fu, fv] = face.uvs[i];
      this.uvs.push(fu ? u1 : u0, fv ? v1 : v0);
      this.colors.push(face.shade, face.shade, face.shade);
    }
    this.indices.push(start, start + 1, start + 2, start + 2, start + 1, start + 3);
  }

  build() {
    if (this.indices.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setIndex(this.indices);
    return geo;
  }
}

// A face is drawn when the neighbor doesn't fully hide it. Two see-through
// blocks of the same type (water next to water) hide each other's faces.
function faceVisible(block, neighbor) {
  if (neighbor === AIR) return true;
  return isSeeThrough(neighbor) && neighbor !== block;
}

// Builds { opaque, transparent } BufferGeometries for one chunk.
// Neighbor lookups go through the world so chunk borders cull correctly.
export function meshChunk(world, cx, cz) {
  const opaque = new GeometryBuilder();
  const transparent = new GeometryBuilder();
  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = baseX + lx;
        const z = baseZ + lz;
        const block = world.getBlock(x, y, z);
        if (block === AIR) continue;
        const builder = BLOCKS[block]?.seeThrough ? transparent : opaque;
        for (const face of FACES) {
          const neighbor = world.getBlock(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
          if (!faceVisible(block, neighbor)) continue;
          builder.addFace(face, x, y, z, faceTile(block, face.dir));
        }
      }
    }
  }

  return { opaque: opaque.build(), transparent: transparent.build() };
}

export function makeMaterials(atlasTexture) {
  const opaque = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
  });
  const transparent = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return { opaque, transparent };
}
