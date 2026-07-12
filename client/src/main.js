import * as THREE from 'three';
import { AIR, CHUNK_SIZE, WATER, WORLD_HEIGHT, isSolid } from './blocks.js';
import { buildAtlas } from './textures.js';
import { World, chunkKey } from './world.js';
import { makeMaterials, meshChunk } from './mesher.js';
import { generateTestChunk } from './testworld.js';
import { Player } from './player.js';
import { HUD } from './hud.js';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');

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

const { texture: atlas, canvas: atlasCanvas } = buildAtlas();
const materials = makeMaterials(atlas);
const world = new World();
const hud = new HUD(atlasCanvas);

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

const player = new Player(world, camera);

function surfaceY(x, z) {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
    if (isSolid(world.getBlock(Math.floor(x), y, Math.floor(z)))) return y + 1;
  }
  return WORLD_HEIGHT;
}
player.pos.set(8.5, surfaceY(8.5, 8.5) + 0.5, 8.5);

// --- Pointer lock, mouse and hotbar input --------------------------------

overlayMsg.innerHTML =
  'click to play<br><br>WASD move · SPACE jump/swim · mouse look<br>' +
  'left click break · right click place · 1-8 / wheel select block';

overlay.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  overlay.classList.toggle('hidden', locked);
  if (locked) hud.show();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) player.onMouseMove(e);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

function applyEdit(x, y, z, id) {
  for (const key of world.setBlock(x, y, z, id)) chunkMeshes.markDirty(key);
}

document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  const hit = player.raycast();
  if (!hit) return;
  if (e.button === 0 && hit.y > 0) {
    applyEdit(hit.x, hit.y, hit.z, AIR);
  } else if (e.button === 2) {
    const [px, py, pz] = [hit.x + hit.face[0], hit.y + hit.face[1], hit.z + hit.face[2]];
    const current = world.getBlock(px, py, pz);
    if ((current === AIR || current === WATER) && !player.blockIntersectsPlayer(px, py, pz)) {
      applyEdit(px, py, pz, hud.selectedBlock);
    }
  }
});

window.addEventListener('keydown', (e) => {
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 8) hud.select(n - 1);
});
window.addEventListener('wheel', (e) => hud.select(hud.selected + Math.sign(e.deltaY)));

// Wireframe box around the block the player is looking at.
const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x111111 }),
);
highlight.visible = false;
scene.add(highlight);

// --- Main loop ------------------------------------------------------------

const clock = new THREE.Clock();
let fpsTime = 0;
let fpsFrames = 0;
let fps = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  player.update(dt);

  const hit = player.raycast();
  highlight.visible = hit !== null;
  if (hit) highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

  chunkMeshes.process(4);

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
  }
  const { x, y, z } = player.pos;
  hud.setDebug(
    `${fps} fps  xyz ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}  ` +
      `chunk ${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`,
  );

  renderer.render(scene, camera);
}

overlay.classList.remove('hidden');
frame();
