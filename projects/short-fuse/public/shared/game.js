// Short Fuse - the game rules. Runs on the server (authoritative) and in the browser (to
// predict your own movement). Every rule and number comes from the supplied Flash game's
// ActionScript; see RE-NOTES.md. Units are the original's: 30 per cell, one tick per frame.

// ---------------------------------------------------------------- constants
export const TICK_HZ = 24, TICK_MS = 1000 / TICK_HZ;
export const CELL = 30, COLS = 15, ROWS = 13;
export const SPEEDS = [2, 3, 5, 6, 10];            // units per tick by speed level
export const FUSE = 60;                             // ticks until a bomb explodes
export const FLAME = 25;                            // flame lifetime; a hit crate burns this long
export const SLIDE = 10;                            // kicked bomb, units per tick
export const FLY = 10, FLY_TICKS = 9;               // thrown bomb
export const LIVES = 3, INVINCIBLE = 75, TELEPORT_WAIT = 24, FIRE_TICKS = 25;
export const ROUND_SECONDS = 180, HEATS = 3, SUDDEN_DEATH = 40, WALL_EVERY = 8, WALL_MAX = 80;
export const POWERUPS = ['flame', 'speed', 'bomb', 'kick', 'glove'];
export const POOL = [8, 8, 8, 4, 4];               // how many of each a heat can drop
export const BONUS = 250;                           // heat winner: seconds left x opponents x 250
export const READY_TICKS = 36, RESULT_TICKS = 98, MATCH_TICKS = 192;
export const MAX_FIGHTERS = 4;
export const CORNERS = [[1, 1], [13, 11], [1, 11], [13, 1]];
export const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, BOMB_KEY = 16;
export const OPEN = 0, WALL = 1, CRATE = 2, BOMB = 3;  // grid values, as in the original
// hit boxes from the original's clips: [xmin, xmax, ymin, ymax] around a centre; a hit is an
// overlap with the player's 15.3-unit hit marker
const DOT = 7.65;
const BOX = {
  armV: [-6.4, 6.4, -18, 18], armH: [-18, 18, -6.4, 6.4],
  bomb: [-15.5, 16.5, -26, 16], fire: [-16, 16, -16, 16], pad: [-17, 16, -17, 16],
};
export const ARENAS = {
  classic: { name: 'Classic' },
  firelines: { name: 'Fire lines' },
  teleport: { name: 'Teleporters' },
  madness: { name: 'Madness', start: { speed: 4, length: 4, bombs: 3, kick: true, glove: true } },
};
const STEP = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] }; // facing: 1 up, 2 down, 3 left, 4 right

export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- grid
export const cell = (i, j) => i * ROWS + j;
// Off the board a cell is NaN, like `undefined` in the original: `!(v > 0)` is true there.
export const at = (g, i, j) => (i >= 0 && i < COLS && j >= 0 && j < ROWS ? g[cell(i, j)] : NaN);
const open = (g, i, j) => !(at(g, i, j) > 0);
const near = v => Math.round(v / CELL);
const touches = (box, x, y, p) => p.x + DOT > x + box[0] && p.x - DOT < x + box[1] && p.y + DOT > y + box[2] && p.y - DOT < y + box[3];

// ---------------------------------------------------------------- movement
// One tick of movement, ported line by line from the original. The nearest cell and the
// distance from its centre are taken once at the start; directions are handled up, down,
// left, right. You move along an axis only when lined up on the other one, into an open
// cell or to finish a step. Holding up/down off a column (with no side key) slides you
// toward the neighbouring column that is open ahead - and the same for rows. Walking into a
// bomb with the kick power calls kick(i, j, dir).
export function move(g, p, keys, kick) {
  const v = SPEEDS[p.speed], gx = near(p.x), gy = near(p.y);
  const lx = CELL * gx - p.x, ly = CELL * gy - p.y;
  const up = keys & UP, down = keys & DOWN, left = keys & LEFT, right = keys & RIGHT;
  const kicks = (i, j, dir, along, across) => { if (p.kick && (at(g, i, j) === BOMB || along !== 0) && across === 0) kick?.(i, j, dir); };
  if (up) {
    p.dir = 1;
    if ((open(g, gx, gy - 1) || p.y % CELL !== 0) && p.x % CELL === 0) p.y -= v;
    else kicks(gx, gy - 1, 1, p.y % CELL, p.x % CELL);
    if (!left && !right) {
      if (open(g, gx + 1, gy - 1) && lx < 0) p.x += v;
      if (open(g, gx, gy - 1) && lx > 0) p.x += v;
      if (open(g, gx - 1, gy - 1) && lx > 0) p.x -= v;
      if (open(g, gx, gy - 1) && lx < 0) p.x -= v;
    }
  }
  if (down) {
    p.dir = 2;
    if ((open(g, gx, gy + 1) || p.y % CELL !== 0) && p.x % CELL === 0) p.y += v;
    else kicks(gx, gy + 1, 2, p.y % CELL, p.x % CELL);
    if (!left && !right) {
      if (open(g, gx + 1, gy + 1) && lx < 0) p.x += v;
      if (open(g, gx, gy + 1) && lx > 0) p.x += v;
      if (open(g, gx - 1, gy + 1) && lx > 0) p.x -= v;
      if (open(g, gx, gy + 1) && lx < 0) p.x -= v;
    }
  }
  if (left) {
    p.dir = 3;
    if ((open(g, gx - 1, gy) || p.x % CELL !== 0) && p.y % CELL === 0) p.x -= v;
    else kicks(gx - 1, gy, 3, p.x % CELL, p.y % CELL);
    if (!up && !down) {
      if (open(g, gx - 1, gy) && ly < 0) p.y -= v;
      if (open(g, gx - 1, gy - 1) && ly > 0) p.y -= v;
      if (open(g, gx - 1, gy) && ly > 0) p.y += v;
      if (open(g, gx - 1, gy + 1) && ly < 0) p.y += v;
    }
  }
  if (right) {
    p.dir = 4;
    if ((open(g, gx + 1, gy) || p.x % CELL !== 0) && p.y % CELL === 0) p.x += v;
    else kicks(gx + 1, gy, 4, p.x % CELL, p.y % CELL);
    if (!up && !down) {
      if (open(g, gx + 1, gy) && ly < 0) p.y -= v;
      if (open(g, gx + 1, gy - 1) && ly > 0) p.y -= v;
      if (open(g, gx + 1, gy) && ly > 0) p.y += v;
      if (open(g, gx + 1, gy + 1) && ly < 0) p.y += v;
    }
  }
}

