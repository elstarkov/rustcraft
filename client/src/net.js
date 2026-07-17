// WebSocket client for the rustcraft server. Text frames carry JSON control
// messages; binary frames carry raw chunk data (see server/src/protocol.rs).

const BIN_CHUNK = 1;

export class Net {
  constructor(url, name, handlers) {
    this.handlers = handlers;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.closed = false;

    this.ws.onopen = () => this.send({ type: 'hello', name });
    this.ws.onerror = () => this.fail();
    this.ws.onclose = () => this.fail();
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handlers.onMessage(JSON.parse(ev.data));
        return;
      }
      const view = new DataView(ev.data);
      if (view.getUint8(0) === BIN_CHUNK) {
        const cx = view.getInt32(1, true);
        const cz = view.getInt32(5, true);
        const blocks = new Uint8Array(ev.data, 9);
        this.handlers.onChunk(cx, cz, blocks);
      }
    };
  }

  fail() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onDisconnect();
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  requestChunk(cx, cz) {
    this.send({ type: 'chunk_req', cx, cz });
  }

  setBlock(x, y, z, id) {
    this.send({ type: 'set_block', x, y, z, id });
  }

  attack(id, tool) {
    this.send({ type: 'attack', id, tool });
  }

  craft(recipe) {
    this.send({ type: 'craft', recipe });
  }

  fall(blocks) {
    this.send({ type: 'fall', blocks });
  }

  chat(text) {
    this.send({ type: 'chat', text });
  }

  sendPos(pos, yaw, pitch) {
    this.send({ type: 'pos', x: pos.x, y: pos.y, z: pos.z, yaw, pitch });
  }
}
