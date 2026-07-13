// Wire protocol — mirrors server/src/protocol.rs. Control messages are JSON
// text frames tagged with `type`; chunk payloads travel as binary frames.

export const BIN_CHUNK = 1;

/** Binary chunk frame: [BIN_CHUNK][cx: i32 LE][cz: i32 LE][blocks...] */
export function encodeChunk(cx, cz, blocks) {
  const buf = Buffer.allocUnsafe(9 + blocks.length);
  buf.writeUInt8(BIN_CHUNK, 0);
  buf.writeInt32LE(cx, 1);
  buf.writeInt32LE(cz, 5);
  buf.set(blocks, 9);
  return buf;
}
