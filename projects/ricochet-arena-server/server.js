// Authoritative game server: serves the static client and runs one Game per
// room at 25 ticks/s. Clients send input frames (sequence-numbered); the
// server applies one input frame per tick per tank and broadcasts snapshots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { FRAME_MS } from './public/shared/sim.js';
import { HostRoom } from './public/shared/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_ROOMS = 500;

export function createServer({ port = 8080, log = console.log } = {}) {
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  // room name -> HostRoom (the same authoritative room code the P2P host runs)
  const rooms = new Map();

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const roomName = (url.searchParams.get('room') || 'lobby').slice(0, 32).replace(/[^\w-]/g, '') || 'lobby';
    if (!rooms.has(roomName) && rooms.size >= MAX_ROOMS) return ws.close(1013, 'server full');
    let room = rooms.get(roomName);
    if (!room) { room = new HostRoom({ log: m => log(`[${roomName}] ${m}`) }); rooms.set(roomName, room); }
    const conn = {
      send: msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      kick: () => ws.terminate(),
    };
    room.addConn(conn);
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      room.handle(conn, msg);
    });
    ws.on('close', () => {
      room.removeConn(conn);
      if (room.conns.size === 0) rooms.delete(roomName);
    });
  });

  // Fixed-rate loop with drift compensation.
  let next = performance.now();
  let timer;
  function loop() {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) { for (const room of rooms.values()) room.tick(); next += FRAME_MS; n++; }
    if (now - next > 1000) next = now; // stalled; don't spiral
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  }
  loop();

  return new Promise(resolve => {
    server.listen(port, () => {
      const actual = server.address().port;
      resolve({ port: actual, rooms, close: () => { clearTimeout(timer); wss.close(); server.close(); for (const c of wss.clients) c.terminate(); } });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +(process.env.PORT || 8080);
  createServer({ port }).then(({ port }) => console.log(`Ricochet Arena running at http://localhost:${port}`));
}
