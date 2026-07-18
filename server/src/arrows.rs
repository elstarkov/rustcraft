//! Skeleton arrows: ballistic points ticked at 10 Hz with substeps so a
//! fast arrow can't tunnel through a wall or a player between ticks.

use crate::world::{block, World};

const GRAVITY: f32 = -18.0;
const LIFETIME: f32 = 5.0;
const SUBSTEPS: i32 = 4;

pub struct Arrow {
    pub id: u32,
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    age: f32,
}

pub enum Fate {
    Flying,
    Gone,
    HitPlayer(u32),
}

fn solid(id: u8) -> bool {
    id != block::AIR && id != block::WATER && id != block::TORCH
}

impl Arrow {
    pub fn new(id: u32, pos: [f32; 3], vel: [f32; 3]) -> Self {
        Arrow { id, pos, vel, age: 0.0 }
    }

    pub fn tick(&mut self, world: &mut World, players: &[(u32, [f32; 3])], dt: f32) -> Fate {
        self.age += dt;
        if self.age > LIFETIME {
            return Fate::Gone;
        }
        let sdt = dt / SUBSTEPS as f32;
        for _ in 0..SUBSTEPS {
            self.vel[1] += GRAVITY * sdt;
            for a in 0..3 {
                self.pos[a] += self.vel[a] * sdt;
            }
            if solid(world.block_at(
                self.pos[0].floor() as i32,
                self.pos[1].floor() as i32,
                self.pos[2].floor() as i32,
            )) {
                return Fate::Gone;
            }
            for (pid, p) in players {
                // Player AABB, padded a little so grazes still count.
                if (self.pos[0] - p[0]).abs() < 0.45
                    && self.pos[1] > p[1] - 0.1
                    && self.pos[1] < p[1] + 1.9
                    && (self.pos[2] - p[2]).abs() < 0.45
                {
                    return Fate::HitPlayer(*pid);
                }
            }
        }
        Fate::Flying
    }
}
