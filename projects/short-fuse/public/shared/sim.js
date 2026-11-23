// Short Fuse - the whole game, shared by the server (authoritative) and the browser
// (movement prediction). Rules and numbers were recovered from the supplied Flash game's
// ActionScript (see RE-NOTES.md). Units are the original's: 30 per map cell, one tick
// per original frame (24 per second).

export const TICK_HZ = 24;
export const FRAME_MS = 1000 / TICK_HZ;
export const CELL = 30, COLS = 15, ROWS = 13;
export const SPEEDS = [2, 3, 5, 6, 10];           // units per tick for speed levels 0-4
export const MAX_SPEED = SPEEDS.length - 1;
export const FUSE = 60;                            // ticks until a bomb explodes (2.5 s)
export const FLAME_TICKS = 25;                     // flames last this long; a hit crate burns this long
export const KICK_SPEED = 10, THROW_SPEED = 10, THROW_TICKS = 9;
export const LIVES = 3, INVINCIBLE_TICKS = 75, TELEPORT_COOLDOWN = 24, FIRELINE_TICKS = 25;
export const ROUND_SECONDS = 180, HEATS = 3;
export const SUDDEN_DEATH_SECONDS = 40, FILL_EVERY = 8, FILL_MAX = 80;
export const PICKUPS = ['flame', 'speed', 'bomb', 'kick', 'throw'];
export const PICKUP_POOL = [8, 8, 8, 4, 4];       // how many of each type a heat can drop
export const BONUS_PER_SECOND = 250;               // winner's bonus: seconds left x opponents x 250
export const READY_TICKS = 36, RESULT_TICKS = 98, MATCH_OVER_TICKS = 192;
export const MAX_FIGHTERS = 4;
export const CORNERS = [[1, 1], [13, 11], [1, 11], [13, 1]];
// Hit boxes from the original's clip bounds: [xmin, xmax, ymin, ymax] around the centre.
// A hit is an overlap with the player's 15.3-unit hit marker.
export const HIT = {
  dot: 7.65,
  armV: [-6.4, 6.4, -18, 18], armH: [-18, 18, -6.4, 6.4], // flame arms (vertical / horizontal)
  bomb: [-15.5, 16.5, -26, 16],                          // the exploding bomb itself
  fire: [-16, 16, -16, 16],                              // a burning fire-line tile
  teleporter: [-17, 16, -17, 16],
};
export const ARENAS = {
  classic: { name: 'Classic' },
  firelines: { name: 'Fire lines' },
  teleport: { name: 'Teleporters' },
  madness: { name: 'Madness', speed: 4, length: 4, bombs: 3, kick: true, throw: true, aggression: 2 },
};
export const BIT = { up: 1, down: 2, left: 4, right: 8, action: 16 };
// grid values (as in the original): 0 open, 1 wall, 2 crate, 3 bomb
export const OPEN = 0, WALL = 1, CRATE = 2, BOMB = 3;

export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (i, j) => i * ROWS + j;
// Cell value; outside the board it's NaN, which (as undefined in the original) is neither
// open-by-equality nor blocked: `!(v > 0)` is true, `v === 0` is false.
export const at = (g, i, j) => (i >= 0 && i < COLS && j >= 0 && j < ROWS ? g[key(i, j)] : NaN);
const open = (g, i, j) => !(at(g, i, j) > 0);
export const gridToString = g => g.join('');
export const gridFromString = s => Array.from(s, c => +c);

// One tick of player movement, ported from the original. Movement is along one axis at a
// time and only when lined up with the grid on the other axis; when you push against a
// wall slightly off a lane, you're nudged sideways toward an open lane ("corner assist").
// The nearest cell and lag are computed once at the start of the tick, as in the original.
// onKick(i, j, dir) is called when you walk into a bomb you can kick.
export function movePlayer(g, p, bits, onKick) {
  const spd = SPEEDS[p.speed];
  const gx = Math.round(p.x / CELL), gy = Math.round(p.y / CELL);
  const lagX = CELL * gx - p.x, lagY = CELL * gy - p.y;
  const up = bits & 1, down = bits & 2, left = bits & 4, right = bits & 8;
  const kickable = (v, offAxis, onAxis) => p.kick && (v === BOMB || offAxis !== 0) && onAxis === 0;
  if (up) {
    p.dir = 1;
    if ((open(g, gx, gy - 1) || p.y % CELL !== 0) && p.x % CELL === 0) p.y -= spd;
    else if (kickable(at(g, gx, gy - 1), p.y % CELL, p.x % CELL)) onKick?.(gx, gy - 1, 1);
    if (!left && !right) {
      if (open(g, gx + 1, gy - 1) && lagX < 0) p.x += spd;
      if (open(g, gx, gy - 1) && lagX > 0) p.x += spd;
      if (open(g, gx - 1, gy - 1) && lagX > 0) p.x -= spd;
      if (open(g, gx, gy - 1) && lagX < 0) p.x -= spd;
    }
  }
  if (down) {
    p.dir = 2;
    if ((open(g, gx, gy + 1) || p.y % CELL !== 0) && p.x % CELL === 0) p.y += spd;
    else if (kickable(at(g, gx, gy + 1), p.y % CELL, p.x % CELL)) onKick?.(gx, gy + 1, 2);
    if (!left && !right) {
      if (open(g, gx + 1, gy + 1) && lagX < 0) p.x += spd;
      if (open(g, gx, gy + 1) && lagX > 0) p.x += spd;
      if (open(g, gx - 1, gy + 1) && lagX > 0) p.x -= spd;
      if (open(g, gx, gy + 1) && lagX < 0) p.x -= spd;
    }
  }
  if (left) {
    p.dir = 3;
    if ((open(g, gx - 1, gy) || p.x % CELL !== 0) && p.y % CELL === 0) p.x -= spd;
    else if (kickable(at(g, gx - 1, gy), p.x % CELL, p.y % CELL)) onKick?.(gx - 1, gy, 3);
    if (!up && !down) {
      if (open(g, gx - 1, gy) && lagY < 0) p.y -= spd;
      if (open(g, gx - 1, gy - 1) && lagY > 0) p.y -= spd;
      if (open(g, gx - 1, gy) && lagY > 0) p.y += spd;
      if (open(g, gx - 1, gy + 1) && lagY < 0) p.y += spd;
    }
  }
  if (right) {
    p.dir = 4;
    if ((open(g, gx + 1, gy) || p.x % CELL !== 0) && p.y % CELL === 0) p.x += spd;
    else if (kickable(at(g, gx + 1, gy), p.x % CELL, p.y % CELL)) onKick?.(gx + 1, gy, 4);
    if (!up && !down) {
      if (open(g, gx + 1, gy) && lagY < 0) p.y -= spd;
      if (open(g, gx + 1, gy - 1) && lagY > 0) p.y -= spd;
      if (open(g, gx + 1, gy) && lagY > 0) p.y += spd;
      if (open(g, gx + 1, gy + 1) && lagY < 0) p.y += spd;
    }
  }
}

