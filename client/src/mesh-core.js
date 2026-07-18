// Greedy chunk mesher — pure data in, typed arrays out. No THREE imports so
// it can run inside the mesh worker (and mirrors what a wasm port needs).
//
// Faces visible under the same rule as before (air or a different see-through
// neighbor), then coplanar faces with the same atlas tile and transparency
// class merge into maximal rectangles. Texture tiling across merged quads is
// resolved in the fragment shader: uvs here are in block units and the `tile`
// vertex attribute picks the atlas tile (see makeMaterials in mesher.js).

import {
  AIR, BLOCKS, CHUNK_SIZE, WORLD_HEIGHT, isSeeThrough, isTorch,
} from './blocks.js';

// Torches aren't cubes: the mesher emits nothing for them (torches.js
// renders a model per torch) and neighbors treat them like air.
const skip = (b) => b === AIR || isTorch(b);

const SHADE = { nx: 0.8, px: 0.8, ny: 0.55, py: 1.0, nz: 0.7, pz: 0.7 };

function faceTile(block, axis, sign) {
  const tiles = BLOCKS[block].tiles; // [top, bottom, side]
  if (axis === 1) return sign > 0 ? tiles[0] : tiles[1];
  return tiles[2];
}

function faceVisible(block, neighbor) {
  if (neighbor === AIR) return true;
  return isSeeThrough(neighbor) && neighbor !== block;
}

class QuadSink {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.tiles = [];
    this.colors = [];
    this.indices = [];
  }

  // Four corners in the fixed (0,1,2),(2,1,3) outward winding, uv in block units.
  quad(corners, uvs, normal, tile, shade) {
    const start = this.positions.length / 3;
    for (let i = 0; i < 4; i++) {
      this.positions.push(...corners[i]);
      this.normals.push(...normal);
      this.uvs.push(...uvs[i]);
      this.tiles.push(tile);
      this.colors.push(shade, shade, shade);
    }
    this.indices.push(start, start + 1, start + 2, start + 2, start + 1, start + 3);
  }

  build() {
    if (this.indices.length === 0) return null;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      tiles: new Float32Array(this.tiles),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
    };
  }
}

// Sweep one mask (U x V cells of merge keys) into maximal rectangles.
function greedy(mask, U, V, emit) {
  for (let v = 0; v < V; v++) {
    for (let u = 0; u < U; u++) {
      const k = mask[v * U + u];
      if (k === 0) continue;
      let w = 1;
      while (u + w < U && mask[v * U + u + w] === k) w++;
      let h = 1;
      outer: while (v + h < V) {
        for (let i = 0; i < w; i++) {
          if (mask[(v + h) * U + u + i] !== k) break outer;
        }
        h++;
      }
      emit(u, v, w, h, k);
      for (let dv = 0; dv < h; dv++) {
        for (let du = 0; du < w; du++) mask[(v + dv) * U + u + du] = 0;
      }
      u += w - 1;
    }
  }
}

// Merge key: atlas tile + transparency class, 0 reserved for "no face".
function keyFor(block, axis, sign) {
  const tile = faceTile(block, axis, sign);
  const transparent = BLOCKS[block]?.seeThrough ? 1 : 0;
  return tile * 2 + transparent + 1;
}

