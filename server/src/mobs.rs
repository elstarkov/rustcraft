//! Server-side mobs. Hostiles (zombies, skeletons, spiders) spawn on the
//! surface near players at night; sheep amble around at any hour. Everyone
//! runs the same AABB-vs-voxel physics as the client player (gravity,
//! per-axis collision, jump when a step blocks the way) at the 10 Hz AI
//! tick — only the brains differ per kind.

use crate::world::{block, World};

const GRAVITY: f32 = -24.0;
/// Sized for the coarse 10 Hz tick: explicit Euler at dt=0.1 loses a lot of
/// height (7.8 would peak at ~0.9 blocks and never clear a step); 9.5 peaks
/// at ~1.4 blocks.
const JUMP_SPEED: f32 = 9.5;
const WANDER_SPEED: f32 = 0.9;
const CHASE_RADIUS: f32 = 20.0;
const MELEE_RANGE: f32 = 1.6;
const HALF_W: f32 = 0.3;
const HEIGHT: f32 = 1.8;
const EPS: f32 = 1e-4;

/// Skeletons hold this band: shoot inside it, close in beyond it, back away
/// under it.
const BOW_RANGE: f32 = 16.0;
const BOW_TOO_CLOSE: f32 = 6.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zombie,
    Skeleton,
    Spider,
    Sheep,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Zombie => "zombie",
            Kind::Skeleton => "skeleton",
            Kind::Spider => "spider",
            Kind::Sheep => "sheep",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "zombie" => Kind::Zombie,
            "skeleton" => Kind::Skeleton,
            "spider" => Kind::Spider,
            "sheep" => Kind::Sheep,
            _ => return None,
        })
    }

    pub fn hp(self) -> i32 {
        match self {
            Kind::Zombie => 12,
            Kind::Skeleton => 10,
            Kind::Spider => 8,
            Kind::Sheep => 8,
        }
    }

    pub fn hostile(self) -> bool {
        self != Kind::Sheep
    }

    fn chase_speed(self) -> f32 {
        match self {
            Kind::Zombie => 2.4,
            Kind::Skeleton => 2.2,
            Kind::Spider => 3.4,
            Kind::Sheep => 0.0,
        }
    }

    pub fn melee_damage(self) -> i32 {
        match self {
            Kind::Zombie => 3,
            Kind::Spider => 2,
            _ => 0,
        }
    }
}

/// What a mob wants done to a player this tick; the caller applies it.
pub enum Action {
    Melee(u32),
    Shoot(u32),
}

pub struct Mob {
    pub id: u32,
    pub kind: Kind,
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub yaw: f32,
    pub hp: i32,
    attack_cooldown: f32,
    leap_cooldown: f32,
    flee_timer: f32,
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
    id != block::AIR && id != block::WATER && !block::is_torch(id)
}

/// Straight-line visibility between two points, stepped at 0.3 blocks.
fn line_of_sight(world: &mut World, from: [f32; 3], to: [f32; 3]) -> bool {
    let d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    let steps = (len / 0.3).ceil() as i32;
    for i in 1..steps {
        let t = i as f32 / steps as f32;
        let p = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
        if solid(world.block_at(p[0].floor() as i32, p[1].floor() as i32, p[2].floor() as i32)) {
            return false;
        }
    }
    true
}

