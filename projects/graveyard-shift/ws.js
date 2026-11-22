// Minimal WebSocket server (RFC 6455) on top of node:http - no dependencies.
// Supports what the game needs: text messages (incl. fragmented), ping/pong,
// close, a payload size limit, and dropping clients that can't keep up.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFERED = 1 << 20; // a client this far behind is too slow: drop it

export class WsConn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 1; // OPEN (same numbering as the browser API)
    this.buf = Buffer.alloc(0);
    this.parts = [];
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  send(text) {
    if (this.readyState !== 1) return;
    if (this.socket.writableLength > MAX_BUFFERED) return this.terminate();
    this.frame(0x1, Buffer.from(text));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code); r.copy(p, 2);
    this.frame(0x8, p);
    this.readyState = 2; // CLOSING
    this.socket.end();
  }

  terminate() { this.socket.destroy(); this.finish(); }

  finish() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  frame(opcode, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    this.socket.write(Buffer.concat([head, payload]));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = this.buf[0] & 0x80, opcode = this.buf[0] & 0x0f, masked = this.buf[1] & 0x80;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > this.maxPayload) return this.close(1009, 'bad frame'); // clients must mask; size limit
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) return this.close();             // close
      if (opcode === 0x9) { this.frame(0xA, data); continue; } // ping -> pong
      if (opcode === 0xA) continue;                         // pong
      if (opcode === 0x1 || opcode === 0x0) {               // text / continuation
        this.parts.push(data);
        const size = this.parts.reduce((a, p) => a + p.length, 0);
        if (size > this.maxPayload) return this.close(1009, 'too big');
        if (fin) { const msg = Buffer.concat(this.parts).toString(); this.parts = []; this.emit('message', msg); }
      }
      // binary frames are ignored
    }
  }
}

// Accept an HTTP upgrade request as a WebSocket; calls onConnection(conn, req).
export function acceptUpgrades(server, onConnection, { maxPayload = 16 * 1024 } = {}) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) return socket.destroy();
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onConnection(new WsConn(socket, maxPayload), req);
  });
}
