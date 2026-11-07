// Authoritative room: runs one Game and talks to connections using the shared
// message protocol. Used unchanged by the Node server and by the P2P host's browser.
//
// Anti-cheat responsibilities live here:
//  * every client message is validated and normalised; anything malformed is dropped
//  * each seat keeps the control scheme it joined with (keyboard seats can't
//    send mouse aim, mouse seats can't send keys)
//  * one input frame is consumed per tick per seat, so sending faster can't speed a tank up
//  * per-connection token-bucket rate limit; abusive connections are kicked
//  * joins/leaves are applied at tick boundaries and, when `verifiable` is on, every
//    tick is published as {ops, inputs, state hash} so peers can re-run and audit it
//  * behavioural detection (anticheat.js) flags or kicks bots and aim assistance;
//    kicked connections can't rejoin the room
//  * a seat whose inputs stop arriving for STARVE_TICKS (1.5 s, far longer than a
//    Wi-Fi hiccup) goes idle instead of repeating its last input forever
//  * none of the anti-cheat may hurt honest play: the detector is isolated (an
//    error disables it, never the game) and throttles itself if it gets slow
import { Game, VIEW_W, VIEW_H } from './sim.js';
import { CheatWatch } from './anticheat.js';

const COLORS = ['#e8483b', '#3b8de8', '#3fbf5a', '#e8b23b', '#a65be8', '#e85bb4', '#38c7c7', '#8a8a8a'];
export const MAX_QUEUE = 4;
export const MAX_SEATS_PER_CONN = 3;
export const MAX_PLAYERS = 8;
export const MAX_FRAMES_PER_MSG = 8;
const RATE = { capacity: 150, perSec: 120, kickAfterDrops: 600 };
export const STARVE_TICKS = 38; // ~1.5 s without input -> tank goes idle (short hiccups keep the last input)
const DETECTOR_BUDGET_MS = 3;   // detector time per tick before it starts skipping ticks
const IDLE = [0, 0, 0];

// Wire input -> normalised [bits, mx, my] for a seat's scheme (or null if invalid).
// The client applies the same function before sending, so audits compare equal.
export function normaliseFrame(scheme, bits, mx, my) {
  if (!Number.isInteger(bits)) return null;
  if (scheme === 'mouse') {
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
    const c = (v, lim) => Math.round(Math.max(-lim, Math.min(2 * lim, v)) * 10) / 10;
    return [32 | (bits & 16), c(mx, VIEW_W), c(my, VIEW_H)];
  }
  return [bits & 31, 0, 0];
}

export function frameToInput([bits, mx, my]) {
  const inp = { f: bits & 1, b: bits & 2, l: bits & 4, r: bits & 8, fire: bits & 16 };
  if (bits & 32) inp.mouse = { x: mx, y: my };
  return inp;
}

export function cleanName(name) {
  // drop control, zero-width and bidi-override characters (name spoofing)
  const bad = c => c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  return [...String(name ?? '')].filter(ch => !bad(ch.codePointAt(0))).join('').trim().slice(0, 16) || 'Player';
}

export class HostRoom {
  // anticheat: 'kick' (default) | 'flag' (report only) | 'off'
  // onKick(conn, reason): lets the owner add e.g. an IP ban
  constructor({ seed, verifiable = false, anticheat = 'kick', onKick = () => {}, log = () => {}, now = () => performance.now() } = {}) {
    this.game = new Game(seed);
    this.mode = anticheat;
    this.onKick = onKick;
    this.reports = [];        // [{ time, tick, id, name, level, reason, evidence }]
    this.watch = anticheat === 'off' ? null : new CheatWatch({ onVerdict: (...a) => this.onVerdict(...a) });
    this.verifiable = verifiable;
    this.log = log;
    this.now = now;
    this.seats = new Map();   // id -> {id, conn, scheme, queue, last:[bits,mx,my], lastSeq}
    this.conns = new Set();
    this.ops = [];            // joins/leaves waiting for the next tick
    this.nextId = 1;
    this.lastMazeSeed = null;
  }

  // conn: { send(msg), kick?(), noAudit? } (noAudit: the host's own loopback, nothing to verify)
  addConn(conn) {
    conn.seatIds = [];
    conn.bucket = { tokens: RATE.capacity, at: this.now(), dropped: 0 };
    this.conns.add(conn);
    conn.send({ t: 'hello' });
    const mm = this.mazeMsg();
    if (mm) conn.send(mm);
    if (this.verifiable && !conn.noAudit) conn.send({ t: 'sync', state: this.game.serialize() });
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
    this.watch?.forget(id);
    this.ops.push(['remove', id]);
  }

  // The detector is an observer: it must never break or slow the game.
  runDetector(g, used, ev) {
    if (!this.watch) return;
    if (this.detectorSkip > 0) { this.detectorSkip--; return; }
    const t0 = this.now();
    try { this.watch.afterTick(g, used, ev); } catch (e) {
      this.log(`anti-cheat disabled after an internal error: ${e && e.message}`);
      this.watch = null;
      return;
    }
    // Over budget (huge room, slow host machine): run on fewer ticks rather than delay the game.
    if (this.now() - t0 > DETECTOR_BUDGET_MS) this.detectorSkip = 2;
  }

  onVerdict(id, level, reason, evidence) {
    const name = this.game.players.get(id)?.name ?? '?';
    const report = { time: Date.now(), tick: this.game.tick, id, name, level, reason, evidence };
    this.reports.push(report);
    if (this.reports.length > 200) this.reports.shift();
    this.log(`anti-cheat ${level}: ${name} (#${id}) - ${reason} ${JSON.stringify(evidence)}`);
    if (level === 'kick' && this.mode === 'kick') this.kick(id, reason);
  }

