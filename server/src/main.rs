mod protocol;
mod world;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use protocol::{encode_chunk, ClientMsg, PlayerInfo, ServerMsg};
use world::{block, World};

type Error = Box<dyn std::error::Error + Send + Sync>;

struct Client {
    tx: UnboundedSender<Message>,
    name: String,
    pos: [f32; 3],
}

/// One in-game day lasts ten minutes of wall clock.
const DAY_SECONDS: f64 = 600.0;

struct Server {
    world: Mutex<World>,
    clients: Mutex<HashMap<u32, Client>>,
    next_id: AtomicU32,
    started: std::time::Instant,
}

impl Server {
    /// Fraction of the current day: 0 sunrise, 0.25 noon, 0.5 sunset.
    /// Starts mid-morning so new worlds open in daylight.
    fn world_time(&self) -> f32 {
        ((self.started.elapsed().as_secs_f64() / DAY_SECONDS + 0.1) % 1.0) as f32
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
    let server = Arc::new(Server {
        world: Mutex::new(world),
        clients: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        started: std::time::Instant::now(),
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
        },
    );

    server.send_to(id, &ServerMsg::Welcome { id, spawn, players });
    server.send_to(id, &ServerMsg::Time { t: server.world_time() });
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
            if server.world.lock().unwrap().set_block(x, y, z, bid) {
                // Echoed to everyone, sender included: the server is authoritative.
                server.broadcast(&ServerMsg::BlockUpdate { x, y, z, id: bid }, None);
            }
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
