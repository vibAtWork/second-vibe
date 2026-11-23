// Authoritative room: one Game per invite link, ticked by the server.
// Cheat protection: the server runs the game, clients only send buttons. Every message is
// validated, a seat can't send more input frames than real time allows (+3% for clock
// drift), connections are rate-limited, and a seat whose inputs stop arriving goes idle.
//
// Netcode: every input frame is applied exactly once, in order, so the player's own
// prediction never disagrees with the server. A late frame isn't guessed (the player stands
// still that tick); a backlog (a fast clock, a burst after a lag spike) is caught up by
// applying two frames in one tick - never by dropping any.
import { Game, TICK_HZ } from './sim.js';

const COLORS = ['#4fc3f7', '#ffd54f', '#ef5350', '#e0e0e0'];
export const MAX_PLAYERS = 4;
export const MAX_SEATS_PER_CONN = 2;           // a second player on the same keyboard
export const MAX_QUEUE = 24;                   // a second of frames at most; more is a broken or hostile client
export const STARVE_TICKS = Math.round(TICK_HZ * 1.5); // 1.5 s without input -> idle
export const TRIM_WINDOW = TICK_HZ;             // check every second whether a seat's input buffer is longer than it needs to be
export const FRAME_BUDGET = { burst: 12, perSec: TICK_HZ * 1.03 }; // input frames a seat may send
const RATE = { capacity: 100, perSec: 60, kickAfterDrops: 600 };
const IDLE = { bits: 0 };

// Wire frame [seq, bits] -> validated input, or null.
export function parseFrame(fr) {
  if (!Array.isArray(fr)) return null;
  const [seq, bits] = fr;
  if (!Number.isInteger(seq) || seq <= 0 || seq > 2 ** 31 || !Number.isInteger(bits)) return null;
  return { seq, bits: bits & 31 };
}

export const cleanName = name => [...String(name ?? '')]
  .filter(ch => { const c = ch.codePointAt(0); return c >= 32 && !(c >= 0x7f && c <= 0x9f) && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x2028 && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069); })
  .join('').trim().slice(0, 16) || 'Player';

export class Room {
  // arena: 'classic' | 'firelines' | 'teleport' | 'madness'; bots: 0-3 computer players
  constructor({ seed = (Math.random() * 2 ** 32) >>> 0, arena, bots, log = () => {}, now = () => performance.now() } = {}) {
    this.game = new Game(seed, { arena, bots: Number.isInteger(+bots) ? +bots : 0 });
    this.log = log;
    this.now = now;
    this.seats = new Map(); // id -> { id, conn, queue, last, lastSeq, starved }
    this.conns = new Set();
    this.nextId = 1;
    this.layout = this.game.layoutId;
  }

  addConn(conn) {
    conn.seatIds = [];
    conn.bucket = { tokens: RATE.capacity, at: this.now(), dropped: 0 };
    this.conns.add(conn);
    conn.send({ t: 'hello' });
    conn.send(this.game.arenaMsg());
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
    const humans = this.game.humans().length;
    if (conn.seatIds.length >= MAX_SEATS_PER_CONN || humans >= MAX_PLAYERS) return conn.send({ t: 'full' });
    const id = this.nextId++;
    const used = new Set(this.game.humans().map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length];
    this.seats.set(id, { id, conn, queue: [], last: IDLE, lastSeq: 0, starved: 0, minQ: Infinity, window: 0, button: 0, catchUp: 0, budget: { tokens: FRAME_BUDGET.burst, at: this.now() }, stats: { applied: 0, caughtUp: 0, late: 0, overBudget: 0 } }); // button: the bomb-button state the game last saw
    conn.seatIds.push(id);
    // two players with the same name get a number, so everyone can tell who's who
    const taken = new Set([...this.game.players.values()].map(p => p.name));
    let name = cleanName(msg.name);
    for (let n = 2; taken.has(name); n++) name = `${cleanName(msg.name).slice(0, 13)} ${n}`;
    this.game.addPlayer(id, name, color);
    conn.send({ t: 'joined', id, slot: msg.slot === 'p2' ? 'p2' : 'p1' });
    this.log(`${name} joined (#${id})`);
  }

  // {t:'in', id, f:[[seq, bits], ...]} - recent frames are re-sent for loss tolerance
  input(conn, msg) {
    const seat = this.seats.get(msg.id);
    if (!seat || seat.conn !== conn || !Array.isArray(msg.f) || msg.f.length > 8) return;
    const b = seat.budget, t = this.now();
    b.tokens = Math.min(FRAME_BUDGET.burst, b.tokens + (t - b.at) / 1000 * FRAME_BUDGET.perSec); b.at = t;
    for (const fr of msg.f) {
      const f = parseFrame(fr);
      const newest = seat.queue.length ? seat.queue.at(-1).seq : seat.lastSeq;
      if (!f || f.seq <= newest) continue;      // a resent copy
      if (b.tokens < 1) { seat.stats.overBudget++; break; } // faster than real time: wait (it's resent with the next message)
      b.tokens--; seat.queue.push(f);
    }
    if (seat.queue.length > MAX_QUEUE) conn.kick?.(); // can't happen within the budget: a broken or hostile client
  }

  tick() {
    const g = this.game, inputs = new Map();
    for (const seat of this.seats.values()) {
      // The queue is a jitter buffer. If it never ran below 2 during the last second it is
      // longer than the jitter needs (every extra frame is a tick of input delay): catch up
      // by applying two frames in a tick, spread over the next second.
      seat.minQ = Math.min(seat.minQ, seat.queue.length);
      if (++seat.window >= TRIM_WINDOW) { seat.catchUp = seat.minQ >= 2 ? seat.minQ - 1 : 0; seat.minQ = Infinity; seat.window = 0; }
      const take = seat.queue.length >= 2 && seat.catchUp > 0 ? 2 : seat.queue.length ? 1 : 0;
      if (take === 2) { seat.catchUp--; seat.stats.caughtUp++; }
      const frames = seat.queue.splice(0, take);
      if (frames.length) { seat.last = frames.at(-1); seat.lastSeq = seat.last.seq; seat.starved = 0; seat.stats.applied += frames.length; }
      else { seat.starved++; seat.stats.late++; }
      // A late frame: don't guess. Stand still this tick (bomb button unchanged) and apply the
      // frame when it arrives. After 1.5 s without input the seat goes idle.
      const input = frames.length ? { frames } : { frames: [seat.starved > STARVE_TICKS ? IDLE : { bits: seat.button }] };
      inputs.set(seat.id, input); seat.button = input.frames.at(-1).bits & 16;
    }
    g.step(inputs);
    if (g.layoutId !== this.layout) { this.layout = g.layoutId; const m = g.arenaMsg(); for (const c of this.conns) c.send(m); }
    const snap = g.snapshot();
    snap.ev = g.drainEvents();
    let body = null; // the snapshot is the same for everyone: stringify it once, prepend each connection's ack
    for (const c of this.conns) {
      const ack = {};
      for (const id of c.seatIds) ack[id] = this.seats.get(id)?.lastSeq ?? 0;
      if (!c.sendText) { c.send({ ...snap, ack }); continue; }
      body ??= JSON.stringify(snap).slice(1);
      c.sendText(`{"ack":${JSON.stringify(ack)},${body}`);
    }
  }
}