// Can this player lay a bomb right now? (Shared by the server and the browser's prediction.)
export function canLay(g, p) {
  return p.canThrow !== 0 && !(at(g, Math.round(p.x / CELL), Math.round(p.y / CELL)) > 0) && p.laid < p.bombs;
}

// The browser's prediction of one of its own ticks, in the server's order: the bomb button
// (laying, picking up, letting go), then movement (kicking a bomb clears its cell).
// p: { x, y, dir, speed, kick, laid, bombs, canThrow, actionHeld }; g is the predicted grid.
// Where a thrown or kicked bomb ends up is left to the server. Returns the cell [i, j] of a
// bomb laid this tick, or null.
export function predictTick(g, p, bits) {
  const action = !!(bits & 16);
  let laid = null;
  if (action && !p.actionHeld) {
    const i = Math.round(p.x / CELL), j = Math.round(p.y / CELL);
    if (canLay(g, p)) { laid = [i, j]; g[key(i, j)] = BOMB; p.laid++; }
    else if (at(g, i, j) === BOMB && p.canThrow === 1) { p.canThrow = 0; g[key(i, j)] = OPEN; } // picked up
  } else if (!action && p.actionHeld && p.canThrow === 0) p.canThrow = 1; // thrown
  p.actionHeld = action;
  movePlayer(g, p, bits, (i, j) => { g[key(i, j)] = OPEN; }); // kicked away
  return laid;
}

// The world as the browser predicts it for its own inputs. An update describes the end of
// server tick T; the first input not yet applied runs at T+1, the next at T+2, and so on.
// Bombs and burning crates vanish at known ticks (a still bomb at fuse count c is gone after
// tick T + 85 - c; a crate burning for n ticks after T + 25 - n), so the predicted grid
// clears them on time - you can walk through the moment the server will let you.
export class PredictedWorld {
  constructor(snap) {
    this.grid = gridFromString(snap.grid);
    this.clears = []; // [after this many ticks, cell]
    for (const [, x, y, count, state] of snap.bombs) if (state === 0 && count < FUSE + FLAME_TICKS) this.clears.push([FUSE + FLAME_TICKS - count, key(Math.round(x / CELL), Math.round(y / CELL))]);
    for (const [k, n] of snap.burning) this.clears.push([FLAME_TICKS - n, k]);
    this.ticks = 0;
  }
  // predict the next input tick: clear what has gone by then, then run the player's tick
  step(p, bits) {
    this.ticks++;
    this.clears = this.clears.filter(([after, k]) => { // each clear happens once
      if (after >= this.ticks) return true;
      if (this.grid[k] !== WALL) this.grid[k] = OPEN;
      return false;
    });
    return predictTick(this.grid, p, bits);
  }
}

const DIRS = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] };
// Does a box [xmin, xmax, ymin, ymax] centred at (x, y) overlap a player's hit marker?
const touches = (box, x, y, p) => p.x + HIT.dot > x + box[0] && p.x - HIT.dot < x + box[1] && p.y + HIT.dot > y + box[2] && p.y - HIT.dot < y + box[3];

