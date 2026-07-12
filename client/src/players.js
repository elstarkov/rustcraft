import * as THREE from 'three';

// Renders other connected players as simple colored figures with name tags.
export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map(); // id -> { group, target: Vector3, yaw }
  }

  add(id, name, pos) {
    if (this.players.has(id)) this.remove(id);
    const color = new THREE.Color().setHSL(((id * 137.5) % 360) / 360, 0.6, 0.5);
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.2, 0.35),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = 0.6;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshLambertMaterial({ color: color.clone().offsetHSL(0, 0, 0.15) }),
    );
    head.position.y = 1.45;
    group.add(body, head);
    group.add(this.makeNameTag(name));

    group.position.set(pos[0], pos[1], pos[2]);
    this.scene.add(group);
    this.players.set(id, { group, target: new THREE.Vector3(...pos), yaw: 0 });
  }

  makeNameTag(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const w = ctx.measureText(name).width + 16;
    ctx.fillRect((256 - w) / 2, 4, w, 40);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, 128, 33);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false }),
    );
    sprite.scale.set(2, 0.375, 1);
    sprite.position.y = 2.1;
    return sprite;
  }

  updatePos(id, x, y, z, yaw) {
    const p = this.players.get(id);
    if (!p) return;
    p.target.set(x, y, z);
    p.yaw = yaw;
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.map?.dispose();
      obj.material?.dispose();
    });
    this.players.delete(id);
  }

  update(dt) {
    // Smooth toward the latest network position.
    const k = Math.min(dt * 12, 1);
    for (const p of this.players.values()) {
      p.group.position.lerp(p.target, k);
      p.group.rotation.y += (p.yaw - p.group.rotation.y) * k;
    }
  }
}
