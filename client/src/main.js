import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT } from './blocks.js';
import { buildAtlas } from './textures.js';
import { World, chunkKey } from './world.js';
import { makeMaterials, meshChunk } from './mesher.js';
import { generateTestChunk } from './testworld.js';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = 0x87ceeb;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 60, 140);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);

scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(0.6, 1, 0.4);
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const { texture: atlas } = buildAtlas();
const materials = makeMaterials(atlas);
const world = new World();

// Owns the THREE meshes for chunks and rebuilds them when marked dirty.
class ChunkMeshes {
  constructor() {
    this.meshes = new Map(); // key -> { opaque?, transparent? }
    this.dirty = new Set();
  }

  markDirty(key) {
    this.dirty.add(key);
  }

  remove(key) {
    const entry = this.meshes.get(key);
    if (!entry) return;
    for (const mesh of Object.values(entry)) {
      if (!mesh) continue;
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.delete(key);
  }

  rebuild(key) {
    this.remove(key);
    const [cx, cz] = key.split(',').map(Number);
    if (!world.hasChunk(cx, cz)) return;
    const { opaque, transparent } = meshChunk(world, cx, cz);
    const entry = {};
    if (opaque) {
      entry.opaque = new THREE.Mesh(opaque, materials.opaque);
      scene.add(entry.opaque);
    }
    if (transparent) {
      entry.transparent = new THREE.Mesh(transparent, materials.transparent);
      scene.add(entry.transparent);
    }
    this.meshes.set(key, entry);
  }

  // Spread mesh rebuilds across frames to avoid hitches.
  process(limit = 2) {
    for (const key of this.dirty) {
      this.dirty.delete(key);
      this.rebuild(key);
      if (--limit <= 0) break;
    }
  }
}

const chunkMeshes = new ChunkMeshes();

// Until the network layer lands: local placeholder terrain.
const RADIUS = 3;
for (let cz = -RADIUS; cz <= RADIUS; cz++) {
  for (let cx = -RADIUS; cx <= RADIUS; cx++) {
    world.setChunk(cx, cz, generateTestChunk(cx, cz));
    chunkMeshes.markDirty(chunkKey(cx, cz));
  }
}

overlay.classList.add('hidden');

// Slow orbit over the terrain while there are no controls yet.
const clock = new THREE.Clock();
let angle = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  angle += dt * 0.1;
  const r = 40;
  camera.position.set(Math.cos(angle) * r + 8, WORLD_HEIGHT * 0.75, Math.sin(angle) * r + 8);
  camera.lookAt(8, 26, 8);
  chunkMeshes.process(4);
  renderer.render(scene, camera);
}
frame();
