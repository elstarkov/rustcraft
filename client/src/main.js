import * as THREE from 'three';
import { AIR, CHUNK_SIZE, WATER } from './blocks.js';
import { buildAtlas } from './textures.js';
import { World, chunkKey } from './world.js';
import { buildGeometry, makeMaterials } from './mesher.js';
import { borderSlices } from './mesh-core.js';
import { Player } from './player.js';
import { HUD } from './hud.js';
import { miningTime } from './items.js';
import { Net } from './net.js';
import { RemotePlayers } from './players.js';
import { RemoteMobs } from './mobs.js';
import { RemoteDrops } from './drops.js';
import { RemoteArrows } from './arrows.js';
import { ViewModel } from './viewmodel.js';
import { CraftingPanel } from './craft.js';
import { Sound } from './sound.js';
import { Chat } from './chat.js';
import { Torches } from './torches.js';

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
  viewModel.resize(camera.aspect);
});

const { texture: atlas, canvas: atlasCanvas } = buildAtlas();
const materials = makeMaterials(atlas);
const world = new World();
const hud = new HUD(atlasCanvas);
const player = new Player(world, camera);
const remotePlayers = new RemotePlayers(scene);
const remoteMobs = new RemoteMobs(scene);
const remoteDrops = new RemoteDrops(scene, atlas);
const remoteArrows = new RemoteArrows(scene);
const torches = new Torches(scene);
const viewModel = new ViewModel(atlas);
const craftPanel = new CraftingPanel(atlasCanvas, (i) => {
  sound.knock();
  net.craft(i);
});
const sound = new Sound();
const chat = new Chat((text) => net.chat(text));
let hudSelected = -1; // forces the initial viewModel.setItem
let invTotal = 0; // to tell pickups (gain) from placements (loss)
let stepAcc = 0;
let groanTimer = 2;
const vignette = document.getElementById('vignette');
const deathEl = document.getElementById('death');
const deathCauseEl = document.getElementById('death-cause');
let deathShownAt = 0;
let hp = 20;

const DEATH_PHRASES = {
  zombie: 'slain by a zombie',
  spider: 'slain by a spider',
  skeleton: 'shot by a skeleton',
  fall: 'you fell from a high place',
};

// Landings: always a thump, and past three blocks the server takes hearts.
player.onLand = (fall) => {
  sound.thump(fall);
  if (fall > 3.5) net.fall(fall);
};

function damageFlash() {
  vignette.style.transition = 'none';
  vignette.style.opacity = '1';
  requestAnimationFrame(() => {
    vignette.style.transition = 'opacity 0.5s ease-out';
    vignette.style.opacity = '0';
  });
}

