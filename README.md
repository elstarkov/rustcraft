# rustcraft

A Minecraft-style multiplayer voxel game with a hybrid architecture:

- **`server/`** — authoritative game server written in **Rust**. Owns the world:
  procedural terrain generation, chunk storage, block edits, and player state.
  Talks to clients over WebSockets.
- **`client/`** — browser client written in **JavaScript** with **Three.js**.
  Renders chunks streamed from the server, handles first-person controls,
  physics, and block breaking/placing.

```
┌────────────────┐   WebSocket    ┌──────────────────────┐
│  Rust server   │ ◄────────────► │ JS client (Three.js) │
│  - world gen   │  JSON control  │  - chunk meshing     │
│  - chunk store │  binary chunks │  - rendering         │
│  - block edits │                │  - input & physics   │
│  - player sync │                │  - HUD               │
└────────────────┘                └──────────────────────┘
```

The server is the source of truth. Clients request chunks around the player,
receive raw block data as binary WebSocket frames (16 KB per chunk), and build
face-culled meshes locally. Block edits are validated server-side and broadcast
to everyone — so multiplayer works out of the box: open a second tab and you'll
see the other player walking around.

## Running

Terminal 1 — the server (needs [Rust](https://rustup.rs)):

```sh
cd server
cargo run
# rustcraft server listening on ws://0.0.0.0:8765
```

Terminal 2 — the client (needs Node 20+):

```sh
cd client
npm install
npm run dev
# open http://localhost:5173
```

Click to grab the mouse and play. To play over LAN, run `npm run dev -- --host`
and have friends open `http://<your-ip>:5173` — the client connects to the
WebSocket server on the same hostname.

### Benchmarking

`bench/` contains a protocol-level test suite for the server:

```sh
cd bench
npm install
node smoke.js ws://localhost:8765     # protocol conformance (10 checks)
node loadtest.js ws://localhost:8765 --bots 60 --radius 8 --secs 15
```

Phase 1 has every bot burst-load its view distance from a fresh region of the
map (measures world gen + encode throughput); phase 2 has all bots stream pos
updates at 20 Hz while timing block-edit round trips (measures relay latency
under load). Restart the server between runs so chunks aren't served from
cache.

### Controls

| Input | Action |
| --- | --- |
| WASD | move |
| mouse | look |
| SPACE | jump / swim up |
| left click | break block |
| right click | place block |
| 1–8 / wheel | select block |

## How it works

**World** — chunks are 16×16×64 blocks. Terrain comes from three octaves of
Perlin noise; columns get grass/dirt/stone layering, sand near the waterline,
water up to sea level, and deterministic tree placement (same seed → same
world). Caves are carved by 3D noise — caverns where one field runs hot,
winding tunnels where two fields cross zero together — with a sealed floor
under oceans and lakes so water never rests on air. Coal, iron, and gold veins
come from hashed 2×2×2 cells in stone, each rarer and deeper than the last. Chunks generate lazily on first request and are cached with any player
edits applied. Edited chunks are written through to `server/world/` as raw
16 KB files and loaded from disk before regeneration, so builds survive server
restarts — untouched terrain keeps regenerating from the seed and costs no
disk at all.

**Protocol** — JSON text frames for control messages (`hello`, `chunk_req`,
`set_block`, `pos` → `welcome`, `block_update`, `player_join/pos/leave`,
`time`) and binary frames for chunk payloads:
`[kind u8][cx i32][cz i32][16384 block bytes]`.

**Day/night** — one in-game day lasts ten minutes. The server owns the clock
and rebroadcasts it every five seconds; clients advance it locally between
corrections and drive the sun's angle and intensity, hemisphere light, and
sky/fog color from it, with a warm glow pass around dawn and dusk.

**Client rendering** — a 16px-per-tile texture atlas is generated procedurally
on a canvas at startup (no asset files). Meshing happens in a web worker: the
main thread snapshots dirty chunks (blocks plus one-block neighbor borders)
and gets back transferable vertex buffers, so even a burst of chunk arrivals
never blocks a frame. The mesher is greedy — coplanar faces with the same
texture and transparency merge into maximal rectangles, which melts real
terrain to ~18% of the naive visible-face geometry. Merged quads carry uvs in
block units plus a per-vertex atlas-tile index; a small patch to the Lambert
shader wraps the uv with `fract()` inside the chosen tile, so textures tile
across merged quads (nearest filtering, no mipmaps, so the trick is
artifact-free). Per-face shading is baked into vertex colors, opaque and
transparent passes are separate meshes; chunks stream in nearest-first and are
evicted when far away.

**Players** — remote players are blocky avatars (head, body, arms, legs) with
deterministic per-id skins: shirt and pants colors from a golden-angle hue
walk, one of four skin tones, hair, and an 8×8 pixel face. The walk cycle is
paced by how fast the avatar actually moves between network updates, the head
follows the sender's pitch, and yaw turns the short way around the circle.

**Physics** — the player is a 0.6×1.8 AABB integrated per axis against the
voxel grid (gravity, jumping, swimming). Block targeting uses an
Amanatides & Woo voxel raycast, so picking is exact rather than mesh-based.

## Roadmap

- [x] Caves and ores
- [x] Chunk persistence to disk (world survives server restarts)
- [x] Greedy meshing + meshing in a web worker
- [x] Day/night cycle
- [x] Player avatars with skins, walk animation
- [ ] Rust → wasm meshing module shared between client and server
