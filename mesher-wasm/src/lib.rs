//! The client's greedy chunk mesher in Rust, compiled to wasm32-unknown-unknown
//! with a raw pointer ABI (no bindgen). It is a line-for-line port of
//! client/src/mesh-core.js and produces byte-identical geometry; the mesh
//! worker prefers it and falls back to the JS mesher if instantiation fails.
//!
//! Protocol: write 16384 chunk bytes (+ optional 16x64 border slices) at
//! `input_ptr()`, call `mesh(cx, cz, border_flags)`, then read twelve
//! (ptr, len) pairs from `header_ptr()` — positions/normals/uvs/tiles/colors
//! (f32) and indices (u32) for the opaque then transparent meshes.
//!
//! Single-threaded by construction (one worker, sequential calls), which is
//! what makes the static mut output buffers sound in practice.
#![allow(static_mut_refs)]

const S: usize = 16;
const H: usize = 64;
const VOLUME: usize = S * S * H;
const BORDER: usize = S * H; // one neighbor column slice, indexed [y * S + i]
const AIR: u8 = 0;

/// [top, bottom, side] atlas tiles per block id — must match client blocks.js.
const TILES: [[u32; 3]; 13] = [
    [0, 0, 0],    // air (unused)
    [0, 1, 2],    // grass
    [1, 1, 1],    // dirt
    [3, 3, 3],    // stone
    [4, 4, 4],    // sand
    [6, 6, 5],    // log
    [7, 7, 7],    // leaves
    [8, 8, 8],    // planks
    [9, 9, 9],    // glass
    [10, 10, 10], // water
    [11, 11, 11], // coal ore
    [12, 12, 12], // iron ore
    [13, 13, 13], // gold ore
];
const SEE_THROUGH: [bool; 13] = [
    true, false, false, false, false, false, false, false, true, true, false, false, false,
];

#[derive(Default)]
struct Sink {
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    tiles: Vec<f32>,
    colors: Vec<f32>,
    indices: Vec<u32>,
}

impl Sink {
    const fn new() -> Self {
        Sink {
            positions: Vec::new(),
            normals: Vec::new(),
            uvs: Vec::new(),
            tiles: Vec::new(),
            colors: Vec::new(),
            indices: Vec::new(),
        }
    }

    fn clear(&mut self) {
        self.positions.clear();
        self.normals.clear();
        self.uvs.clear();
        self.tiles.clear();
        self.colors.clear();
        self.indices.clear();
    }

    fn quad(
        &mut self,
        corners: [[f32; 3]; 4],
        uvs: [[f32; 2]; 4],
        normal: [f32; 3],
        tile: f32,
        shade: f32,
    ) {
        let start = (self.positions.len() / 3) as u32;
        for i in 0..4 {
            self.positions.extend_from_slice(&corners[i]);
            self.normals.extend_from_slice(&normal);
            self.uvs.extend_from_slice(&uvs[i]);
            self.tiles.push(tile);
            self.colors.extend_from_slice(&[shade, shade, shade]);
        }
        self.indices
            .extend_from_slice(&[start, start + 1, start + 2, start + 2, start + 1, start + 3]);
    }
}

