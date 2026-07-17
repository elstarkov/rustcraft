import * as THREE from 'three';

// Renders other connected players as blocky avatars: head, body, arms and
// legs, with a deterministic per-id skin (shirt/pants palette, skin tone,
// hair, pixel face) and a walk cycle driven by how fast the avatar actually
// moves. The group origin is at the feet, matching the server's player pos.

const WALK_SPEED = 5.6; // full swing at the local player's walk speed

export function makePalette(id) {
  const hue = ((id * 137.5) % 360) / 360;
  const tones = [[236, 188, 148], [214, 160, 116], [166, 116, 78], [124, 82, 54]];
  const hairs = [0x2c2018, 0x53402a, 0x8a6a3c, 0x1a1a1e, 0x5f2f16];
  const [r, g, b] = tones[id % tones.length];
  return {
    shirt: new THREE.Color().setHSL(hue, 0.6, 0.48),
    pants: new THREE.Color().setHSL((hue + 0.52) % 1, 0.38, 0.3),
    skin: new THREE.Color(r / 255, g / 255, b / 255),
    hair: new THREE.Color(hairs[id % hairs.length]),
  };
}

// 8x8 pixel face: skin base, hair fringe, eyes, mouth.
export function makeFaceTexture(palette) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `#${palette.skin.getHexString()}`;
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = `#${palette.hair.getHexString()}`;
  ctx.fillRect(0, 0, 8, 2);
  ctx.fillRect(0, 2, 1, 1);
  ctx.fillRect(7, 2, 1, 1);
  ctx.fillStyle = palette.sclera ?? '#ffffff';
  ctx.fillRect(1, 3, 2, 1);
  ctx.fillRect(5, 3, 2, 1);
  ctx.fillStyle = palette.eyes ?? '#4a3ba0';
  ctx.fillRect(2, 3, 1, 1);
  ctx.fillRect(5, 3, 1, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(3, 6, 2, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A limb rotates around its pivot, so the geometry hangs below it.
function limb(w, h, d, material, x, pivotY) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, pivotY, 0);
  return mesh;
}

export function buildHumanoid(palette) {
  const skinMat = new THREE.MeshLambertMaterial({ color: palette.skin });
  const hairMat = new THREE.MeshLambertMaterial({ color: palette.hair });
  const shirtMat = new THREE.MeshLambertMaterial({ color: palette.shirt });
  const pantsMat = new THREE.MeshLambertMaterial({ color: palette.pants });
  const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(palette) });

  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.7, 0.3), shirtMat);
  body.position.y = 1.1;

  // Head pivots at the neck so pitch nods it; the face looks down -z,
  // the direction yaw = 0 walks.
  const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  headGeo.translate(0, 0.25, 0);
  const head = new THREE.Mesh(headGeo, [skinMat, skinMat, hairMat, skinMat, hairMat, faceMat]);
  head.position.y = 1.45;

  const legL = limb(0.24, 0.75, 0.24, pantsMat, -0.14, 0.75);
  const legR = limb(0.24, 0.75, 0.24, pantsMat, 0.14, 0.75);
  const armL = limb(0.2, 0.66, 0.2, shirtMat, -0.39, 1.4);
  const armR = limb(0.2, 0.66, 0.2, shirtMat, 0.39, 1.4);

  group.add(body, head, legL, legR, armL, armR);
  return { group, head, legL, legR, armL, armR };
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map(); // id -> avatar parts + interpolation state
  }

  add(id, name, pos) {
    if (this.players.has(id)) this.remove(id);
    const avatar = buildHumanoid(makePalette(id));
    avatar.group.add(this.makeNameTag(name));
    avatar.group.position.set(pos[0], pos[1], pos[2]);
    this.scene.add(avatar.group);
    this.players.set(id, {
      ...avatar,
      name,
      target: new THREE.Vector3(...pos),
      yaw: 0,
      pitch: 0,
      phase: 0,
      speed: 0,
    });
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
    sprite.position.y = 2.25;
    return sprite;
  }

  updatePos(id, x, y, z, yaw, pitch = 0) {
    const p = this.players.get(id);
    if (!p) return;
    p.target.set(x, y, z);
    p.yaw = yaw;
    p.pitch = pitch;
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((obj) => {
      obj.geometry?.dispose();
      for (const mat of [].concat(obj.material ?? [])) {
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.players.delete(id);
  }

  update(dt) {
    const k = Math.min(dt * 12, 1);
    for (const p of this.players.values()) {
      const px = p.group.position.x;
      const pz = p.group.position.z;
      p.group.position.lerp(p.target, k);

      // Walk cycle paced by actual horizontal motion, eased so it doesn't
      // snap when updates arrive in bursts.
      const moved = Math.hypot(p.group.position.x - px, p.group.position.z - pz);
      const speed = moved / Math.max(dt, 1e-4);
      p.speed += (speed - p.speed) * Math.min(dt * 8, 1);
      p.phase += p.speed * dt * 2.6;
      const swing = Math.sin(p.phase) * 0.7 * Math.min(p.speed / WALK_SPEED, 1);
      p.legL.rotation.x = swing;
      p.legR.rotation.x = -swing;
      p.armL.rotation.x = -swing * 0.8;
      p.armR.rotation.x = swing * 0.8;

      // Turn the short way around when yaw wraps past +-PI.
      let dyaw = p.yaw - p.group.rotation.y;
      dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
      p.group.rotation.y += dyaw * k;
      p.head.rotation.x += (p.pitch - p.head.rotation.x) * k;
    }
  }
}
