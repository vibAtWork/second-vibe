// Behavioural cheat detection, run by whoever owns the authoritative room
// (the Node server, or the P2P host). The simulation already makes rule-breaking
// impossible; this looks for play that is *legal but not human*: bots and aim
// assistance, frame-perfect scripted input, and tampered client clocks.
//
// It only reads the game (never mutates it) and reports verdicts:
//   'flag' -> logged / reported for review
//   'kick' -> strong evidence; the room removes the player
// Thresholds are deliberately conservative: several independent signals over
// many shots are needed before anyone is kicked.
import { makeBullet, pointInTank, bounceStep, BULLET_SUBSTEPS } from './sim.js';

export const LIMITS = {
  shotWindow: 20,        // judge the most recent N cannon shots
  minShots: 8,           // ...but only once there are at least this many
  bankFlag: 0.5,         // share of shots that are ricochet kills-in-waiting
  bankKick: 0.6,         //   ...kick when also reacting instantly
  bankKickAlone: 0.8,    //   ...or kick on this alone, with minShotsAlone shots
  minShotsAlone: 16,
  instantTicks: 1,       // "instant" reaction: fired within 1 tick (40 ms) of the shot becoming lethal
  instantFlag: 0.8,      // share of lethal shots fired instantly (min minLethal lethal shots)
  instantKick: 0.75,
  minLethal: 8,
  horizon: 60,           // frames a shot is followed to see whether it would hit
  toggleWindow: 125,     // 5 s of ticks
  toggleFlag: 0.5,       // input changed on more than half the ticks...
  toggleWindowsFlag: 3,  // ...for this many consecutive windows
  snapJump: 120,         // mouse pointer jumping this far (px) in one tick...
  snapOnTarget: 0.2,     // ...landing within this many cells of an enemy's centre
  snapWindow: 1500,      // 60 s
  snapFlag: 5,
  snapKick: 10,
  overflowWindow: 250,   // 10 s
  overflowFlag: 50,      // input frames dropped for arriving faster than real time
};


// Follow a would-be shot from `tank` against everyone's current positions.
// Returns { victim, bounces } for the first tank it would hit, or null.
export function traceShot(game, tank, horizon = LIMITS.horizon) {
  const m = game.maze;
  const b = makeBullet(m, tank, 0);
  let bounces = 0;
  for (let f = 0; f < horizon; f++) {
    for (let i = 0; i < BULLET_SUBSTEPS; i++) if (bounceStep(m, b)) bounces++;
    for (const t of game.tanks.values()) if (t.alive && pointInTank(m.S, t, b.x, b.y)) return { victim: t.id, bounces };
  }
  return null;
}

export class CheatWatch {
  // onVerdict(id, level, reason, evidence)
  constructor({ onVerdict = () => {}, limits = {} } = {}) {
    this.onVerdict = onVerdict;
    this.L = { ...LIMITS, ...limits };
    this.seats = new Map();
  }

  seat(id) {
    let s = this.seats.get(id);
    if (!s) {
      s = { shots: [], lethalSince: null, lastBits: null, changes: [], hotWindows: 0, snaps: [], pointer: null, round: 0, overflow: [], said: new Set() };
      this.seats.set(id, s);
    }
    return s;
  }
  forget(id) { this.seats.delete(id); }

  verdict(id, level, reason, evidence) {
    const s = this.seat(id), key = `${level}:${reason}`;
    if (s.said.has(key)) return;
    s.said.add(key);
    this.onVerdict(id, level, reason, evidence);
  }

  noteOverflow(id, tick) { this.seat(id).overflow.push(tick); }

