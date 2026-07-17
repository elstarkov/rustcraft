//! Dropped items. Breaking a block spawns one as a small entity that pops
//! out, falls, and settles on the ground (or bobs at the water surface).
//! They share the 10 Hz tick with mobs and despawn after five minutes.

use crate::world::{block, World};

const GRAVITY: f32 = -24.0;
const DESPAWN_SECONDS: f32 = 300.0;

pub struct Drop {
    pub id: u32,
    pub item: u8,
    /// Bottom of the item, like a player's feet.
    pub pos: [f32; 3],
    vel: [f32; 3],
    pub age: f32,
    settled: bool,
}

/// What breaking a block leaves behind. Everything drops itself so every
/// hotbar slot stays obtainable; air and water leave nothing.
pub fn drop_for(id: u8) -> Option<u8> {
    (id != block::AIR && id != block::WATER).then_some(id)
}

impl Drop {
    /// Spawn at the center of the broken block with a small random pop.
    pub fn new(id: u32, item: u8, bx: i32, by: i32, bz: i32, r0: f32, r1: f32) -> Self {
        Drop {
            id,
            item,
            pos: [bx as f32 + 0.5, by as f32 + 0.3, bz as f32 + 0.5],
            vel: [(r0 - 0.5) * 1.6, 3.0, (r1 - 0.5) * 1.6],
            age: 0.0,
            settled: false,
        }
    }

    pub fn expired(&self) -> bool {
        self.age > DESPAWN_SECONDS
    }

    /// True while the drop still moves and needs rebroadcasting.
    pub fn in_motion(&self) -> bool {
        !self.settled
    }

    pub fn tick(&mut self, world: &mut World, dt: f32) {
        self.age += dt;
        if self.settled {
            // A block placed or removed under a settled drop unsettles it.
            if solid_at(world, self.pos[0], self.pos[1] - 0.06, self.pos[2]) {
                return;
            }
            self.settled = false;
        }

        self.vel[1] = (self.vel[1] + GRAVITY * dt).max(-20.0);
        if world.block_at(
            self.pos[0].floor() as i32,
            self.pos[1].floor() as i32,
            self.pos[2].floor() as i32,
        ) == block::WATER
        {
            // Buoyancy overshoots the surface, gravity pulls back: it bobs.
            self.vel[1] = self.vel[1].max(1.0);
        }

        // Horizontal: slide unless a wall is in the way.
        for axis in [0, 2] {
            let next = self.pos[axis] + self.vel[axis] * dt;
            let probe = [
                if axis == 0 { next } else { self.pos[0] },
                self.pos[1] + 0.1,
                if axis == 2 { next } else { self.pos[2] },
            ];
            if solid_at(world, probe[0], probe[1], probe[2]) {
                self.vel[axis] = 0.0;
            } else {
                self.pos[axis] = next;
            }
        }

        // Vertical: land on top of the block below, pass through otherwise.
        let next_y = self.pos[1] + self.vel[1] * dt;
        if self.vel[1] < 0.0 && solid_at(world, self.pos[0], next_y, self.pos[2]) {
            self.pos[1] = next_y.floor() + 1.0;
            self.vel = [self.vel[0] * 0.5, 0.0, self.vel[2] * 0.5];
            if self.vel[0].abs() + self.vel[2].abs() < 0.05 {
                self.vel = [0.0; 3];
                self.settled = true;
            }
        } else {
            self.pos[1] = next_y.max(0.0);
        }
    }
}

fn solid_at(world: &mut World, x: f32, y: f32, z: f32) -> bool {
    let id = world.block_at(x.floor() as i32, y.floor() as i32, z.floor() as i32);
    id != block::AIR && id != block::WATER && id != block::TORCH
}
