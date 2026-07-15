import * as THREE from 'three';
import { buildHumanoid } from './players.js';

// Renders server-driven mobs. Zombies reuse the player humanoid with a green
// palette and the classic arms-forward reach; positions interpolate toward
// the server's 10 Hz updates, legs swing with actual movement.

const ZOMBIE_PALETTE = {
  skin: new THREE.Color(0x5f9e4f),
  shirt: new THREE.Color(0x3a6b60),
  pants: new THREE.Color(0x413a5c),
  hair: new THREE.Color(0x274427),
  sclera: '#d8e6c9',
  eyes: '#1a1a1a',
};

export class RemoteMobs {
  constructor(scene) {
    this.scene = scene;
    this.mobs = new Map(); // id -> humanoid parts + interpolation state
  }

  add(id, kind, pos) {
    if (this.mobs.has(id)) this.remove(id);
    const avatar = buildHumanoid(ZOMBIE_PALETTE);
    avatar.armL.rotation.x = -Math.PI / 2; // zombie reach
    avatar.armR.rotation.x = -Math.PI / 2;
    avatar.group.position.set(pos[0], pos[1], pos[2]);
    this.scene.add(avatar.group);
    this.mobs.set(id, {
      ...avatar,
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

  // Nearest mob AABB (0.7 x 1.95) hit by the ray, or null.
  pick(origin, dir, maxDist = 3.5) {
    let best = null;
    for (const [id, m] of this.mobs) {
      const p = m.group.position;
      const min = [p.x - 0.35, p.y, p.z - 0.35];
      const max = [p.x + 0.35, p.y + 1.95, p.z + 0.35];
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
      const swing = Math.sin(m.phase) * 0.6 * Math.min(m.speed / 2.4, 1);
      m.legL.rotation.x = swing;
      m.legR.rotation.x = -swing;

      let dyaw = m.yaw - m.group.rotation.y;
      dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
      m.group.rotation.y += dyaw * k;

      m.hurtTimer = Math.max(0, m.hurtTimer - dt);
      const glow = m.hurtTimer > 0 ? 0.65 : 0;
      m.group.traverse((obj) => {
        if (obj.material?.emissive) obj.material.emissive.setRGB(glow, 0, 0);
      });
    }
  }
}
