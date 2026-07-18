mod arrows;
mod craft;
mod drops;
mod mobs;
mod protocol;
mod world;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use arrows::Arrow;
use drops::Drop;
use mobs::Mob;
use protocol::{encode_chunk, ClientMsg, PlayerInfo, ServerMsg};
use world::{block, World};

type Error = Box<dyn std::error::Error + Send + Sync>;

const FULL_HP: i32 = 20;
const FULL_FOOD: i32 = 20;

struct Client {
    tx: UnboundedSender<Message>,
    name: String,
    pos: [f32; 3],
    hp: i32,
    food: i32,
    // Hunger clock accumulators, all in seconds.
    food_t: f32,
    starve_t: f32,
    regen_t: f32,
    inventory: HashMap<u8, u32>,
}

fn inventory_snapshot(c: &Client) -> ServerMsg {
    ServerMsg::Inventory {
        items: c
            .inventory
            .iter()
            .filter(|&(_, &n)| n > 0)
            .map(|(&id, &n)| (id, n))
            .collect(),
    }
}

/// One in-game day lasts ten minutes of wall clock.
const DAY_SECONDS: f64 = 600.0;

struct Server {
    world: Mutex<World>,
    clients: Mutex<HashMap<u32, Client>>,
    mobs: Mutex<HashMap<u32, Mob>>,
    drops: Mutex<HashMap<u32, Drop>>,
    arrows: Mutex<HashMap<u32, Arrow>>,
    next_id: AtomicU32,
    next_mob_id: AtomicU32,
    next_drop_id: AtomicU32,
    next_arrow_id: AtomicU32,
    started: std::time::Instant,
    start_frac: f64,
    /// RUSTCRAFT_SPAWN forces every hostile spawn to one kind (testing).
    forced_spawn: Option<mobs::Kind>,
    /// RUSTCRAFT_CREATIVE=1: placing needs no stock and consumes nothing.
    creative: bool,
    /// Seconds per food point (RUSTCRAFT_HUNGER shortens it for tests).
    hunger_secs: f32,
}

impl Server {
    /// Fraction of the current day: 0 sunrise, 0.25 noon, 0.5 sunset.
    /// Starts mid-morning so new worlds open in daylight (RUSTCRAFT_TIME
    /// overrides the starting fraction, handy for testing the night).
    fn world_time(&self) -> f32 {
        ((self.started.elapsed().as_secs_f64() / DAY_SECONDS + self.start_frac) % 1.0) as f32
    }

    fn is_night(&self) -> bool {
        (self.world_time() as f64 * std::f64::consts::TAU).sin() < -0.05
    }

    fn send_to(&self, id: u32, msg: &ServerMsg) {
        let text = serde_json::to_string(msg).unwrap();
        if let Some(c) = self.clients.lock().unwrap().get(&id) {
            let _ = c.tx.send(Message::text(text));
        }
    }

    fn broadcast(&self, msg: &ServerMsg, except: Option<u32>) {
        let text = serde_json::to_string(msg).unwrap();
        for (id, c) in self.clients.lock().unwrap().iter() {
            if Some(*id) != except {
                let _ = c.tx.send(Message::text(text.clone()));
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let addr = "0.0.0.0:8765";
    let world = World::new(1337, "world".into());
    let saved = world.saved_chunk_count();
    let start_frac = std::env::var("RUSTCRAFT_TIME")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.1);
    let forced_spawn = std::env::var("RUSTCRAFT_SPAWN")
        .ok()
        .and_then(|v| mobs::Kind::parse(&v));
    let server = Arc::new(Server {
        world: Mutex::new(world),
        clients: Mutex::new(HashMap::new()),
        mobs: Mutex::new(HashMap::new()),
        drops: Mutex::new(HashMap::new()),
        arrows: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        next_mob_id: AtomicU32::new(1),
        next_drop_id: AtomicU32::new(1),
        next_arrow_id: AtomicU32::new(1),
        started: std::time::Instant::now(),
        start_frac,
        forced_spawn,
        creative: std::env::var("RUSTCRAFT_CREATIVE").is_ok_and(|v| v == "1"),
        hunger_secs: std::env::var("RUSTCRAFT_HUNGER")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(45.0),
    });

    // Mob AI runs at 10 Hz.
    let mob_server = server.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        let mut rng = mobs::Rng(0x2545_f491 ^ std::process::id());
        loop {
            tick.tick().await;
            tick_mobs(&mob_server, &mut rng);
            tick_arrows(&mob_server);
            tick_drops(&mob_server);
            tick_hunger(&mob_server);
        }
    });

