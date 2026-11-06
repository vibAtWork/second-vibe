// Shared, deterministic game simulation used by both the server (authoritative)
// and the browser (client-side prediction of your own tank).
//
// Timing and movement rules follow the classic Flash maze-tank game the owner
// supplied: 25 frames/s, 5 movement sub-steps per frame, 10 degrees of turn per
// frame, 4 px/frame forward and 2.5 px/frame reverse at a 50 px cell,
// 7 bounce sub-steps per frame for bullets, 250-frame bullet lifetime, and a
// limit on how many bullets each tank can have in play.
// All code, art and maze generation here is original.

export const FPS = 25;
export const FRAME_MS = 1000 / FPS;
export const VIEW_W = 692;           // logical canvas width
export const VIEW_H = 480;           // logical canvas height
export const BOTTOM_BAR = 80;        // scoreboard strip below the maze
export const MAZE_AREA_H = VIEW_H - BOTTOM_BAR;
export const WALL = 0.125;           // wall thickness, in cells

export const STEPS = 5;              // movement sub-steps per frame
export const TURN_SPEED = 10;        // degrees per frame
export const FORWARD = 4;            // px per frame at SCALE 50
export const BACKUP = 2.5;
export const BULLET_SPEED = 4.5;
export const BULLET_SUBSTEPS = 7;
export const BULLET_LIFETIME = 250;  // frames
export const BULLET_SPAWN = 4.5 / 16; // muzzle distance, in cells
export const MAX_BULLETS = 5;
export const MOUSE_DEADZONE = 60;    // px: mouse closer than this => stop
export const FRAMES_FROZEN = 50;     // freeze at round start
export const FRAMES_BEFORE_END = 125; // after only one tank remains

// Tank body, in cells (approximation of the original's proportions).
export const TANK_W = 0.32;
export const TANK_L = 0.40;

// ---------------------------------------------------------------- RNG
// Small seedable PRNG (mulberry32) so mazes can be reproduced from a seed.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- Maze
// v[i][j]: vertical wall on grid line x=i, spanning row j   (i: 0..W, j: 0..H-1)
// h[i][j]: horizontal wall on grid line y=j, spanning col i (i: 0..W-1, j: 0..H)
export function generateMaze(seed, opts = {}) {
  const r = rng(seed);
  const W = opts.W ?? 4 + Math.floor(r() * 9);  // 4..12 columns
  const H = opts.H ?? 4 + Math.floor(r() * 7);  // 4..10 rows
  const v = [], h = [];
  for (let i = 0; i <= W; i++) { v.push(new Array(H).fill(true)); }
  for (let i = 0; i < W; i++) { h.push(new Array(H + 1).fill(true)); }

  // Randomised depth-first carve -> every cell reachable.
  const seen = new Array(W * H).fill(false);
  const stack = [[Math.floor(r() * W), Math.floor(r() * H)]];
  seen[stack[0][1] * W + stack[0][0]] = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const nbrs = [];
    if (cx > 0 && !seen[cy * W + cx - 1]) nbrs.push([-1, 0]);
    if (cx < W - 1 && !seen[cy * W + cx + 1]) nbrs.push([1, 0]);
    if (cy > 0 && !seen[(cy - 1) * W + cx]) nbrs.push([0, -1]);
    if (cy < H - 1 && !seen[(cy + 1) * W + cx]) nbrs.push([0, 1]);
    if (!nbrs.length) { stack.pop(); continue; }
    const [dx, dy] = nbrs[Math.floor(r() * nbrs.length)];
    if (dx === -1) v[cx][cy] = false;
    if (dx === 1) v[cx + 1][cy] = false;
    if (dy === -1) h[cx][cy] = false;
    if (dy === 1) h[cx][cy + 1] = false;
    const nx = cx + dx, ny = cy + dy;
    seen[ny * W + nx] = true;
    stack.push([nx, ny]);
  }
  // Knock out extra interior walls to create loops (more open arenas).
  const extra = opts.openness ?? 0.3;
  for (let i = 1; i < W; i++) for (let j = 0; j < H; j++) if (v[i][j] && r() < extra) v[i][j] = false;
  for (let i = 0; i < W; i++) for (let j = 1; j < H; j++) if (h[i][j] && r() < extra) h[i][j] = false;

  const S = Math.min(VIEW_W / (W + WALL), MAZE_AREA_H / (H + WALL));
  return { seed, W, H, S, v, h, ox: (VIEW_W - S * (W + WALL)) / 2, oy: (MAZE_AREA_H - S * (H + WALL)) / 2 };
}

