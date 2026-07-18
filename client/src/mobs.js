import * as THREE from 'three';
import { buildHumanoid } from './players.js';

// Renders server-driven mobs, one builder per kind. Zombies and skeletons
// reuse the player humanoid with their own palettes; spiders and sheep are
// bespoke box models. Positions interpolate toward the server's 10 Hz
// updates and legs swing with actual movement. Materials are created per
// mob because remove() disposes them.

const ZOMBIE_PALETTE = {
  skin: new THREE.Color(0x5f9e4f),
  shirt: new THREE.Color(0x3a6b60),
  pants: new THREE.Color(0x413a5c),
  hair: new THREE.Color(0x274427),
  sclera: '#d8e6c9',
  eyes: '#1a1a1a',
};

const SKELETON_PALETTE = {
  skin: new THREE.Color(0xd6d6c8),
  shirt: new THREE.Color(0xc4c4b4),
  pants: new THREE.Color(0xb2b2a2),
  hair: new THREE.Color(0x8f8f83),
  sclera: '#3a3a34', // hollow sockets
  eyes: '#101010',
};

function buildZombie() {
  const a = buildHumanoid(ZOMBIE_PALETTE);
  a.armL.rotation.x = -Math.PI / 2; // classic reach
  a.armR.rotation.x = -Math.PI / 2;
  return { group: a.group, legs: [a.legL, a.legR], halfW: 0.35, height: 1.95 };
}

function buildSkeleton() {
  const a = buildHumanoid(SKELETON_PALETTE);
  a.armR.rotation.x = -Math.PI / 2; // bow arm up
  const bow = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.72, 0.05),
    new THREE.MeshLambertMaterial({ color: 0x6b4a26 }),
  );
  bow.position.set(0, -0.55, -0.06);
  a.armR.add(bow);
  return { group: a.group, legs: [a.legL, a.legR], halfW: 0.35, height: 1.95 };
}

function buildSpider() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2b2320 });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x231c1a });
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0xb03030, emissive: 0x701818 });
  eyeMat.userData.base = eyeMat.emissive.clone(); // survives the hurt flash

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.45, 1.15), bodyMat);
  body.position.set(0, 0.5, 0.15);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.5), headMat);
  head.position.set(0, 0.45, -0.65);
  group.add(body, head);
  for (const dx of [-0.14, 0.14]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.03), eyeMat);
    eye.position.set(dx, 0.52, -0.91);
    group.add(eye);
  }

  const legs = [];
  const legGeo = new THREE.BoxGeometry(0.07, 0.6, 0.07);
  legGeo.translate(0, -0.3, 0); // pivot at the hip
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(side * 0.45, 0.55, -0.35 + i * 0.32);
      leg.rotation.z = side * 0.85; // splayed out; walk wiggles rotation.x
      group.add(leg);
      legs.push(leg);
    }
  }
  return { group, legs, halfW: 0.65, height: 0.85 };
}

function buildSheep() {
  const group = new THREE.Group();
  const woolMat = new THREE.MeshLambertMaterial({ color: 0xe9e5db });
  const faceMat = new THREE.MeshLambertMaterial({ color: 0xcbb39e });
  const legMat = new THREE.MeshLambertMaterial({ color: 0xa89c8c });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.65, 1.25), woolMat);
  body.position.set(0, 0.85, 0.05);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.38, 0.42), faceMat);
  head.position.set(0, 1.05, -0.72);
  const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.32), woolMat);
  tuft.position.set(0, 1.28, -0.68);
  group.add(body, head, tuft);

  const legs = [];
  const legGeo = new THREE.BoxGeometry(0.16, 0.55, 0.16);
  legGeo.translate(0, -0.275, 0);
  // Diagonal pairs share a swing phase for a proper gait.
  for (const [x, z] of [[-0.25, -0.4], [0.25, 0.45], [0.25, -0.4], [-0.25, 0.45]]) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, 0.55, z);
    group.add(leg);
    legs.push(leg);
  }
  return { group, legs, halfW: 0.5, height: 1.35 };
}

