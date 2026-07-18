use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use noise::{NoiseFn, Perlin};

pub const CHUNK_SIZE: usize = 16;
pub const WORLD_HEIGHT: usize = 64;
pub const CHUNK_VOLUME: usize = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;
pub const SEA_LEVEL: i32 = 26;

pub mod block {
    pub const AIR: u8 = 0;
    pub const GRASS: u8 = 1;
    pub const DIRT: u8 = 2;
    pub const STONE: u8 = 3;
    pub const SAND: u8 = 4;
    pub const LOG: u8 = 5;
    pub const LEAVES: u8 = 6;
    pub const PLANKS: u8 = 7;
    pub const GLASS: u8 = 8;
    pub const WATER: u8 = 9;
    pub const COAL_ORE: u8 = 10;
    pub const IRON_ORE: u8 = 11;
    pub const GOLD_ORE: u8 = 12;
    /// Non-solid light source; crafted, never generated.
    pub const TORCH: u8 = 13;
    /// Food item: exists only in inventories and drops, never in the world.
    pub const APPLE: u8 = 14;
    /// Wall-mounted torch variants, named for the side of the cell holding
    /// the supporting wall. One inventory item (TORCH) covers them all —
    /// placement picks the variant, breaking drops the plain torch.
    pub const TORCH_WALL_PX: u8 = 15;
    pub const TORCH_WALL_NX: u8 = 16;
    pub const TORCH_WALL_PZ: u8 = 17;
    pub const TORCH_WALL_NZ: u8 = 18;

    pub fn is_torch(id: u8) -> bool {
        matches!(id, TORCH | TORCH_WALL_PX | TORCH_WALL_NX | TORCH_WALL_PZ | TORCH_WALL_NZ)
    }

    /// Blocks a client is allowed to place. Water flows only from world gen.
    /// Ores are placeable so mined ore isn't a dead item (no crafting yet).
    pub fn placeable(id: u8) -> bool {
        matches!(
            id,
            GRASS | DIRT | STONE | SAND | LOG | LEAVES | PLANKS | GLASS
                | COAL_ORE | IRON_ORE | GOLD_ORE
        ) || is_torch(id)
    }
}

pub struct Chunk {
    /// Indexed as (y * CHUNK_SIZE + z) * CHUNK_SIZE + x
    pub blocks: Vec<u8>,
}

impl Chunk {
    fn new() -> Self {
        Chunk {
            blocks: vec![block::AIR; CHUNK_VOLUME],
        }
    }

    #[inline]
    fn idx(x: usize, y: usize, z: usize) -> usize {
        (y * CHUNK_SIZE + z) * CHUNK_SIZE + x
    }

    pub fn get(&self, x: usize, y: usize, z: usize) -> u8 {
        self.blocks[Self::idx(x, y, z)]
    }

    pub fn set(&mut self, x: usize, y: usize, z: usize, id: u8) {
        self.blocks[Self::idx(x, y, z)] = id;
    }
}

pub struct World {
    seed: u32,
    noise: Perlin,
    cave: Perlin,
    tunnel: Perlin,
    chunks: HashMap<(i32, i32), Chunk>,
    /// World positions of every torch in loaded chunks, so spawn checks
    /// don't have to scan blocks. Chunks are never evicted server-side.
    torches: HashSet<(i32, i32, i32)>,
    save_dir: PathBuf,
}

impl World {
    pub fn new(seed: u32, save_dir: PathBuf) -> Self {
        fs::create_dir_all(&save_dir).expect("failed to create world save dir");
        World {
            seed,
            noise: Perlin::new(seed),
            cave: Perlin::new(seed.wrapping_add(1)),
            tunnel: Perlin::new(seed.wrapping_add(2)),
            chunks: HashMap::new(),
            torches: HashSet::new(),
            save_dir,
        }
    }

    pub fn saved_chunk_count(&self) -> usize {
        fs::read_dir(&self.save_dir).map(|d| d.count()).unwrap_or(0)
    }

    fn chunk_path(&self, cx: i32, cz: i32) -> PathBuf {
        self.save_dir.join(format!("c{cx}_{cz}.bin"))
    }

    /// Edited chunks are stored as raw block arrays, one file per chunk.
    /// Untouched chunks have no file and keep regenerating from the seed.
    fn load(&self, cx: i32, cz: i32) -> Option<Chunk> {
        let blocks = fs::read(self.chunk_path(cx, cz)).ok()?;
        (blocks.len() == CHUNK_VOLUME).then_some(Chunk { blocks })
    }

    fn persist(&self, cx: i32, cz: i32) {
        let Some(chunk) = self.chunks.get(&(cx, cz)) else {
            return;
        };
        if let Err(e) = fs::write(self.chunk_path(cx, cz), &chunk.blocks) {
            eprintln!("failed to save chunk ({cx},{cz}): {e}");
        }
    }

