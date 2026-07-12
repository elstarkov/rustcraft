# rustcraft

A Minecraft-style voxel game with a hybrid architecture:

- **`server/`** — authoritative game server written in **Rust**. Owns the world:
  procedural terrain generation, chunk storage, block edits, and player state.
  Talks to clients over WebSockets.
- **`client/`** — browser client written in **JavaScript** with **Three.js**.
  Renders chunks streamed from the server, handles first-person controls,
  physics, and block breaking/placing.

## Status

🚧 Early days — scaffolding in progress.

## Architecture

```
┌────────────────┐   WebSocket    ┌─────────────────────┐
│  Rust server    │ ◄────────────► │  JS client (Three.js)│
│  - world gen    │  JSON control  │  - chunk meshing     │
│  - chunk store  │  binary chunks │  - rendering         │
│  - block edits  │                │  - input & physics   │
│  - player sync  │                │  - HUD               │
└────────────────┘                └─────────────────────┘
```

The server is the source of truth. Clients request chunks around the player,
receive raw block data as binary WebSocket frames, and build optimized meshes
locally. Block edits go to the server and are broadcast to everyone — so
multiplayer works out of the box.

## Running

See `server/` and `client/` READMEs (coming as the pieces land).
