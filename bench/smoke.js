// Protocol smoke test: hello → welcome, chunk_req → binary chunk,
// set_block → block_update echo, second client sees player_join + player_pos.
import WebSocket from 'ws';

const url = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const a = new WebSocket(url);
a.binaryType = 'arraybuffer';
const aMsgs = [];
let chunkFrame = null;
a.on('message', (data, isBinary) => {
  if (isBinary) chunkFrame = data;
  else aMsgs.push(JSON.parse(data.toString()));
});
await new Promise((r) => a.on('open', r));
a.send(JSON.stringify({ type: 'hello', name: '  tester-with-a-very-long-name  ' }));
await new Promise((r) => setTimeout(r, 300));

const welcome = aMsgs.find((m) => m.type === 'welcome');
check('welcome received', !!welcome, JSON.stringify(welcome));
check('welcome has numeric id + spawn[3]', Number.isInteger(welcome?.id) && welcome?.spawn?.length === 3);

a.send(JSON.stringify({ type: 'chunk_req', cx: 0, cz: 0 }));
await new Promise((r) => setTimeout(r, 300));

check('chunk binary frame', !!chunkFrame, chunkFrame ? `${chunkFrame.byteLength} bytes` : 'none');
let surfaceY = -1;
if (chunkFrame) {
  const v = new DataView(chunkFrame);
  check('chunk frame layout', v.getUint8(0) === 1 && v.getInt32(1, true) === 0 && v.getInt32(5, true) === 0 && chunkFrame.byteLength === 9 + 16 * 16 * 64);
  const blocks = new Uint8Array(chunkFrame, 9);
  const nonAir = blocks.reduce((s, b) => s + (b !== 0 ? 1 : 0), 0);
  check('chunk has terrain', nonAir > 4000 && nonAir < 16384, `${nonAir} non-air blocks`);
  for (let y = 63; y >= 0; y--) {
    const id = blocks[(y * 16 + 5) * 16 + 5];
    if (id !== 0 && id !== 9) { surfaceY = y; break; }
  }
}

// Breaking always echoes (placing would need stock in the inventory).
a.send(JSON.stringify({ type: 'set_block', x: 5, y: surfaceY, z: 5, id: 0 }));
a.send(JSON.stringify({ type: 'set_block', x: 5, y: 0, z: 5, id: 0 })); // must be rejected (floor)
a.send(JSON.stringify({ type: 'set_block', x: 6, y: 30, z: 6, id: 9 })); // must be rejected (water)
await new Promise((r) => setTimeout(r, 300));

const updates = aMsgs.filter((m) => m.type === 'block_update');
check('set_block echoed to sender', updates.length === 1 && updates[0].x === 5 && updates[0].y === surfaceY && updates[0].id === 0, JSON.stringify(updates));

// Second client: should see tester in players list, then get pos relays.
const b = new WebSocket(url);
const bMsgs = [];
b.on('message', (data, isBinary) => { if (!isBinary) bMsgs.push(JSON.parse(data.toString())); });
await new Promise((r) => b.on('open', r));
b.send(JSON.stringify({ type: 'hello', name: '' }));
await new Promise((r) => setTimeout(r, 200));
a.send(JSON.stringify({ type: 'pos', x: 1.5, y: 30, z: 2.5, yaw: 0.5, pitch: -0.2 }));
await new Promise((r) => setTimeout(r, 200));

const bWelcome = bMsgs.find((m) => m.type === 'welcome');
check('empty name defaults to "player"', bWelcome && aMsgs.some((m) => m.type === 'player_join' && m.name === 'player'));
check('players list includes first client (name trimmed to 16)', bWelcome?.players?.some((p) => p.name === 'tester-with-a-ve'), JSON.stringify(bWelcome?.players));
check('pos relayed to other client only', bMsgs.some((m) => m.type === 'player_pos' && m.x === 1.5) && !aMsgs.some((m) => m.type === 'player_pos'));

b.close();
await new Promise((r) => setTimeout(r, 200));
check('player_leave broadcast', aMsgs.some((m) => m.type === 'player_leave' && m.id === bWelcome.id));

a.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