    /// Terrain height (top solid block y) at world column (wx, wz).
    fn height_at(&self, wx: i32, wz: i32) -> i32 {
        let f = 0.012;
        let x = wx as f64 * f;
        let z = wz as f64 * f;
        let n = self.noise.get([x, z])
            + 0.5 * self.noise.get([x * 2.0 + 100.0, z * 2.0 + 100.0])
            + 0.25 * self.noise.get([x * 4.0 + 200.0, z * 4.0 + 200.0]);
        let n = n / 1.75; // normalize to roughly -1..1
        let h = 26.0 + n * 14.0;
        (h as i32).clamp(4, WORLD_HEIGHT as i32 - 12)
    }

    /// Deterministic per-column hash used for tree placement.
    fn column_hash(&self, wx: i32, wz: i32) -> u32 {
        self.hash(&[wx as u32, wz as u32])
    }

    /// Per-cell hash used for ore veins (fed 2x2x2 block cell coordinates).
    fn cell_hash(&self, x: i32, y: i32, z: i32) -> u32 {
        self.hash(&[x as u32, y as u32, z as u32])
    }

    fn hash(&self, vals: &[u32]) -> u32 {
        let mut h = self.seed ^ 0x9e37_79b9;
        for &v in vals {
            h ^= v.wrapping_mul(0x85eb_ca6b);
            h = h.rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64);
        }
        h ^= h >> 16;
        h = h.wrapping_mul(0x7feb_352d);
        h ^= h >> 15;
        h
    }

    fn generate(&self, cx: i32, cz: i32) -> Chunk {
        let mut chunk = Chunk::new();
        let mut heights = [0i32; CHUNK_SIZE * CHUNK_SIZE];

        for lz in 0..CHUNK_SIZE {
            for lx in 0..CHUNK_SIZE {
                let wx = cx * CHUNK_SIZE as i32 + lx as i32;
                let wz = cz * CHUNK_SIZE as i32 + lz as i32;
                let h = self.height_at(wx, wz);
                heights[lz * CHUNK_SIZE + lx] = h;

                for y in 0..=h.min(WORLD_HEIGHT as i32 - 1) {
                    let id = if y == h {
                        if h <= SEA_LEVEL + 1 {
                            block::SAND
                        } else {
                            block::GRASS
                        }
                    } else if y >= h - 3 {
                        if h <= SEA_LEVEL + 1 {
                            block::SAND
                        } else {
                            block::DIRT
                        }
                    } else {
                        block::STONE
                    };
                    chunk.set(lx, y as usize, lz, id);
                }

                // Fill oceans/lakes up to sea level.
                for y in (h + 1)..=SEA_LEVEL {
                    if y >= 0 && (y as usize) < WORLD_HEIGHT {
                        chunk.set(lx, y as usize, lz, block::WATER);
                    }
                }
            }
        }

        // Caves and ores. Caverns open up where 3D noise runs hot; winding
        // tunnels where two noise fields cross zero together. Ocean and lake
        // floors keep a 3-block seal (there is no fluid sim, so water must
        // never sit on carved air). Ore veins come from hashing 2x2x2 cells
        // so they clump instead of scattering single blocks.
        for lz in 0..CHUNK_SIZE {
            for lx in 0..CHUNK_SIZE {
                let wx = cx * CHUNK_SIZE as i32 + lx as i32;
                let wz = cz * CHUNK_SIZE as i32 + lz as i32;
                let h = heights[lz * CHUNK_SIZE + lx];
                let top = if h <= SEA_LEVEL + 1 { h - 3 } else { h };

                for y in 2..=top.min(WORLD_HEIGHT as i32 - 1) {
                    let (fx, fy, fz) = (wx as f64, y as f64, wz as f64);
                    let cavern = self.cave.get([fx * 0.075, fy * 0.11, fz * 0.075]) > 0.58;
                    let tunnel = self.cave.get([fx * 0.045, fy * 0.06, fz * 0.045]).abs() < 0.075
                        && self.tunnel.get([fx * 0.045, fy * 0.06, fz * 0.045]).abs() < 0.075;
                    if cavern || tunnel {
                        chunk.set(lx, y as usize, lz, block::AIR);
                        continue;
                    }

                    if chunk.get(lx, y as usize, lz) != block::STONE {
                        continue;
                    }
                    let cell = self.cell_hash(wx >> 1, y >> 1, wz >> 1);
                    let ore = if y <= 14 && cell % 130 == 0 {
                        block::GOLD_ORE
                    } else if y <= 28 && cell % 70 == 0 {
                        block::IRON_ORE
                    } else if y <= 40 && cell % 40 == 0 {
                        block::COAL_ORE
                    } else {
                        continue;
                    };
                    chunk.set(lx, y as usize, lz, ore);
                }
            }
        }

        // Trees: only where the whole canopy (radius 2) fits inside this chunk,
        // so generation never depends on neighboring chunks.
        for lz in 2..CHUNK_SIZE - 2 {
            for lx in 2..CHUNK_SIZE - 2 {
                let wx = cx * CHUNK_SIZE as i32 + lx as i32;
                let wz = cz * CHUNK_SIZE as i32 + lz as i32;
                let h = heights[lz * CHUNK_SIZE + lx];
                if h <= SEA_LEVEL + 1 {
                    continue; // no trees on beaches or under water
                }
                if chunk.get(lx, h as usize, lz) != block::GRASS {
                    continue; // surface was carved away by a cave mouth
                }
                let hash = self.column_hash(wx, wz);
                if hash % 97 != 0 {
                    continue;
                }
                let trunk_h = 4 + (hash >> 8) % 3; // 4..6
                let top = h + trunk_h as i32;
                if top as usize + 2 >= WORLD_HEIGHT {
                    continue;
                }

                for dy in 1..=trunk_h as i32 {
                    chunk.set(lx, (h + dy) as usize, lz, block::LOG);
                }
                // Two wide leaf layers below the top, then a small cap.
                for (dy, r) in [(-1i32, 2i32), (0, 2), (1, 1), (2, 1)] {
                    let y = top + dy;
                    for dz in -r..=r {
                        for dx in -r..=r {
                            if dx == 0 && dz == 0 && dy <= 0 {
                                continue; // trunk occupies the center
                            }
                            if dx.abs() == r && dz.abs() == r && r == 2 {
                                continue; // clip corners for a rounder canopy
                            }
                            let (px, py, pz) =
                                ((lx as i32 + dx) as usize, y as usize, (lz as i32 + dz) as usize);
                            if chunk.get(px, py, pz) == block::AIR {
                                chunk.set(px, py, pz, block::LEAVES);
                            }
                        }
                    }
                }
            }
        }

        chunk
    }

    pub fn chunk(&mut self, cx: i32, cz: i32) -> &Chunk {
        if !self.chunks.contains_key(&(cx, cz)) {
            let c = self.load(cx, cz).unwrap_or_else(|| self.generate(cx, cz));
            // Torches only exist in saved player edits, but scanning every
            // fresh chunk keeps the registry unconditionally right.
            for y in 0..WORLD_HEIGHT {
                for z in 0..CHUNK_SIZE {
                    for x in 0..CHUNK_SIZE {
                        if block::is_torch(c.get(x, y, z)) {
                            self.torches.insert((
                                cx * CHUNK_SIZE as i32 + x as i32,
                                y as i32,
                                cz * CHUNK_SIZE as i32 + z as i32,
                            ));
                        }
                    }
                }
            }
            self.chunks.insert((cx, cz), c);
        }
        &self.chunks[&(cx, cz)]
    }

    pub fn set_block(&mut self, x: i32, y: i32, z: i32, id: u8) -> bool {
        if y < 0 || y as usize >= WORLD_HEIGHT {
            return false;
        }
        let (cx, cz) = (
            x.div_euclid(CHUNK_SIZE as i32),
            z.div_euclid(CHUNK_SIZE as i32),
        );
        self.chunk(cx, cz); // make sure it exists
        let chunk = self.chunks.get_mut(&(cx, cz)).unwrap();
        let (lx, ly, lz) = (
            x.rem_euclid(CHUNK_SIZE as i32) as usize,
            y as usize,
            z.rem_euclid(CHUNK_SIZE as i32) as usize,
        );
        if block::is_torch(chunk.get(lx, ly, lz)) {
            self.torches.remove(&(x, y, z));
        }
        if block::is_torch(id) {
            self.torches.insert((x, y, z));
        }
        chunk.set(lx, ly, lz, id);
        self.persist(cx, cz);
        true
    }

    /// Any torch within `r` blocks (3D)? Hostile mobs won't spawn in its
    /// light.
    pub fn torch_near(&self, pos: [f32; 3], r: f32) -> bool {
        let r2 = r * r;
        self.torches.iter().any(|&(tx, ty, tz)| {
            let d = [tx as f32 + 0.5 - pos[0], ty as f32 - pos[1], tz as f32 + 0.5 - pos[2]];
            d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < r2
        })
    }

    pub fn block_at(&mut self, x: i32, y: i32, z: i32) -> u8 {
        if y < 0 || y as usize >= WORLD_HEIGHT {
            return block::AIR;
        }
        let (cx, cz) = (
            x.div_euclid(CHUNK_SIZE as i32),
            z.div_euclid(CHUNK_SIZE as i32),
        );
        self.chunk(cx, cz).get(
            x.rem_euclid(CHUNK_SIZE as i32) as usize,
            y as usize,
            z.rem_euclid(CHUNK_SIZE as i32) as usize,
        )
    }

    /// Highest solid (non-air, non-water, non-torch) block in a column.
    pub fn surface_y(&mut self, x: i32, z: i32) -> Option<i32> {
        (0..WORLD_HEIGHT as i32).rev().find(|&y| {
            let id = self.block_at(x, y, z);
            id != block::AIR && id != block::WATER && !block::is_torch(id)
        })
    }

    /// A safe place to drop a new player: on top of the terrain near origin.
    pub fn spawn_point(&mut self) -> [f32; 3] {
        let (x, z) = (8, 8);
        let h = self.height_at(x, z).max(SEA_LEVEL);
        [x as f32 + 0.5, h as f32 + 2.5, z as f32 + 0.5]
    }
}