const BUILDERS = {
  zombie: buildZombie,
  skeleton: buildSkeleton,
  spider: buildSpider,
  sheep: buildSheep,
};

export class RemoteMobs {
  constructor(scene) {
    this.scene = scene;
    this.mobs = new Map(); // id -> model parts + interpolation state
  }

  add(id, kind, pos) {
    if (this.mobs.has(id)) this.remove(id);
    const built = (BUILDERS[kind] ?? BUILDERS.zombie)();
    built.group.position.set(pos[0], pos[1], pos[2]);
    this.scene.add(built.group);
    this.mobs.set(id, {
      ...built,
      kind,
      target: new THREE.Vector3(...pos),
      yaw: 0,
      phase: 0,
      speed: 0,
      hurtTimer: 0,
    });
  }

  updateAll(list) {
    for (const [id, x, y, z, yaw] of list) {
      const m = this.mobs.get(id);
      if (!m) continue;
      m.target.set(x, y, z);
      m.yaw = yaw;
    }
  }

  hurt(id) {
    const m = this.mobs.get(id);
    if (m) m.hurtTimer = 0.25;
  }

  // Nearest mob AABB hit by the ray, or null. Box sizes come per kind.
  pick(origin, dir, maxDist = 3.5) {
    let best = null;
    for (const [id, m] of this.mobs) {
      const p = m.group.position;
      const min = [p.x - m.halfW, p.y, p.z - m.halfW];
      const max = [p.x + m.halfW, p.y + m.height, p.z + m.halfW];
      const o = [origin.x, origin.y, origin.z];
      const d = [dir.x, dir.y, dir.z];
      let t0 = 0;
      let t1 = maxDist;
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(d[a]) < 1e-8) {
          ok = o[a] >= min[a] && o[a] <= max[a];
          continue;
        }
        let ta = (min[a] - o[a]) / d[a];
        let tb = (max[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        ok = t0 <= t1;
      }
      if (ok && (best === null || t0 < best.dist)) best = { id, dist: t0 };
    }
    return best;
  }

  remove(id) {
    const m = this.mobs.get(id);
    if (!m) return;
    this.scene.remove(m.group);
    m.group.traverse((obj) => {
      obj.geometry?.dispose();
      for (const mat of [].concat(obj.material ?? [])) {
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.mobs.delete(id);
  }

  clear() {
    for (const id of [...this.mobs.keys()]) this.remove(id);
  }

  update(dt) {
    const k = Math.min(dt * 10, 1);
    for (const m of this.mobs.values()) {
      const px = m.group.position.x;
      const pz = m.group.position.z;
      m.group.position.lerp(m.target, k);

      const moved = Math.hypot(m.group.position.x - px, m.group.position.z - pz);
      const speed = moved / Math.max(dt, 1e-4);
      m.speed += (speed - m.speed) * Math.min(dt * 8, 1);
      m.phase += m.speed * dt * 3;
      const amp = m.kind === 'spider' ? 0.35 : 0.6;
      const swing = Math.sin(m.phase) * amp * Math.min(m.speed / 2.4, 1);
      m.legs.forEach((leg, i) => {
        leg.rotation.x = swing * (i % 2 ? -1 : 1);
      });

      let dyaw = m.yaw - m.group.rotation.y;
      dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
      m.group.rotation.y += dyaw * k;

      m.hurtTimer = Math.max(0, m.hurtTimer - dt);
      const hurt = m.hurtTimer > 0;
      m.group.traverse((obj) => {
        const mat = obj.material;
        if (!mat?.emissive) return;
        if (hurt) mat.emissive.setRGB(0.65, 0, 0);
        else if (mat.userData.base) mat.emissive.copy(mat.userData.base);
        else mat.emissive.setRGB(0, 0, 0);
      });
    }
  }
}