export function meshChunkData(cx, cz, blocks, borders) {
  const S = CHUNK_SIZE;
  const H = WORLD_HEIGHT;
  const baseX = cx * S;
  const baseZ = cz * S;

  const get = (x, y, z) => {
    if (y < 0 || y >= H) return AIR;
    if (x < 0) return borders.nx ? borders.nx[y * S + z] : AIR;
    if (x >= S) return borders.px ? borders.px[y * S + z] : AIR;
    if (z < 0) return borders.nz ? borders.nz[y * S + x] : AIR;
    if (z >= S) return borders.pz ? borders.pz[y * S + x] : AIR;
    return blocks[(y * S + z) * S + x];
  };

  const opaque = new QuadSink();
  const transparent = new QuadSink();
  const sinkFor = (k) => (k % 2 === 0 ? transparent : opaque); // key parity carries the class
  const mask = new Int32Array(S * H); // biggest mask; y-slices use S*S of it

  // X faces: slices x, mask (u=z, v=y).
  for (const sign of [-1, 1]) {
    const shade = SHADE[sign < 0 ? 'nx' : 'px'];
    const normal = [sign, 0, 0];
    for (let x = 0; x < S; x++) {
      let any = 0;
      for (let y = 0; y < H; y++) {
        for (let z = 0; z < S; z++) {
          const b = get(x, y, z);
          const visible = !skip(b) && faceVisible(b, get(x + sign, y, z));
          mask[y * S + z] = visible ? (any = keyFor(b, 0, sign)) : 0;
        }
      }
      if (!any) continue;
      const px = baseX + x + (sign > 0 ? 1 : 0);
      greedy(mask, S, H, (z0, y0, w, h, k) => {
        const z = baseZ + z0;
        const corners = sign < 0
          ? [[px, y0 + h, z], [px, y0, z], [px, y0 + h, z + w], [px, y0, z + w]]
          : [[px, y0 + h, z + w], [px, y0, z + w], [px, y0 + h, z], [px, y0, z]];
        sinkFor(k).quad(corners, [[0, h], [0, 0], [w, h], [w, 0]], normal, (k - 1) >> 1, shade);
      });
    }
  }

  // Z faces: slices z, mask (u=x, v=y).
  for (const sign of [-1, 1]) {
    const shade = SHADE[sign < 0 ? 'nz' : 'pz'];
    const normal = [0, 0, sign];
    for (let z = 0; z < S; z++) {
      let any = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < S; x++) {
          const b = get(x, y, z);
          const visible = !skip(b) && faceVisible(b, get(x, y, z + sign));
          mask[y * S + x] = visible ? (any = keyFor(b, 2, sign)) : 0;
        }
      }
      if (!any) continue;
      const pz = baseZ + z + (sign > 0 ? 1 : 0);
      greedy(mask, S, H, (x0, y0, w, h, k) => {
        const x = baseX + x0;
        const corners = sign < 0
          ? [[x + w, y0, pz], [x, y0, pz], [x + w, y0 + h, pz], [x, y0 + h, pz]]
          : [[x, y0, pz], [x + w, y0, pz], [x, y0 + h, pz], [x + w, y0 + h, pz]];
        sinkFor(k).quad(corners, [[0, 0], [w, 0], [0, h], [w, h]], normal, (k - 1) >> 1, shade);
      });
    }
  }

  // Y faces: slices y, mask (u=x, v=z).
  for (const sign of [-1, 1]) {
    const shade = SHADE[sign < 0 ? 'ny' : 'py'];
    const normal = [0, sign, 0];
    for (let y = 0; y < H; y++) {
      let any = 0;
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const b = get(x, y, z);
          const visible = !skip(b) && faceVisible(b, get(x, y + sign, z));
          mask[z * S + x] = visible ? (any = keyFor(b, 1, sign)) : 0;
        }
      }
      if (!any) continue;
      const py = y + (sign > 0 ? 1 : 0);
      greedy(mask, S, S, (x0, z0, w, h, k) => {
        const x = baseX + x0;
        const z = baseZ + z0;
        const corners = sign < 0
          ? [[x + w, py, z + h], [x, py, z + h], [x + w, py, z], [x, py, z]]
          : [[x, py, z + h], [x + w, py, z + h], [x, py, z], [x + w, py, z]];
        sinkFor(k).quad(corners, [[w, 0], [0, 0], [w, h], [0, h]], normal, (k - 1) >> 1, shade);
      });
    }
  }

  return { opaque: opaque.build(), transparent: transparent.build() };
}

// Border slices a chunk's mesh needs from its four neighbors: the one-block
// column facing this chunk, indexed [y * CHUNK_SIZE + (z|x)]. Null when the
// neighbor isn't loaded (treated as air, same as before).
export function borderSlices(getChunk, cx, cz) {
  const S = CHUNK_SIZE;
  const slice = (chunk, pick) => {
    if (!chunk) return null;
    const out = new Uint8Array(S * WORLD_HEIGHT);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let i = 0; i < S; i++) out[y * S + i] = chunk[pick(y, i)];
    }
    return out;
  };
  return {
    nx: slice(getChunk(cx - 1, cz), (y, z) => (y * S + z) * S + (S - 1)),
    px: slice(getChunk(cx + 1, cz), (y, z) => (y * S + z) * S),
    nz: slice(getChunk(cx, cz - 1), (y, x) => (y * S + (S - 1)) * S + x),
    pz: slice(getChunk(cx, cz + 1), (y, x) => (y * S) * S + x),
  };
}
