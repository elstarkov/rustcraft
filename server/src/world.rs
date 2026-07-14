use std::collections::HashMap;
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

    /// Blocks a client is allowed to place. Water flows only from world gen.
    pub fn placeable(id: u8) -> bool {
        matches!(id, GRASS | DIRT | STONE | SAND | LOG | LEAVES | PLANKS | GLASS)
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
    chunks: HashMap<(i32, i32), Chunk>,
    save_dir: PathBuf,
}

impl World {
    pub fn new(seed: u32, save_dir: PathBuf) -> Self {
        fs::create_dir_all(&save_dir).expect("failed to create world save dir");
        World {
            seed,
            noise: Perlin::new(seed),
            chunks: HashMap::new(),
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
        let mut h = self.seed ^ 0x9e37_79b9;
        for v in [wx as u32, wz as u32] {
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

        for lz in 0..CHUNK_SIZE {
            for lx in 0..CHUNK_SIZE {
                let wx = cx * CHUNK_SIZE as i32 + lx as i32;
                let wz = cz * CHUNK_SIZE as i32 + lz as i32;
                let h = self.height_at(wx, wz);

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

        // Trees: only where the whole canopy (radius 2) fits inside this chunk,
        // so generation never depends on neighboring chunks.
        for lz in 2..CHUNK_SIZE - 2 {
            for lx in 2..CHUNK_SIZE - 2 {
                let wx = cx * CHUNK_SIZE as i32 + lx as i32;
                let wz = cz * CHUNK_SIZE as i32 + lz as i32;
                let h = self.height_at(wx, wz);
                if h <= SEA_LEVEL + 1 {
                    continue; // no trees on beaches or under water
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
        chunk.set(
            x.rem_euclid(CHUNK_SIZE as i32) as usize,
            y as usize,
            z.rem_euclid(CHUNK_SIZE as i32) as usize,
            id,
        );
        self.persist(cx, cz);
        true
    }

    /// A safe place to drop a new player: on top of the terrain near origin.
    pub fn spawn_point(&mut self) -> [f32; 3] {
        let (x, z) = (8, 8);
        let h = self.height_at(x, z).max(SEA_LEVEL);
        [x as f32 + 0.5, h as f32 + 2.5, z as f32 + 0.5]
    }
}
