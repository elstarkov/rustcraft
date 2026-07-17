//! Server-side mobs. Zombies spawn on the surface near players at night,
//! wander until someone comes close, then chase and swing. They run the same
//! AABB-vs-voxel physics as the client player (gravity, per-axis collision,
//! jump when a step blocks the way) at the 10 Hz AI tick.

use crate::world::{block, World};

pub const ZOMBIE_HP: i32 = 12;
pub const ZOMBIE_DAMAGE: i32 = 3;
const GRAVITY: f32 = -24.0;
/// Sized for the coarse 10 Hz tick: explicit Euler at dt=0.1 loses a lot of
/// height (7.8 would peak at ~0.9 blocks and never clear a step); 9.5 peaks
/// at ~1.4 blocks.
const JUMP_SPEED: f32 = 9.5;
const CHASE_SPEED: f32 = 2.4;
const WANDER_SPEED: f32 = 0.9;
const CHASE_RADIUS: f32 = 20.0;
const ATTACK_RANGE: f32 = 1.6;
const ATTACK_COOLDOWN: f32 = 1.0;
const HALF_W: f32 = 0.3;
const HEIGHT: f32 = 1.8;
const EPS: f32 = 1e-4;

pub struct Mob {
    pub id: u32,
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub yaw: f32,
    pub hp: i32,
    attack_cooldown: f32,
    wander_timer: f32,
    wander_dir: [f32; 2],
    on_ground: bool,
    // Mobs that fall into caves mid-chase pace one spot forever and clog the
    // spawn cap; track how long one has been near its anchor and recycle it.
    anchor: [f32; 3],
    stuck_time: f32,
}

/// Small deterministic-enough RNG for spawn placement and wandering.
pub struct Rng(pub u32);

impl Rng {
    pub fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    pub fn unit(&mut self) -> f32 {
        (self.next() % 10_000) as f32 / 10_000.0
    }
}

fn solid(id: u8) -> bool {
    id != block::AIR && id != block::WATER && id != block::TORCH
}

impl Mob {
    pub fn new(id: u32, pos: [f32; 3]) -> Self {
        Mob {
            id,
            pos,
            vel: [0.0; 3],
            yaw: 0.0,
            hp: ZOMBIE_HP,
            attack_cooldown: 0.0,
            wander_timer: 0.0,
            wander_dir: [0.0, 0.0],
            on_ground: false,
            anchor: pos,
            stuck_time: 0.0,
        }
    }

    /// True once this mob has idled in one spot too long with nobody in
    /// swinging distance — the tick loop despawns it.
    pub fn is_stale(&self) -> bool {
        self.stuck_time > 25.0
    }

    pub fn knockback(&mut self, from: [f32; 3]) {
        let dx = self.pos[0] - from[0];
        let dz = self.pos[2] - from[2];
        let len = (dx * dx + dz * dz).sqrt().max(0.01);
        self.vel[0] += dx / len * 5.0;
        self.vel[2] += dz / len * 5.0;
        self.vel[1] += 3.5;
    }