// ------------------------------------------------------------------ arenas
// Pillars on even/even cells inside a wall border; the classic crate generator clears an
// L of five cells in each start corner and then 20 random crates (all as in the original).
function baseGrid() {
  const g = new Array(COLS * ROWS).fill(OPEN);
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
    if (i === 0 || j === 0 || i === COLS - 1 || j === ROWS - 1 || (i % 2 === 0 && j % 2 === 0)) g[key(i, j)] = WALL;
  }
  return g;
}
function crates(g, rand, keepClear) {
  for (let i = 1; i < COLS - 1; i++) for (let j = 1; j < ROWS - 1; j++) if (g[key(i, j)] === OPEN && !keepClear.has(key(i, j))) g[key(i, j)] = CRATE;
  for (const [cx, cy] of CORNERS) {
    const sx = cx === 1 ? 1 : -1, sy = cy === 1 ? 1 : -1;
    for (const [dx, dy] of [[0, 0], [sx, 0], [2 * sx, 0], [0, sy], [0, 2 * sy]]) g[key(cx + dx, cy + dy)] = OPEN;
  }
  for (let k = 0; k < 20; k++) { // remove 20 random crates (retrying until it hits one)
    const i = 1 + Math.floor(rand() * (COLS - 2)), j = 1 + Math.floor(rand() * (ROWS - 2));
    if (g[key(i, j)] === CRATE) g[key(i, j)] = OPEN; else k--;
  }
}
// Arena layouts are Short Fuse's own; fire lines and teleporters work as in the original.
export function makeArena(type, seed) {
  const rand = rng(seed), g = baseGrid(), floor = [];
  if (type === 'firelines') { // a double-barred "H" of fire track
    const track = [];
    for (let j = 2; j <= 10; j++) track.push([5, j], [9, j]);
    for (let i = 6; i <= 8; i++) track.push([i, 5], [i, 7]);
    for (const [i, j] of track) floor.push({ kind: 'fire', i, j });
    crates(g, rand, new Set(track.map(([i, j]) => key(i, j))));
  } else if (type === 'teleport') { // two pairs: left<->right and top<->bottom
    const pads = [[1, 6, 13, 6], [7, 1, 7, 11]];
    const clear = new Set();
    pads.forEach(([a, b, c, d], n) => {
      floor.push({ kind: 'tele', i: a, j: b, to: [c, d], pair: n }, { kind: 'tele', i: c, j: d, to: [a, b], pair: n });
      for (const [i, j] of [[a, b], [c, d]]) { clear.add(key(i, j)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (i + dx > 0 && i + dx < COLS - 1 && j + dy > 0 && j + dy < ROWS - 1 && (i + dx) % 2 + (j + dy) % 2) clear.add(key(i + dx, j + dy)); }
    });
    crates(g, rand, clear);
  } else if (type === 'madness') {
    // an open arena: no crates
  } else crates(g, rand, new Set());
  return { grid: g, floor };
}

// ------------------------------------------------------------------ the game
export class Game {
  constructor(seed = 1, { arena = 'classic', bots = 0 } = {}) {
    this.seed = seed >>> 0;
    this.rand = rng(this.seed);
    this.botRand = rng(this.seed ^ 0x9e3779b9);
    this.arenaType = ARENAS[arena] ? arena : 'classic';
    this.botCount = Math.max(0, Math.min(3, bots | 0));
    this.players = new Map();
    this.tick = 0; this.events = [];
    this.nextBotId = -1;
    this.layoutId = 0;
    this.newMatch();
  }

  // ---------------------------------------------------------- players & bots
  addPlayer(id, name, color, bot = false) {
    const p = { id, name, color, bot, wins: 0, points: 0, fighting: false, order: this.joinCount = (this.joinCount || 0) + 1, slot: -1, alive: false, x: 0, y: 0, dir: 2, lives: 0 };
    this.players.set(id, p);
    this.events.push({ type: 'join', id, name });
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.fighting && p.alive) this.dropHeld(p);
    this.players.delete(id);
    this.events.push({ type: 'leave', id, name: p.name, fighting: p.fighting && p.alive });
    for (const b of this.bombs) if (b.owner === id) b.owner = 0;
  }
  humans() { return [...this.players.values()].filter(p => !p.bot); }
  // bots fill seats up to the room's bot count, never past 4 fighters
  syncBots() {
    const want = Math.max(0, Math.min(this.botCount, MAX_FIGHTERS - Math.min(MAX_FIGHTERS, this.humans().length)));
    const bots = [...this.players.values()].filter(p => p.bot);
    const names = ['Bolt', 'Ember', 'Rivet', 'Sprocket'], colors = ['#9ccc65', '#ba68c8', '#4db6ac', '#ff8a65'];
    for (let n = bots.length; n < want; n++) {
      const used = new Set([...this.players.values()].map(q => q.name));
      const name = 'Bot ' + (names.find(x => !used.has('Bot ' + x)) || n);
      this.addPlayer(this.nextBotId--, name, colors[n % colors.length], true);
    }
    for (const b of bots.slice(want).reverse()) if (!b.fighting || this.phase !== 'play') this.removePlayer(b.id);
  }

  // ---------------------------------------------------------- match / heat flow
  newMatch() {
    this.heat = 0;
    for (const p of this.players.values()) { p.wins = 0; p.points = 0; }
    this.phase = 'waiting'; this.timer = 0; this.winner = null; this.matchWinner = null;
    this.grid = baseGrid(); this.floor = []; this.bombs = []; this.flames = []; this.burning = new Map(); this.pickups = new Map();
    this.resetClock();
  }
  resetClock() { this.frames = 0; this.elapsed = 0; this.fill = { count: 0, slow: 0, row: 0, col: 1, dir: 1, wall: 1 }; this.fireOn = 0; this.fireCount = 0; }
  secondsLeft() { return ROUND_SECONDS - this.elapsed; }

  startHeat() {
    this.syncBots();
    const pool = [...this.players.values()].sort((a, b) => (a.bot - b.bot) || (a.order - b.order)); // humans first, in join order
    const fighters = pool.slice(0, MAX_FIGHTERS);
    if (fighters.length < 2 || !this.humans().length) { this.phase = 'waiting'; for (const p of this.players.values()) p.fighting = false; return; }
    this.heat++;
    const a = ARENAS[this.arenaType];
    const layout = makeArena(this.arenaType, (this.seed + this.heat * 7919 + this.tick) >>> 0);
    this.grid = layout.grid; this.floor = layout.floor; this.layoutId++;
    this.bombs = []; this.flames = []; this.burning = new Map(); this.pickups = new Map(); this.pool = [...PICKUP_POOL];
    this.nextBombId = 1; this.resetClock(); this.winner = null;
    for (const p of this.players.values()) { p.fighting = false; p.alive = false; }
    fighters.forEach((p, n) => {
      // start corners rotate each heat (the crate layout isn't symmetric); with two players
      // that means swapping diagonal corners
      const [cx, cy] = CORNERS[(n + this.heat - 1) % fighters.length];
      Object.assign(p, {
        fighting: true, slot: n, alive: true, x: cx * CELL, y: cy * CELL, dir: 2, lives: LIVES, inv: 0,
        speed: a.speed ?? 2, length: a.length ?? 2, bombs: a.bombs ?? 1, laid: 0, kick: !!a.kick, canThrow: a.throw ? 1 : -1,
        holding: 0, actionHeld: false, tele: false, teleCount: 0, bot: p.bot, botMem: {},
      });
    });
    this.phase = 'ready'; this.timer = READY_TICKS;
    this.events.push({ type: 'heat', heat: this.heat });
  }

  fighters() { return [...this.players.values()].filter(p => p.fighting).sort((a, b) => a.slot - b.slot); }

  step(inputs = new Map()) {
    this.tick++;
    if (this.phase === 'waiting') {
      this.syncBots();
      if (this.humans().length && this.players.size >= 2) this.startHeat();
      return;
    }
    if (!this.humans().length) { this.newMatch(); return; } // everyone left: bots don't play on their own
    if (this.phase === 'ready') { if (--this.timer <= 0) this.phase = 'play'; return; }
    if (this.phase === 'result') {
      if (--this.timer <= 0) {
        if (this.heat >= HEATS) this.endMatch();
        else this.startHeat();
      }
      return;
    }
    if (this.phase === 'matchover') { if (--this.timer <= 0) { this.newMatch(); this.startHeat(); } return; }
    this.playTick(inputs);
  }

  endMatch() {
    const ranked = [...this.players.values()].filter(p => p.wins || p.points).sort((a, b) => b.wins - a.wins || b.points - a.points);
    this.matchWinner = ranked[0] && (!ranked[1] || ranked[1].wins < ranked[0].wins || ranked[1].points < ranked[0].points) ? ranked[0].id : null;
    this.phase = 'matchover'; this.timer = MATCH_OVER_TICKS;
    this.events.push({ type: 'match', winner: this.matchWinner });
  }

  // ---------------------------------------------------------- one tick of play
  playTick(inputs) {
    const fighters = this.fighters();
    // players: action button, then movement (key events come before the frame in Flash)
    for (const p of fighters) {
      if (!p.alive) continue;
      if (p.inv > 0) p.inv--;
      if (p.tele && ++p.teleCount === TELEPORT_COOLDOWN) { p.tele = false; p.teleCount = 0; }
      // a human's input for this tick: usually one frame; two when the server is catching
      // up on a backlog (each frame is still applied exactly as the browser predicted it)
      const inp = inputs.get(p.id);
      const frames = p.bot ? [{ bits: botInput(this, p) }] : inp?.frames ?? [{ bits: inp?.bits ?? 0, seq: inp?.seq }];
      for (const { bits, seq } of frames) {
        const action = !!(bits & BIT.action);
        if (action && !p.actionHeld) this.pressAction(p, seq);
        else if (!action && p.actionHeld) this.releaseAction(p);
        p.actionHeld = action;
        movePlayer(this.grid, p, bits, (i, j, dir) => this.kick(i, j, dir));
      }
    }
    for (const b of [...this.bombs]) this.updateBomb(b);
    this.updateFlames(fighters);
    for (const [k, n] of [...this.burning]) {
      if (n + 1 < FLAME_TICKS) { this.burning.set(k, n + 1); continue; }
      this.burning.delete(k); this.grid[k] = OPEN;
      this.dropPickup(Math.floor(k / ROWS), k % ROWS);
    }
    for (const p of fighters) this.collect(p);
    this.updateFloor(fighters);
    if (++this.frames % TICK_HZ === 0) this.elapsed++;
    const left = this.secondsLeft();
    if (left > 0 && left < SUDDEN_DEATH_SECONDS) this.suddenDeath(fighters);
    const alive = fighters.filter(p => p.alive);
    if (alive.length <= 1 || left <= 0) return this.endHeat(alive.length === 1 ? alive[0] : null, fighters.length, left);
    // as in the original, the heat also ends once every human is out: the bot with the most lives takes it
    if (fighters.some(p => !p.bot) && !alive.some(p => !p.bot)) {
      const best = alive.reduce((x, y) => (y.lives > x.lives ? y : x));
      this.endHeat(alive.filter(p => p.lives === best.lives).length === 1 ? best : null, fighters.length, left);
    }
  }

  endHeat(winner, count, left) {
    this.phase = 'result'; this.timer = RESULT_TICKS; this.winner = winner?.id ?? null;
    if (winner) { winner.wins++; winner.points += Math.max(0, left) * (count - 1) * BONUS_PER_SECOND; }
    this.events.push({ type: 'result', winner: this.winner, heat: this.heat });
  }

  // ---------------------------------------------------------- bombs
  bombAt(i, j) { return this.bombs.find(b => b.bx === i && b.by === j && !b.moving && !b.held && !b.thrown); }

  pressAction(p, seq) {
    if (p.canThrow === 0) return; // already carrying a bomb
    const gx = Math.round(p.x / CELL), gy = Math.round(p.y / CELL), v = at(this.grid, gx, gy);
    if (canLay(this.grid, p)) { this.layBomb(p, gx, gy, seq); p.laid++; return; }
    if (v === BOMB && p.canThrow === 1) { // pick up the bomb you're standing on
      const b = this.bombAt(gx, gy);
      if (!b || b.count >= FUSE) return;
      p.canThrow = 0; p.holding = b.id; b.held = p.id;
      this.grid[key(gx, gy)] = OPEN;
      this.events.push({ type: 'pickup-bomb', id: p.id });
    }
  }
  releaseAction(p) {
    if (p.canThrow !== 0) return;
    const b = this.bombs.find(x => x.id === p.holding);
    p.canThrow = 1; p.holding = 0;
    if (!b) return;
    b.held = 0; b.thrown = p.dir; b.flight = 0;
    this.events.push({ type: 'throw', id: p.id, x: p.x, y: p.y });
  }
  dropHeld(p) { // a carried bomb falls where its carrier is (the original left it floating)
    const b = this.bombs.find(x => x.id === p.holding);
    if (b) { b.held = 0; b.x = Math.round(p.x / CELL) * CELL; b.y = Math.round(p.y / CELL) * CELL; }
    p.holding = 0; if (p.canThrow === 0) p.canThrow = 1;
  }
  layBomb(p, gx, gy, seq = 0) {
    const b = { id: this.nextBombId++, owner: p.id, x: gx * CELL, y: gy * CELL, bx: gx, by: gy, count: 0, length: p.length, moving: 0, dir: 0, held: 0, thrown: 0, flight: 0 };
    this.bombs.push(b);
    this.grid[key(gx, gy)] = BOMB;
    this.events.push({ type: 'lay', id: p.id, x: b.x, y: b.y, seq }); // seq: the input frame that laid it (0 for bots)
  }
  kick(i, j, dir) {
    const b = this.bombAt(i, j);
    if (!b) return;
    b.moving = 1; b.dir = dir;
    this.grid[key(i, j)] = OPEN;
    this.events.push({ type: 'kick', x: b.x, y: b.y });
  }

  // One bomb tick, ported: carried and flying bombs don't count down; a flying bomb goes
  // 9 ticks at 10/tick, wrapping round the board, and keeps going 2 ticks at a time until
  // it can land on a free cell; a kicked bomb slides at 10/tick until something blocks it.
  updateBomb(b) {
    if (b.chained === this.tick) return; // set off by another bomb this tick: it goes off next tick
    b.count++;
    if (b.count <= FUSE - 1) {
      const gx = Math.round(b.x / CELL), gy = Math.round(b.y / CELL);
      if (b.held) {
        b.count--;
        const h = this.players.get(b.held); // follows its carrier (the original followed its layer)
        if (h) { b.x = h.x; b.y = h.y; }
        b.moving = 0;
      } else if (b.thrown) {
        b.count--;
        if (b.flight <= THROW_TICKS) {
          const [dx, dy] = DIRS[b.thrown];
          b.x += dx * THROW_SPEED; b.y += dy * THROW_SPEED;
          if (b.y < -10) b.y = 360; else if (b.y > 360) b.y = -10;  // wrap (the original's edges)
          if (b.x < -20) b.x = 430; else if (b.x > 430) b.x = -20;
          if (++b.flight === THROW_TICKS) {
            if (!this.landable(gx, gy)) b.flight = THROW_TICKS - 2;
            else { b.x = gx * CELL; b.y = gy * CELL; b.flight = THROW_TICKS + 1; }
          }
        } else { b.thrown = 0; this.events.push({ type: 'land', x: b.x, y: b.y }); }
        b.moving = 0;
      } else if (!b.moving) {
        b.x = gx * CELL; b.y = gy * CELL;
        this.grid[key(gx, gy)] = BOMB;
      }
      b.bx = gx; b.by = gy;
      if (b.moving) {
        const [dx, dy] = DIRS[b.dir];
        const along = dx ? b.x % CELL : b.y % CELL, across = dx ? b.y % CELL : b.x % CELL;
        if ((open(this.grid, gx + dx, gy + dy) || along !== 0) && across === 0) {
          b.x += dx * KICK_SPEED; b.y += dy * KICK_SPEED;
          this.pickups.delete(key(Math.round(b.x / CELL), Math.round(b.y / CELL))); // kicked bombs crush pickups
        } else b.moving = 0;
      }
    }
    if (b.count >= FUSE) for (const p of this.fighters()) if (p.alive && touches(HIT.bomb, b.x, b.y, p)) this.hit(p);
    if (b.count === FUSE) this.explode(b);
    if (b.count === FUSE + FLAME_TICKS) this.removeBomb(b);
  }
  landable(i, j) { return at(this.grid, i, j) === OPEN && !this.pickups.has(key(i, j)) && !this.floor.some(f => f.i === i && f.j === j); }
  removeBomb(b) {
    const owner = this.players.get(b.owner); // the layer gets the bomb back (the original credited the last thrower)
    if (owner && owner.fighting) owner.laid = Math.max(0, owner.laid - 1);
    if (at(this.grid, b.bx, b.by) === BOMB) this.grid[key(b.bx, b.by)] = OPEN;
    this.bombs.splice(this.bombs.indexOf(b), 1);
  }

  // Flames go out `length` cells each way. Open cells (and pickups) let them through, a crate
  // stops them and starts burning, a wall stops them, another bomb is set off next tick.
  explode(b) {
    this.events.push({ type: 'boom', x: b.x, y: b.y });
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = DIRS[dir];
      for (let i = 1; i <= b.length; i++) {
        const cx = b.bx + dx * i, cy = b.by + dy * i, v = at(this.grid, cx, cy);
        const x = b.x + dx * CELL * i, y = b.y + dy * CELL * i;
        if (!(v > 0)) { this.flames.push({ x, y, i: cx, j: cy, dir, end: i === b.length, life: FLAME_TICKS, spent: false }); continue; }
        if (v === CRATE) {
          this.flames.push({ x, y, i: cx, j: cy, dir, end: true, life: FLAME_TICKS, spent: false });
          if (!this.burning.has(key(cx, cy))) { this.burning.set(key(cx, cy), -1); /* burns for the next 25 ticks */ this.events.push({ type: 'crate', x, y }); }
        } else if (v === BOMB) {
          const o = this.bombAt(cx, cy);
          if (o && o.count < FUSE - 1) { o.count = FUSE - 1; o.chained = this.tick; }
        }
        break;
      }
    }
  }

  // Each flame arm can hit one player once; flames on fire-line track light the track.
  updateFlames(fighters) {
    for (const f of this.flames) {
      if (this.floor.some(t => t.kind === 'fire' && t.i === f.i && t.j === f.j)) this.fireOn = 1;
      const box = f.dir <= 2 ? HIT.armV : HIT.armH;
      if (!f.spent) {
        // An arm is used up by the first hit (as in the original), but everyone it touches on
        // that tick is hit - the original picked the lowest player number, unfair online.
        const caught = fighters.filter(p => p.alive && touches(box, f.x, f.y, p));
        if (caught.length) { f.spent = true; for (const p of caught) this.hit(p); }
      }
      f.life--;
    }
    this.flames = this.flames.filter(f => f.life > 0);
  }

  // A hit costs a life and gives 75 ticks of invincibility; no lives left = out of the heat.
  hit(p) {
    if (!p.alive || p.inv > 0) return;
    p.lives--; p.inv = INVINCIBLE_TICKS;
    this.events.push({ type: 'hit', id: p.id, lives: p.lives });
    if (p.lives > 0) return;
    p.alive = false; this.dropHeld(p);
    this.events.push({ type: 'out', id: p.id, x: p.x, y: p.y });
  }

  // A destroyed crate rolls a type (throw is rerolled 1 time in 5), then drops it half the time
  // if the heat's pool still has one.
  dropPickup(i, j) {
    let t = Math.floor(this.rand() * 5);
    if (t === 4 && Math.floor(this.rand() * 5) === 2) t = Math.floor(this.rand() * 4);
    if (Math.floor(this.rand() * 2) === 1 && this.pool[t] > 0) { this.pickups.set(key(i, j), t); this.pool[t]--; }
  }
  // Collected only when standing exactly on the cell's centre.
  collect(p) {
    if (!p.alive || p.x % CELL !== 0 || p.y % CELL !== 0) return;
    const k = key(p.x / CELL, p.y / CELL), t = this.pickups.get(k);
    if (t === undefined) return;
    this.pickups.delete(k);
    if (t === 0) p.length++;
    else if (t === 1) { if (p.speed < MAX_SPEED) p.speed++; }
    else if (t === 2) p.bombs++;
    else if (t === 3) p.kick = true;
    else if (p.canThrow === -1) p.canThrow = 1;
    this.events.push({ type: 'pickup', id: p.id, kind: PICKUPS[t] });
  }

  // Teleporter pads and fire-line track.
  updateFloor(fighters) {
    for (const t of this.floor) {
      if (t.kind !== 'tele') continue;
      for (const p of fighters) {
        if (!p.alive || p.tele || !touches(HIT.teleporter, t.i * CELL, t.j * CELL, p)) continue;
        p.tele = true; p.teleCount = 0;
        p.x = t.to[0] * CELL; p.y = t.to[1] * CELL;
        this.events.push({ type: 'teleport', id: p.id });
      }
    }
    if (this.fireOn) {
      if (this.fireCount === 0) this.events.push({ type: 'fire' });
      for (const t of this.floor) {
        if (t.kind !== 'fire') continue;
        for (const p of fighters) {
          if (!p.alive || t.spent || !touches(HIT.fire, t.i * CELL, t.j * CELL, p)) continue;
          t.spent = true; this.hit(p); // each tile can hit once per burn (the original: once per round)
        }
      }
      if (++this.fireCount >= FIRELINE_TICKS) { this.fireOn = 0; this.fireCount = 0; for (const t of this.floor) t.spent = false; }
    }
  }

  // The last 40 seconds: a wall drops every 8 ticks, spiralling in from the outer ring
  // (80 at most); a player under it loses a life.
  suddenDeath(fighters) {
    const f = this.fill;
    if (f.count >= FILL_MAX || ++f.slow % FILL_EVERY !== 0) return;
    if (f.dir === 1) { if (++f.row > COLS - 2 - f.wall) f.dir = 2; }
    else if (f.dir === 2) { if (++f.col > ROWS - 2 - f.wall) f.dir = 3; }
    else if (f.dir === 3) { if (!(--f.row > f.wall)) f.dir = 4; }
    else if (!(--f.col > 1 + f.wall)) { f.dir = 1; f.wall++; }
    const k = key(f.row, f.col);
    this.grid[k] = WALL; this.burning.delete(k); this.pickups.delete(k);
    for (const b of [...this.bombs]) if (b.bx === f.row && b.by === f.col && !b.held && !b.thrown) this.removeBomb(b); // crushed
    for (const p of fighters) if (p.alive && Math.round(p.x / CELL) === f.row && Math.round(p.y / CELL) === f.col) this.hit(p);
    f.count++;
    this.events.push({ type: 'fill', i: f.row, j: f.col });
  }

  // ---------------------------------------------------------- network snapshot
  snapshot() {
    return {
      t: 's', tick: this.tick, phase: this.phase, timer: this.timer, heat: this.heat, heats: HEATS, arena: this.arenaType,
      clock: this.secondsLeft(), winner: this.winner, matchWinner: this.matchWinner, fire: this.fireOn, layout: this.layoutId,
      grid: gridToString(this.grid),
      players: [...this.players.values()].map(p => [p.id, p.x, p.y, p.dir, p.lives, p.alive ? 1 : 0, p.inv > 0 ? 1 : 0, p.speed ?? 2, p.length ?? 2, p.bombs ?? 1, p.kick ? 1 : 0, p.canThrow ?? -1, p.holding ? 1 : 0, p.name, p.color, p.wins, p.points, p.bot ? 1 : 0, p.fighting ? 1 : 0, p.slot, p.laid ?? 0, p.actionHeld ? 1 : 0]),
      bombs: this.bombs.map(b => [b.id, b.x, b.y, b.count, b.held ? 3 : b.thrown ? 2 : b.moving ? 1 : 0]),
      flames: this.flames.map(f => [f.x, f.y, f.dir, f.end ? 1 : 0, f.life]),
      burning: [...this.burning], // [cell, ticks burned]
      pickups: [...this.pickups].map(([k, t]) => [Math.floor(k / ROWS), k % ROWS, t]),
    };
  }
  arenaMsg() { return { t: 'arena', layout: this.layoutId, arena: this.arenaType, floor: this.floor.map(f => ({ kind: f.kind, i: f.i, j: f.j, pair: f.pair })) }; }
  drainEvents() { const e = this.events; this.events = []; return e; }
}

