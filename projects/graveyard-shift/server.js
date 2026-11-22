// Graveyard Shift server: serves the browser client and runs one authoritative
// Room per invite link at 30 ticks/s. No npm dependencies (see ws.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrades } from './ws.js';
import { FRAME_MS } from './public/shared/sim.js';
import { Room } from './public/shared/room.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_ROOMS = 500;

export function createServer({ port = 8080, log = console.log } = {}) {
  const rooms = new Map();
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

  const sockets = new Set();
  acceptUpgrades(server, (ws, req) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const name = (new URL(req.url, 'http://x').searchParams.get('room') || 'lobby').slice(0, 32).replace(/[^\w-]/g, '') || 'lobby';
    if (!rooms.has(name) && rooms.size >= MAX_ROOMS) return ws.close(1013, 'server full');
    let room = rooms.get(name);
    if (!room) { room = new Room({ log: m => log(`[${name}] ${m}`) }); rooms.set(name, room); }
    const conn = { send: m => ws.send(JSON.stringify(m)), kick: () => ws.terminate() };
    room.addConn(conn);
    ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } room.handle(conn, m); });
    ws.on('close', () => { room.removeConn(conn); if (!room.conns.size) rooms.delete(name); });
  });

  // fixed-rate loop with drift compensation
  let next = performance.now(), timer;
  (function loop() {
    const now = performance.now();
    for (let n = 0; now >= next && n < 5; n++) { for (const r of rooms.values()) r.tick(); next += FRAME_MS; }
    if (now - next > 1000) next = now;
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  })();

  return new Promise(resolve => server.listen(port, () => resolve({
    port: server.address().port, rooms,
    close: () => { clearTimeout(timer); server.close(); for (const s of sockets) s.terminate(); },
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer({ port: +(process.env.PORT || 8080) }).then(({ port }) => console.log(`Graveyard Shift running at http://localhost:${port}`));
}
