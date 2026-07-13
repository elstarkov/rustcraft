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

### Alternative server: Node.js

`server-js/` is a line-for-line port of the Rust server speaking the identical
wire protocol — the client connects to either without changes. It exists to
compare the two runtimes:

```sh
cd server-js
npm install
npm start          # same ws://0.0.0.0:8765 (PORT=8766 npm start to override)
```

Same seed produces a world with identical shape and cost, but not
block-for-block identical terrain (the permutation table behind the Perlin
noise is shuffled by a different RNG).

`bench/` contains a protocol-level load test that runs against both servers:

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
world). Chunks generate lazily on first request and are cached with any player
edits applied.

**Protocol** — JSON text frames for control messages (`hello`, `chunk_req`,
`set_block`, `pos` → `welcome`, `block_update`, `player_join/pos/leave`) and
binary frames for chunk payloads: `[kind u8][cx i32][cz i32][16384 block bytes]`.

**Client rendering** — a 16px-per-tile texture atlas is generated procedurally
on a canvas at startup (no asset files). The mesher emits only block faces
adjacent to air or see-through blocks, with per-face shading baked into vertex
colors, split into opaque and transparent passes. Mesh rebuilds are budgeted
per frame; chunks stream in nearest-first and are evicted when far away.

**Physics** — the player is a 0.6×1.8 AABB integrated per axis against the
voxel grid (gravity, jumping, swimming). Block targeting uses an
Amanatides & Woo voxel raycast, so picking is exact rather than mesh-based.

## Roadmap

- [ ] Caves and ores
- [ ] Chunk persistence to disk (world survives server restarts)
- [ ] Greedy meshing + meshing in a web worker
- [ ] Day/night cycle
- [ ] Player avatars with skins, walk animation
- [ ] Rust → wasm meshing module shared between client and server
