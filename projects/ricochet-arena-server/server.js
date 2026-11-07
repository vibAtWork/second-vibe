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
// Address bans are off by default: friends and family often share one IP, and a
// kicked bot gets detected again anyway. Opt in with banMinutes / BAN_MINUTES.

// anticheat: 'kick' | 'flag' | 'off'. adminToken: enables GET /admin/reports?token=...
export function createServer({ port = 8080, log = console.log, anticheat = 'kick', adminToken = '', banMinutes = 0 } = {}) {
  const bans = new Map(); // remote address -> banned until (ms)
  const banned = ip => { const until = bans.get(ip); if (until && until > Date.now()) return true; bans.delete(ip); return false; };

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/admin/reports')) {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      if (!adminToken || token !== adminToken) { res.writeHead(404); return res.end('not found'); }
      const reports = [...rooms].flatMap(([room, r]) => r.reports.map(x => ({ room, ...x })));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ bans: [...bans].map(([ip, until]) => ({ ip, until: new Date(until).toISOString() })), reports }, null, 2));
    }
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
    const ip = req.socket.remoteAddress;
    if (banned(ip)) return ws.close(4003, 'banned for cheating');
    if (!rooms.has(roomName) && rooms.size >= MAX_ROOMS) return ws.close(1013, 'server full');
    let room = rooms.get(roomName);
    if (!room) {
      room = new HostRoom({
        anticheat, log: m => log(`[${roomName}] ${m}`),
        onKick: kickedConn => { if (banMinutes > 0) bans.set(kickedConn.ip, Date.now() + banMinutes * 60000); setTimeout(() => kickedConn.kick(), 500); },
      });
      rooms.set(roomName, room);
    }
    const conn = {
      send: msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      kick: () => ws.terminate(),
      ip,
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
  createServer({ port, anticheat: process.env.ANTICHEAT || 'kick', adminToken: process.env.ADMIN_TOKEN || '', banMinutes: +(process.env.BAN_MINUTES || 0) }).then(({ port }) => console.log(`Ricochet Arena running at http://localhost:${port}`));
}
