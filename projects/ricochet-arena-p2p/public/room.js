// Host-side room: runs the authoritative Game inside the host's browser.
// Transport-agnostic: a "conn" is any object with send(msg) and a seatIds array.
// The message protocol is identical to approach 1's Node server.
import { Game } from './shared/sim.js';

const COLORS = ['#e8483b', '#3b8de8', '#3fbf5a', '#e8b23b', '#a65be8', '#e85bb4', '#38c7c7', '#8a8a8a'];
const MAX_QUEUE = 4;
const MAX_SEATS_PER_CONN = 3;
const MAX_PLAYERS = 8;

export class HostRoom {
  constructor({ seed, log = () => {} } = {}) {
    this.game = new Game(seed);
    this.seats = new Map();
    this.conns = new Set();
    this.nextId = 1;
    this.log = log;
  }

  mazeMsg() {
    const g = this.game, m = g.maze;
    return m && { t: 'maze', round: g.round, maze: { seed: m.seed, W: m.W, H: m.H, S: m.S, v: m.v, h: m.h, ox: m.ox, oy: m.oy } };
  }

  broadcastMaze() { const mm = this.mazeMsg(); if (mm) for (const c of this.conns) c.send(mm); }

  addConn(conn) {
    conn.seatIds = conn.seatIds || [];
    this.conns.add(conn);
    conn.send({ t: 'hello' });
    const mm = this.mazeMsg();
    if (mm) conn.send(mm);
  }

  removeConn(conn) {
    for (const id of [...conn.seatIds]) this.dropSeat(conn, id);
    this.conns.delete(conn);
  }

  dropSeat(conn, id) {
    const i = conn.seatIds.indexOf(id);
    if (i < 0) return;
    conn.seatIds.splice(i, 1);
    this.seats.delete(id);
    this.game.removePlayer(id);
  }

  freeColor() {
    const used = new Set([...this.game.players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[this.game.players.size % COLORS.length];
  }

  handle(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') {
      if (conn.seatIds.length >= MAX_SEATS_PER_CONN || this.game.players.size >= MAX_PLAYERS) return conn.send({ t: 'full' });
      const id = this.nextId++;
      const name = String(msg.name || 'Player').slice(0, 16);
      this.seats.set(id, { id, conn, queue: [], last: {}, lastSeq: 0 });
      conn.seatIds.push(id);
      const before = this.game.maze && this.game.maze.seed;
      this.game.addPlayer(id, name, this.freeColor());
      conn.send({ t: 'joined', id, slot: msg.slot });
      if (this.game.maze && this.game.maze.seed !== before) this.broadcastMaze();
      this.log(`${name} joined (#${id})`);
    } else if (msg.t === 'in' && Array.isArray(msg.f)) {
      const seat = this.seats.get(msg.id);
      if (!seat || seat.conn !== conn) return;
      for (const fr of msg.f) {
        if (!Array.isArray(fr)) continue;
        const [seq, bits, mx, my] = fr;
        const lastQueued = seat.queue.length ? seat.queue[seat.queue.length - 1].seq : seat.lastSeq;
        if (typeof seq !== 'number' || seq <= lastQueued) continue;
        const inp = { seq, f: bits & 1, b: bits & 2, l: bits & 4, r: bits & 8, fire: bits & 16 };
        if (bits & 32) inp.mouse = { x: +mx || 0, y: +my || 0 };
        seat.queue.push(inp);
      }
      while (seat.queue.length > MAX_QUEUE) { const d = seat.queue.shift(); seat.last = d; seat.lastSeq = d.seq; }
    } else if (msg.t === 'leave') {
      this.dropSeat(conn, msg.id);
    } else if (msg.t === 'ping') {
      conn.send({ t: 'pong', c: msg.c });
    }
  }

  tick() {
    const g = this.game;
    const inputs = new Map();
    for (const seat of this.seats.values()) {
      let inp = seat.queue.shift();
      if (inp) { seat.last = inp; seat.lastSeq = inp.seq; } else inp = seat.last;
      inputs.set(seat.id, inp);
    }
    const prevSeed = g.maze && g.maze.seed;
    g.step(inputs);
    const ev = g.drainEvents();
    if (g.maze && g.maze.seed !== prevSeed) this.broadcastMaze();
    const base = {
      t: 's', tick: g.tick, frozen: g.frozen, end: g.endCount,
      tanks: [...g.tanks.values()].map(t => [t.id, +t.x.toFixed(2), +t.y.toFixed(2), +t.rot.toFixed(3), t.alive ? 1 : 0, t.triggerReleased ? 1 : 0, t.bulletsFired]),
      bullets: g.bullets.map(b => [b.id, +b.x.toFixed(2), +b.y.toFixed(2)]),
      players: [...g.players.values()].map(p => [p.id, p.name, p.color, p.score]),
      ev,
    };
    for (const c of this.conns) {
      const ack = {};
      for (const id of c.seatIds) { const s = this.seats.get(id); if (s) ack[id] = s.lastSeq; }
      c.send({ ...base, ack });
    }
  }
}
