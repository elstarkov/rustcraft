// Protocol-level load test for a rustcraft server (Rust or Node — same wire
// protocol, so the same test runs against both).
//
//   node loadtest.js ws://localhost:8765 [--bots 20] [--radius 8] [--secs 10]
//
// Phase 1 (chunk burst): every bot connects and requests all chunks in a
// (2*radius+1)^2 square, like a client loading its view distance at login.
// Measures aggregate chunk throughput and bytes moved.
//
// Phase 2 (relay load): all bots spam pos updates at 20 Hz (the server relays
// each to every other bot), while bot #0 places a block twice a second and
// times the round trip until the server's block_update echo arrives. That RTT
// is the "does the game feel laggy" number under load.

import WebSocket from 'ws';

const url = process.argv[2] || 'ws://localhost:8765';
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : Number(process.argv[i + 1]);
};
const BOTS = arg('bots', 20);
const RADIUS = arg('radius', 8);
const SECS = arg('secs', 10);
const POS_HZ = 20;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

class Bot {
  constructor(i) {
    this.i = i;
    this.chunksLeft = 0;
    this.bytes = 0;
    this.relayed = 0;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', name: `bot${i}` })));
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) {
          this.bytes += data.byteLength ?? data.length;
          if (--this.chunksLeft === 0 && this.onBurstDone) this.onBurstDone();
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === 'welcome') {
          this.spawn = msg.spawn;
          resolve();
        } else if (msg.type === 'player_pos') {
          this.relayed++;
        } else if (msg.type === 'block_update' && this.onEcho) {
          this.onEcho(msg);
        }
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  // Each bot loads its own region of the map so every chunk is freshly
  // generated — otherwise bot #0 generates and everyone else gets cache hits.
  burst(radius) {
    return new Promise((resolve) => {
      this.chunksLeft = (2 * radius + 1) ** 2;
      this.onBurstDone = resolve;
      const off = this.i * 64;
      for (let cz = -radius; cz <= radius; cz++) {
        for (let cx = -radius; cx <= radius; cx++) {
          this.send({ type: 'chunk_req', cx: cx + off, cz });
        }
      }
    });
  }
}

console.log(`target ${url} — ${BOTS} bots, chunk radius ${RADIUS}, relay phase ${SECS}s`);

// --- connect ---
const bots = Array.from({ length: BOTS }, (_, i) => new Bot(i));
await Promise.all(bots.map((b) => b.ready));
console.log(`connected ${BOTS} bots`);

// --- phase 1: chunk burst ---
const perSquare = (2 * RADIUS + 1) ** 2;
const t0 = performance.now();
await Promise.all(bots.map((b) => b.burst(RADIUS)));
const burstMs = performance.now() - t0;
const totalChunks = perSquare * BOTS;
const totalMB = bots.reduce((s, b) => s + b.bytes, 0) / 1e6;
console.log(`\nchunk burst: ${totalChunks} chunks (${perSquare}/bot) in ${burstMs.toFixed(0)} ms`);
console.log(`  ${(totalChunks / (burstMs / 1000)).toFixed(0)} chunks/s, ${(totalMB / (burstMs / 1000)).toFixed(1)} MB/s`);

// --- phase 2: pos relay + block-echo RTT ---
const rtts = [];
let pending = null;
bots[0].onEcho = () => {
  if (pending !== null) {
    rtts.push(performance.now() - pending);
    pending = null;
  }
};

const timers = [];
for (const b of bots) {
  let t = 0;
  const [sx, sy, sz] = b.spawn;
  timers.push(setInterval(() => {
    t += 0.05;
    b.send({
      type: 'pos',
      x: sx + 10 * Math.sin(t + b.i), y: sy, z: sz + 10 * Math.cos(t + b.i),
      yaw: t, pitch: 0,
    });
  }, 1000 / POS_HZ));
}
timers.push(setInterval(() => {
  if (pending === null) {
    pending = performance.now();
    bots[0].send({ type: 'set_block', x: 1000, y: 1, z: 1000, id: 3 });
  }
}, 500));

await new Promise((r) => setTimeout(r, SECS * 1000));
timers.forEach(clearInterval);

const relayed = bots.reduce((s, b) => s + b.relayed, 0);
rtts.sort((a, b) => a - b);
console.log(`\nrelay load: ${BOTS} bots at ${POS_HZ} Hz for ${SECS}s`);
console.log(`  ${(relayed / SECS).toFixed(0)} msgs/s relayed (expected ~${BOTS * (BOTS - 1) * POS_HZ})`);
if (rtts.length) {
  console.log(`  block-echo RTT: p50 ${percentile(rtts, 50).toFixed(2)} ms, p99 ${percentile(rtts, 99).toFixed(2)} ms, max ${rtts[rtts.length - 1].toFixed(2)} ms (n=${rtts.length})`);
}

bots.forEach((b) => b.ws.close());
process.exit(0);