// Is world point (x, y) inside a wall? Maze coordinates: (0,0) is the top-left
// corner of the outer wall; every wall segment is a rectangle that starts on
// its grid line and is WALL*S thick, extended by the thickness at its end so
// corners are filled.
export function wallAt(m, x, y) {
  const S = m.S, t = WALL * S;
  if (x < 0 || y < 0 || x >= m.W * S + t || y >= m.H * S + t) return true;
  const i = Math.floor(x / S), j = Math.floor(y / S);
  const fx = x - i * S, fy = y - j * S;
  if (fx < t) { // inside vertical grid line i
    if (j < m.H && m.v[i][j]) return true;
    if (fy < t && j > 0 && m.v[i][j - 1]) return true;
  }
  if (fy < t) { // inside horizontal grid line j
    if (i < m.W && m.h[i][j]) return true;
    if (fx < t && i > 0 && m.h[i - 1][j]) return true;
  }
  return false;
}

export function cellCenter(m, cx, cy) {
  return { x: (cx + 0.5) * m.S + WALL * m.S / 2, y: (cy + 0.5) * m.S + WALL * m.S / 2 };
}

// ---------------------------------------------------------------- Tanks
const D2R = Math.PI / 180;
export function normRot(r) { // flash-style _rotation range (-180, 180]
  r = r % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

// Collision sample points in tank-local coordinates (y negative = front).
function tankPoints(S) {
  const w = TANK_W * S, l = TANK_L * S;
  const front = [[-w / 2, -l / 2], [-w / 4, -l / 2], [w / 4, -l / 2], [w / 2, -l / 2], [0, -BULLET_SPAWN * S]];
  const rear = [[-w / 2, l / 2], [-w / 4, l / 2], [w / 4, l / 2], [w / 2, l / 2]];
  const left = [[-w / 2, -l / 4], [-w / 2, 0], [-w / 2, l / 4]];
  const right = [[w / 2, -l / 4], [w / 2, 0], [w / 2, l / 4]];
  return { front, rear, sides: left.concat(right) };
}
const pointCache = new Map();
function pts(S) {
  let p = pointCache.get(S);
  if (!p) { p = tankPoints(S); pointCache.set(S, p); }
  return p;
}

function hitAny(m, list, x, y, rot) {
  const a = rot * D2R, c = Math.cos(a), s = Math.sin(a);
  for (const [px, py] of list) {
    if (wallAt(m, x + px * c - py * s, y + px * s + py * c)) return true;
  }
  return false;
}

export function tankHitsWall(m, x, y, rot) {
  const p = pts(m.S);
  return hitAny(m, p.front, x, y, rot) || hitAny(m, p.rear, x, y, rot) || hitAny(m, p.sides, x, y, rot);
}

// input: { f, b, l, r, fire, mouse?: { aim: {x, y} } }
// Mutates tank {x, y, rot}. Mirrors the original per-frame movement routine:
// try full move+turn in 5 sub-steps; on collision revert, then retry turn and
// move separately per sub-step; finally snap rotation to a 10-degree multiple.
export function moveTank(m, tank, input) {
  const S = m.S;
  const fwd = FORWARD * S / 50, back = BACKUP * S / 50;
  const p = pts(S);
  const oldX = tank.x, oldY = tank.y, oldRot = tank.rot;
  let forward = !!input.f, backup = !!input.b, left = !!input.l, right = !!input.r;
  const mouse = !!input.mouse;
  if (mouse) {
    const dx = input.mouse.x - tank.x, dy = input.mouse.y - tank.y;
    tank.rot = normRot(Math.atan2(dy, dx) / D2R + 90);
    forward = Math.hypot(dx, dy) > MOUSE_DEADZONE;
    backup = false; left = false; right = false;
  }
  let moveSize = 0, turnSize = 0;
  if (forward) moveSize = fwd / STEPS;
  if (backup) moveSize -= back / STEPS;
  if (left) turnSize = -TURN_SPEED / STEPS;
  if (right) turnSize += TURN_SPEED / STEPS;
  let hitSomething = false;

  let x = tank.x, y = tank.y, rot = tank.rot;
  for (let k = 0; k < STEPS; k++) {
    rot += turnSize;
    x += Math.cos((rot - 90) * D2R) * moveSize;
    y += Math.sin((rot - 90) * D2R) * moveSize;
  }
  rot = normRot(rot);
  if (tankHitsWall(m, x, y, rot)) {
    x = oldX; y = oldY; rot = oldRot;
    for (let k = 0; k < STEPS; k++) {
      if (!mouse) {
        const pr = rot;
        rot = normRot(rot + turnSize);
        if (tankHitsWall(m, x, y, rot)) { rot = pr; hitSomething = true; }
      }
      const px = x, py = y;
      x += Math.cos((rot - 90) * D2R) * moveSize;
      y += Math.sin((rot - 90) * D2R) * moveSize;
      if (moveSize > 0 && hitAny(m, p.front, x, y, rot)) { x = px; y = py; hitSomething = true; }
      else if (moveSize < 0 && hitAny(m, p.rear, x, y, rot)) { x = px; y = py; hitSomething = true; }
    }
  }
  const offset = ((360 + rot) % TURN_SPEED + TURN_SPEED) % TURN_SPEED;
  if (!hitSomething && turnSize !== 0 && offset !== 0) {
    rot = offset < TURN_SPEED / 2 ? rot - offset : rot + (TURN_SPEED - offset);
  }
  tank.x = x; tank.y = y; tank.rot = normRot(Math.round(rot * 1e6) / 1e6);
}

// Point-in-tank test (bullet centre vs tank body), used for hits.
export function pointInTank(S, tank, x, y) {
  const a = -tank.rot * D2R, c = Math.cos(a), s = Math.sin(a);
  const dx = x - tank.x, dy = y - tank.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= TANK_W * S / 2 && Math.abs(ly) <= TANK_L * S / 2;
}

// ---------------------------------------------------------------- Bullets
export function makeBullet(m, tank, id) {
  const S = m.S, a = (tank.rot - 90) * D2R;
  const sp = BULLET_SPEED / BULLET_SUBSTEPS * S / 50;
  return {
    id, owner: tank.id,
    x: tank.x + Math.cos(a) * S * BULLET_SPAWN,
    y: tank.y + Math.sin(a) * S * BULLET_SPAWN,
    vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
    life: BULLET_LIFETIME,
  };
}

// Advance one frame. Returns number of wall bounces (for sound).
// Bounce rule from the original: on entering a wall, step back, then probe
// with x-velocity flipped and with y-velocity flipped; flip whichever axis
// clears the wall (both if neither or both clear).
export function stepBullet(m, b) {
  let bounces = 0;
  for (let i = 0; i < BULLET_SUBSTEPS; i++) {
    const px = b.x, py = b.y;
    b.x += b.vx; b.y += b.vy;
    if (wallAt(m, b.x, b.y)) {
      bounces++;
      const hitXInv = wallAt(m, px - b.vx, py + b.vy);
      const hitYInv = wallAt(m, px + b.vx, py - b.vy);
      if (hitXInv && !hitYInv) b.vy = -b.vy;
      else if (hitYInv && !hitXInv) b.vx = -b.vx;
      else { b.vx = -b.vx; b.vy = -b.vy; }
      b.x = px + b.vx; b.y = py + b.vy;
    }
  }
  return bounces;
}

// ---------------------------------------------------------------- Game
// A full round/world. Players are keyed by id; tanks exist only for players
// who were present at round start.
export class Game {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0, settings = {}) {
    this.settings = { maxBullets: MAX_BULLETS, ...settings };
    this.seedRng = rng(seed);
    this.tick = 0;
    this.players = new Map(); // id -> {id, name, color, score}
    this.tanks = new Map();   // id -> tank
    this.bullets = [];
    this.nextBulletId = 1;
    this.events = [];
    this.round = 0;
    this.maze = null;
    this.frozen = 0;
    this.endCount = -1;
  }

  addPlayer(id, name, color) {
    this.players.set(id, { id, name, color, score: 0 });
    // Start a fresh round when a second player arrives (or the first).
    if (this.players.size <= 2) this.newRound();
  }

  removePlayer(id) {
    this.players.delete(id);
    this.tanks.delete(id);
    if (this.players.size === 0) { this.maze = null; this.tanks.clear(); this.bullets = []; }
  }

  newRound() {
    this.round++;
    const seed = (this.seedRng() * 2 ** 32) >>> 0;
    const m = generateMaze(seed);
    this.maze = m;
    this.bullets = [];
    this.tanks.clear();
    const r = rng(seed ^ 0x9e3779b9);
    const cells = [];
    for (let x = 0; x < m.W; x++) for (let y = 0; y < m.H; y++) cells.push([x, y]);
    for (let i = cells.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [cells[i], cells[k]] = [cells[k], cells[i]]; }
    let n = 0;
    for (const p of this.players.values()) {
      const [cx, cy] = cells[n++ % cells.length];
      const c = cellCenter(m, cx, cy);
      this.tanks.set(p.id, {
        id: p.id, x: c.x, y: c.y, rot: normRot(Math.floor(r() * 36) * 10),
        alive: true, bulletsFired: 0, triggerReleased: true, lastSeq: 0,
      });
    }
    this.frozen = FRAMES_FROZEN;
    this.endCount = -1;
    this.events.push({ type: 'round', round: this.round });
  }

  // inputs: Map id -> input for this frame
  step(inputs) {
    this.tick++;
    if (!this.maze) return;
    if (this.frozen > 0) { this.frozen--; return; }
    const m = this.maze;

    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      const inp = inputs.get(t.id) || {};
      moveTank(m, t, inp);
      if (inp.fire) {
        if (t.triggerReleased && t.bulletsFired < this.settings.maxBullets) {
          t.triggerReleased = false;
          this.bullets.push(makeBullet(m, t, this.nextBulletId++));
          t.bulletsFired++;
          this.events.push({ type: 'fire', x: t.x, y: t.y });
        }
      } else t.triggerReleased = true;
    }

    const survivors = [];
    for (const b of this.bullets) {
      const bounces = stepBullet(m, b);
      if (bounces) this.events.push({ type: 'bounce' });
      let dead = false;
      for (const t of this.tanks.values()) {
        if (t.alive && pointInTank(m.S, t, b.x, b.y)) {
          t.alive = false;
          dead = true;
          this.events.push({ type: 'boom', x: t.x, y: t.y, victim: t.id, killer: b.owner });
          break;
        }
      }
      if (!dead && --b.life <= 0) { dead = true; this.events.push({ type: 'poof', x: b.x, y: b.y }); }
      if (dead) {
        const o = this.tanks.get(b.owner);
        if (o) o.bulletsFired--;
      } else survivors.push(b);
    }
    this.bullets = survivors;

    // Round flow: with 2+ tanks, once <= 1 remains, count down then score.
    if (this.tanks.size >= 2) {
      const alive = [...this.tanks.values()].filter(t => t.alive);
      if (this.endCount < 0 && alive.length <= 1) this.endCount = FRAMES_BEFORE_END;
      if (this.endCount > 0 && --this.endCount === 0) {
        const winners = [...this.tanks.values()].filter(t => t.alive);
        if (winners.length === 1) {
          const p = this.players.get(winners[0].id);
          if (p) p.score++;
          this.events.push({ type: 'win', id: winners[0].id });
        } else this.events.push({ type: 'draw' });
        this.newRound();
      }
    } else if (this.tanks.size === 1 && this.players.size === 1) {
      // Solo practice: respawn after death.
      const t = [...this.tanks.values()][0];
      if (!t.alive) {
        if (this.endCount < 0) this.endCount = FRAMES_BEFORE_END;
        else if (--this.endCount === 0) this.newRound();
      }
    } else if (this.players.size >= 2 && this.tanks.size < 2) {
      this.newRound();
    }
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
