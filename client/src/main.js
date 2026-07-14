import * as THREE from 'three';
import { AIR, CHUNK_SIZE, WATER } from './blocks.js';
import { buildAtlas } from './textures.js';
import { World, chunkKey } from './world.js';
import { buildGeometry, makeMaterials } from './mesher.js';
import { borderSlices } from './mesh-core.js';
import { Player } from './player.js';
import { HUD } from './hud.js';
import { Net } from './net.js';
import { RemotePlayers } from './players.js';

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

const hemi = new THREE.HemisphereLight(0xffffff, 0x777788, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(0.6, 1, 0.4);
scene.add(sun);

// --- Day/night cycle ---------------------------------------------------------
// Server-synced world time: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.
// The client advances it locally and snaps to the server's `time` messages.

const DAY_SECONDS = 600;
let worldTime = 0.1;

const SKY_DAY = new THREE.Color(0x87ceeb);
const SKY_NIGHT = new THREE.Color(0x0b1026);
const SKY_DUSK = new THREE.Color(0xf08a4b);
const skyColor = new THREE.Color();

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function updateSky(dt) {
  worldTime = (worldTime + dt / DAY_SECONDS) % 1;
  const ang = worldTime * Math.PI * 2;
  const elev = Math.sin(ang); // sun height, -1..1

  sun.position.set(Math.cos(ang) * 0.7, elev, 0.35);
  sun.intensity = Math.max(0, elev) * 1.1;
  hemi.intensity = 0.18 + 0.97 * smoothstep(-0.08, 0.25, elev);

  skyColor.lerpColors(SKY_NIGHT, SKY_DAY, smoothstep(-0.12, 0.25, elev));
  skyColor.lerp(SKY_DUSK, Math.exp(-((elev / 0.16) ** 2)) * 0.55); // dawn/dusk glow
  scene.background.copy(skyColor);
  scene.fog.color.copy(skyColor);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const { texture: atlas, canvas: atlasCanvas } = buildAtlas();
const materials = makeMaterials(atlas);
const world = new World();
const hud = new HUD(atlasCanvas);
const player = new Player(world, camera);
const remotePlayers = new RemotePlayers(scene);

// Owns the THREE meshes for chunks. Meshing itself happens in a web worker:
// process() snapshots dirty chunks (blocks + neighbor borders) to the worker,
// results come back as transferable typed arrays and swap in here.
class ChunkMeshes {
  constructor() {
    this.meshes = new Map(); // key -> { opaque?, transparent? }
    this.dirty = new Set();
    this.inFlight = new Set();
    this.worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onResult(e.data);
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

  onResult({ key, opaque, transparent }) {
    this.inFlight.delete(key);
    const [cx, cz] = key.split(',').map(Number);
    if (!world.hasChunk(cx, cz)) return; // dropped while the worker meshed it
    this.remove(key);
    const entry = {};
    if (opaque) {
      entry.opaque = new THREE.Mesh(buildGeometry(opaque), materials.opaque);
      scene.add(entry.opaque);
    }
    if (transparent) {
      entry.transparent = new THREE.Mesh(buildGeometry(transparent), materials.transparent);
      scene.add(entry.transparent);
    }
    this.meshes.set(key, entry);
  }

  // Feed dirty chunks to the worker. A chunk edited while its job is in
  // flight stays dirty and is resubmitted when the stale result lands.
  process(limit = 4) {
    for (const key of this.dirty) {
      if (this.inFlight.has(key)) continue;
      const chunk = world.chunks.get(key);
      this.dirty.delete(key);
      if (!chunk) continue;
      const [cx, cz] = key.split(',').map(Number);
      const blocks = chunk.slice();
      const borders = borderSlices((ncx, ncz) => world.chunks.get(chunkKey(ncx, ncz)), cx, cz);
      this.inFlight.add(key);
      this.worker.postMessage(
        { key, cx, cz, blocks, borders },
        [blocks.buffer, ...Object.values(borders).filter(Boolean).map((b) => b.buffer)],
      );
      if (--limit <= 0) break;
    }
  }
}

const chunkMeshes = new ChunkMeshes();

// --- Networking ------------------------------------------------------------

let spawned = false;

function playerName() {
  let name = localStorage.getItem('rustcraft-name');
  if (!name) {
    name = `steve${Math.floor(Math.random() * 900) + 100}`;
    localStorage.setItem('rustcraft-name', name);
  }
  return name;
}

function applyEdit(x, y, z, id) {
  for (const key of world.setBlock(x, y, z, id)) chunkMeshes.markDirty(key);
}

const net = new Net(`ws://${location.hostname}:8765`, playerName(), {
  onMessage(m) {
    switch (m.type) {
      case 'welcome':
        player.pos.set(m.spawn[0], m.spawn[1], m.spawn[2]);
        player.vel.set(0, 0, 0);
        for (const p of m.players) remotePlayers.add(p.id, p.name, p.pos);
        spawned = true;
        overlayMsg.innerHTML =
          'click to play<br><br>WASD move · SPACE jump/swim · mouse look<br>' +
          'left click break · right click place · 1-8 / wheel select block';
        break;
      case 'player_join':
        remotePlayers.add(m.id, m.name, m.pos);
        break;
      case 'player_leave':
        remotePlayers.remove(m.id);
        break;
      case 'player_pos':
        remotePlayers.updatePos(m.id, m.x, m.y, m.z, m.yaw);
        break;
      case 'block_update':
        applyEdit(m.x, m.y, m.z, m.id);
        break;
      case 'time':
        worldTime = m.t;
        break;
    }
  },
  onChunk(cx, cz, blocks) {
    world.setChunk(cx, cz, new Uint8Array(blocks));
    chunkMeshes.markDirty(chunkKey(cx, cz));
    // Border faces of already-loaded neighbors may now be hidden or exposed.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (world.hasChunk(cx + dx, cz + dz)) chunkMeshes.markDirty(chunkKey(cx + dx, cz + dz));
    }
  },
  onDisconnect() {
    spawned = false;
    document.exitPointerLock();
    overlay.classList.remove('hidden');
    overlayMsg.innerHTML =
      '<span class="error">can\'t reach the server at ws://' +
      `${location.hostname}:8765</span><br><br>` +
      'start it with:&nbsp; cd server && cargo run<br>then reload this page';
  },
});

overlayMsg.textContent = 'connecting…';

// --- Chunk streaming --------------------------------------------------------

const RENDER_RADIUS = 4;
const DROP_RADIUS = RENDER_RADIUS + 2;
const requested = new Set();

// Ring offsets sorted nearest-first so close terrain streams in first.
const OFFSETS = [];
for (let dz = -RENDER_RADIUS; dz <= RENDER_RADIUS; dz++) {
  for (let dx = -RENDER_RADIUS; dx <= RENDER_RADIUS; dx++) OFFSETS.push([dx, dz]);
}
OFFSETS.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));