  // Remove a cheating player; their connection may not join again.
  kick(id, reason) {
    const seat = this.seats.get(id);
    if (!seat) return;
    const conn = seat.conn;
    conn.banned = reason;
    conn.send({ t: 'kicked', id, reason });
    conn.seatIds.splice(conn.seatIds.indexOf(id), 1);
    this.seats.delete(id);
    this.watch?.forget(id);
    this.ops.push(['kick', id, reason]);
    this.onKick(conn, reason);
  }

  allow(conn) {
    const b = conn.bucket, t = this.now();
    b.tokens = Math.min(RATE.capacity, b.tokens + (t - b.at) / 1000 * RATE.perSec);
    b.at = t;
    if (b.tokens >= 1) { b.tokens--; return true; }
    if (++b.dropped > RATE.kickAfterDrops && conn.kick) { this.log('kicking flooding connection'); conn.kick(); }
    return false;
  }

  handle(conn, msg) {
    if (!this.conns.has(conn) || !msg || typeof msg !== 'object' || !this.allow(conn)) return;
    if (msg.t === 'join') this.join(conn, msg);
    else if (msg.t === 'in') this.input(conn, msg);
    else if (msg.t === 'leave') this.dropSeat(conn, msg.id);
    else if (msg.t === 'ping' && Number.isFinite(msg.c)) conn.send({ t: 'pong', c: msg.c });
  }

  join(conn, msg) {
    if (conn.banned) return conn.send({ t: 'banned', reason: conn.banned });
    const players = this.game.players.size + this.ops.filter(o => o[0] === 'add').length - this.ops.filter(o => o[0] === 'remove').length;
    if (conn.seatIds.length >= MAX_SEATS_PER_CONN || players >= MAX_PLAYERS) return conn.send({ t: 'full' });
    const slot = ['arrows', 'esdf', 'mouse'].includes(msg.slot) ? msg.slot : 'arrows';
    const id = this.nextId++;
    const name = cleanName(msg.name);
    const nonce = Number.isInteger(msg.nonce) ? msg.nonce >>> 0 : 0;
    const used = new Set([...this.game.players.values()].map(p => p.color).concat(this.ops.filter(o => o[0] === 'add').map(o => o[3])));
    const color = COLORS.find(c => !used.has(c)) || COLORS[id % COLORS.length];
    this.seats.set(id, { id, conn, scheme: slot === 'mouse' ? 'mouse' : 'keys', queue: [], last: [0, 0, 0], lastSeq: 0 });
    conn.seatIds.push(id);
    this.ops.push(['add', id, name, color, nonce]);
    conn.send({ t: 'joined', id, slot });
    this.log(`${name} joined (#${id})`);
  }

  // {t:'in', id, f:[[seq, bits, mx, my], ...]}: recent frames re-sent for loss tolerance
  input(conn, msg) {
    const seat = this.seats.get(msg.id);
    if (!seat || seat.conn !== conn || !Array.isArray(msg.f) || msg.f.length > MAX_FRAMES_PER_MSG) return;
    for (const fr of msg.f) {
      if (!Array.isArray(fr)) continue;
      const seq = fr[0];
      const newest = seat.queue.length ? seat.queue[seat.queue.length - 1].seq : seat.lastSeq;
      if (!Number.isInteger(seq) || seq <= newest || seq > 2 ** 31) continue;
      const frame = normaliseFrame(seat.scheme, fr[1], fr[2], fr[3]);
      if (frame) seat.queue.push({ seq, frame });
    }
    // Client running fast or a burst arrived: drop the oldest to bound latency.
    while (seat.queue.length > MAX_QUEUE) {
      const d = seat.queue.shift(); seat.last = d.frame; seat.lastSeq = d.seq;
      this.watch?.noteOverflow(seat.id, this.game.tick);
    }
  }

  mazeMsg() {
    const g = this.game, m = g.maze;
    return m && { t: 'maze', round: g.round, maze: { seed: m.seed, W: m.W, H: m.H, S: m.S, v: m.v, h: m.h, ox: m.ox, oy: m.oy } };
  }

  tick() {
    const g = this.game;
    const ops = this.ops;
    this.ops = [];
    const kicked = [];
    for (const op of ops) {
      if (op[0] === 'add') g.addPlayer(op[1], op[2], op[3], op[4]);
      else {
        if (op[0] === 'kick') kicked.push({ type: 'cheater', id: op[1], name: g.players.get(op[1])?.name ?? '?', reason: op[2] });
        g.removePlayer(op[1]);
      }
    }
    const inputs = new Map(), used = [];
    for (const seat of this.seats.values()) {
      const next = seat.queue.shift();
      if (next) { seat.last = next.frame; seat.lastSeq = next.seq; seat.starved = 0; } else seat.starved = (seat.starved || 0) + 1;
      const frame = seat.starved > STARVE_TICKS ? IDLE : seat.last;
      inputs.set(seat.id, frameToInput(frame));
      used.push([seat.id, seat.lastSeq, ...frame]);
    }
    g.step(inputs);
    const ev = kicked.concat(g.drainEvents());
    this.runDetector(g, used, ev);
    if (g.maze && g.maze.seed !== this.lastMazeSeed) {
      this.lastMazeSeed = g.maze.seed;
      const mm = this.mazeMsg();
      for (const c of this.conns) c.send(mm);
    }
    const snap = g.snapshot();
    snap.ev = ev;
    const logMsg = this.verifiable && { t: 'log', tick: g.tick, ops, in: used, h: g.hash() };
    for (const c of this.conns) {
      const ack = {};
      for (const id of c.seatIds) { const s = this.seats.get(id); if (s) ack[id] = s.lastSeq; }
      c.send({ ...snap, ack });
      if (logMsg && !c.noAudit) c.send(logMsg);
    }
  }
}
