import * as THREE from 'three';
import { AIR, WATER, isSolid } from './blocks.js';

const GRAVITY = -24;
const JUMP_SPEED = 8.2;
const WALK_SPEED = 5.6;
const SWIM_SPEED = 3.2;
const HALF_W = 0.3; // player is a 0.6 x 1.8 x 0.6 box
const HEIGHT = 1.8;
const EYE = 1.62;
const EPS = 1e-4;

export class Player {
  constructor(world, camera) {
    this.world = world;
    this.camera = camera;
    this.pos = new THREE.Vector3(8.5, 40, 8.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.keys = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  onMouseMove(e) {
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  eye() {
    return new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z);
  }

  lookDir() {
    return new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
      .normalize();
  }

  inWater() {
    const head = this.world.getBlock(
      Math.floor(this.pos.x),
      Math.floor(this.pos.y + EYE * 0.6),
      Math.floor(this.pos.z),
    );
    return head === WATER;
  }

  update(dt) {
    const swimming = this.inWater();

    // Horizontal input in the yaw plane.
    let fwd = 0;
    let strafe = 0;
    if (this.keys.has('KeyW')) fwd += 1;
    if (this.keys.has('KeyS')) fwd -= 1;
    if (this.keys.has('KeyD')) strafe += 1;
    if (this.keys.has('KeyA')) strafe -= 1;
    const speed = swimming ? SWIM_SPEED : WALK_SPEED;
    const len = Math.hypot(fwd, strafe) || 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.vel.x = ((-sin * fwd + cos * strafe) / len) * speed;
    this.vel.z = ((-cos * fwd - sin * strafe) / len) * speed;

    if (swimming) {
      this.vel.y += GRAVITY * 0.15 * dt;
      this.vel.y = Math.max(this.vel.y, -3);
      if (this.keys.has('Space')) this.vel.y = SWIM_SPEED;
    } else {
      this.vel.y += GRAVITY * dt;
      if (this.keys.has('Space') && this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    this.onGround = false;
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('y', this.vel.y * dt);
    this.moveAxis('z', this.vel.z * dt);

    // Don't fall out of the world forever.
    if (this.pos.y < -20) {
      this.pos.set(this.pos.x, 80, this.pos.z);
      this.vel.set(0, 0, 0);
    }

    this.camera.position.copy(this.eye());
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  moveAxis(axis, delta) {
    if (delta === 0) return;
    this.pos[axis] += delta;

    const min = [this.pos.x - HALF_W, this.pos.y, this.pos.z - HALF_W];
    const max = [this.pos.x + HALF_W, this.pos.y + HEIGHT, this.pos.z + HALF_W];

    for (let by = Math.floor(min[1]); by < Math.ceil(max[1]); by++) {
      for (let bz = Math.floor(min[2]); bz < Math.ceil(max[2]); bz++) {
        for (let bx = Math.floor(min[0]); bx < Math.ceil(max[0]); bx++) {
          if (!isSolid(this.world.getBlock(bx, by, bz))) continue;
          if (axis === 'x') {
            this.pos.x = delta > 0 ? bx - HALF_W - EPS : bx + 1 + HALF_W + EPS;
            this.vel.x = 0;
          } else if (axis === 'z') {
            this.pos.z = delta > 0 ? bz - HALF_W - EPS : bz + 1 + HALF_W + EPS;
            this.vel.z = 0;
          } else if (delta > 0) {
            this.pos.y = by - HEIGHT - EPS;
            this.vel.y = 0;
          } else {
            this.pos.y = by + 1 + EPS;
            this.vel.y = 0;
            this.onGround = true;
          }
          return;
        }
      }
    }
  }

  // Amanatides & Woo voxel traversal from the eye along the view direction.
  // Returns the first solid block hit and the face normal it was entered
  // through (so the caller knows where a new block would be placed).
  raycast(maxDist = 6) {
    const origin = this.eye();
    const dir = this.lookDir();
    let [x, y, z] = [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)];
    const step = [Math.sign(dir.x), Math.sign(dir.y), Math.sign(dir.z)];
    const tDelta = [
      dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity,
      dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity,
      dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity,
    ];
    const tMax = [
      dir.x > 0 ? (x + 1 - origin.x) / dir.x : dir.x < 0 ? (x - origin.x) / dir.x : Infinity,
      dir.y > 0 ? (y + 1 - origin.y) / dir.y : dir.y < 0 ? (y - origin.y) / dir.y : Infinity,
      dir.z > 0 ? (z + 1 - origin.z) / dir.z : dir.z < 0 ? (z - origin.z) / dir.z : Infinity,
    ];
    let face = [0, 0, 0];
    let t = 0;

    while (t <= maxDist) {
      const id = this.world.getBlock(x, y, z);
      if (id !== AIR && id !== WATER) {
        return { x, y, z, id, face };
      }
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      t = tMax[axis];
      tMax[axis] += tDelta[axis];
      if (axis === 0) x += step[0];
      else if (axis === 1) y += step[1];
      else z += step[2];
      face = [0, 0, 0];
      face[axis] = -step[axis];
    }
    return null;
  }

  blockIntersectsPlayer(bx, by, bz) {
    return (
      bx + 1 > this.pos.x - HALF_W &&
      bx < this.pos.x + HALF_W &&
      by + 1 > this.pos.y &&
      by < this.pos.y + HEIGHT &&
      bz + 1 > this.pos.z - HALF_W &&
      bz < this.pos.z + HALF_W
    );
  }
}