    /// Advance one AI tick. Returns the id of a player this mob just hit.
    pub fn tick(
        &mut self,
        world: &mut World,
        players: &[(u32, [f32; 3])],
        dt: f32,
        rng: &mut Rng,
    ) -> Option<u32> {
        self.attack_cooldown = (self.attack_cooldown - dt).max(0.0);

        // Nearest player, by horizontal distance — but chase range is a 3D
        // check, so a player pacing 20 blocks above a cave-bound mob doesn't
        // count as reachable.
        let target = players
            .iter()
            .map(|(id, p)| {
                let d = ((p[0] - self.pos[0]).powi(2) + (p[2] - self.pos[2]).powi(2)).sqrt();
                (*id, *p, d)
            })
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .filter(|(_, p, d)| (d * d + (p[1] - self.pos[1]).powi(2)).sqrt() < CHASE_RADIUS);

        let (dir, speed) = if let Some((_, p, d)) = target {
            let dir = [(p[0] - self.pos[0]) / d.max(0.01), (p[2] - self.pos[2]) / d.max(0.01)];
            (dir, if d > ATTACK_RANGE * 0.8 { CHASE_SPEED } else { 0.0 })
        } else {
            self.wander_timer -= dt;
            if self.wander_timer <= 0.0 {
                self.wander_timer = 2.0 + rng.unit() * 3.0;
                let a = rng.unit() * std::f32::consts::TAU;
                // Sometimes just stand around.
                self.wander_dir = if rng.unit() < 0.3 { [0.0, 0.0] } else { [a.cos(), a.sin()] };
            }
            (self.wander_dir, WANDER_SPEED)
        };

        self.vel[0] = dir[0] * speed;
        self.vel[2] = dir[1] * speed;
        if speed > 0.0 && (dir[0] != 0.0 || dir[1] != 0.0) {
            // Match the client convention: yaw 0 walks toward -z.
            self.yaw = (-dir[0]).atan2(-dir[1]);
        }

        self.vel[1] = (self.vel[1] + GRAVITY * dt).max(-30.0);

        // Buoyancy: a submerged zombie bobs up and floats across instead of
        // pacing the pond floor forever.
        let mid = world.block_at(
            self.pos[0].floor() as i32,
            (self.pos[1] + 0.9).floor() as i32,
            self.pos[2].floor() as i32,
        );
        if mid == block::WATER {
            self.vel[1] = self.vel[1].max(1.2);
        }

        let wanted = [self.vel[0], self.vel[2]];
        self.on_ground = false;
        self.move_axis(world, 0, self.vel[0] * dt);
        self.move_axis(world, 1, self.vel[1] * dt);
        self.move_axis(world, 2, self.vel[2] * dt);

        // A wall zeroed the velocity we asked for: hop, it's probably a step.
        let blocked = (wanted[0] != 0.0 && self.vel[0] == 0.0) || (wanted[1] != 0.0 && self.vel[2] == 0.0);
        if blocked && self.on_ground {
            self.vel[1] = JUMP_SPEED;
        }

        // Track idling: reset the anchor whenever the mob makes real progress
        // or has someone to fight; otherwise the staleness clock runs.
        let dx = self.pos[0] - self.anchor[0];
        let dy = self.pos[1] - self.anchor[1];
        let dz = self.pos[2] - self.anchor[2];
        let fighting = matches!(target, Some((_, _, d)) if d < ATTACK_RANGE * 1.5);
        if dx * dx + dy * dy + dz * dz > 2.25 || fighting {
            self.anchor = self.pos;
            self.stuck_time = 0.0;
        } else {
            self.stuck_time += dt;
        }

        // Swing when close enough on both axes.
        if let Some((pid, p, d)) = target {
            if d < ATTACK_RANGE && (p[1] - self.pos[1]).abs() < 2.0 && self.attack_cooldown == 0.0 {
                self.attack_cooldown = ATTACK_COOLDOWN;
                return Some(pid);
            }
        }
        None
    }

    fn move_axis(&mut self, world: &mut World, axis: usize, delta: f32) {
        if delta == 0.0 {
            return;
        }
        self.pos[axis] += delta;
        let min = [self.pos[0] - HALF_W, self.pos[1], self.pos[2] - HALF_W];
        let max = [self.pos[0] + HALF_W, self.pos[1] + HEIGHT, self.pos[2] + HALF_W];
        for by in (min[1].floor() as i32)..(max[1].ceil() as i32) {
            for bz in (min[2].floor() as i32)..(max[2].ceil() as i32) {
                for bx in (min[0].floor() as i32)..(max[0].ceil() as i32) {
                    if !solid(world.block_at(bx, by, bz)) {
                        continue;
                    }
                    match axis {
                        0 => {
                            self.pos[0] = if delta > 0.0 { bx as f32 - HALF_W - EPS } else { bx as f32 + 1.0 + HALF_W + EPS };
                            self.vel[0] = 0.0;
                        }
                        2 => {
                            self.pos[2] = if delta > 0.0 { bz as f32 - HALF_W - EPS } else { bz as f32 + 1.0 + HALF_W + EPS };
                            self.vel[2] = 0.0;
                        }
                        _ => {
                            if delta > 0.0 {
                                self.pos[1] = by as f32 - HEIGHT - EPS;
                            } else {
                                self.pos[1] = by as f32 + 1.0 + EPS;
                                self.on_ground = true;
                            }
                            self.vel[1] = 0.0;
                        }
                    }
                    return;
                }
            }
        }
    }
}

/// A surface spot with two blocks of air above it, or None.
pub fn spawn_spot(world: &mut World, x: i32, z: i32) -> Option<[f32; 3]> {
    let y = world.surface_y(x, z)?;
    let feet = y + 1;
    // Two blocks of air keeps them out of ponds too: a submerged column has
    // water at feet level, and surface_y already skipped the water itself.
    if world.block_at(x, feet, z) != block::AIR || world.block_at(x, feet + 1, z) != block::AIR {
        return None;
    }
    Some([x as f32 + 0.5, feet as f32 + 0.05, z as f32 + 0.5])
}