// Laying a bomb: your cell must be free and you must have a bomb left.
export const canLay = (g, p) => p.glove !== 0 && !(at(g, near(p.x), near(p.y)) > 0) && p.laid < p.bombs;

// ---------------------------------------------------------------- arenas
// Pillars on even/even cells inside a wall border. Crates fill the rest except an L of five
// cells in each start corner, then 20 random crates are removed (the original's generator).
// The fire-line and teleporter layouts are Short Fuse's own; they work as in the original.
export function makeArena(type, seed) {
  const rand = rng(seed), g = new Array(COLS * ROWS).fill(OPEN), floor = [];
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
    if (i === 0 || j === 0 || i === COLS - 1 || j === ROWS - 1 || (i % 2 === 0 && j % 2 === 0)) g[cell(i, j)] = WALL;
  }
  const keep = new Set();
  if (type === 'firelines') { // an "H" of fire track
    for (let j = 2; j <= 10; j++) floor.push({ kind: 'fire', i: 5, j }, { kind: 'fire', i: 9, j });
    for (let i = 6; i <= 8; i++) floor.push({ kind: 'fire', i, j: 5 }, { kind: 'fire', i, j: 7 });
  } else if (type === 'teleport') { // two pairs: left <-> right, top <-> bottom
    [[1, 6, 13, 6], [7, 1, 7, 11]].forEach(([a, b, c, d], pair) => floor.push({ kind: 'pad', i: a, j: b, to: [c, d], pair }, { kind: 'pad', i: c, j: d, to: [a, b], pair }));
    for (const f of floor) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) keep.add(cell(f.i + dx, f.j + dy));
  }
  for (const f of floor) keep.add(cell(f.i, f.j));
  if (type !== 'madness') {
    for (let k = 0; k < g.length; k++) if (g[k] === OPEN && !keep.has(k)) g[k] = CRATE;
    for (const [cx, cy] of CORNERS) {
      const sx = cx === 1 ? 1 : -1, sy = cy === 1 ? 1 : -1;
      for (const [dx, dy] of [[0, 0], [sx, 0], [2 * sx, 0], [0, sy], [0, 2 * sy]]) g[cell(cx + dx, cy + dy)] = OPEN;
    }
    for (let k = 0; k < 20;) { // remove 20 random crates, retrying until it hits one
      const c = cell(1 + Math.floor(rand() * (COLS - 2)), 1 + Math.floor(rand() * (ROWS - 2)));
      if (g[c] === CRATE) { g[c] = OPEN; k++; }
    }
  }
  return { grid: g, floor };
}

// ---------------------------------------------------------------- the game
export class Game {
  constructor({ seed = 1, arena = 'classic', bots = 0 } = {}) {
    this.seed = seed >>> 0; this.rand = rng(this.seed); this.botRand = rng(this.seed ^ 0x5bd1e995);
    this.arena = ARENAS[arena] ? arena : 'classic';
    this.botCount = Math.max(0, Math.min(3, bots | 0));
    this.players = new Map(); this.events = [];
    this.tick = 0; this.layout = 0; this.joins = 0; this.nextBot = -1;
    this.newMatch();
  }