static mut INPUT: [u8; VOLUME + 4 * BORDER] = [0; VOLUME + 4 * BORDER];
static mut OPAQUE: Sink = Sink::new();
static mut TRANSPARENT: Sink = Sink::new();
static mut HEADER: [u32; 24] = [0; 24];

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut u8 {
    unsafe { INPUT.as_mut_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn header_ptr() -> *const u32 {
    unsafe { HEADER.as_ptr() }
}

fn get(input: &[u8], flags: u32, x: i32, y: i32, z: i32) -> u8 {
    if y < 0 || y >= H as i32 {
        return AIR;
    }
    let y = y as usize;
    let border = |which: usize, i: i32| {
        if flags & (1 << which) == 0 {
            AIR
        } else {
            input[VOLUME + which * BORDER + y * S + i as usize]
        }
    };
    if x < 0 {
        return border(0, z);
    }
    if x >= S as i32 {
        return border(1, z);
    }
    if z < 0 {
        return border(2, x);
    }
    if z >= S as i32 {
        return border(3, x);
    }
    input[(y * S + z as usize) * S + x as usize]
}

fn face_visible(block: u8, neighbor: u8) -> bool {
    if neighbor == AIR {
        return true;
    }
    let st = SEE_THROUGH.get(neighbor as usize).copied().unwrap_or(false);
    st && neighbor != block
}

/// Merge key: atlas tile + transparency class, 0 reserved for "no face".
fn key_for(block: u8, axis: usize, sign: i32) -> u32 {
    let tiles = TILES.get(block as usize).unwrap_or(&[0, 0, 0]);
    let tile = if axis == 1 {
        if sign > 0 { tiles[0] } else { tiles[1] }
    } else {
        tiles[2]
    };
    let transparent = SEE_THROUGH.get(block as usize).copied().unwrap_or(false) as u32;
    tile * 2 + transparent + 1
}

fn greedy(mask: &mut [u32], u_len: usize, v_len: usize, mut emit: impl FnMut(usize, usize, usize, usize, u32)) {
    for v in 0..v_len {
        let mut u = 0;
        while u < u_len {
            let k = mask[v * u_len + u];
            if k == 0 {
                u += 1;
                continue;
            }
            let mut w = 1;
            while u + w < u_len && mask[v * u_len + u + w] == k {
                w += 1;
            }
            let mut h = 1;
            'grow: while v + h < v_len {
                for i in 0..w {
                    if mask[(v + h) * u_len + u + i] != k {
                        break 'grow;
                    }
                }
                h += 1;
            }
            emit(u, v, w, h, k);
            for dv in 0..h {
                for du in 0..w {
                    mask[(v + dv) * u_len + u + du] = 0;
                }
            }
            u += w;
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mesh(cx: i32, cz: i32, border_flags: u32) {
    let (input, opaque, transparent) = unsafe {
        OPAQUE.clear();
        TRANSPARENT.clear();
        (&INPUT[..], &mut OPAQUE, &mut TRANSPARENT)
    };
    let flags = border_flags;
    let base_x = cx * S as i32;
    let base_z = cz * S as i32;
    let mut mask = [0u32; S * H];
    // key parity carries the transparency class (see key_for)
    macro_rules! sink {
        ($k:expr) => {
            if $k % 2 == 0 { &mut *transparent } else { &mut *opaque }
        };
    }

    // X faces: slices x, mask (u=z, v=y).
    for sign in [-1i32, 1] {
        let shade = 0.8f32;
        let normal = [sign as f32, 0.0, 0.0];
        for x in 0..S as i32 {
            let mut any = false;
            for y in 0..H {
                for z in 0..S {
                    let b = get(input, flags, x, y as i32, z as i32);
                    let visible = b != AIR && face_visible(b, get(input, flags, x + sign, y as i32, z as i32));
                    mask[y * S + z] = if visible {
                        any = true;
                        key_for(b, 0, sign)
                    } else {
                        0
                    };
                }
            }
            if !any {
                continue;
            }
            let px = (base_x + x + i32::from(sign > 0)) as f32;
            greedy(&mut mask, S, H, |z0, y0, w, h, k| {
                let z = (base_z + z0 as i32) as f32;
                let (y0, w, h) = (y0 as f32, w as f32, h as f32);
                let corners = if sign < 0 {
                    [[px, y0 + h, z], [px, y0, z], [px, y0 + h, z + w], [px, y0, z + w]]
                } else {
                    [[px, y0 + h, z + w], [px, y0, z + w], [px, y0 + h, z], [px, y0, z]]
                };
                sink!(k).quad(corners, [[0.0, h], [0.0, 0.0], [w, h], [w, 0.0]], normal, ((k - 1) >> 1) as f32, shade);
            });
        }
    }

    // Z faces: slices z, mask (u=x, v=y).
    for sign in [-1i32, 1] {
        let shade = 0.7f32;
        let normal = [0.0, 0.0, sign as f32];
        for z in 0..S as i32 {
            let mut any = false;
            for y in 0..H {
                for x in 0..S {
                    let b = get(input, flags, x as i32, y as i32, z);
                    let visible = b != AIR && face_visible(b, get(input, flags, x as i32, y as i32, z + sign));
                    mask[y * S + x] = if visible {
                        any = true;
                        key_for(b, 2, sign)
                    } else {
                        0
                    };
                }
            }
            if !any {
                continue;
            }
            let pz = (base_z + z + i32::from(sign > 0)) as f32;
            greedy(&mut mask, S, H, |x0, y0, w, h, k| {
                let x = (base_x + x0 as i32) as f32;
                let (y0, w, h) = (y0 as f32, w as f32, h as f32);
                let corners = if sign < 0 {
                    [[x + w, y0, pz], [x, y0, pz], [x + w, y0 + h, pz], [x, y0 + h, pz]]
                } else {
                    [[x, y0, pz], [x + w, y0, pz], [x, y0 + h, pz], [x + w, y0 + h, pz]]
                };
                sink!(k).quad(corners, [[0.0, 0.0], [w, 0.0], [0.0, h], [w, h]], normal, ((k - 1) >> 1) as f32, shade);
            });
        }
    }

    // Y faces: slices y, mask (u=x, v=z).
    for sign in [-1i32, 1] {
        let shade = if sign < 0 { 0.55f32 } else { 1.0 };
        let normal = [0.0, sign as f32, 0.0];
        for y in 0..H as i32 {
            let mut any = false;
            for z in 0..S {
                for x in 0..S {
                    let b = get(input, flags, x as i32, y, z as i32);
                    let visible = b != AIR && face_visible(b, get(input, flags, x as i32, y + sign, z as i32));
                    mask[z * S + x] = if visible {
                        any = true;
                        key_for(b, 1, sign)
                    } else {
                        0
                    };
                }
            }
            if !any {
                continue;
            }
            let py = (y + i32::from(sign > 0)) as f32;
            greedy(&mut mask, S, S, |x0, z0, w, h, k| {
                let x = (base_x + x0 as i32) as f32;
                let z = (base_z + z0 as i32) as f32;
                let (w, h) = (w as f32, h as f32);
                let corners = if sign < 0 {
                    [[x + w, py, z + h], [x, py, z + h], [x + w, py, z], [x, py, z]]
                } else {
                    [[x, py, z + h], [x + w, py, z + h], [x, py, z], [x + w, py, z]]
                };
                sink!(k).quad(corners, [[w, 0.0], [0.0, 0.0], [w, h], [0.0, h]], normal, ((k - 1) >> 1) as f32, shade);
            });
        }
    }

    unsafe {
        HEADER = [
            OPAQUE.positions.as_ptr() as u32, OPAQUE.positions.len() as u32,
            OPAQUE.normals.as_ptr() as u32, OPAQUE.normals.len() as u32,
            OPAQUE.uvs.as_ptr() as u32, OPAQUE.uvs.len() as u32,
            OPAQUE.tiles.as_ptr() as u32, OPAQUE.tiles.len() as u32,
            OPAQUE.colors.as_ptr() as u32, OPAQUE.colors.len() as u32,
            OPAQUE.indices.as_ptr() as u32, OPAQUE.indices.len() as u32,
            TRANSPARENT.positions.as_ptr() as u32, TRANSPARENT.positions.len() as u32,
            TRANSPARENT.normals.as_ptr() as u32, TRANSPARENT.normals.len() as u32,
            TRANSPARENT.uvs.as_ptr() as u32, TRANSPARENT.uvs.len() as u32,
            TRANSPARENT.tiles.as_ptr() as u32, TRANSPARENT.tiles.len() as u32,
            TRANSPARENT.colors.as_ptr() as u32, TRANSPARENT.colors.len() as u32,
            TRANSPARENT.indices.as_ptr() as u32, TRANSPARENT.indices.len() as u32,
        ];
    }
}