impl Mob {
    pub fn new(id: u32, kind: Kind, pos: [f32; 3]) -> Self {
        Mob {
            id,
            kind,
            pos,
            vel: [0.0; 3],
            yaw: 0.0,
            hp: kind.hp(),
            attack_cooldown: 0.0,
            leap_cooldown: 0.0,
            flee_timer: 0.0,
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
        if self.kind == Kind::Sheep {
            self.flee_timer = 4.0;
        }
    }

    fn wander(&mut self, dt: f32, rng: &mut Rng) -> ([f32; 2], f32) {
        self.wander_timer -= dt;
        if self.wander_timer <= 0.0 {
            self.wander_timer = 2.0 + rng.unit() * 3.0;
            let a = rng.unit() * std::f32::consts::TAU;
            // Sometimes just stand around.
            self.wander_dir = if rng.unit() < 0.3 { [0.0, 0.0] } else { [a.cos(), a.sin()] };
        }
        (self.wander_dir, WANDER_SPEED * if self.kind == Kind::Sheep { 0.8 } else { 1.0 })
    }

    /// Advance one AI tick; returns what this mob did to whom, if anything.
    pub fn tick(
        &mut self,
        world: &mut World,
        players: &[(u32, [f32; 3])],
        dt: f32,
        rng: &mut Rng,
    ) -> Option<Action> {
        self.attack_cooldown = (self.attack_cooldown - dt).max(0.0);
        self.leap_cooldown = (self.leap_cooldown - dt).max(0.0);
        self.flee_timer = (self.flee_timer - dt).max(0.0);

        // Nearest player, by horizontal distance — but chase range is a 3D
        // check, so a player pacing 20 blocks above a cave-bound mob doesn't
        // count as reachable.
        let nearest = players
            .iter()
            .map(|(id, p)| {
                let d = ((p[0] - self.pos[0]).powi(2) + (p[2] - self.pos[2]).powi(2)).sqrt();
                (*id, *p, d)
            })
            .min_by(|a, b| a.2.total_cmp(&b.2));
        let target = nearest
            .filter(|(_, p, d)| (d * d + (p[1] - self.pos[1]).powi(2)).sqrt() < CHASE_RADIUS);

        let toward = |p: [f32; 3], m: &Mob, d: f32| {
            [(p[0] - m.pos[0]) / d.max(0.01), (p[2] - m.pos[2]) / d.max(0.01)]
        };

        let mut bow_ready = false;
        let (dir, speed) = match self.kind {
            Kind::Zombie | Kind::Spider => {
                if let Some((_, p, d)) = target {
                    let dir = toward(p, self, d);
                    (dir, if d > MELEE_RANGE * 0.8 { self.kind.chase_speed() } else { 0.0 })
                } else {
                    self.wander(dt, rng)
                }
            }
            Kind::Skeleton => {
                if let Some((_, p, d)) = target {
                    let eye = [self.pos[0], self.pos[1] + 1.5, self.pos[2]];
                    let their_eye = [p[0], p[1] + 1.4, p[2]];
                    bow_ready = d <= BOW_RANGE && line_of_sight(world, eye, their_eye);
                    let dir = toward(p, self, d);
                    if d < BOW_TOO_CLOSE {
                        ([-dir[0], -dir[1]], self.kind.chase_speed()) // back off
                    } else if bow_ready {
                        ([0.0, 0.0], 0.0) // hold still and draw
                    } else {
                        (dir, self.kind.chase_speed())
                    }
                } else {
                    self.wander(dt, rng)
                }
            }
            Kind::Sheep => {
                if self.flee_timer > 0.0 {
                    if let Some((_, p, d)) = nearest {
                        let dir = toward(p, self, d);
                        ([-dir[0], -dir[1]], 3.4)
                    } else {
                        self.wander(dt, rng)
                    }
                } else {
                    self.wander(dt, rng)
                }
            }
        };

        self.vel[0] = dir[0] * speed;
        self.vel[2] = dir[1] * speed;
        if speed > 0.0 && (dir[0] != 0.0 || dir[1] != 0.0) {
            // Match the client convention: yaw 0 walks toward -z.
            self.yaw = (-dir[0]).atan2(-dir[1]);
        } else if let Some((_, p, d)) = target {
            // Standing archers still face their mark.
            let dir = toward(p, self, d);
            self.yaw = (-dir[0]).atan2(-dir[1]);
        }

        // Spiders pounce: a flat leap toward anyone in mid range.
        if self.kind == Kind::Spider && self.on_ground && self.leap_cooldown == 0.0 {
            if let Some((_, p, d)) = target {
                if (2.2..5.5).contains(&d) {
                    let dir = toward(p, self, d);
                    self.vel[0] = dir[0] * 6.5;
                    self.vel[2] = dir[1] * 6.5;
                    self.vel[1] = 5.5;
                    self.leap_cooldown = 2.5;
                }
            }
        }

        self.vel[1] = (self.vel[1] + GRAVITY * dt).max(-30.0);

        // Buoyancy: a submerged mob bobs up and floats across instead of
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
        let engaged = match self.kind {
            Kind::Skeleton => bow_ready,
            _ => matches!(target, Some((_, _, d)) if d < MELEE_RANGE * 1.5),
        };
        if dx * dx + dy * dy + dz * dz > 2.25 || engaged {
            self.anchor = self.pos;
            self.stuck_time = 0.0;
        } else {
            self.stuck_time += dt;
        }

        // Act when in position.
        if let Some((pid, p, d)) = target {
            match self.kind {
                Kind::Zombie | Kind::Spider => {
                    if d < MELEE_RANGE && (p[1] - self.pos[1]).abs() < 2.0 && self.attack_cooldown == 0.0 {
                        self.attack_cooldown = 1.0;
                        return Some(Action::Melee(pid));
                    }
                }
                Kind::Skeleton => {
                    if bow_ready && self.attack_cooldown == 0.0 {
                        self.attack_cooldown = 2.0;
                        return Some(Action::Shoot(pid));
                    }
                }
                Kind::Sheep => {}
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