  // ---- players
  addPlayer(id, name, color, bot = false) {
    const p = { id, name, color, bot, order: ++this.joins, wins: 0, points: 0, fighting: false, alive: false, slot: -1, x: 0, y: 0, dir: 2, lives: 0 };
    this.players.set(id, p);
    this.events.push({ type: 'join', id, name, bot });
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.dropCarried(p);
    this.players.delete(id);
    this.events.push({ type: 'leave', id, name: p.name, bot: p.bot });
  }
  humans() { return [...this.players.values()].filter(p => !p.bot); }
  fighters() { return [...this.players.values()].filter(p => p.fighting).sort((a, b) => a.slot - b.slot); }
  syncBots() { // bots fill seats up to the room's bot count, never past 4 fighters
    const bots = [...this.players.values()].filter(p => p.bot);
    const want = Math.min(this.botCount, Math.max(0, MAX_FIGHTERS - this.humans().length));
    const names = ['Bolt', 'Ember', 'Rivet'], colors = ['#9ccc65', '#ba68c8', '#4db6ac'];
    for (let n = bots.length; n < want; n++) {
      const used = new Set(bots.map(b => b.name));
      const k = names.findIndex(x => !used.has('Bot ' + x));
      bots.push(this.addPlayer(this.nextBot--, 'Bot ' + names[k], colors[k], true));
    }
    for (const b of bots.slice(want)) this.removePlayer(b.id);
  }

  // ---- match flow: waiting -> ready -> play -> result -> (next heat | matchover)
  newMatch() {
    for (const p of this.players.values()) { p.wins = 0; p.points = 0; }
    this.heat = 0; this.phase = 'waiting'; this.timer = 0; this.winner = null; this.matchWinner = null;
    this.clear(makeArena('madness', 1));
  }
  clear({ grid, floor }) {
    this.grid = grid; this.floor = floor; this.layout++;
    this.bombs = []; this.flames = []; this.burning = new Map(); this.powerups = new Map(); this.pool = [...POOL];
    this.frames = 0; this.elapsed = 0; this.fireOn = false; this.fireTicks = 0;
    this.walls = { count: 0, slow: 0, x: 0, y: 1, dir: 1, ring: 1 };
    this.nextBomb = 1;
  }
  secondsLeft() { return ROUND_SECONDS - this.elapsed; }

  startHeat() {
    this.syncBots();
    const fighters = [...this.players.values()].sort((a, b) => a.bot - b.bot || a.order - b.order).slice(0, MAX_FIGHTERS);
    for (const p of this.players.values()) { p.fighting = false; p.alive = false; }
    if (fighters.length < 2 || !fighters.some(p => !p.bot)) { this.phase = 'waiting'; return; }
    this.heat++;
    this.clear(makeArena(this.arena, (this.seed + this.heat * 7919 + this.tick) >>> 0));
    const start = ARENAS[this.arena].start || {};
    fighters.forEach((p, n) => {
      const [cx, cy] = CORNERS[(n + this.heat - 1) % fighters.length]; // corners rotate each heat
      Object.assign(p, {
        fighting: true, alive: true, slot: n, x: cx * CELL, y: cy * CELL, dir: 2, lives: LIVES, inv: 0,
        speed: start.speed ?? 2, length: start.length ?? 2, bombs: start.bombs ?? 1, laid: 0,
        kick: !!start.kick, glove: start.glove ? 1 : -1, carrying: 0, button: false, padWait: 0, mind: {},
      });
    });
    this.phase = 'ready'; this.timer = READY_TICKS; this.winner = null;
    this.events.push({ type: 'heat', heat: this.heat });
  }

  // inputs: Map id -> { frames: [{ keys, seq }] } (one frame a tick; two when the server catches up)
  step(inputs = new Map()) {
    this.tick++;
    if (this.phase === 'waiting') {
      this.syncBots();
      if (this.humans().length && this.players.size >= 2) this.startHeat();
    } else if (!this.humans().length) this.newMatch();              // everyone left
    else if (this.phase === 'ready') { if (--this.timer <= 0) this.phase = 'play'; }
    else if (this.phase === 'play') this.play(inputs);
    else if (this.phase === 'result') { if (--this.timer <= 0) { if (this.heat >= HEATS) this.endMatch(); else this.startHeat(); } }
    else if (this.phase === 'matchover' && --this.timer <= 0) { this.newMatch(); this.startHeat(); }
  }

  endMatch() {
    const ranked = [...this.players.values()].sort((a, b) => b.wins - a.wins || b.points - a.points);
    const [a, b] = ranked;
    this.matchWinner = a && (a.wins || a.points) && (!b || b.wins < a.wins || b.points < a.points) ? a.id : null;
    this.phase = 'matchover'; this.timer = MATCH_TICKS;
    this.events.push({ type: 'match', winner: this.matchWinner });
  }

