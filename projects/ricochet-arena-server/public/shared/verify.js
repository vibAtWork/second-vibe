// Audits a host that runs the game in someone else's browser (P2P mode).
// The host publishes, per tick, the joins/leaves and the exact input frame it
// used for every seat, plus a hash of the resulting state. The auditor replays
// the same tick on its own copy of the game (the simulation is bit-exact on
// every engine, see dmath.js) and checks:
//   * the state hash matches            -> host didn't bend any rule
//   * my seats got the inputs I sent    -> host didn't forge or alter my controls
//   * my join carried my name and nonce -> host can't pick round seeds alone
//   * nobody removed my seats           -> host didn't kick me silently
// Any failure calls onCheat(reason). The host can still only lag or drop
// inputs (indistinguishable from a bad connection) - never change outcomes.
import { Game } from './sim.js';
import { frameToInput } from './room.js';

export class Auditor {
  constructor(onCheat) {
    this.onCheat = onCheat;
    this.failed = null;
    this.reset();
  }

  // New connection / new host: seat ids and game state start over.
  reset() {
    this.game = null;
    this.sent = new Map();     // my seat id -> Map(seq -> [bits, mx, my])
    this.joins = [];           // {name, nonce} I asked for, matched to seat ids when they appear
    this.mySeats = new Set();
    this.lastUsed = new Map(); // seat id -> [seq, bits, mx, my] last applied
    this.lastLogAt = 0;
  }

  // ---- what I sent
  noteJoin(name, nonce) { this.joins.push({ name, nonce }); }
  noteSeat(id) { this.mySeats.add(id); if (!this.sent.has(id)) this.sent.set(id, new Map()); }
  noteFrame(id, seq, frame) {
    const m = this.sent.get(id);
    if (!m) return;
    m.set(seq, frame);
    if (m.size > 400) m.delete(m.keys().next().value);
  }

  // ---- what the host says
  sync(state) { if (!this.failed) { this.game = Game.deserialize(state); this.lastLogAt = performance.now(); } }

  fail(reason) {
    if (this.failed) return;
    this.failed = reason;
    this.onCheat(reason);
  }

  log(msg) {
    const g = this.game;
    if (!g || this.failed) return;
    this.lastLogAt = performance.now();
    if (msg.tick !== g.tick + 1) return this.fail(`tick sequence broken (${g.tick} -> ${msg.tick})`);
    for (const op of msg.ops || []) {
      if (op[0] === 'add') {
        const [, id, name, color, nonce] = op;
        if (this.mySeats.has(id)) {
          const j = this.joins.findIndex(j => j.name === name && j.nonce === nonce);
          if (j < 0) return this.fail('my join was altered');
          this.joins.splice(j, 1);
        }
        g.addPlayer(id, name, color, nonce);
      } else if (op[0] === 'remove') {
        if (this.mySeats.has(op[1]) && !this.leaving) return this.fail('host removed my tank');
        g.removePlayer(op[1]);
      } else if (op[0] === 'kick') { // anti-cheat removal: announced to everyone, not a silent kick
        this.mySeats.delete(op[1]);
        g.removePlayer(op[1]);
      } else return this.fail('unknown operation');
    }
    const inputs = new Map();
    for (const [id, seq, bits, mx, my] of msg.in || []) {
      if (this.mySeats.has(id)) {
        const prev = this.lastUsed.get(id);
        const same = prev && prev[0] === seq;
        const want = same ? prev.slice(1) : seq === 0 ? [0, 0, 0] : this.sent.get(id)?.get(seq);
        if (!want) return this.fail('host used an input I never sent');
        const idle = same && bits === 0 && mx === 0 && my === 0; // my inputs stopped arriving: tank idles
        if (!idle && (want[0] !== bits || want[1] !== mx || want[2] !== my)) return this.fail('host altered my input');
        if (prev && seq < prev[0]) return this.fail('host replayed an old input');
        if (!idle) this.lastUsed.set(id, [seq, bits, mx, my]);
      }
      inputs.set(id, frameToInput([bits, mx, my]));
    }
    for (const id of this.mySeats) {
      if (g.players.has(id) && !inputs.has(id) && !this.leaving) return this.fail('host ignored my tank');
    }
    g.step(inputs);
    g.drainEvents();
    const h = g.hash();
    if (h !== msg.h) this.fail(`game state differs from the rules at tick ${msg.tick}`);
  }

  // Host must keep publishing while it sends snapshots.
  stale(nowMs, limitMs = 3000) { return !!this.game && !this.failed && nowMs - this.lastLogAt > limitMs; }
}