// ------------------------------------------------------------------ bots
// Short Fuse's own AI (the original's was simpler): it maps when every cell will be on
// fire (chain reactions included), flees to a safe cell when threatened, drops a bomb when
// that would hit a crate or a rival and it can still get away, and otherwise heads for
// pickups, crates and rivals. From the original: a bot that hasn't bombed for 350 ticks
// (divided by the arena's aggression) drops one anyway.
const BOT_FORCE_TICKS = 350;
export function dangerMap(g, extra) {
  const t = new Array(COLS * ROWS).fill(Infinity);
  const bombs = g.bombs.filter(b => !b.held && !b.thrown).map(b => ({ i: b.bx, j: b.by, len: b.length, at: Math.max(0, FUSE - b.count), live: b.count >= FUSE }));
  if (extra) bombs.push(extra);
  for (let changed = true, n = 0; changed && n < 6; n++) { // chain reactions: a bomb in another's blast goes off with it
    changed = false;
    for (const a of bombs) for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = DIRS[dir];
      for (let s = 1; s <= a.len; s++) {
        const v = at(g.grid, a.i + dx * s, a.j + dy * s);
        if (v === BOMB) { const o = bombs.find(b => b.i === a.i + dx * s && b.j === a.j + dy * s); if (o && o.at > a.at + 1) { o.at = a.at + 1; changed = true; } }
        if (v > 0) break;
      }
    }
  }
  const mark = (i, j, when) => { const k = key(i, j); if (when < t[k]) t[k] = when; };
  for (const a of bombs) {
    mark(a.i, a.j, a.at);
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = DIRS[dir];
      for (let s = 1; s <= a.len; s++) {
        const i = a.i + dx * s, j = a.j + dy * s, v = at(g.grid, i, j);
        if (v === WALL || Number.isNaN(v)) break;
        mark(i, j, a.at);
        if (v > 0) break;
      }
    }
  }
  for (const f of g.flames) mark(f.i, f.j, 0);
  if (g.fireOn) for (const f of g.floor) if (f.kind === 'fire') mark(f.i, f.j, 0);
  const left = g.secondsLeft();
  if (left < SUDDEN_DEATH_SECONDS + 2) { // the next few sudden-death walls
    const f = { ...g.fill };
    for (let n = 1; n <= 4 && f.count < FILL_MAX; n++, f.count++) {
      if (f.dir === 1) { if (++f.row > COLS - 2 - f.wall) f.dir = 2; } else if (f.dir === 2) { if (++f.col > ROWS - 2 - f.wall) f.dir = 3; } else if (f.dir === 3) { if (!(--f.row > f.wall)) f.dir = 4; } else if (!(--f.col > 1 + f.wall)) { f.dir = 1; f.wall++; }
      mark(f.row, f.col, 0);
    }
  }
  return t;
}

