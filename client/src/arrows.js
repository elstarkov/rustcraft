import * as THREE from 'three';

// Skeleton arrows: thin dark shafts oriented along their flight path,
// interpolating between the server's 10 Hz position batches. Geometry and
// material are shared and never disposed.

const shaftGeo = new THREE.BoxGeometry(0.05, 0.05, 0.6);
const shaftMat = new THREE.MeshLambertMaterial({ color: 0x5d4a33 });
const Z = new THREE.Vector3(0, 0, 1);

export class RemoteArrows {
  constructor(scene) {
    this.scene = scene;
    this.arrows = new Map(); // id -> { mesh, target }
  }

  add(id, pos, vel) {
    if (this.arrows.has(id)) this.remove(id);
    const mesh = new THREE.Mesh(shaftGeo, shaftMat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    this.orient(mesh, new THREE.Vector3(vel[0], vel[1], vel[2]));
    this.scene.add(mesh);
    this.arrows.set(id, { mesh, target: mesh.position.clone() });
  }

  orient(mesh, dir) {
    if (dir.lengthSq() < 1e-6) return;
    mesh.quaternion.setFromUnitVectors(Z, dir.normalize());
  }

  updateAll(list) {
    for (const [id, x, y, z] of list) {
      const a = this.arrows.get(id);
      if (!a) continue;
      const next = new THREE.Vector3(x, y, z);
      this.orient(a.mesh, next.clone().sub(a.target));
      a.target.copy(next);
    }
  }

  remove(id) {
    const a = this.arrows.get(id);
    if (!a) return;
    this.scene.remove(a.mesh); // shared resources stay
    this.arrows.delete(id);
  }

  clear() {
    for (const id of [...this.arrows.keys()]) this.remove(id);
  }

  update(dt) {
    const k = Math.min(dt * 12, 1);
    for (const a of this.arrows.values()) {
      a.mesh.position.lerp(a.target, k);
    }
  }
}
