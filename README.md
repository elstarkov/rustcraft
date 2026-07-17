# rustcraft

A Minecraft-style multiplayer voxel game with a hybrid architecture:

- **`server/`** — authoritative game server written in **Rust**. Owns the world:
  procedural terrain generation, chunk storage, block edits, player state, and
  mob AI. Talks to clients over WebSockets.
- **`client/`** — browser client written in **JavaScript** with **Three.js**.
  Renders chunks streamed from the server, handles first-person controls,
  physics, and block breaking/placing.
- **`mesher-wasm/`** — the client's greedy mesher as a **Rust** crate compiled
  to WebAssembly, with the JS port kept as a fallback.

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
| hold left click | mine block (faster with the right tool) |
| left click a zombie | attack — sword 6, tools 3, fists 2 |
| right click | place block |
| 1–8 / wheel | select block or tool |
| E | open / close crafting |

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
`set_block`, `pos`, `craft` → `welcome`, `block_update`, `player_join/pos/leave`,
`time`, `drop_spawn/drops/drop_gone`, `inventory`) and binary frames for chunk payloads:
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
evicted when far away. The first-person hand — an arm in your avatar's skin
holding the selected block or tool — lives in a tiny camera-space scene
rendered as a second pass over a cleared depth buffer, so it never clips into
walls; it swings on use, keeps chopping while you mine, bobs as you walk, and
darkens with the night.

The mesher exists twice: `mesher-wasm/` is a Rust port compiled to a 22 KB
wasm module (raw pointer ABI, no bindgen) that the worker prefers — ~5× faster
than the JS mesher with byte-identical output — and `mesh-core.js` is the
fallback if instantiation fails. The `.wasm` is checked in, so running the
client needs no Rust toolchain; rebuild it with `npm run build:wasm` (needs
`rustup target add wasm32-unknown-unknown`).

**Items & mining** — the hotbar holds eleven blocks (the three ores included)
plus four tools (pickaxe, shovel, axe, sword — scroll past the blocks to
reach them). Breaking is timed: every block has a hardness (sand is half a
second bare-handed, ores are several), the matching tool mines its block
class 5× faster, and crack stages overlay the block while you hold the
button. A broken block pops out as a little spinning cube that falls, settles
(or bobs in water), and despawns after five minutes — walk over it to collect
it. The inventory is server-authoritative: counts show on the hotbar slots,
placing consumes stock, and a placement without stock is reverted by the
server. Every block drops itself, so anything you can see you can collect;
new players start with empty pockets — punch a tree. E opens the crafting
panel: a log becomes four planks, sand becomes glass, each recipe a click
(grayed out until you have the ingredients — the server validates and
applies, the client only draws the menu). The sword mines nothing faster —
it's for fighting. Tools are free and indestructible for now.

**Monsters** — zombies spawn on the surface near players at night (the server
clock decides) and despawn at dawn, when everyone leaves, or after idling too
long — usually that means one fell into a cave mid-chase. AI runs server-side
at 10 Hz with the same AABB voxel physics as players: they wander, chase
anyone within 3D range, hop single blocks (the jump speed is tuned for the
coarse tick), float across ponds, and swing for 3 damage in melee range.
Players carry 20 hp rendered as hearts, flash red when hit, and respawn at
world spawn on death. Swinging back deals 6 with the sword, 3 with other
tools, 2 bare-handed, with knockback — a zombie dies after 12.

**Sound** — every effect is synthesized by the Web Audio API the moment it
plays: digs and footsteps are filtered noise bursts, pickups are sine chirps,
crafting is a wooden double-knock, hurt is a falling square wave, and zombie
groans are a wobbling low sawtooth faded and stereo-panned by where the
zombie actually stands. Like the textures, no audio files ship with the game.

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
- [x] Rust → wasm meshing module (~5× the JS mesher, JS fallback kept)
- [x] Tools and timed mining with crack stages
- [x] Zombies at night, player health and respawn
- [x] Item drops and a server-authoritative inventory
- [x] First-person hand with the held block or tool
- [x] Crafting (logs → planks, sand → glass)
- [x] Synthesized sound effects (Web Audio, no asset files)
- [ ] More mob types