function botInput(g, p) {
  const m = p.botMem, rand = g.botRand, aggression = ARENAS[g.arenaType].aggression || 1;
  if (g.botDangerTick !== g.tick) { g.botDanger = dangerMap(g); g.botDangerTick = g.tick; }
  const danger = g.botDanger;
  if (p.canThrow === 0) return 0; // carrying (never happens for bots, but release)
  m.sinceBomb = (m.sinceBomb ?? 0) + 1;
  const cx = Math.round(p.x / CELL), cy = Math.round(p.y / CELL), perCell = CELL / SPEEDS[p.speed];
  const pads = new Set(g.floor.filter(f => f.kind === 'tele').map(f => key(f.i, f.j)));
  const passable = (i, j) => (at(g.grid, i, j) === OPEN && !pads.has(key(i, j))) || (i === cx && j === cy); // bots don't use teleporters
  const unsafeAt = (k, when) => danger[k] !== Infinity && when >= danger[k] - perCell - 2 && when <= danger[k] + FLAME_TICKS + 2;
  // breadth-first search from the current cell with arrival times
  const bfs = (dmap = danger, avoidAll = false) => {
    const prev = new Map([[key(cx, cy), -1]]), dist = new Map([[key(cx, cy), 0]]), order = [key(cx, cy)];
    for (let n = 0; n < order.length; n++) {
      const k = order[n], i = Math.floor(k / ROWS), j = k % ROWS, d = dist.get(k);
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const ni = i + dx, nj = j + dy, nk = key(ni, nj);
        if (dist.has(nk) || !passable(ni, nj)) continue;
        const when = (d + 1) * perCell;
        if (avoidAll ? dmap[nk] !== Infinity : (dmap[nk] !== Infinity && when >= dmap[nk] - perCell - 2 && when <= dmap[nk] + FLAME_TICKS + 2)) continue;
        dist.set(nk, d + 1); prev.set(nk, k); order.push(nk);
      }
    }
    return { prev, dist, order };
  };
  const stepToward = (prev, target) => {
    let k = target;
    while (prev.get(k) !== key(cx, cy) && prev.get(k) !== -1 && prev.get(k) !== undefined) k = prev.get(k);
    return k;
  };
  const dirTo = k => {
    const i = Math.floor(k / ROWS), j = k % ROWS;
    if (i === cx && j === cy) { // re-centre in the cell
      const dx = cx * CELL - p.x, dy = cy * CELL - p.y;
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? BIT.right : BIT.left) : dy ? (dy > 0 ? BIT.down : BIT.up) : 0;
    }
    return j < cy ? BIT.up : j > cy ? BIT.down : i < cx ? BIT.left : BIT.right;
  };
  const here = key(cx, cy);
  const search = bfs();
  // 1. in danger: run to the closest cell that never burns
  if (danger[here] !== Infinity) {
    const safe = search.order.find(k => danger[k] === Infinity);
    if (safe !== undefined) return dirTo(stepToward(search.prev, safe));
    return dirTo(here);
  }
  // 2. drop a bomb if it would hit something and there's a way out
  const rivals = g.fighters().filter(q => q !== p && q.alive);
  const hitsSomething = () => {
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = DIRS[dir];
      for (let s = 1; s <= p.length; s++) {
        const i = cx + dx * s, j = cy + dy * s, v = at(g.grid, i, j);
        if (v === CRATE && !g.burning.has(key(i, j))) return true;
        if (rivals.some(q => Math.round(q.x / CELL) === i && Math.round(q.y / CELL) === j)) return true;
        if (v > 0) break;
      }
    }
    return false;
  };
  const centred = p.x % CELL === 0 && p.y % CELL === 0;
  if (p.laid < p.bombs && at(g.grid, cx, cy) === OPEN && centred && !p.actionHeld && (hitsSomething() || m.sinceBomb > BOT_FORCE_TICKS / aggression || (aggression > 1 && rand() < 0.02))) {
    const withBomb = dangerMap(g, { i: cx, j: cy, len: p.length, at: FUSE, live: false });
    const escape = bfs(withBomb);
    if (escape.order.some(k => withBomb[k] === Infinity && escape.dist.get(k) * perCell < FUSE - 8)) { m.sinceBomb = 0; m.fleeing = true; return BIT.action; }
  }
  // 3. go somewhere useful: a pickup, a spot next to a crate, or a rival
  const pick = () => {
    const ok = search.order.filter(k => danger[k] === Infinity);
    const near = k => search.dist.get(k) <= 6;
    const pk = ok.find(k => g.pickups.has(k) && (g.pickups.get(k) !== 1 || p.speed < MAX_SPEED));
    if (pk !== undefined && near(pk)) return pk;
    // hunt: a reachable cell from which a bomb would reach a rival
    const line = new Set();
    for (const r of rivals) {
      const ri = Math.round(r.x / CELL), rj = Math.round(r.y / CELL);
      line.add(key(ri, rj));
      for (const dir of [1, 2, 3, 4]) {
        const [dx, dy] = DIRS[dir];
        for (let s = 1; s <= p.length; s++) { if (at(g.grid, ri + dx * s, rj + dy * s) > 0) break; line.add(key(ri + dx * s, rj + dy * s)); }
      }
    }
    const hunt = ok.find(k => line.has(k));
    if (hunt !== undefined && (search.dist.get(hunt) <= 8 || aggression > 1)) return hunt;
    if (pk !== undefined) return pk;
    const crateSpot = ok.find(k => { const i = Math.floor(k / ROWS), j = k % ROWS; return [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => at(g.grid, i + dx, j + dy) === CRATE && !g.burning.has(key(i + dx, j + dy))); });
    if (crateSpot !== undefined) return crateSpot;
    if (rivals.length) {
      const r = rivals[Math.floor((g.tick / 120 + p.slot) % rivals.length)], rk = key(Math.round(r.x / CELL), Math.round(r.y / CELL));
      let best = ok[0], bd = Infinity;
      for (const k of ok) { const d = Math.abs(Math.floor(k / ROWS) - Math.floor(rk / ROWS)) + Math.abs(k % ROWS - rk % ROWS); if (d < bd) { bd = d; best = k; } }
      return best;
    }
    return ok[Math.floor(rand() * ok.length)];
  };
  if (m.goal === undefined || m.goal === here || !search.dist.has(m.goal) || danger[m.goal] !== Infinity || g.tick % 48 === p.slot * 12) m.goal = pick();
  if (m.goal === undefined || m.goal === here) return dirTo(here);
  const next = stepToward(search.prev, m.goal);
  if (unsafeAt(next, perCell)) return 0; // wait for the flames to pass
  return dirTo(next);
}