  // After every tick: used = [[id, seq, bits, mx, my], ...] (the frames applied), events = game events.
  afterTick(game, used, events) {
    if (!game.maze || game.frozen > 0) return;
    const L = this.L, tick = game.tick;
    const fired = new Set(events.filter(e => e.type === 'fire' && e.weapon === 'bullet').map(e => e.id));

    for (const [id, , bits, mx, my] of used) {
      const t = game.tanks.get(id);
      if (!t || !t.alive) continue;
      const s = this.seat(id);

      // 1. cannon shots: would this shot kill someone after ricocheting? how fast was it taken?
      const lethalNow = t.weapon === 'bullet' ? traceShot(game, t) : null;
      const killsEnemy = lethalNow && lethalNow.victim !== id;
      if (fired.has(id)) {
        const reaction = killsEnemy ? (s.lethalSince == null ? 0 : tick - s.lethalSince) : null;
        s.shots.push({ bank: !!(killsEnemy && lethalNow.bounces > 0), lethal: !!killsEnemy, instant: reaction != null && reaction <= L.instantTicks });
        if (s.shots.length > L.shotWindow) s.shots.shift();
        this.judgeShots(id, s);
      }
      s.lethalSince = killsEnemy ? (s.lethalSince ?? tick) : null;

      // 2. frame-perfect input: buttons changing on most ticks, for many seconds
      if (s.lastBits != null) s.changes.push(bits !== s.lastBits ? 1 : 0);
      s.lastBits = bits;
      if (s.changes.length >= L.toggleWindow) {
        const rate = s.changes.reduce((a, b) => a + b, 0) / s.changes.length;
        s.changes.length = 0;
        s.hotWindows = rate > L.toggleFlag ? s.hotWindows + 1 : 0;
        if (s.hotWindows >= L.toggleWindowsFlag) this.verdict(id, 'flag', 'frame-perfect input', { rate });
      }

      // 3. mouse aimbot: the pointer teleports a long way in one tick and lands
      //    right on an enemy (hands move the pointer through the space in between)
      if (s.round !== game.round) { s.round = game.round; s.pointer = null; }
      if (bits & 32) {
        const p = s.pointer;
        s.pointer = [mx, my];
        if (p && Math.hypot(mx - p[0], my - p[1]) > L.snapJump) {
          for (const e of game.tanks.values()) {
            if (e.id === id || !e.alive) continue;
            if (Math.hypot(mx - e.x, my - e.y) <= L.snapOnTarget * game.maze.S) { s.snaps.push(tick); break; }
          }
          s.snaps = s.snaps.filter(k => tick - k <= L.snapWindow);
          if (s.snaps.length >= L.snapKick) this.verdict(id, 'kick', 'aimbot (mouse snaps onto targets)', { snaps: s.snaps.length });
          else if (s.snaps.length >= L.snapFlag) this.verdict(id, 'flag', 'suspicious mouse snaps onto targets', { snaps: s.snaps.length });
        }
      }

      // 4. client clock running fast: input frames keep arriving faster than real time
      s.overflow = s.overflow.filter(k => tick - k <= L.overflowWindow);
      if (s.overflow.length >= L.overflowFlag) this.verdict(id, 'flag', 'client clock running fast (speed hack attempt)', { dropped: s.overflow.length });
    }
  }

  judgeShots(id, s) {
    const L = this.L, n = s.shots.length;
    const lethal = s.shots.filter(x => x.lethal);
    const bank = s.shots.filter(x => x.bank).length / n;
    const instant = lethal.length ? lethal.filter(x => x.instant).length / lethal.length : 0;
    const evidence = { shots: n, bankRate: +bank.toFixed(2), lethalShots: lethal.length, instantRate: +instant.toFixed(2) };
    if (n >= L.minShots && bank >= L.bankKick && lethal.length >= L.minLethal && instant >= L.instantKick) this.verdict(id, 'kick', 'automated aiming (instant ricochet kills)', evidence);
    else if (n >= L.minShotsAlone && bank >= L.bankKickAlone) this.verdict(id, 'kick', 'automated aiming (near-perfect ricochet shots)', evidence);
    else if (n >= L.minShots && bank >= L.bankFlag) this.verdict(id, 'flag', 'unusually many ricochet kill shots', evidence);
    if (lethal.length >= L.minLethal && instant >= L.instantFlag) this.verdict(id, 'flag', 'inhumanly fast reactions', evidence);
  }
}