  play(inputs) {
    const fighters = this.fighters();
    for (const p of fighters) {
      if (!p.alive) continue;
      if (p.inv > 0) p.inv--;
      if (p.padWait > 0) p.padWait--;
      const frames = p.bot ? [{ keys: botKeys(this, p) }] : (inputs.get(p.id)?.frames ?? [{ keys: 0 }]);
      for (const f of frames) {
        const pressed = !!(f.keys & BOMB_KEY);
        if (pressed && !p.button) this.pressBomb(p, f.seq);
        if (!pressed && p.button) this.releaseBomb(p);
        p.button = pressed;
        move(this.grid, p, f.keys, (i, j, dir) => this.kick(i, j, dir));
      }
    }
    for (const b of [...this.bombs]) this.updateBomb(b, fighters);
    this.updateFlames(fighters);
    for (const [c, n] of [...this.burning]) {
      if (n + 1 < FLAME) { this.burning.set(c, n + 1); continue; }
      this.burning.delete(c); this.grid[c] = OPEN; this.dropPowerup(c);
    }
    for (const p of fighters) this.collect(p);
    this.updateFloor(fighters);
    if (++this.frames % TICK_HZ === 0) this.elapsed++;
    const left = this.secondsLeft();
    if (left > 0 && left < SUDDEN_DEATH) this.suddenDeath(fighters);
    const alive = fighters.filter(p => p.alive);
    if (alive.length <= 1 || left <= 0) return this.endHeat(alive.length === 1 ? alive[0] : null, fighters.length, left);
    if (!alive.some(p => !p.bot)) { // as in the original: once every human is out, the heat is over
      const best = Math.max(...alive.map(p => p.lives)), top = alive.filter(p => p.lives === best);
      this.endHeat(top.length === 1 ? top[0] : null, fighters.length, left);
    }
  }

  endHeat(winner, count, left) {
    this.phase = 'result'; this.timer = RESULT_TICKS; this.winner = winner?.id ?? null;
    if (winner) { winner.wins++; winner.points += Math.max(0, left) * (count - 1) * BONUS; }
    this.events.push({ type: 'result', winner: this.winner });
  }

