import * as THREE from 'three';
import {
  CHUNK_SIZE, TORCH, TORCH_WALL_NX, TORCH_WALL_NZ, TORCH_WALL_PX, TORCH_WALL_PZ, WORLD_HEIGHT,
  isTorch,
} from './blocks.js';

// Torch rendering and light. Each torch cell gets a little model (stick +
// glowing head); actual light comes from a fixed pool of point lights that
// is reassigned to the torches nearest the player every frame. A fixed pool
// means the number of lights in the shader never changes, so placing a
// torch never recompiles materials.

const LIGHT_POOL = 10;
const LIGHT_COLOR = 0xffa95e;
const LIGHT_DISTANCE = 12;

const stickGeo = new THREE.BoxGeometry(0.09, 0.5, 0.09);
const headGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
const stickMat = new THREE.MeshLambertMaterial({ color: 0x7a5a30 });
const headMat = new THREE.MeshLambertMaterial({
  color: 0xffc74a,
  emissive: 0xffa030,
  emissiveIntensity: 1.4,
});

/// A torch model with its origin at the block's bottom center. Shared
/// geometry and materials — dispose nothing when removing one.
export function makeTorch() {
  const group = new THREE.Group();
  const stick = new THREE.Mesh(stickGeo, stickMat);
  stick.position.y = 0.25;
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 0.55;
  group.add(stick, head);
  return group;
}

// How each variant sits in its cell: floor torches stand centered, wall
// torches shift toward their supporting wall, ride a little higher, and
// lean away from it.
const MOUNT = {
  [TORCH]: { dx: 0, dz: 0, rx: 0, rz: 0, dy: 0 },
  [TORCH_WALL_PX]: { dx: 0.3, dz: 0, rx: 0, rz: 0.5, dy: 0.22 },
  [TORCH_WALL_NX]: { dx: -0.3, dz: 0, rx: 0, rz: -0.5, dy: 0.22 },
  [TORCH_WALL_PZ]: { dx: 0, dz: 0.3, rx: -0.5, rz: 0, dy: 0.22 },
  [TORCH_WALL_NZ]: { dx: 0, dz: -0.3, rx: 0.5, rz: 0, dy: 0.22 },
};

export class Torches {
  constructor(scene) {
    this.scene = scene;
    this.byChunk = new Map(); // chunk key -> [{ x, y, z, group }]
    this.lights = [];
    this.time = 0;
    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, 1.8);
      scene.add(light);
      this.lights.push(light);
    }
  }

  /// Re-scan one chunk's blocks for torches and swap in fresh models.
  sync(key, blocks) {
    this.removeChunk(key);
    if (!blocks) return;
    const [cx, cz] = key.split(',').map(Number);
    const list = [];
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const id = blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
          if (!isTorch(id)) continue;
          const m = MOUNT[id];
          const group = makeTorch();
          group.position.set(
            cx * CHUNK_SIZE + x + 0.5 + m.dx,
            y + m.dy,
            cz * CHUNK_SIZE + z + 0.5 + m.dz,
          );
          group.rotation.set(m.rx, 0, m.rz);
          this.scene.add(group);
          list.push({ x: group.position.x, y: group.position.y, z: group.position.z, group });
        }
      }
    }
    if (list.length) this.byChunk.set(key, list);
  }

  removeChunk(key) {
    for (const t of this.byChunk.get(key) ?? []) this.scene.remove(t.group);
    this.byChunk.delete(key);
  }

  get count() {
    let n = 0;
    for (const list of this.byChunk.values()) n += list.length;
    return n;
  }

  /// Flicker and hand the light pool to the nearest torches.
  update(dt, playerPos) {
    this.time += dt;
    const flicker = 1 + Math.sin(this.time * 11) * 0.06 + Math.sin(this.time * 27) * 0.04;
    headMat.emissiveIntensity = 1.4 * flicker;

    const all = [];
    for (const list of this.byChunk.values()) {
      for (const t of list) {
        const dx = t.x - playerPos.x;
        const dy = t.y - playerPos.y;
        const dz = t.z - playerPos.z;
        all.push([dx * dx + dy * dy + dz * dz, t]);
      }
    }
    if (all.length > LIGHT_POOL) all.sort((a, b) => a[0] - b[0]);

    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = this.lights[i];
      const t = all[i]?.[1];
      if (t) {
        light.position.set(t.x, t.y + 0.7, t.z);
        light.intensity = 26 * flicker;
      } else {
        light.intensity = 0;
      }
    }
  }
}
