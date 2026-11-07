// Authoritative game server: serves the static client and runs one Game per
// room at 25 ticks/s. Clients send input frames (sequence-numbered); the
// server applies one input frame per tick per tank and broadcasts snapshots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, FRAME_MS } from './public/shared/sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const COLORS = ['#e8483b', '#3b8de8', '#3fbf5a', '#e8b23b', '#a65be8', '#e85bb4', '#38c7c7', '#8a8a8a'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_QUEUE = 4;
const MAX_SEATS_PER_CONN = 3;
const MAX_PLAYERS_PER_ROOM = 8;

export function createServer({ port = 8080, log = console.log } = {}) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const rooms = new Map();
  let nextId = 1;

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { name, game: new Game(), seats: new Map(), conns: new Set(), lastMazeSeed: null };
      rooms.set(name, room);
    }
    return room;
  }

  function freeColor(room) {
    const used = new Set([...room.game.players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[room.game.players.size % COLORS.length];
  }

  function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function mazeMsg(g) {
    const m = g.maze;
    return m && { t: 'maze', round: g.round, maze: { seed: m.seed, W: m.W, H: m.H, S: m.S, v: m.v, h: m.h, ox: m.ox, oy: m.oy } };
  }

  function tickRoom(room) {
    const g = room.game;
    const inputs = new Map();
    for (const seat of room.seats.values()) {
      let inp = seat.queue.shift();
      if (inp) { seat.last = inp; seat.lastSeq = inp.seq; }
      else inp = seat.last;
      inputs.set(seat.id, inp);
    }
    g.step(inputs);
    const events = g.drainEvents();
    // Announce the maze whenever it differs from the last one we sent (new round, first join, ...).
    if (g.maze && g.maze.seed !== room.lastMazeSeed) { room.lastMazeSeed = g.maze.seed; for (const c of room.conns) send(c, mazeMsg(g)); }
    const snap = g.snapshot();
    snap.ev = events;
    for (const c of room.conns) {
      const acks = {};
      for (const id of c.seatIds) { const s = room.seats.get(id); if (s) acks[id] = s.lastSeq; }
      snap.ack = acks;
      send(c, snap);
    }
  }

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const roomName = (url.searchParams.get('room') || 'lobby').slice(0, 32).replace(/[^\w-]/g, '') || 'lobby';
    const room = getRoom(roomName);
    room.conns.add(ws);
    ws.seatIds = [];
    send(ws, { t: 'hello', room: roomName });
    const mm = mazeMsg(room.game);
    if (mm) send(ws, mm);

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'join') {
        if (ws.seatIds.length >= MAX_SEATS_PER_CONN || room.game.players.size >= MAX_PLAYERS_PER_ROOM) {
          return send(ws, { t: 'full' });
        }
        const id = nextId++;
        const name = String(msg.name || 'Player').slice(0, 16);
        room.seats.set(id, { id, ws, queue: [], last: {}, lastSeq: 0 });
        ws.seatIds.push(id);
        room.game.addPlayer(id, name, freeColor(room));
        send(ws, { t: 'joined', id, slot: msg.slot });
        const g = room.game;
        if (g.maze && g.maze.seed !== room.lastMazeSeed) { room.lastMazeSeed = g.maze.seed; for (const c of room.conns) send(c, mazeMsg(g)); }
        log(`[${roomName}] ${name} joined (#${id}), ${room.game.players.size} players`);
      } else if (msg.t === 'in' && Array.isArray(msg.f)) {
        // msg: {t:'in', id, f:[[seq, bits, mx, my], ...]} - bundles recent frames for loss tolerance
        const seat = room.seats.get(msg.id);
        if (!seat || seat.ws !== ws) return;
        const lastQueued = seat.queue.length ? seat.queue[seat.queue.length - 1].seq : seat.lastSeq;
        for (const fr of msg.f) {
          const [seq, bits, mx, my] = fr;
          if (typeof seq !== 'number' || seq <= lastQueued) continue;
          if (seat.queue.length && seq <= seat.queue[seat.queue.length - 1].seq) continue;
          const inp = { seq, f: bits & 1, b: bits & 2, l: bits & 4, r: bits & 8, fire: bits & 16 };
          if (bits & 32) inp.mouse = { x: +mx || 0, y: +my || 0 };
          seat.queue.push(inp);
        }
        // Client running fast or a burst arrived: drop the oldest to bound latency.
        while (seat.queue.length > MAX_QUEUE) { const d = seat.queue.shift(); seat.last = d; seat.lastSeq = d.seq; }
      } else if (msg.t === 'leave') {
        dropSeat(msg.id);
      } else if (msg.t === 'ping') {
        send(ws, { t: 'pong', c: msg.c });
      }
    });

    function dropSeat(id) {
      const i = ws.seatIds.indexOf(id);
      if (i < 0) return;
      ws.seatIds.splice(i, 1);
      room.seats.delete(id);
      room.game.removePlayer(id);
    }

    ws.on('close', () => {
      for (const id of [...ws.seatIds]) dropSeat(id);
      room.conns.delete(ws);
      if (room.conns.size === 0) rooms.delete(roomName);
    });
  });

  // Fixed-rate loop with drift compensation.
  let next = performance.now();
  let timer;
  function loop() {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) { for (const room of rooms.values()) tickRoom(room); next += FRAME_MS; n++; }
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