  // ---- bombs
  stillBombAt(i, j) { return this.bombs.find(b => b.cx === i && b.cy === j && b.state === 'still'); }
  pressBomb(p, seq) {
    if (p.glove === 0) return; // carrying one already
    const i = near(p.x), j = near(p.y);
    if (canLay(this.grid, p)) {
      const b = { id: this.nextBomb++, owner: p.id, x: i * CELL, y: j * CELL, cx: i, cy: j, count: 0, length: p.length, state: 'still', dir: 0, flight: 0, carrier: 0 };
      this.bombs.push(b); this.grid[cell(i, j)] = BOMB; p.laid++;
      this.events.push({ type: 'lay', id: p.id, x: b.x, y: b.y, seq: seq ?? 0 });
    } else if (p.glove === 1 && at(this.grid, i, j) === BOMB) { // pick up the bomb you stand on
      const b = this.stillBombAt(i, j);
      if (!b || b.count >= FUSE) return;
      b.state = 'held'; b.carrier = p.id; p.glove = 0; p.carrying = b.id;
      this.grid[cell(i, j)] = OPEN;
    }
  }
  releaseBomb(p) { // throw what you carry
    if (p.glove !== 0) return;
    const b = this.bombs.find(x => x.id === p.carrying);
    p.glove = 1; p.carrying = 0;
    if (!b) return;
    b.state = 'fly'; b.dir = p.dir; b.flight = 0; b.carrier = 0;
    this.events.push({ type: 'throw', x: p.x, y: p.y });
  }
  dropCarried(p) { // a carried bomb falls where its carrier was
    const b = this.bombs.find(x => x.id === p.carrying);
    if (b) { b.carrier = 0; b.x = p.x; b.y = p.y; this.settle(b); }
    p.carrying = 0; if (p.glove === 0) p.glove = 1;
  }
  // A bomb comes to rest: it snaps to its cell and claims it at once. (The original claimed
  // the cell a frame later, leaving a moment where a second bomb could land or be laid in
  // the same cell - and then one of them would go on as a "ghost".) If the cell is already
  // taken, it rests on the nearest free neighbour.
  settle(b) {
    let i = near(b.x), j = near(b.y);
    if (at(this.grid, i, j) !== OPEN) {
      const free = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [i + dx, j + dy]).find(([x, y]) => at(this.grid, x, y) === OPEN);
      if (free) [i, j] = free;
    }
    b.state = 'still'; b.cx = i; b.cy = j; b.x = i * CELL; b.y = j * CELL;
    if (at(this.grid, i, j) === OPEN) this.grid[cell(i, j)] = BOMB;
  }
  kick(i, j, dir) { // only a bomb that can move: one exploding or up against something stays put
    const b = this.stillBombAt(i, j), [dx, dy] = STEP[dir];
    if (!b || b.count >= FUSE || !open(this.grid, i + dx, j + dy)) return;
    b.state = 'slide'; b.dir = dir; this.grid[cell(i, j)] = OPEN;
    this.events.push({ type: 'kick', x: b.x, y: b.y });
  }

  // One bomb tick, ported. Carried and flying bombs don't count down. A thrown bomb flies 9
  // ticks at 10/tick, wrapping round the board, and keeps going two ticks at a time until it
  // can land on a free cell. A kicked bomb slides at 10/tick until something blocks it.
  updateBomb(b, fighters) {
    if (b.chained === this.tick) return; // set off by another bomb this tick: goes off next tick
    b.count++;
    if (b.count < FUSE) {
      const gx = near(b.x), gy = near(b.y);
      if (b.state === 'held') {
        b.count--;
        const c = this.players.get(b.carrier);
        if (c) { b.x = c.x; b.y = c.y; }
      } else if (b.state === 'fly') {
        b.count--;
        if (b.flight <= FLY_TICKS) {
          const [dx, dy] = STEP[b.dir];
          b.x += dx * FLY; b.y += dy * FLY;
          if (b.y < -10) b.y = 360; else if (b.y > 360) b.y = -10;  // the original's wrap edges
          if (b.x < -20) b.x = 430; else if (b.x > 430) b.x = -20;
          if (++b.flight === FLY_TICKS) {
            if (this.landable(gx, gy)) { b.x = gx * CELL; b.y = gy * CELL; this.settle(b); this.events.push({ type: 'land', x: b.x, y: b.y }); return; }
            b.flight = FLY_TICKS - 2;
          }
        }
      } else if (b.state === 'still') {
        b.x = gx * CELL; b.y = gy * CELL; this.grid[cell(gx, gy)] = BOMB;
      } else { // sliding
        const [dx, dy] = STEP[b.dir];
        const along = dx ? b.x % CELL : b.y % CELL, across = dx ? b.y % CELL : b.x % CELL;
        if ((open(this.grid, gx + dx, gy + dy) || along !== 0) && across === 0) {
          b.x += dx * SLIDE; b.y += dy * SLIDE;
          this.powerups.delete(cell(near(b.x), near(b.y))); // a sliding bomb crushes powerups
          b.cx = near(b.x); b.cy = near(b.y);
        } else this.settle(b);
        return this.afterFuse(b, fighters);
      }
      b.cx = gx; b.cy = gy;
    }
    this.afterFuse(b, fighters);
  }
  afterFuse(b, fighters) {
    if (b.count < FUSE) return;
    for (const p of fighters) if (p.alive && touches(BOX.bomb, b.x, b.y, p)) this.hit(p);
    if (b.count === FUSE) this.explode(b);
    if (b.count === FUSE + FLAME) this.removeBomb(b);
  }
  landable(i, j) { return at(this.grid, i, j) === OPEN && !this.powerups.has(cell(i, j)) && !this.floor.some(f => f.i === i && f.j === j); }
  removeBomb(b) {
    const owner = this.players.get(b.owner); // the layer gets the bomb back
    if (owner?.fighting) owner.laid = Math.max(0, owner.laid - 1);
    if (at(this.grid, b.cx, b.cy) === BOMB && !this.bombs.some(o => o !== b && o.state === 'still' && o.cx === b.cx && o.cy === b.cy)) this.grid[cell(b.cx, b.cy)] = OPEN;
    this.bombs.splice(this.bombs.indexOf(b), 1);
  }

  // Flames go `length` cells each way. Open cells (and powerups) let them through; a crate
  // stops them and starts burning; a wall stops them; another bomb goes off next tick.
  explode(b) {
    if (b.state === 'held') { const c = this.players.get(b.carrier); if (c) { c.glove = 1; c.carrying = 0; } }
    b.state = 'still';
    this.events.push({ type: 'boom', x: b.x, y: b.y });
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = STEP[dir];
      for (let n = 1; n <= b.length; n++) {
        const i = b.cx + dx * n, j = b.cy + dy * n, v = at(this.grid, i, j), x = b.x + dx * CELL * n, y = b.y + dy * CELL * n;
        if (!(v > 0)) { this.flames.push({ i, j, x, y, dir, end: n === b.length, life: FLAME, spent: false }); continue; }
        if (v === CRATE) {
          this.flames.push({ i, j, x, y, dir, end: true, life: FLAME, spent: false });
          if (!this.burning.has(cell(i, j))) { this.burning.set(cell(i, j), -1); this.events.push({ type: 'crate', x, y }); }
        } else if (v === BOMB) {
          const o = this.stillBombAt(i, j);
          if (o && o.count < FUSE - 1) { o.count = FUSE - 1; o.chained = this.tick; }
        }
        break;
      }
    }
  }

  // A flame arm is used up by its first hit (as in the original) but hits everyone in it on
  // that tick. Flames on fire-line track light the whole track.
  updateFlames(fighters) {
    for (const f of this.flames) {
      if (this.floor.some(t => t.kind === 'fire' && t.i === f.i && t.j === f.j)) this.fireOn = true;
      if (!f.spent) {
        const caught = fighters.filter(p => p.alive && touches(f.dir <= 2 ? BOX.armV : BOX.armH, f.x, f.y, p));
        if (caught.length) { f.spent = true; for (const p of caught) this.hit(p); }
      }
      f.life--;
    }
    this.flames = this.flames.filter(f => f.life > 0);
  }

  // A hit costs a life and gives 75 ticks of (blinking) invincibility; no lives = out.
  hit(p) {
    if (!p.alive || p.inv > 0) return;
    p.lives--; p.inv = INVINCIBLE;
    this.events.push({ type: 'hit', id: p.id, lives: p.lives, x: p.x, y: p.y });
    if (p.lives > 0) return;
    p.alive = false; this.dropCarried(p);
    this.events.push({ type: 'out', id: p.id, x: p.x, y: p.y });
  }

  // A burnt crate rolls a type (glove is rerolled 1 time in 5), then drops it half the time if
  // the heat's pool still has one.
  dropPowerup(c) {
    let t = Math.floor(this.rand() * 5);
    if (t === 4 && Math.floor(this.rand() * 5) === 2) t = Math.floor(this.rand() * 4);
    if (Math.floor(this.rand() * 2) === 1 && this.pool[t] > 0) { this.powerups.set(c, t); this.pool[t]--; }
  }
  collect(p) { // only exactly on the cell centre
    if (!p.alive || p.x % CELL !== 0 || p.y % CELL !== 0) return;
    const c = cell(p.x / CELL, p.y / CELL), t = this.powerups.get(c);
    if (t === undefined) return;
    this.powerups.delete(c);
    if (t === 0) p.length++;
    else if (t === 1) p.speed = Math.min(SPEEDS.length - 1, p.speed + 1);
    else if (t === 2) p.bombs++;
    else if (t === 3) p.kick = true;
    else if (p.glove === -1) p.glove = 1;
    this.events.push({ type: 'powerup', id: p.id, kind: POWERUPS[t], x: p.x, y: p.y });
  }

  // Teleporter pads (24 ticks before you can teleport again) and fire-line track.
  updateFloor(fighters) {
    for (const t of this.floor) {
      if (t.kind !== 'pad') continue;
      for (const p of fighters) {
        if (!p.alive || p.padWait > 0 || !touches(BOX.pad, t.i * CELL, t.j * CELL, p)) continue;
        p.padWait = TELEPORT_WAIT; p.x = t.to[0] * CELL; p.y = t.to[1] * CELL;
        this.events.push({ type: 'teleport', id: p.id, x: p.x, y: p.y });
      }
    }
    if (!this.fireOn) return;
    if (this.fireTicks === 0) this.events.push({ type: 'fire' });
    for (const t of this.floor) {
      if (t.kind !== 'fire' || t.spent) continue;
      const caught = fighters.filter(p => p.alive && touches(BOX.fire, t.i * CELL, t.j * CELL, p));
      if (caught.length) { t.spent = true; for (const p of caught) this.hit(p); } // once per tile per burn
    }
    if (++this.fireTicks >= FIRE_TICKS) { this.fireOn = false; this.fireTicks = 0; for (const t of this.floor) t.spent = false; }
  }

  // The last 40 seconds: a wall every 8 ticks, spiralling in from the outer ring (80 at most).
  // A player under it loses a life; bombs and powerups under it are crushed.
  suddenDeath(fighters) {
    const w = this.walls;
    if (w.count >= WALL_MAX || ++w.slow % WALL_EVERY !== 0) return;
    advanceSpiral(w);
    const c = cell(w.x, w.y);
    this.grid[c] = WALL; this.burning.delete(c); this.powerups.delete(c);
    for (const b of [...this.bombs]) if (b.cx === w.x && b.cy === w.y && (b.state === 'still' || b.state === 'slide')) this.removeBomb(b);
    for (const p of fighters) if (p.alive && near(p.x) === w.x && near(p.y) === w.y) this.hit(p);
    w.count++;
    this.events.push({ type: 'wall', i: w.x, j: w.y });
  }

  // ---- what the browser needs (rows keep it small; field order is decoded in client.js)
  snapshot() {
    return {
      t: 's', tick: this.tick, phase: this.phase, timer: this.timer, heat: this.heat, arena: this.arena, layout: this.layout,
      clock: this.secondsLeft(), winner: this.winner, matchWinner: this.matchWinner, fire: this.fireOn ? 1 : 0,
      grid: this.grid.join(''),
      players: [...this.players.values()].map(p => [p.id, p.x, p.y, p.dir, p.alive ? 1 : 0, p.fighting ? 1 : 0, p.lives, p.inv > 0 ? 1 : 0,
        p.speed ?? 2, p.length ?? 2, p.bombs ?? 1, p.laid ?? 0, p.kick ? 1 : 0, p.glove ?? -1, p.button ? 1 : 0, p.carrying ? 1 : 0,
        p.name, p.color, p.bot ? 1 : 0, p.slot, p.wins, p.points]),
      bombs: this.bombs.map(b => [b.id, b.x, b.y, b.count, b.state[0], b.owner]),
      flames: this.flames.map(f => [f.x, f.y, f.dir, f.end ? 1 : 0, f.life]),
      burning: [...this.burning],
      powerups: [...this.powerups],
    };
  }
  floorMsg() { return { t: 'floor', layout: this.layout, floor: this.floor.map(({ kind, i, j, pair }) => ({ kind, i, j, pair })) }; }
  drain() { const e = this.events; this.events = []; return e; }
}