// Owns the THREE meshes for chunks. Meshing itself happens in a web worker:
// process() snapshots dirty chunks (blocks + neighbor borders) to the worker,
// results come back as transferable typed arrays and swap in here.
class ChunkMeshes {
  constructor() {
    this.meshes = new Map(); // key -> { opaque?, transparent? }
    this.dirty = new Set();
    this.inFlight = new Set();
    this.worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' });
    this.backend = 'starting';
    this.worker.onmessage = (e) => {
      if (e.data.backend) {
        this.backend = e.data.backend;
        console.log(`mesher backend: ${e.data.backend}`);
        return;
      }
      this.onResult(e.data);
    };
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
  const key = chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
  torches.sync(key, world.chunks.get(key));
}

const net = new Net(`ws://${location.hostname}:8765`, playerName(), {
  onMessage(m) {
    switch (m.type) {
      case 'welcome':
        player.pos.set(m.spawn[0], m.spawn[1], m.spawn[2]);
        player.vel.set(0, 0, 0);
        player.peakY = player.pos.y;
        viewModel.setPalette(m.id);
        for (const p of m.players) remotePlayers.add(p.id, p.name, p.pos);
        spawned = true;
        overlayMsg.innerHTML =
          'click to play<br><br>WASD move · SPACE jump/swim · mouse look<br>' +
          'hold left click mine · right click place · 1-8 / wheel select item · E craft · T chat';
        break;
      case 'player_join':
        remotePlayers.add(m.id, m.name, m.pos);
        chat.add('', `${m.name} joined`);
        break;
      case 'player_leave': {
        const name = remotePlayers.players.get(m.id)?.name;
        remotePlayers.remove(m.id);
        if (name) chat.add('', `${name} left`);
        break;
      }
      case 'player_pos':
        remotePlayers.updatePos(m.id, m.x, m.y, m.z, m.yaw, m.pitch);
        break;
      case 'block_update':
        applyEdit(m.x, m.y, m.z, m.id);
        break;
      case 'time':
        worldTime = m.t;
        break;
      case 'mob_spawn':
        remoteMobs.add(m.id, m.kind, [m.x, m.y, m.z]);
        break;
      case 'mobs':
        remoteMobs.updateAll(m.list);
        break;
      case 'mob_hurt': {
        remoteMobs.hurt(m.id);
        const mob = remoteMobs.mobs.get(m.id);
        const d = mob ? mob.group.position.distanceTo(player.pos) : 99;
        if (d < 24) sound.hit(1 / (1 + d * 0.2));
        break;
      }
      case 'mob_gone':
        remoteMobs.remove(m.id);
        break;
      case 'arrow_spawn':
        remoteArrows.add(m.id, [m.x, m.y, m.z], [m.vx, m.vy, m.vz]);
        break;
      case 'arrows':
        remoteArrows.updateAll(m.list);
        break;
      case 'arrow_gone':
        remoteArrows.remove(m.id);
        break;
      case 'drop_spawn':
        remoteDrops.add(m.id, m.item, [m.x, m.y, m.z]);
        break;
      case 'drops':
        remoteDrops.updateAll(m.list);
        break;
      case 'drop_gone':
        remoteDrops.remove(m.id);
        break;
      case 'health':
        if (m.hp < hp) {
          damageFlash();
          sound.hurt();
        }
        hp = m.hp;
        hud.setHealth(hp);
        break;
      case 'respawn':
        player.pos.set(m.spawn[0], m.spawn[1], m.spawn[2]);
        player.vel.set(0, 0, 0);
        player.peakY = player.pos.y; // a teleport is not a fall
        deathCauseEl.textContent = DEATH_PHRASES[m.cause] ?? '';
        deathEl.classList.remove('hidden');
        deathShownAt = performance.now();
        craftPanel.hide();
        chat.closeInput();
        miningDown = false;
        break;
      case 'chat':
        chat.add(m.name, m.text);
        break;
      case 'inventory': {
        hud.setInventory(new Map(m.items));
        craftPanel.refresh(hud.inventory);
        const total = m.items.reduce((s, [, n]) => s + n, 0);
        // Gained items outside the crafting panel: that's a pickup.
        if (total > invTotal && !craftPanel.open) sound.pop();
        invTotal = total;
        break;
      }
    }
  },
  onChunk(cx, cz, blocks) {
    world.setChunk(cx, cz, new Uint8Array(blocks));
    chunkMeshes.markDirty(chunkKey(cx, cz));
    torches.sync(chunkKey(cx, cz), world.chunks.get(chunkKey(cx, cz)));
    // Border faces of already-loaded neighbors may now be hidden or exposed.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (world.hasChunk(cx + dx, cz + dz)) chunkMeshes.markDirty(chunkKey(cx + dx, cz + dz));
    }
  },
  onDisconnect() {
    spawned = false;
    document.exitPointerLock();
    craftPanel.hide();
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
      torches.removeChunk(key);
      requested.delete(key);
    }
  }
}

// --- Pointer lock, mouse and hotbar input -----------------------------------

overlay.addEventListener('click', () => {
  sound.unlock();
  if (spawned) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  // The crafting panel releases the pointer on purpose; don't show the
  // click-to-play overlay over it.
  overlay.classList.toggle('hidden', locked || craftPanel.open);
  if (locked) {
    hud.show();
    craftPanel.hide();
  } else {
    miningDown = false;
    chat.closeInput();
  }
});

// E swaps between playing (pointer locked) and the crafting panel.
function toggleCrafting() {
  if (craftPanel.open) {
    craftPanel.hide();
    renderer.domElement.requestPointerLock();
  } else if (document.pointerLockElement === renderer.domElement) {
    craftPanel.show();
    document.exitPointerLock();
  }
}
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) player.onMouseMove(e);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Left button holds to mine (handled in the frame loop); right button places.
let miningDown = false;

document.addEventListener('mousedown', (e) => {
  sound.unlock();
  // The death screen eats every click; a short delay so mid-combat
  // clicking doesn't dismiss it before it's even been seen.
  if (!deathEl.classList.contains('hidden')) {
    if (performance.now() - deathShownAt > 800) deathEl.classList.add('hidden');
    return;
  }
  if (document.pointerLockElement !== renderer.domElement || !spawned) return;
  if (e.button === 0) {
    viewModel.swing();
    // A mob in reach takes the swing; check it isn't behind the wall in view.
    const mobHit = remoteMobs.pick(player.eye(), player.lookDir(), 3.5);
    if (mobHit) {
      const blockHit = player.raycast(mobHit.dist);
      if (!blockHit) {
        net.attack(mobHit.id, hud.selectedTool?.kind ?? null);
        return;
      }
    }
    miningDown = true;
    return;
  }
  if (e.button !== 2) return;
  const block = hud.selectedBlock;
  if (block == null) return; // a tool is in hand
  if (hud.stockOf(block) <= 0) return; // nothing left to place
  const hit = player.raycast();
  if (!hit) return;
  const [px, py, pz] = [hit.x + hit.face[0], hit.y + hit.face[1], hit.z + hit.face[2]];
  const current = world.getBlock(px, py, pz);
  if ((current === AIR || current === WATER) && !player.blockIntersectsPlayer(px, py, pz)) {
    applyEdit(px, py, pz, block);
    net.setBlock(px, py, pz, block);
    hud.consumeOne(block);
    viewModel.swing();
    sound.place();
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) miningDown = false;
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing in chat
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 8) hud.select(n - 1);
  if (e.code === 'KeyE' && spawned) toggleCrafting();
  if (
    (e.code === 'KeyT' || e.code === 'Enter') &&
    spawned &&
    document.pointerLockElement === renderer.domElement &&
    !chat.inputOpen
  ) {
    e.preventDefault(); // keep the "t" out of the input
    player.keys.clear(); // held movement keys would never get their keyup
    chat.openInput();
  }
});
window.addEventListener('wheel', (e) => hud.select(hud.selected + Math.sign(e.deltaY)));

