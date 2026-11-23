// Short Fuse server: serves the browser client and runs one authoritative Room per
// invite link at 24 ticks/s (the original's frame rate), sending an update every tick.
// No npm dependencies (see ws.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrades } from './ws.js';
import { FRAME_MS, TICK_HZ } from './public/shared/sim.js';
import { Room } from './public/shared/room.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
// SKIN_DIR: optional folder with your own art/sound/music (see public/skin.js), served at /skin/
const SKIN = path.resolve(process.env.SKIN_DIR || path.join(HERE, 'skin'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
const MAX_ROOMS = 500;

export function createServer({ port = 8080, log = console.log } = {}) {
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/index.html';
    const root = p.startsWith('/skin/') ? SKIN : PUBLIC;
    const file = path.normalize(path.join(root, root === SKIN ? p.slice(5) : p));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err && p === '/skin/skin.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); } // no skin: built-in art
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const sockets = new Set();
  acceptUpgrades(server, (ws, req) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const q = new URL(req.url, 'http://x').searchParams;
    const name = (q.get('room') || 'lobby').slice(0, 32).replace(/[^\w-]/g, '') || 'lobby';
    if (!rooms.has(name) && rooms.size >= MAX_ROOMS) return ws.close(1013, 'server full');
    let room = rooms.get(name);
    if (!room) { // the first visitor's link sets the room's arena and bots
      room = new Room({ arena: q.get('arena'), bots: q.get('bots'), log: m => log(`[${name}] ${m}`) });
      rooms.set(name, room);
    }
    const conn = { send: m => ws.send(JSON.stringify(m)), sendText: t => ws.send(t), kick: () => ws.terminate() };
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
  createServer({ port: +(process.env.PORT || 8080) }).then(({ port }) => console.log(`Short Fuse running at http://localhost:${port} (${TICK_HZ} ticks/s)`));
}