export function advanceSpiral(w) { // the original's walk: right, down, left, up, then one ring in
  if (w.dir === 1) { if (++w.x > COLS - 2 - w.ring) w.dir = 2; }
  else if (w.dir === 2) { if (++w.y > ROWS - 2 - w.ring) w.dir = 3; }
  else if (w.dir === 3) { if (!(--w.x > w.ring)) w.dir = 4; }
  else if (!(--w.y > 1 + w.ring)) { w.dir = 1; w.ring++; }
}

// ---------------------------------------------------------------- prediction (browser)
// Your own ticks, predicted in the server's order: bomb button, then movement. Laying puts a
// bomb in the predicted grid (so you can't walk back onto it); picking up and kicking clear
// the cell. Where thrown or kicked bombs end up is left to the server. Bombs and burning
// crates vanish on a known tick, so those clear on time too. Returns a laid cell or null.
export class Prediction {
  constructor(snap, me) {
    this.grid = Array.from(snap.grid, Number);
    this.p = { x: me.x, y: me.y, dir: me.dir, speed: me.speed, kick: me.kick, laid: me.laid, bombs: me.bombs, glove: me.glove, button: me.button };
    this.clears = []; this.fuses = new Map(); // cell -> fuse count of the bomb resting there
    for (const b of snap.bombs) { // raw rows [id, x, y, count, state, owner] or decoded objects
      const [x, y, count, state, owner] = Array.isArray(b) ? b.slice(1) : [b.x, b.y, b.count, b.state, b.owner];
      if (count < FUSE + FLAME) this.clears.push([FUSE + FLAME - count, state === 's' ? cell(near(x), near(y)) : -1, owner === me.id]); // your bomb comes back then
      if (state === 's') this.fuses.set(cell(near(x), near(y)), count);
    }
    for (const [c, n] of snap.burning) this.clears.push([FLAME - n, c]);
    this.ticks = 0;
  }
  step(keys) {
    const g = this.grid, p = this.p;
    this.ticks++;
    this.clears = this.clears.filter(([after, c, mine]) => {
      if (after >= this.ticks) return true;
      if (c >= 0 && g[c] !== WALL) g[c] = OPEN;
      if (mine) p.laid = Math.max(0, p.laid - 1);
      return false;
    });
    let laid = null;
    const pressed = !!(keys & BOMB_KEY);
    if (pressed && !p.button) {
      const i = near(p.x), j = near(p.y);
      if (canLay(g, p)) { g[cell(i, j)] = BOMB; p.laid++; laid = [i, j]; }
      else if (p.glove === 1 && at(g, i, j) === BOMB) { g[cell(i, j)] = OPEN; p.glove = 0; }
    } else if (!pressed && p.button && p.glove === 0) p.glove = 1;
    p.button = pressed;
    // a kick clears the cell, unless that bomb is already exploding (the server refuses those);
    // its fuse count at this tick's movement is (count in the update) + (ticks since) - 1
    move(g, p, keys, (i, j, dir) => {
      const n = this.fuses.get(cell(i, j)), [dx, dy] = STEP[dir];
      if ((n === undefined || n + this.ticks - 1 < FUSE) && open(g, i + dx, j + dy)) g[cell(i, j)] = OPEN;
    });
    return laid;
  }
}