    // Keep everyone's day/night cycle in sync; clients advance time locally
    // between these corrections.
    let time_server = server.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            let t = time_server.world_time();
            time_server.broadcast(&ServerMsg::Time { t }, None);
        }
    });

    let listener = TcpListener::bind(addr).await.expect("failed to bind");
    println!("rustcraft server listening on ws://{addr}");
    println!("world edits persist to ./world ({saved} chunks saved so far)");

    while let Ok((stream, peer)) = listener.accept().await {
        let server = server.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(server, stream).await {
                eprintln!("client {peer}: {e}");
            }
        });
    }
}

/// One 10 Hz mob tick: despawn, spawn, AI, then broadcasts. Never holds the
/// clients lock while the world lock is held (chunk requests take world then
/// clients, so the reverse order would deadlock).
fn tick_mobs(server: &Server, rng: &mut mobs::Rng) {
    const DT: f32 = 0.1;
    let night = server.is_night();
    let players: Vec<(u32, [f32; 3])> = server
        .clients
        .lock()
        .unwrap()
        .iter()
        .map(|(&id, c)| (id, c.pos))
        .collect();

    let mut events: Vec<ServerMsg> = Vec::new();
    let mut hits: Vec<(u32, i32, &'static str)> = Vec::new();
    let mut shots: Vec<([f32; 3], [f32; 3])> = Vec::new(); // shooter pos, target pos
    {
        let mut world = server.world.lock().unwrap();
        let mut mob_map = server.mobs.lock().unwrap();

        // Hostiles vanish at dawn; anything goes when everyone left, it
        // wandered too far, or it idled too long (usually fallen into a
        // cave).
        mob_map.retain(|id, m| {
            let near_someone = players
                .iter()
                .any(|(_, p)| (p[0] - m.pos[0]).hypot(p[2] - m.pos[2]) < 56.0);
            let keep = near_someone && !m.is_stale() && (night || !m.kind.hostile());
            if !keep {
                events.push(ServerMsg::MobGone { id: *id });
            }
            keep
        });

        let mut spawn = |mob_map: &mut HashMap<u32, Mob>,
                         world: &mut World,
                         rng: &mut mobs::Rng,
                         kind: mobs::Kind,
                         min_dist: f32| {
            let (_, p) = players[rng.next() as usize % players.len()];
            let ang = rng.unit() * std::f32::consts::TAU;
            let dist = min_dist + rng.unit() * 12.0;
            let x = (p[0] + ang.cos() * dist).floor() as i32;
            let z = (p[2] + ang.sin() * dist).floor() as i32;
            if let Some(pos) = mobs::spawn_spot(world, x, z) {
                // Torchlight keeps the monsters out; sheep don't mind it.
                if kind.hostile() && world.torch_near(pos, 8.0) {
                    return;
                }
                let id = server.next_mob_id.fetch_add(1, Ordering::Relaxed);
                mob_map.insert(id, Mob::new(id, kind, pos));
                events.push(ServerMsg::MobSpawn {
                    id,
                    kind: kind.name().into(),
                    x: pos[0],
                    y: pos[1],
                    z: pos[2],
                });
            }
        };

        if !players.is_empty() {
            let hostiles = mob_map.values().filter(|m| m.kind.hostile()).count();
            let cap = (players.len() * 4).min(16);
            if night && hostiles < cap && rng.unit() < 0.2 {
                let kind = server.forced_spawn.unwrap_or_else(|| {
                    let r = rng.unit();
                    if r < 0.5 {
                        mobs::Kind::Zombie
                    } else if r < 0.8 {
                        mobs::Kind::Skeleton
                    } else {
                        mobs::Kind::Spider
                    }
                });
                spawn(&mut mob_map, &mut world, rng, kind, 14.0);
            }

            // Sheep graze at any hour, in smaller numbers and closer by.
            let sheep = mob_map.len() - hostiles;
            if sheep < (players.len() * 2).min(8) && rng.unit() < 0.04 {
                spawn(&mut mob_map, &mut world, rng, mobs::Kind::Sheep, 10.0);
            }
        }

        for m in mob_map.values_mut() {
            match m.tick(&mut world, &players, DT, rng) {
                Some(mobs::Action::Melee(pid)) => {
                    hits.push((pid, m.kind.melee_damage(), m.kind.name()));
                }
                Some(mobs::Action::Shoot(pid)) => {
                    if let Some((_, p)) = players.iter().find(|(id, _)| *id == pid) {
                        shots.push((m.pos, *p));
                    }
                }
                None => {}
            }
        }

        if !mob_map.is_empty() {
            events.push(ServerMsg::Mobs {
                list: mob_map
                    .values()
                    .map(|m| (m.id, m.pos[0], m.pos[1], m.pos[2], m.yaw))
                    .collect(),
            });
        }
    }

    // Loose arrows: aimed straight at the target with a little arc
    // compensation for gravity over the flight.
    for (mpos, ppos) in shots {
        let from = [mpos[0], mpos[1] + 1.5, mpos[2]];
        let to = [ppos[0], ppos[1] + 1.4, ppos[2]];
        let d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(0.01);
        let mut vel = [d[0] / len * 18.0, d[1] / len * 18.0, d[2] / len * 18.0];
        vel[1] += len * 0.5;
        let id = server.next_arrow_id.fetch_add(1, Ordering::Relaxed);
        server.arrows.lock().unwrap().insert(id, Arrow::new(id, from, vel));
        events.push(ServerMsg::ArrowSpawn {
            id,
            x: from[0], y: from[1], z: from[2],
            vx: vel[0], vy: vel[1], vz: vel[2],
        });
    }

    for e in &events {
        server.broadcast(e, None);
    }
    for (pid, dmg, cause) in hits {
        damage_player(server, pid, dmg, cause);
    }
}

/// Hunger clock at 10 Hz: food drains over time, an empty stomach grinds
/// you down to two hearts (never kills), a well-fed one slowly heals.
fn tick_hunger(server: &Server) {
    const DT: f32 = 0.1;
    let send = |c: &Client, msg: &ServerMsg| {
        let _ = c.tx.send(Message::text(serde_json::to_string(msg).unwrap()));
    };
    let mut starving: Vec<u32> = Vec::new();
    {
        let mut clients = server.clients.lock().unwrap();
        for (&id, c) in clients.iter_mut() {
            c.food_t += DT;
            if c.food_t >= server.hunger_secs {
                c.food_t = 0.0;
                if c.food > 0 {
                    c.food -= 1;
                    send(c, &ServerMsg::Food { food: c.food });
                }
            }

            if c.food == 0 {
                c.starve_t += DT;
                if c.starve_t >= 4.0 {
                    c.starve_t = 0.0;
                    if c.hp > 2 {
                        starving.push(id);
                    }
                }
            } else {
                c.starve_t = 0.0;
            }

            if c.food >= 16 && c.hp < FULL_HP {
                c.regen_t += DT;
                if c.regen_t >= 3.0 {
                    c.regen_t = 0.0;
                    c.hp += 1;
                    send(c, &ServerMsg::Health { hp: c.hp });
                }
            } else {
                c.regen_t = 0.0;
            }
        }
    }
    for id in starving {
        damage_player(server, id, 1, "starve");
    }
}

/// One 10 Hz arrow tick: ballistics, wall hits, player hits.
fn tick_arrows(server: &Server) {
    const DT: f32 = 0.1;
    let players: Vec<(u32, [f32; 3])> = server
        .clients
        .lock()
        .unwrap()
        .iter()
        .map(|(&id, c)| (id, c.pos))
        .collect();

    let mut events: Vec<ServerMsg> = Vec::new();
    let mut hits: Vec<u32> = Vec::new();
    {
        let mut world = server.world.lock().unwrap();
        let mut arrow_map = server.arrows.lock().unwrap();
        let mut moving = Vec::new();
        arrow_map.retain(|id, a| match a.tick(&mut world, &players, DT) {
            arrows::Fate::Flying => {
                moving.push((a.id, a.pos[0], a.pos[1], a.pos[2]));
                true
            }
            arrows::Fate::HitPlayer(pid) => {
                hits.push(pid);
                events.push(ServerMsg::ArrowGone { id: *id });
                false
            }
            arrows::Fate::Gone => {
                events.push(ServerMsg::ArrowGone { id: *id });
                false
            }
        });
        if !moving.is_empty() {
            events.push(ServerMsg::Arrows { list: moving });
        }
    }

    for e in &events {
        server.broadcast(e, None);
    }
    for pid in hits {
        damage_player(server, pid, 4, "skeleton");
    }
}

/// One 10 Hz drop tick: physics for drops still in motion, pickup by
/// proximity, despawn expired ones. A drop that settled this tick is
/// included in the batch once more so clients get its final resting
/// position.
fn tick_drops(server: &Server) {
    const DT: f32 = 0.1;
    let players: Vec<(u32, [f32; 3])> = server
        .clients
        .lock()
        .unwrap()
        .iter()
        .map(|(&id, c)| (id, c.pos))
        .collect();

    let mut events: Vec<ServerMsg> = Vec::new();
    let mut pickups: Vec<(u32, u8)> = Vec::new();
    {
        let mut world = server.world.lock().unwrap();
        let mut drop_map = server.drops.lock().unwrap();

        let mut moving = Vec::new();
        for d in drop_map.values_mut() {
            let was_moving = d.in_motion();
            d.tick(&mut world, DT);
            if was_moving {
                moving.push((d.id, d.pos[0], d.pos[1], d.pos[2]));
            }
        }
        if !moving.is_empty() {
            events.push(ServerMsg::Drops { list: moving });
        }

        // Walking over a drop collects it; a short grace after spawning so
        // the pop-out animation is seen at all.
        drop_map.retain(|id, d| {
            if d.expired() {
                events.push(ServerMsg::DropGone { id: *id });
                return false;
            }
            if d.age < 0.25 {
                return true;
            }
            let collector = players.iter().find(|(_, p)| {
                (p[0] - d.pos[0]).powi(2)
                    + (p[1] - d.pos[1]).powi(2)
                    + (p[2] - d.pos[2]).powi(2)
                    < 2.25
            });
            if let Some(&(pid, _)) = collector {
                pickups.push((pid, d.item));
                events.push(ServerMsg::DropGone { id: *id });
                return false;
            }
            true
        });
    }

    for e in &events {
        server.broadcast(e, None);
    }
    for (pid, item) in pickups {
        let snapshot = {
            let mut clients = server.clients.lock().unwrap();
            let Some(c) = clients.get_mut(&pid) else { continue };
            *c.inventory.entry(item).or_insert(0) += 1;
            inventory_snapshot(c)
        };
        server.send_to(pid, &snapshot);
    }
}

fn damage_player(server: &Server, id: u32, dmg: i32, cause: &str) {
    let spawn = server.world.lock().unwrap().spawn_point();
    let (hp, died, name) = {
        let mut clients = server.clients.lock().unwrap();
        let Some(c) = clients.get_mut(&id) else { return };
        c.hp -= dmg;
        let died = c.hp <= 0;
        if died {
            c.hp = FULL_HP;
            c.food = FULL_FOOD;
            c.pos = spawn;
        }
        (c.hp, died, c.name.clone())
    };
    if died {
        server.send_to(id, &ServerMsg::Respawn { spawn, cause: cause.into() });
        server.send_to(id, &ServerMsg::Food { food: FULL_FOOD });
        // Everyone else sees the body snap back to spawn.
        server.broadcast(
            &ServerMsg::PlayerPos { id, x: spawn[0], y: spawn[1], z: spawn[2], yaw: 0.0, pitch: 0.0 },
            Some(id),
        );
        let phrase = match cause {
            "zombie" => "was slain by a zombie",
            "spider" => "was slain by a spider",
            "skeleton" => "was shot by a skeleton",
            "fall" => "fell from a high place",
            "drown" => "drowned",
            _ => "died",
        };
        server.broadcast(
            &ServerMsg::Chat { name: String::new(), text: format!("{name} {phrase}") },
            None,
        );
    }
    server.send_to(id, &ServerMsg::Health { hp });
}

async fn handle_client(server: Arc<Server>, stream: TcpStream) -> Result<(), Error> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();

    // All sends go through a channel so any task can talk to this client
    // while the writer owns the sink.
    let (tx, mut rx) = unbounded_channel::<Message>();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // The first message must be a hello.
    let name = loop {
        match source.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(ClientMsg::Hello { name }) = serde_json::from_str(text.as_str()) {
                    let name: String = name.trim().chars().take(16).collect();
                    break if name.is_empty() { "player".into() } else { name };
                }
                return Err("expected hello as first message".into());
            }
            Some(Ok(_)) => continue, // ignore pings etc.
            _ => return Ok(()),      // disconnected before hello
        }
    };

    let id = server.next_id.fetch_add(1, Ordering::Relaxed);
    let spawn = server.world.lock().unwrap().spawn_point();

    let players: Vec<PlayerInfo> = server
        .clients
        .lock()
        .unwrap()
        .iter()
        .map(|(&id, c)| PlayerInfo {
            id,
            name: c.name.clone(),
            pos: c.pos,
        })
        .collect();

    server.clients.lock().unwrap().insert(
        id,
        Client {
            tx: tx.clone(),
            name: name.clone(),
            pos: spawn,
            hp: FULL_HP,
            food: FULL_FOOD,
            food_t: 0.0,
            starve_t: 0.0,
            regen_t: 0.0,
            inventory: HashMap::new(),
        },
    );

    server.send_to(id, &ServerMsg::Welcome { id, spawn, players });
    server.send_to(id, &ServerMsg::Time { t: server.world_time() });
    server.send_to(id, &ServerMsg::Health { hp: FULL_HP });
    server.send_to(id, &ServerMsg::Food { food: FULL_FOOD });
    let inv_msg = server.clients.lock().unwrap().get(&id).map(inventory_snapshot);
    if let Some(m) = inv_msg {
        server.send_to(id, &m);
    }
    let existing_drops: Vec<ServerMsg> = server
        .drops
        .lock()
        .unwrap()
        .values()
        .map(|d| ServerMsg::DropSpawn { id: d.id, item: d.item, x: d.pos[0], y: d.pos[1], z: d.pos[2] })
        .collect();
    for m in &existing_drops {
        server.send_to(id, m);
    }
    server.broadcast(
        &ServerMsg::PlayerJoin {
            id,
            name: name.clone(),
            pos: spawn,
        },
        Some(id),
    );
    println!("[+] {name} (#{id}) joined");

    while let Some(msg) = source.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(text) => {
                let Ok(parsed) = serde_json::from_str::<ClientMsg>(text.as_str()) else {
                    continue;
                };
                handle_msg(&server, id, parsed);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    server.clients.lock().unwrap().remove(&id);
    server.broadcast(&ServerMsg::PlayerLeave { id }, None);
    println!("[-] {name} (#{id}) left");
    Ok(())
}

