import * as THREE from 'three';
import { APPLE, TORCH } from './blocks.js';
import { blockGeometry, makeApple } from './blockgeo.js';
import { drawToolIcon } from './items.js';
import { makePalette } from './players.js';
import { makeTorch } from './torches.js';

// First-person hand: an arm holding the selected block or tool, rendered as
// a second pass into a tiny camera-space scene with the depth buffer cleared
// so it never clips into world geometry. Swings on use, bobs with movement,
// and matches the world's day/night light levels.

const SWING_SECONDS = 0.28;
const WALK_SPEED = 5.6; // must match player.js for a full-speed bob

export class ViewModel {
  constructor(atlas) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.05, 10,
    );
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x666677, 1.0);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.8);
    this.sun.position.set(0.4, 1, 0.6);
    this.scene.add(this.hemi, this.sun);

    this.blockMaterial = new THREE.MeshLambertMaterial({ map: atlas, transparent: true });
    this.skinMat = new THREE.MeshLambertMaterial({ color: 0xecbc94 });
    this.sleeveMat = new THREE.MeshLambertMaterial({ color: 0x2f7d5e });

    // The arm reaches from the bottom-right corner toward the crosshair;
    // the holder is where the held item sits, just past the wrist.
    this.group = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.55), this.skinMat);
    arm.position.set(0, -0.02, 0.14);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.2), this.sleeveMat);
    sleeve.position.set(0, -0.02, 0.38);
    this.holder = new THREE.Group();
    this.holder.position.set(0, 0.1, -0.16);
    this.group.add(arm, sleeve, this.holder);
    this.scene.add(this.group);

    this.basePos = new THREE.Vector3(0.5, -0.42, -0.85);
    this.baseRot = new THREE.Euler(0.18, 0.35, 0);

    this.geometries = new Map(); // block id -> held-cube geometry
    this.toolMaterials = new Map(); // tool kind -> icon material
    this.toolGeometry = new THREE.PlaneGeometry(0.42, 0.42);
    this.held = null;
    this.swingT = 1; // 1 = at rest
    this.bobPhase = 0;
  }

  /// Recolor the arm to the local player's avatar skin once the id is known.
  setPalette(id) {
    const p = makePalette(id);
    this.skinMat.color.copy(p.skin);
    this.sleeveMat.color.copy(p.shirt);
  }

  /// item is a hud entry: { block } or { tool }.
  setItem(item) {
    if (this.held) this.holder.remove(this.held); // resources are cached
    this.held = null;
    if (item?.block === TORCH) {
      this.held = makeTorch();
      this.held.scale.setScalar(0.8);
      this.held.position.y = -0.18; // model origin is at its base
    } else if (item?.block === APPLE) {
      this.held = makeApple();
      this.held.position.y = -0.12;
    } else if (item?.block != null) {
      if (!this.geometries.has(item.block)) {
        this.geometries.set(item.block, blockGeometry(item.block, 0.22));
      }
      this.held = new THREE.Mesh(this.geometries.get(item.block), this.blockMaterial);
      this.held.rotation.y = 0.5; // three-quarter view
    } else if (item?.tool) {
      this.held = new THREE.Mesh(this.toolGeometry, this.toolMaterial(item.tool.kind));
      this.held.position.set(0, 0.05, -0.02);
      this.held.rotation.z = -0.2;
    }
    if (this.held) this.holder.add(this.held);
  }

  toolMaterial(kind) {
    if (!this.toolMaterials.has(kind)) {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      drawToolIcon(canvas.getContext('2d'), kind);
      const tex = new THREE.CanvasTexture(canvas);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.toolMaterials.set(kind, new THREE.MeshLambertMaterial({
        map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide,
      }));
    }
    return this.toolMaterials.get(kind);
  }

  swing() {
    this.swingT = 0;
  }

  /// Follow the world lighting so the hand darkens at night too.
  matchLight(hemiIntensity, sunIntensity) {
    this.hemi.intensity = Math.max(0.25, hemiIntensity);
    this.sun.intensity = sunIntensity * 0.8;
  }

  update(dt, speed, miningActive) {
    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt / SWING_SECONDS);
    else if (miningActive) this.swingT = 0; // keep chopping while mining

    this.bobPhase += speed * dt * 2.2;
    const amp = Math.min(speed / WALK_SPEED, 1) * 0.035;
    const swing = Math.sin(this.swingT * Math.PI);

    this.group.position.copy(this.basePos);
    this.group.position.x += Math.sin(this.bobPhase) * amp;
    this.group.position.y += -Math.abs(Math.sin(this.bobPhase)) * amp * 0.8 - swing * 0.1;
    this.group.position.z -= swing * 0.15;
    this.group.rotation.set(
      this.baseRot.x - swing * 0.9,
      this.baseRot.y + swing * 0.25,
      0,
    );
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
