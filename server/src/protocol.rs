use serde::{Deserialize, Serialize};

/// Messages a client sends as JSON text frames.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello { name: String },
    ChunkReq { cx: i32, cz: i32 },
    SetBlock { x: i32, y: i32, z: i32, id: u8 },
    Pos { x: f32, y: f32, z: f32, yaw: f32, pitch: f32 },
}

#[derive(Serialize, Clone)]
pub struct PlayerInfo {
    pub id: u32,
    pub name: String,
    pub pos: [f32; 3],
}

/// Messages the server sends as JSON text frames.
/// Chunk payloads travel as binary frames instead — see `encode_chunk`.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        id: u32,
        spawn: [f32; 3],
        players: Vec<PlayerInfo>,
    },
    PlayerJoin {
        id: u32,
        name: String,
        pos: [f32; 3],
    },
    PlayerLeave {
        id: u32,
    },
    PlayerPos {
        id: u32,
        x: f32,
        y: f32,
        z: f32,
        yaw: f32,
        pitch: f32,
    },
    BlockUpdate {
        x: i32,
        y: i32,
        z: i32,
        id: u8,
    },
    /// World time as a fraction of a day: 0 sunrise, 0.25 noon, 0.5 sunset.
    Time {
        t: f32,
    },
}

pub const BIN_CHUNK: u8 = 1;

/// Binary chunk frame: [BIN_CHUNK][cx: i32 LE][cz: i32 LE][blocks...]
pub fn encode_chunk(cx: i32, cz: i32, blocks: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(9 + blocks.len());
    buf.push(BIN_CHUNK);
    buf.extend_from_slice(&cx.to_le_bytes());
    buf.extend_from_slice(&cz.to_le_bytes());
    buf.extend_from_slice(blocks);
    buf
}