// Wireframe box around the block the player is looking at.
const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x111111 }),
);
highlight.visible = false;
scene.add(highlight);

// --- Mining: hold to break, crack overlay while it progresses ----------------

function makeCrackTexture(stage) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  let s = 91 + stage * 7;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  ctx.strokeStyle = 'rgba(18,14,10,0.85)';
  for (let i = 0; i <= stage + 1; i++) {
    ctx.beginPath();
    let x = 8 + (rand() - 0.5) * 4;
    let y = 8 + (rand() - 0.5) * 4;
    ctx.moveTo(x, y);
    for (let seg = 0; seg < 3 + stage; seg++) {
      x += (rand() - 0.5) * 9;
      y += (rand() - 0.5) * 9;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  return texture;
}

const crackTextures = [0, 1, 2, 3].map(makeCrackTexture);
const crackBox = new THREE.Mesh(
  new THREE.BoxGeometry(1.006, 1.006, 1.006),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, map: crackTextures[0] }),
);
crackBox.visible = false;
scene.add(crackBox);

const mining = { key: null, progress: 0, time: Infinity };

function updateMining(hit, dt) {
  if (!miningDown || !hit || hit.y <= 0) {
    mining.key = null;
    crackBox.visible = false;
    return;
  }
  const key = `${hit.x},${hit.y},${hit.z}`;
  if (mining.key !== key) {
    mining.key = key;
    mining.progress = 0;
    mining.time = miningTime(hit.id, hud.selectedTool);
  }
  mining.progress += dt;
  if (mining.progress >= mining.time) {
    applyEdit(hit.x, hit.y, hit.z, AIR); // optimistic; server echoes the same
    net.setBlock(hit.x, hit.y, hit.z, AIR);
    sound.dig();
    mining.key = null;
    crackBox.visible = false;
    return;
  }
  const stage = Math.min(3, Math.floor((mining.progress / mining.time) * 4));
  crackBox.material.map = crackTextures[stage];
  crackBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  crackBox.visible = true;
}

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
    updateMining(hit, dt);

    if (hud.selected !== hudSelected) {
      hudSelected = hud.selected;
      viewModel.setItem(hud.items[hudSelected]);
    }
    viewModel.matchLight(hemi.intensity, sun.intensity);
    const horizSpeed = Math.hypot(player.vel.x, player.vel.z);
    viewModel.update(dt, horizSpeed, miningDown && hit !== null);

    // Footsteps paced by ground distance covered, zombie groans by chance
    // from wherever the nearest ones actually are.
    if (player.onGround && horizSpeed > 1) {
      stepAcc += horizSpeed * dt;
      if (stepAcc > 2.1) {
        stepAcc = 0;
        sound.step();
      }
    }
    groanTimer -= dt;
    if (groanTimer <= 0) {
      groanTimer = 2.5 + Math.random() * 4;
      const mobs = [...remoteMobs.mobs.values()];
      const mob = mobs[Math.floor(Math.random() * mobs.length)];
      const d = mob ? mob.group.position.distanceTo(player.pos) : Infinity;
      if (d < 26) {
        const to = mob.group.position.clone().sub(player.pos).normalize();
        const pan = (to.x * Math.cos(player.yaw) - to.z * Math.sin(player.yaw)) * 0.8;
        const gain = 1 / (1 + d * 0.18);
        const voice = { zombie: 'groan', skeleton: 'rattle', spider: 'hiss', sheep: 'baa' };
        sound[voice[mob.kind] ?? 'groan'](gain, pan);
      }
    }
  }

  updateSky(dt);
  remotePlayers.update(dt);
  remoteMobs.update(dt);
  remoteDrops.update(dt);
  remoteArrows.update(dt);
  torches.update(dt, player.pos);
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
      `players ${remotePlayers.players.size + 1}  mobs ${remoteMobs.mobs.size}  drops ${remoteDrops.drops.size}`,
  );

  renderer.render(scene, camera);
  if (spawned) {
    // The hand renders on top with a cleared depth buffer so it never
    // clips into nearby world geometry.
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(viewModel.scene, viewModel.camera);
    renderer.autoClear = true;
  }
}

frame();

// Debug handle for tooling and console poking.
window.__rustcraft = {
  world, player, chunkMeshes, remotePlayers, remoteMobs, remoteDrops, hud, scene, viewModel,
  craftPanel, sound, chat, net, torches, remoteArrows, applyEdit,
  crack: { box: crackBox, textures: crackTextures },
  get hp() { return hp; },
};
