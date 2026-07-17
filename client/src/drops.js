import * as THREE from 'three';
import { TORCH } from './blocks.js';
import { blockGeometry } from './blockgeo.js';
import { makeTorch } from './torches.js';

// Dropped items streamed from the server: small textured cubes that spin
// and bob in place. The server position is the item's bottom; the mesh is
// centered, so rendering floats it half a cube (plus hover room) higher.

const SIZE = 0.28;

export class RemoteDrops {
  constructor(scene, atlas) {
    this.scene = scene;
    this.material = new THREE.MeshLambertMaterial({ map: atlas, transparent: true });
    this.geometries = new Map(); // block id -> shared geometry
    this.drops = new Map(); // drop id -> { mesh, target, phase }
    this.time = 0;
  }

  geometry(item) {
    if (!this.geometries.has(item)) this.geometries.set(item, blockGeometry(item, SIZE));
    return this.geometries.get(item);
  }

  add(id, item, pos) {
    if (this.drops.has(id)) this.remove(id);
    let mesh;
    if (item === TORCH) {
      mesh = makeTorch(); // a mini torch model, not a texture cube
      mesh.scale.setScalar(0.55);
    } else {
      mesh = new THREE.Mesh(this.geometry(item), this.material);
    }
    const target = new THREE.Vector3(pos[0], pos[1], pos[2]);
    mesh.position.copy(target);
    this.scene.add(mesh);
    this.drops.set(id, { item, mesh, target, phase: (id % 32) * 0.7 });
  }

  updateAll(list) {
    for (const [id, x, y, z] of list) {
      this.drops.get(id)?.target.set(x, y, z);
    }
  }

  remove(id) {
    const d = this.drops.get(id);
    if (!d) return;
    this.scene.remove(d.mesh); // geometry and material are shared — keep them
    this.drops.delete(id);
  }

  clear() {
    for (const id of [...this.drops.keys()]) this.remove(id);
  }

  update(dt) {
    this.time += dt;
    const k = Math.min(dt * 10, 1);
    for (const d of this.drops.values()) {
      const bob = Math.sin(this.time * 2.2 + d.phase) * 0.04;
      d.mesh.position.x += (d.target.x - d.mesh.position.x) * k;
      d.mesh.position.z += (d.target.z - d.mesh.position.z) * k;
      d.mesh.position.y += (d.target.y + SIZE / 2 + 0.08 + bob - d.mesh.position.y) * k;
      d.mesh.rotation.y = this.time * 1.6 + d.phase;
    }
  }
}