// ---------------------------------------------------------------- bots
// Short Fuse's own AI. Each tick it maps when every cell will burn (chain reactions included),
// runs to safety when threatened, bombs crates and rivals when it can still escape, and
// otherwise collects powerups, digs toward rivals and hunts them. From the original: a bot
// that hasn't bombed for 350 ticks drops one anyway.
export function dangerMap(g, extra) {
  const when = new Array(COLS * ROWS).fill(Infinity);
  const bombs = g.bombs.filter(b => b.state === 'still').map(b => ({ i: b.cx, j: b.cy, len: b.length, t: Math.max(0, FUSE - b.count) }));
  if (extra) bombs.push(extra);
  const reach = (b, fn) => {
    fn(b.i, b.j);
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = STEP[dir];
      for (let n = 1; n <= b.len; n++) {
        const i = b.i + dx * n, j = b.j + dy * n, v = at(g.grid, i, j);
        if (v === WALL || Number.isNaN(v)) break;
        fn(i, j);
        if (v > 0) break;
      }
    }
  };
  for (let pass = 0, changed = true; changed && pass < 8; pass++) { // chain reactions
    changed = false;
    for (const a of bombs) reach(a, (i, j) => { for (const o of bombs) if (o !== a && o.i === i && o.j === j && o.t > a.t + 1) { o.t = a.t + 1; changed = true; } });
  }
  for (const b of bombs) reach(b, (i, j) => { when[cell(i, j)] = Math.min(when[cell(i, j)], b.t); });
  for (const f of g.flames) when[cell(f.i, f.j)] = 0;
  if (g.fireOn) for (const t of g.floor) if (t.kind === 'fire') when[cell(t.i, t.j)] = 0;
  if (g.secondsLeft() <= SUDDEN_DEATH + 1) { const w = { ...g.walls }; for (let n = 0; n < 4; n++) { advanceSpiral(w); when[cell(w.x, w.y)] = 0; } }
  return when;
}