fn handle_msg(server: &Server, id: u32, msg: ClientMsg) {
    match msg {
        ClientMsg::Hello { .. } => {}
        ClientMsg::ChunkReq { cx, cz } => {
            let data = {
                let mut world = server.world.lock().unwrap();
                let chunk = world.chunk(cx, cz);
                encode_chunk(cx, cz, &chunk.blocks)
            };
            if let Some(c) = server.clients.lock().unwrap().get(&id) {
                let _ = c.tx.send(Message::binary(data));
            }
        }
        ClientMsg::SetBlock { x, y, z, id: bid } => {
            // y == 0 is kept as a floor so nobody digs out of the world.
            let allowed = (bid == block::AIR || block::placeable(bid)) && y > 0;
            if !allowed {
                return;
            }
            // Placing needs stock — wall torch variants all cost the one
            // torch item. Check-then-consume can't race with itself: a
            // client's messages are handled serially by its own read loop,
            // and other players only ever add to someone's inventory.
            let cost = if block::is_torch(bid) { block::TORCH } else { bid };
            if bid != block::AIR && !server.creative {
                let has = server
                    .clients
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|c| c.inventory.get(&cost).copied().unwrap_or(0) > 0);
                if !has {
                    // Revert the sender's optimistic local edit.
                    let current = server.world.lock().unwrap().block_at(x, y, z);
                    server.send_to(id, &ServerMsg::BlockUpdate { x, y, z, id: current });
                    return;
                }
            }

            let prev = {
                let mut world = server.world.lock().unwrap();
                let prev = world.block_at(x, y, z);
                if prev == bid || !world.set_block(x, y, z, bid) {
                    return;
                }
                prev
            };
            // Echoed to everyone, sender included: the server is authoritative.
            server.broadcast(&ServerMsg::BlockUpdate { x, y, z, id: bid }, None);

            if bid == block::AIR {
                // Breaking pops the block out as an item drop.
                let did = server.next_drop_id.fetch_add(1, Ordering::Relaxed);
                let mut rng = mobs::Rng(did.wrapping_mul(0x9e37_79b9) ^ 0x517c_c1b7);
                if let Some(item) = drops::drop_for(prev, rng.unit()) {
                    let d = Drop::new(did, item, x, y, z, rng.unit(), rng.unit());
                    let msg = ServerMsg::DropSpawn { id: did, item, x: d.pos[0], y: d.pos[1], z: d.pos[2] };
                    server.drops.lock().unwrap().insert(did, d);
                    server.broadcast(&msg, None);
                }
            } else if !server.creative {
                // Placing consumes one from stock.
                let snapshot = {
                    let mut clients = server.clients.lock().unwrap();
                    clients.get_mut(&id).map(|c| {
                        let n = c.inventory.entry(cost).or_insert(0);
                        *n = n.saturating_sub(1);
                        inventory_snapshot(c)
                    })
                };
                if let Some(s) = snapshot {
                    server.send_to(id, &s);
                }
            }
        }
        ClientMsg::Attack { id: mob_id, tool } => {
            let Some(ppos) = server.clients.lock().unwrap().get(&id).map(|c| c.pos) else {
                return;
            };
            let dmg = match tool.as_deref() {
                Some("sword") => 6,
                Some(_) => 3,
                None => 2,
            };
            let mut outcome = None;
            {
                let mut mob_map = server.mobs.lock().unwrap();
                if let Some(m) = mob_map.get_mut(&mob_id) {
                    let d2 = (m.pos[0] - ppos[0]).powi(2)
                        + (m.pos[1] - ppos[1]).powi(2)
                        + (m.pos[2] - ppos[2]).powi(2);
                    // Reach check so a client can't snipe across the map.
                    if d2 <= 30.0 {
                        m.hp -= dmg;
                        m.knockback(ppos);
                        if m.hp <= 0 {
                            mob_map.remove(&mob_id);
                            outcome = Some(ServerMsg::MobGone { id: mob_id });
                        } else {
                            outcome = Some(ServerMsg::MobHurt { id: mob_id });
                        }
                    }
                }
            }
            if let Some(msg) = outcome {
                server.broadcast(&msg, None);
            }
        }
        ClientMsg::Craft { recipe } => {
            let Some(r) = craft::RECIPES.get(recipe) else {
                return;
            };
            let snapshot = {
                let mut clients = server.clients.lock().unwrap();
                let Some(c) = clients.get_mut(&id) else { return };
                let affordable = r
                    .inputs
                    .iter()
                    .all(|(item, n)| c.inventory.get(item).copied().unwrap_or(0) >= *n);
                if !affordable {
                    return;
                }
                for (item, n) in r.inputs {
                    *c.inventory.get_mut(item).unwrap() -= n;
                }
                *c.inventory.entry(r.output.0).or_insert(0) += r.output.1;
                inventory_snapshot(c)
            };
            server.send_to(id, &snapshot);
        }
        ClientMsg::Fall { blocks } => {
            // A heart per block beyond three; ~23 blocks is lethal from
            // full health. The clamp keeps a hostile client from claiming
            // more than the world's height.
            let dmg = (blocks.min(64.0) - 3.0).floor() as i32;
            if dmg > 0 {
                damage_player(server, id, dmg, "fall");
            }
        }
        ClientMsg::Eat => {
            let msgs = {
                let mut clients = server.clients.lock().unwrap();
                let Some(c) = clients.get_mut(&id) else { return };
                let apples = c.inventory.get(&block::APPLE).copied().unwrap_or(0);
                if apples == 0 || c.food >= FULL_FOOD {
                    return;
                }
                c.inventory.insert(block::APPLE, apples - 1);
                c.food = (c.food + 6).min(FULL_FOOD);
                (inventory_snapshot(c), ServerMsg::Food { food: c.food })
            };
            server.send_to(id, &msgs.0);
            server.send_to(id, &msgs.1);
        }
        ClientMsg::Drown => {
            damage_player(server, id, 2, "drown");
        }
        ClientMsg::Chat { text } => {
            let text: String = text.trim().chars().take(200).collect();
            if text.is_empty() {
                return;
            }
            let Some(name) = server.clients.lock().unwrap().get(&id).map(|c| c.name.clone())
            else {
                return;
            };
            server.broadcast(&ServerMsg::Chat { name, text }, None);
        }
        ClientMsg::Pos { x, y, z, yaw, pitch } => {
            if let Some(c) = server.clients.lock().unwrap().get_mut(&id) {
                c.pos = [x, y, z];
            }
            server.broadcast(
                &ServerMsg::PlayerPos {
                    id,
                    x,
                    y,
                    z,
                    yaw,
                    pitch,
                },
                Some(id),
            );
        }
    }
}