function streamChunks() {
  const pcx = Math.floor(player.pos.x / CHUNK_SIZE);
  const pcz = Math.floor(player.pos.z / CHUNK_SIZE);

  for (const [dx, dz] of OFFSETS) {
    const cx = pcx + dx;
    const cz = pcz + dz;
    const key = chunkKey(cx, cz);
    if (!world.hasChunk(cx, cz) && !requested.has(key)) {
      requested.add(key);
      net.requestChunk(cx, cz);
    }
  }

  for (const key of [...world.chunks.keys()]) {
    const [cx, cz] = key.split(',').map(Number);
    if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > DROP_RADIUS) {
      world.dropChunk(cx, cz);
      chunkMeshes.remove(key);
      chunkMeshes.dirty.delete(key);
      requested.delete(key);
    }
  }
}

// --- Pointer lock, mouse and hotbar input -----------------------------------

overlay.addEventListener('click', () => {
  if (spawned) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  overlay.classList.toggle('hidden', locked);
  if (locked) hud.show();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) player.onMouseMove(e);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== renderer.domElement || !spawned) return;
  const hit = player.raycast();
  if (!hit) return;
  if (e.button === 0 && hit.y > 0) {
    applyEdit(hit.x, hit.y, hit.z, AIR); // optimistic; server echoes the same
    net.setBlock(hit.x, hit.y, hit.z, AIR);
  } else if (e.button === 2) {
    const [px, py, pz] = [hit.x + hit.face[0], hit.y + hit.face[1], hit.z + hit.face[2]];
    const current = world.getBlock(px, py, pz);
    if ((current === AIR || current === WATER) && !player.blockIntersectsPlayer(px, py, pz)) {
      applyEdit(px, py, pz, hud.selectedBlock);
      net.setBlock(px, py, pz, hud.selectedBlock);
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

// --- Main loop ---------------------------------------------------------------

const clock = new THREE.Clock();
let streamTimer = 0;
let posTimer = 0;
let fpsTime = 0;
let fpsFrames = 0;
let fps = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (spawned) {
    streamTimer -= dt;
    if (streamTimer <= 0) {
      streamTimer = 0.25;
      streamChunks();
    }

    // Freeze physics until the ground under the player has arrived.
    const pcx = Math.floor(player.pos.x / CHUNK_SIZE);
    const pcz = Math.floor(player.pos.z / CHUNK_SIZE);
    if (world.hasChunk(pcx, pcz)) player.update(dt);

    posTimer -= dt;
    if (posTimer <= 0) {
      posTimer = 0.1;
      net.sendPos(player.pos, player.yaw, player.pitch);
    }

    const hit = document.pointerLockElement === renderer.domElement ? player.raycast() : null;
    highlight.visible = hit !== null;
    if (hit) highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  }

  updateSky(dt);
  remotePlayers.update(dt);
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
      `chunk ${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}  ` +
      `players ${remotePlayers.players.size + 1}`,
  );

  renderer.render(scene, camera);
}

frame();

// Debug handle for tooling and console poking.
window.__rustcraft = { world, player, chunkMeshes, remotePlayers };
