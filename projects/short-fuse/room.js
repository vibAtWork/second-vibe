// One room per invite link: runs a Game on the server and talks to the players' browsers.
//
// Netcode rules (each is tested in test/room.test.js and test/net.test.js):
// * Browsers send input frames [seq, keys], one per tick, re-sending the last few.
// * Every frame is applied exactly once and in order, so a player's own prediction of their
//   movement never disagrees with the server.
// * A frame that hasn't arrived in time is not guessed: the player stands still that tick
//   (bomb key unchanged), and the frame is applied when it comes.
// * If the buffer has been longer than it needs to be for a whole second (a clock running a
//   little fast, a burst after a lag spike), two frames are applied in one tick until it's
//   back down - frames are never dropped.
// * A seat can't send more frames than real time allows (+3% for clock drift): no speed hacks.
// Plus: messages are validated, connections rate-limited, 4 human players at most.
import { Game, TICK_HZ } from './public/shared/game.js';

export const MAX_HUMANS = 4, SEATS_PER_CONNECTION = 2;
export const BUDGET = { burst: 12, perSecond: TICK_HZ * 1.03 };
export const CATCH_UP_WINDOW = TICK_HZ;            // ticks
export const IDLE_AFTER = Math.round(TICK_HZ * 1.5); // ticks without input
const MAX_BUFFER = 48;
const RATE = { burst: 100, perSecond: 60 };
const COLORS = ['#4fc3f7', '#ffd54f', '#ef5350', '#f5f5f5'];

export function parseFrame(f) {
  if (!Array.isArray(f) || !Number.isInteger(f[0]) || f[0] < 1 || f[0] > 2 ** 31 || !Number.isInteger(f[1])) return null;
  return { seq: f[0], keys: f[1] & 31 };
}
export function cleanName(s) {
  const name = [...String(s ?? '')].filter(ch => { const c = ch.codePointAt(0); return c >= 32 && !(c >= 0x7f && c <= 0x9f) && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x2028 && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069); }).join('').trim().slice(0, 16);
  return name || 'Player';
}

export class Room {
  constructor({ seed = (Math.random() * 2 ** 32) >>> 0, arena, bots, now = () => performance.now(), log = () => {} } = {}) {
    this.game = new Game({ seed, arena, bots: +bots || 0 });
    this.now = now; this.log = log;
    this.conns = new Set(); this.seats = new Map(); this.nextId = 1;
    this.layout = this.game.layout;
  }

  addConn(conn) {
    conn.seats = [];
    conn.rate = { tokens: RATE.burst, at: this.now() };
    this.conns.add(conn);
    conn.send(this.game.floorMsg());
  }
  removeConn(conn) {
    for (const id of [...conn.seats]) this.leave(conn, id);
    this.conns.delete(conn);
  }

  handle(conn, m) {
    if (!this.conns.has(conn) || !m || typeof m !== 'object') return;
    const r = conn.rate, t = this.now();
    r.tokens = Math.min(RATE.burst, r.tokens + (t - r.at) / 1000 * RATE.perSecond); r.at = t;
    if (r.tokens < 1) return;
    r.tokens--;
    if (m.t === 'join') this.join(conn, m);
    else if (m.t === 'in') this.input(conn, m);
    else if (m.t === 'leave') this.leave(conn, m.id);
    else if (m.t === 'ping' && Number.isFinite(m.c)) conn.send({ t: 'pong', c: m.c });
  }

  join(conn, m) {
    if (conn.seats.length >= SEATS_PER_CONNECTION || this.game.humans().length >= MAX_HUMANS) return conn.send({ t: 'full' });
    const id = this.nextId++, used = new Set(this.game.humans().map(p => p.color));
    const taken = new Set([...this.game.players.values()].map(p => p.name));
    let name = cleanName(m.name);
    for (let n = 2; taken.has(name); n++) name = `${cleanName(m.name).slice(0, 13)} ${n}`; // tell same-named players apart
    this.seats.set(id, { id, conn, buffer: [], lastSeq: 0, keys: 0, late: 0, low: Infinity, window: 0, catchUp: 0, budget: { tokens: BUDGET.burst, at: this.now() }, stats: { applied: 0, late: 0, caughtUp: 0, overBudget: 0 } });
    conn.seats.push(id);
    this.game.addPlayer(id, name, COLORS.find(c => !used.has(c)) ?? COLORS[0]);
    conn.send({ t: 'joined', id, slot: m.slot === 'p2' ? 'p2' : 'p1', name });
    this.log(`${name} joined`);
  }
  leave(conn, id) {
    const k = conn.seats.indexOf(id);
    if (k < 0) return;
    conn.seats.splice(k, 1); this.seats.delete(id); this.game.removePlayer(id);
  }

  input(conn, m) {
    const s = this.seats.get(m.id);
    if (!s || s.conn !== conn || !Array.isArray(m.f) || m.f.length > 8) return;
    const b = s.budget, t = this.now();
    b.tokens = Math.min(BUDGET.burst, b.tokens + (t - b.at) / 1000 * BUDGET.perSecond); b.at = t;
    for (const raw of m.f) {
      const f = parseFrame(raw), newest = s.buffer.length ? s.buffer.at(-1).seq : s.lastSeq;
      if (!f || f.seq <= newest) continue;                    // a re-sent copy
      if (b.tokens < 1) { s.stats.overBudget++; break; }      // faster than real time: wait (it's re-sent)
      b.tokens--; s.buffer.push(f);
    }
    if (s.buffer.length > MAX_BUFFER) conn.close?.();         // impossible within the budget
  }

  tick() {
    const inputs = new Map();
    for (const s of this.seats.values()) {
      s.low = Math.min(s.low, s.buffer.length);
      if (++s.window >= CATCH_UP_WINDOW) { s.catchUp = s.low >= 2 ? s.low - 1 : 0; s.low = Infinity; s.window = 0; }
      const n = s.buffer.length >= 2 && s.catchUp > 0 ? 2 : Math.min(1, s.buffer.length);
      if (n === 2) { s.catchUp--; s.stats.caughtUp++; }
      const frames = s.buffer.splice(0, n);
      if (frames.length) { s.lastSeq = frames.at(-1).seq; s.keys = frames.at(-1).keys; s.late = 0; s.stats.applied += n; }
      else { s.late++; s.stats.late++; }
      // late: stand still with the bomb key as it was; after 1.5 s, let go of everything
      inputs.set(s.id, { frames: frames.length ? frames : [{ keys: s.late > IDLE_AFTER ? 0 : s.keys & 16 }] });
      if (!frames.length && s.late > IDLE_AFTER) s.keys = 0;
    }
    const g = this.game;
    g.step(inputs);
    if (g.layout !== this.layout) { this.layout = g.layout; const m = g.floorMsg(); for (const c of this.conns) c.send(m); }
    const snap = g.snapshot();
    snap.ev = g.drain();
    const body = JSON.stringify(snap).slice(1); // the same for everyone: add each connection's acks in front
    for (const c of this.conns) c.sendText(`{"ack":${JSON.stringify(Object.fromEntries(c.seats.map(id => [id, this.seats.get(id)?.lastSeq ?? 0])))},${body}`);
  }
}
