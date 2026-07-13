// rustcraft server, Node.js edition — a line-for-line port of server/src/main.rs
// speaking the identical wire protocol, so the same client connects to either.

import { WebSocketServer } from 'ws';

import { encodeChunk } from './protocol.js';
import { block, World } from './world.js';

const PORT = Number(process.env.PORT || process.argv[2] || 8765);

const world = new World(1337);
const clients = new Map(); // id -> { ws, name, pos }
let nextId = 1;

function sendTo(id, msg) {
  const c = clients.get(id);
  if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(msg, except = null) {
  const text = JSON.stringify(msg);
  for (const [id, c] of clients) {
    if (id !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }
}

function handleMsg(id, msg) {
  switch (msg.type) {
    case 'chunk_req': {
      const { cx, cz } = msg;
      if (!Number.isInteger(cx) || !Number.isInteger(cz)) return;
      const chunk = world.chunk(cx, cz);
      const c = clients.get(id);
      if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(encodeChunk(cx, cz, chunk.blocks));
      break;
    }
    case 'set_block': {
      const { x, y, z, id: bid } = msg;
      if (![x, y, z].every(Number.isInteger)) return;
      // y == 0 is kept as a floor so nobody digs out of the world.
      const allowed = (bid === block.AIR || block.placeable(bid)) && y > 0;
      if (!allowed) return;
      if (world.setBlock(x, y, z, bid)) {
        // Echoed to everyone, sender included: the server is authoritative.
        broadcast({ type: 'block_update', x, y, z, id: bid });
      }
      break;
    }
    case 'pos': {
      const { x, y, z, yaw, pitch } = msg;
      const c = clients.get(id);
      if (c) c.pos = [x, y, z];
      broadcast({ type: 'player_pos', id, x, y, z, yaw, pitch }, id);
      break;
    }
  }
}

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

wss.on('connection', (ws) => {
  let id = null;
  let name = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // The first message must be a hello.
    if (id === null) {
      if (msg.type !== 'hello') {
        ws.close();
        return;
      }
      name = String(msg.name ?? '').trim().slice(0, 16) || 'player';
      id = nextId++;
      const spawn = world.spawnPoint();

      const players = [...clients.entries()].map(([pid, c]) => ({ id: pid, name: c.name, pos: c.pos }));
      clients.set(id, { ws, name, pos: spawn });

      sendTo(id, { type: 'welcome', id, spawn, players });
      broadcast({ type: 'player_join', id, name, pos: spawn }, id);
      console.log(`[+] ${name} (#${id}) joined`);
      return;
    }

    handleMsg(id, msg);
  });

  ws.on('close', () => {
    if (id === null) return;
    clients.delete(id);
    broadcast({ type: 'player_leave', id });
    console.log(`[-] ${name} (#${id}) left`);
  });

  ws.on('error', () => ws.close());
});

console.log(`rustcraft server (node) listening on ws://0.0.0.0:${PORT}`);