function botKeys(g, p) {
  const m = p.mind, rand = g.botRand, crazy = g.arena === 'madness';
  if (g.dangerTick !== g.tick) { g.danger = dangerMap(g); g.dangerTick = g.tick; }
  const danger = g.danger, perCell = CELL / SPEEDS[p.speed];
  const cx = near(p.x), cy = near(p.y), here = cell(cx, cy);
  m.idle = (m.idle ?? 0) + 1;
  const pads = new Set(g.floor.filter(f => f.kind === 'pad').map(f => cell(f.i, f.j)));
  const walkable = c => c === here || (g.grid[c] === OPEN && !pads.has(c)); // bots avoid teleporters
  const unsafe = (map, c, t) => map[c] !== Infinity && t >= map[c] - perCell - 2 && t <= map[c] + FLAME + 2;
  const search = (map = danger) => { // breadth-first, with arrival times
    const dist = new Map([[here, 0]]), prev = new Map(), order = [here];
    for (let k = 0; k < order.length; k++) {
      const c = order[k], i = Math.floor(c / ROWS), j = c % ROWS, d = dist.get(c) + 1;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const n = cell(i + dx, j + dy);
        if (i + dx < 0 || j + dy < 0 || i + dx >= COLS || j + dy >= ROWS || dist.has(n) || !walkable(n) || unsafe(map, n, d * perCell)) continue;
        dist.set(n, d); prev.set(n, c); order.push(n);
      }
    }
    return { dist, prev, order };
  };
  const firstStep = (prev, target) => { let c = target; while (prev.get(c) !== undefined && prev.get(c) !== here) c = prev.get(c); return c; };
  const toward = c => {
    const i = Math.floor(c / ROWS), j = c % ROWS;
    if (c === here) { const dx = cx * CELL - p.x, dy = cy * CELL - p.y; return dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : dy < 0 ? UP : 0; }
    return j < cy ? UP : j > cy ? DOWN : i < cx ? LEFT : RIGHT;
  };
  if (p.glove === 0) return 0; // let go of anything carried
  const s = search();
  if (danger[here] !== Infinity) { // 1. threatened: run to the nearest cell that never burns
    const safe = s.order.find(c => danger[c] === Infinity);
    return safe === undefined ? toward(here) : toward(firstStep(s.prev, safe));
  }
  const rivals = g.fighters().filter(q => q !== p && q.alive);
  const hits = () => { // would a bomb here hit a crate or a rival?
    for (const dir of [1, 2, 3, 4]) {
      const [dx, dy] = STEP[dir];
      for (let n = 1; n <= p.length; n++) {
        const i = cx + dx * n, j = cy + dy * n, v = at(g.grid, i, j);
        if (v === CRATE && !g.burning.has(cell(i, j))) return true;
        if (rivals.some(q => near(q.x) === i && near(q.y) === j)) return true;
        if (v > 0 || Number.isNaN(v)) break;
      }
    }
    return rivals.some(q => near(q.x) === cx && near(q.y) === cy);
  };
  if (!p.button && p.laid < p.bombs && g.grid[here] === OPEN && p.x % CELL === 0 && p.y % CELL === 0 && (hits() || m.idle > 350 || (crazy && rand() < 0.02))) {
    const after = dangerMap(g, { i: cx, j: cy, len: p.length, t: FUSE }), out = search(after); // 2. bomb, if there's a way out
    if (out.order.some(c => after[c] === Infinity && out.dist.get(c) * perCell < FUSE - 8)) { m.idle = 0; return BOMB_KEY; }
  }
  const pick = () => { // 3. somewhere useful
    const ok = s.order.filter(c => danger[c] === Infinity);
    const power = ok.find(c => g.powerups.has(c) && s.dist.get(c) <= 6);
    if (power !== undefined) return power;
    const line = new Set();
    for (const q of rivals) {
      const qi = near(q.x), qj = near(q.y); line.add(cell(qi, qj));
      for (const dir of [1, 2, 3, 4]) { const [dx, dy] = STEP[dir]; for (let n = 1; n <= p.length && !(at(g.grid, qi + dx * n, qj + dy * n) > 0); n++) line.add(cell(qi + dx * n, qj + dy * n)); }
    }
    const hunt = ok.find(c => line.has(c));
    if (hunt !== undefined && (s.dist.get(hunt) <= 8 || crazy)) return hunt;
    const dig = ok.find(c => { const i = Math.floor(c / ROWS), j = c % ROWS; return [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => at(g.grid, i + dx, j + dy) === CRATE && !g.burning.has(cell(i + dx, j + dy))); });
    if (dig !== undefined) return dig;
    if (!rivals.length || !ok.length) return ok[Math.floor(rand() * ok.length)];
    const r = rivals[p.slot % rivals.length], ri = near(r.x), rj = near(r.y);
    return ok.reduce((a, c) => (Math.abs(Math.floor(c / ROWS) - ri) + Math.abs(c % ROWS - rj) < Math.abs(Math.floor(a / ROWS) - ri) + Math.abs(a % ROWS - rj) ? c : a));
  };
  if (m.goal === undefined || m.goal === here || !s.dist.has(m.goal) || danger[m.goal] !== Infinity || g.tick % 48 === p.slot * 12) m.goal = pick();
  if (m.goal === undefined || m.goal === here) return toward(here);
  const next = firstStep(s.prev, m.goal);
  return unsafe(danger, next, perCell) ? 0 : toward(next);
}
