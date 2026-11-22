// Authoritative room: one Game per room, ticked by the server.
// Cheat protection: the server runs the game, clients only send buttons.
// Every message is validated, one input frame is applied per tick (sending
// faster gains nothing), connections are rate-limited, and a seat whose inputs
// stop arriving goes idle after STARVE_TICKS instead of repeating its last input.
import { Game, WEAPONS } from './sim.js';

const COLORS = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292'];
export const MAX_PLAYERS = 4;
export const MAX_SEATS_PER_CONN = 2;   // a second player on the same keyboard
export const MAX_QUEUE = 4;
export const STARVE_TICKS = 45;        // 1.5 s without input -> idle
const RATE = { capacity: 150, perSec: 120, kickAfterDrops: 600 };
const IDLE = { bits: 0, w: -1 };

// Wire frame [seq, bits, w] -> validated input, or null.
export function parseFrame(fr) {
  if (!Array.isArray(fr)) return null;
  const [seq, bits, w] = fr;
  if (!Number.isInteger(seq) || seq <= 0 || seq > 2 ** 31 || !Number.isInteger(bits)) return null;
  return { seq, bits: bits & 31, w: Number.isInteger(w) && w >= 0 && w < WEAPONS.length ? w : -1 };
}

export const cleanName = name => [...String(name ?? '')]
  .filter(ch => { const c = ch.codePointAt(0); return c >= 32 && !(c >= 0x7f && c <= 0x9f) && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x2028 && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069); })
  .join('').trim().slice(0, 16) || 'Player';

export class Room {
  constructor({ seed, log = () => {}, now = () => performance.now() } = {}) {
    this.game = new Game(seed);
    this.log = log;
    this.now = now;
    this.seats = new Map(); // id -> { id, conn, queue, last, lastSeq, starved }
    this.conns = new Set();
    this.nextId = 1;
  }

  addConn(conn) {
    conn.seatIds = [];
    conn.bucket = { tokens: RATE.capacity, at: this.now(), dropped: 0 };
    this.conns.add(conn);
    conn.send({ t: 'hello' });
    conn.send(this.mapMsg());
  }

  removeConn(conn) {
    for (const id of [...conn.seatIds]) this.leave(conn, id);
    this.conns.delete(conn);
  }

  leave(conn, id) {
    const i = conn.seatIds.indexOf(id);
    if (i < 0) return;
    conn.seatIds.splice(i, 1);
    this.seats.delete(id);
    this.game.removePlayer(id);
  }

  allow(conn) {
    const b = conn.bucket, t = this.now();
    b.tokens = Math.min(RATE.capacity, b.tokens + (t - b.at) / 1000 * RATE.perSec);
    b.at = t;
    if (b.tokens >= 1) { b.tokens--; return true; }
    if (++b.dropped > RATE.kickAfterDrops) conn.kick?.();
    return false;
  }

  handle(conn, msg) {
    if (!this.conns.has(conn) || !msg || typeof msg !== 'object' || !this.allow(conn)) return;
    if (msg.t === 'join') this.join(conn, msg);
    else if (msg.t === 'in') this.input(conn, msg);
    else if (msg.t === 'leave') this.leave(conn, msg.id);
    else if (msg.t === 'ping' && Number.isFinite(msg.c)) conn.send({ t: 'pong', c: msg.c });
  }

  join(conn, msg) {
    if (conn.seatIds.length >= MAX_SEATS_PER_CONN || this.game.players.size >= MAX_PLAYERS) return conn.send({ t: 'full' });
    const id = this.nextId++;
    const used = new Set([...this.game.players.values()].map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length];
    this.seats.set(id, { id, conn, queue: [], last: IDLE, lastSeq: 0, starved: 0 });
    conn.seatIds.push(id);
    this.game.addPlayer(id, cleanName(msg.name), color);
    conn.send({ t: 'joined', id, slot: msg.slot === 'p2' ? 'p2' : 'p1' });
    this.log(`${cleanName(msg.name)} joined (#${id})`);
  }

  // {t:'in', id, f:[[seq, bits, w], ...]} - recent frames are re-sent for loss tolerance
  input(conn, msg) {
    const seat = this.seats.get(msg.id);
    if (!seat || seat.conn !== conn || !Array.isArray(msg.f) || msg.f.length > 8) return;
    for (const fr of msg.f) {
      const f = parseFrame(fr);
      const newest = seat.queue.length ? seat.queue.at(-1).seq : seat.lastSeq;
      if (f && f.seq > newest) seat.queue.push(f);
    }
    while (seat.queue.length > MAX_QUEUE) { const d = seat.queue.shift(); seat.last = d; seat.lastSeq = d.seq; }
  }

  mapMsg() { return { t: 'map', seed: this.game.map.seed, tiles: this.game.map.tiles, spawns: this.game.map.spawns }; }

  tick() {
    const g = this.game, inputs = new Map();
    for (const seat of this.seats.values()) {
      const next = seat.queue.shift();
      if (next) { seat.last = next; seat.lastSeq = next.seq; seat.starved = 0; } else seat.starved++;
      // weapon switches apply once; held buttons repeat through short network hiccups
      inputs.set(seat.id, seat.starved > STARVE_TICKS ? IDLE : next || { bits: seat.last.bits, w: -1 });
    }
    const mapSeed = g.map.seed;
    g.step(inputs);
    if (g.map.seed !== mapSeed) for (const c of this.conns) c.send(this.mapMsg());
    const snap = g.snapshot();
    snap.ev = g.drainEvents();
    for (const c of this.conns) {
      const ack = {};
      for (const id of c.seatIds) ack[id] = this.seats.get(id)?.lastSeq ?? 0;
      c.send({ ...snap, ack });
    }
  }
}
