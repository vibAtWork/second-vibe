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
export const MAX_BULLETS = 1;      // original default setting: one cannon ball at a time
// Power-ups (crate weapons) - timings from the original's settings.
export const WEAPONS = ['laser', 'frag', 'gatling', 'homing']; // the original's default crate set
export const WEAPON_CODE = { bullet: 0, laser: 1, frag: 2, gatling: 3, homing: 4 };
export const CRATE_TIME_BASE = 350, CRATE_TIME_RANDOM = 200, CRATE_MAZE_SCALE = 2000, CRATE_MODIFIER = 0.1;
export const MAX_CRATES = 100;
export const CRATE_HALF = 0.15;      // crate half-size, in cells
export const LASER_SPEED = 70, LASER_SUBSTEPS = 70, LASER_LIFETIME = 8, LASER_SAFE_STEPS = 7;
export const AIMER_LENGTH = 200, AIMER_SUBSTEPS = 100, AIMER_SAFE_STEPS = 7;
export const FRAG_SPEED = 4.5, FRAG_SUBSTEPS = 7, FRAG_LIFETIME = 250, FRAG_SHARDS = 40, SHARD_LIFETIME = 20;
export const GATLING_SPEED = 5.5, GATLING_SUBSTEPS = 7, GATLING_LIFETIME = 125, GATLING_BULLETS = 20;
export const GATLING_SPIN = 10, GATLING_SAFE = 2, GATLING_SPREAD = 11;
export const HOMING_SPEED = 4.5, HOMING_SUBSTEPS = 5, HOMING_LIFETIME = 250, HOMING_STARTUP = 50, HOMING_TURN = 0.12;
export const PROJ_CODE = { bullet: 0, gatling: 1, frag: 2, shard: 3, homing: 4 };
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

// One sub-step of straight motion with the original's bounce rule:
// on entering a wall, step back, then probe with x-velocity flipped and with
// y-velocity flipped; flip whichever axis clears the wall (both if neither or
// both clear). Returns true if it bounced.
export function bounceStep(m, b) {
  const px = b.x, py = b.y;
  b.x += b.vx; b.y += b.vy;
  if (!wallAt(m, b.x, b.y)) return false;
  const hitXInv = wallAt(m, px - b.vx, py + b.vy);
  const hitYInv = wallAt(m, px + b.vx, py - b.vy);
  if (hitXInv && !hitYInv) b.vy = -b.vy;
  else if (hitYInv && !hitXInv) b.vx = -b.vx;
  else { b.vx = -b.vx; b.vy = -b.vy; }
  b.x = px + b.vx; b.y = py + b.vy;
  return true;
}

// Advance a plain projectile one frame. Returns number of wall bounces.
export function stepBullet(m, b, substeps = BULLET_SUBSTEPS) {
  let bounces = 0;
  for (let i = 0; i < substeps; i++) if (bounceStep(m, b)) bounces++;
  return bounces;
}

function muzzle(m, tank) {
  const a = (tank.rot - 90) * D2R;
  return { x: tank.x + Math.cos(a) * m.S * BULLET_SPAWN, y: tank.y + Math.sin(a) * m.S * BULLET_SPAWN, c: Math.cos(a), s: Math.sin(a) };
}

// Sight line shown while a tank holds the laser: a bouncing trace of
// AIMER_LENGTH px (at scale 50) that stops at the first tank it touches.
// Pure function of the maze and tank poses, so clients draw it locally.
export function traceAimer(m, tank, tanks) {
  const mz = muzzle(m, tank);
  const sp = AIMER_LENGTH / AIMER_SUBSTEPS * m.S / 50;
  const p = { x: mz.x, y: mz.y, vx: mz.c * sp, vy: mz.s * sp };
  const pts = [[p.x, p.y]];
  for (let j = 0; j < AIMER_SUBSTEPS; j++) {
    const bounced = bounceStep(m, p);
    if (bounced) pts.push([p.x - p.vx, p.y - p.vy]);
    if (j >= AIMER_SAFE_STEPS && j % 2 === 0) {
      for (const t of tanks) if (t.alive && pointInTank(m.S, t, p.x, p.y)) { pts.push([p.x, p.y]); return pts; }
    }
  }
  pts.push([p.x, p.y]);
  return pts;
}

// Cell index of a world point.
function cellOf(m, x, y) {
  return [Math.max(0, Math.min(m.W - 1, Math.floor(x / m.S))), Math.max(0, Math.min(m.H - 1, Math.floor(y / m.S)))];
}
// BFS distances (in cells) from (sx, sy) to every cell.
export function mazeDistances(m, sx, sy) {
  const d = new Int32Array(m.W * m.H).fill(-1);
  const q = [sx + sy * m.W];
  d[q[0]] = 0;
  for (let k = 0; k < q.length; k++) {
    const c = q[k], x = c % m.W, y = (c - x) / m.W;
    const go = (nx, ny, wall) => { const n = nx + ny * m.W; if (!wall && d[n] < 0) { d[n] = d[c] + 1; q.push(n); } };
    if (x > 0) go(x - 1, y, m.v[x][y]);
    if (x < m.W - 1) go(x + 1, y, m.v[x + 1][y]);
    if (y > 0) go(x, y - 1, m.h[x][y]);
    if (y < m.H - 1) go(x, y + 1, m.h[x][y + 1]);
  }
  return d;
}

// ---------------------------------------------------------------- Game
// A full round/world. Players are keyed by id; tanks exist only for players
// who were present at round start.
export class Game {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0, settings = {}) {
    this.settings = { maxBullets: MAX_BULLETS, weapons: WEAPONS, crates: true, ...settings };
    this.seedRng = rng(seed);
    this.rand = rng(seed ^ 0x51ed270b);
    this.tick = 0;
    this.players = new Map(); // id -> {id, name, color, score}
    this.tanks = new Map();   // id -> tank
    this.bullets = [];        // all moving projectiles: bullet, gatling, frag, shard, homing
    this.lasers = [];
    this.guns = [];           // active gatling guns
    this.crates = [];
    this.nextId = 1;
    this.events = [];
    this.round = 0;
    this.maze = null;
    this.frozen = 0;
    this.endCount = -1;
    this.crateTimer = 0;
  }

  addPlayer(id, name, color) {
    this.players.set(id, { id, name, color, score: 0 });
    // Start a fresh round when a second player arrives (or the first).
    if (this.players.size <= 2) this.newRound();
  }

  removePlayer(id) {
    this.players.delete(id);
    this.tanks.delete(id);
    this.guns = this.guns.filter(g => g.owner !== id);
    if (this.players.size === 0) { this.maze = null; this.tanks.clear(); this.bullets = []; this.lasers = []; this.crates = []; this.guns = []; }
  }

  newRound() {
    this.round++;
    const seed = (this.seedRng() * 2 ** 32) >>> 0;
    const m = generateMaze(seed);
    this.maze = m;
    this.bullets = []; this.lasers = []; this.guns = []; this.crates = [];
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
        alive: true, bulletsFired: 0, triggerReleased: true,
        weapon: 'bullet', laserReady: true, fragFired: false, lastFrag: null, gatlingReady: true, homingReady: true,
      });
    }
    this.frozen = FRAMES_FROZEN;
    this.endCount = -1;
    this.crateTimer = (CRATE_TIME_BASE + Math.floor(this.rand() * CRATE_TIME_RANDOM)) * CRATE_MODIFIER;
    this.events.push({ type: 'round', round: this.round });
  }

  // ------------------------------------------------ weapons
  locked(t) { return t.weapon === 'laser' && !t.laserReady; }

  weaponReady(t) {
    switch (t.weapon) {
      case 'laser': return t.laserReady;
      case 'frag': return true;
      case 'gatling': return t.gatlingReady;
      case 'homing': return t.homingReady;
      default: return t.bulletsFired < this.settings.maxBullets;
    }
  }

  fire(t) {
    const m = this.maze, S = m.S, mz = muzzle(m, t);
    const proj = (kind, speed, substeps, life, deadly) => {
      const sp = speed / substeps * S / 50;
      const b = { id: this.nextId++, kind, owner: t.id, x: mz.x, y: mz.y, vx: mz.c * sp, vy: mz.s * sp, substeps, life, deadly };
      this.bullets.push(b);
      return b;
    };
    switch (t.weapon) {
      case 'bullet':
        proj('bullet', BULLET_SPEED, BULLET_SUBSTEPS, BULLET_LIFETIME, 0);
        t.bulletsFired++;
        this.events.push({ type: 'fire', x: t.x, y: t.y });
        break;
      case 'laser': {
        const sp = LASER_SPEED / LASER_SUBSTEPS * S / 50;
        this.lasers.push({ id: this.nextId++, owner: t.id, x: mz.x, y: mz.y, vx: mz.c * sp, vy: mz.s * sp, life: LASER_LIFETIME, safe: LASER_SAFE_STEPS, trail: [] });
        t.laserReady = false;
        this.events.push({ type: 'laser', x: t.x, y: t.y });
        break;
      }
      case 'frag':
        if (t.fragFired) { if (t.lastFrag) this.detonate(t.lastFrag); }
        else {
          t.lastFrag = proj('frag', FRAG_SPEED, FRAG_SUBSTEPS, FRAG_LIFETIME, 0);
          t.fragFired = true;
          this.events.push({ type: 'fire', x: t.x, y: t.y });
        }
        break;
      case 'gatling':
        this.guns.push({ owner: t.id, active: true, spin: 0, counter: 0, left: GATLING_BULLETS });
        t.gatlingReady = false;
        this.events.push({ type: 'spin', id: t.id });
        break;
      case 'homing': {
        const b = proj('homing', HOMING_SPEED, HOMING_SUBSTEPS, HOMING_LIFETIME, 0);
        b.startup = HOMING_STARTUP; b.homing = false; b.target = null;
        t.homingReady = false;
        this.events.push({ type: 'missile', x: t.x, y: t.y });
        break;
      }
    }
  }

  setWeapon(t, w) { if (t) t.weapon = w; }

  detonate(b) {
    if (b.dead) return;
    b.dead = true;
    const o = this.tanks.get(b.owner);
    if (o) { o.fragFired = false; o.lastFrag = null; this.setWeapon(o, 'bullet'); }
    const S = this.maze.S;
    for (let i = 0; i < FRAG_SHARDS; i++) {
      const a = (Math.floor(this.rand() * 360) - 90) * D2R;
      const sp = (FRAG_SPEED - this.rand() * FRAG_SPEED + 4) / FRAG_SUBSTEPS * S / 50;
      this.bullets.push({ id: this.nextId++, kind: 'shard', owner: b.owner, x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, substeps: FRAG_SUBSTEPS, life: SHARD_LIFETIME, deadly: 0 });
    }
    this.events.push({ type: 'frag', x: b.x, y: b.y });
  }

  kill(t, killer) {
    if (!t.alive) return;
    t.alive = false;
    this.events.push({ type: 'boom', x: t.x, y: t.y, victim: t.id, killer });
  }

  tankAt(x, y) {
    for (const t of this.tanks.values()) if (t.alive && pointInTank(this.maze.S, t, x, y)) return t;
    return null;
  }

  stepGun(g) {
    const t = this.tanks.get(g.owner);
    if (!t || !t.alive) return false;
    if (g.active && t.triggerReleased) g.active = false;
    if (g.active) {
      if (g.spin < GATLING_SPIN) g.spin++;
      if (g.spin === GATLING_SPIN && ++g.counter % 3 === 0 && g.left > 0) {
        g.left--;
        const S = this.maze.S, mz = muzzle(this.maze, t);
        const a = (t.rot - 90 + this.rand() * GATLING_SPREAD - GATLING_SPREAD / 2) * D2R;
        const sp = GATLING_SPEED / GATLING_SUBSTEPS * S / 50;
        this.bullets.push({ id: this.nextId++, kind: 'gatling', owner: t.id, x: mz.x, y: mz.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, substeps: GATLING_SUBSTEPS, life: GATLING_LIFETIME, deadly: GATLING_SAFE });
        this.events.push({ type: 'gshot' });
      }
    } else {
      if (g.spin > 0) g.spin--;
      if (g.spin === 0) { t.gatlingReady = true; this.setWeapon(t, 'bullet'); return false; }
    }
    return true;
  }

  stepLaser(L) {
    const m = this.maze;
    L.trail = [[L.x, L.y]];
    for (let j = 0; j < LASER_SUBSTEPS; j++) {
      if (bounceStep(m, L)) L.trail.push([L.x - L.vx, L.y - L.vy]);
      if (L.safe > 0) L.safe--;
      if (L.safe === 0) {
        const hit = this.tankAt(L.x, L.y);
        if (hit) { this.kill(hit, L.owner); L.life = 1; break; }
      }
    }
    L.trail.push([L.x, L.y]);
    if (--L.life === 0) {
      const o = this.tanks.get(L.owner);
      if (o) { o.laserReady = true; this.setWeapon(o, 'bullet'); }
      return false;
    }
    return true;
  }

  // Homing missile guidance: nearest live tank by maze path (ties prefer
  // non-owners), aim at the next cell on the shortest path, nudge velocity
  // toward it each sub-step and cap speed.
  stepHoming(b) {
    const m = this.maze, S = m.S;
    let aim = null;
    if (b.homing) {
      const [cx, cy] = cellOf(m, b.x, b.y);
      const dist = mazeDistances(m, cx, cy);
      let best = 1e9, target = null;
      for (const t of this.tanks.values()) {
        if (!t.alive) continue;
        const [tx, ty] = cellOf(m, t.x, t.y);
        const d = dist[tx + ty * m.W];
        if (d < 0) continue;
        if (d < best || (d === best && t.id !== b.owner)) { best = d; target = t; }
      }
      if (!target) b.homing = false;
      else {
        if (b.target !== target.id) { b.target = target.id; this.events.push({ type: 'lock', id: target.id }); }
        if (best === 0) aim = { x: target.x, y: target.y };
        else {
          // step from our cell to the neighbour that is one closer to the target
          const [tx, ty] = cellOf(m, target.x, target.y);
          const back = mazeDistances(m, tx, ty);
          const here = back[cx + cy * m.W];
          const opts = [];
          if (cx > 0 && !m.v[cx][cy]) opts.push([cx - 1, cy]);
          if (cx < m.W - 1 && !m.v[cx + 1][cy]) opts.push([cx + 1, cy]);
          if (cy > 0 && !m.h[cx][cy]) opts.push([cx, cy - 1]);
          if (cy < m.H - 1 && !m.h[cx][cy + 1]) opts.push([cx, cy + 1]);
          const next = opts.find(([x, y]) => back[x + y * m.W] === here - 1) || [tx, ty];
          aim = cellCenter(m, next[0], next[1]);
        }
      }
    }
    const maxSp = HOMING_SPEED / HOMING_SUBSTEPS * S / 50, acc = HOMING_TURN / HOMING_SUBSTEPS;
    let bounces = 0;
    for (let i = 0; i < HOMING_SUBSTEPS; i++) {
      if (bounceStep(m, b)) bounces++;
      if (aim) {
        b.vx += aim.x - b.x < 0 ? -acc : acc;
        b.vy += aim.y - b.y < 0 ? -acc : acc;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > maxSp) { b.vx = b.vx / sp * maxSp; b.vy = b.vy / sp * maxSp; }
      }
    }
    return bounces;
  }

  // A shard stops for the rest of the frame when it touches a wall, so it
  // creeps through walls slowly while fading (life = 20 frames).
  stepShard(b) {
    for (let i = 0; i < b.substeps; i++) {
      b.x += b.vx; b.y += b.vy;
      if (wallAt(this.maze, b.x, b.y)) break;
    }
  }

  spawnCrate() {
    const m = this.maze;
    this.crateTimer = (CRATE_TIME_BASE + Math.floor(this.rand() * CRATE_TIME_RANDOM) + CRATE_MAZE_SCALE / (m.W * m.H)) * CRATE_MODIFIER;
    const ws = this.settings.weapons;
    if (!this.settings.crates || !ws.length || this.crates.length >= MAX_CRATES) return;
    for (let tries = 0; tries < 5; tries++) {
      const cx = Math.floor(this.rand() * m.W), cy = Math.floor(this.rand() * m.H);
      if (this.crates.some(c => c.cx === cx && c.cy === cy)) continue;
      const c = cellCenter(m, cx, cy);
      this.crates.push({ id: this.nextId++, cx, cy, x: c.x, y: c.y, rot: this.rand() * 90 - 45, weapon: ws[Math.floor(this.rand() * ws.length)] });
      this.events.push({ type: 'crate', x: c.x, y: c.y });
      return;
    }
  }

  checkCrates() {
    const S = this.maze.S;
    this.crates = this.crates.filter(c => {
      const a = c.rot * D2R, co = Math.cos(a), si = Math.sin(a), h = CRATE_HALF * S;
      const corners = [[-h, -h], [-h, h], [h, h], [h, -h]].map(([x, y]) => [c.x + x * co - y * si, c.y + x * si + y * co]);
      for (const t of this.tanks.values()) {
        if (!t.alive || t.weapon !== 'bullet') continue;
        const dx = t.x - c.x, dy = t.y - c.y;
        const lx = dx * co + dy * si, ly = -dx * si + dy * co; // tank centre in crate space
        if (corners.some(([x, y]) => pointInTank(S, t, x, y)) || (Math.abs(lx) <= h && Math.abs(ly) <= h)) {
          this.setWeapon(t, c.weapon);
          this.events.push({ type: 'pickup', id: t.id, weapon: c.weapon });
          return false;
        }
      }
      return true;
    });
  }

  // inputs: Map id -> input for this frame
  step(inputs) {
    this.tick++;
    if (!this.maze) return;
    if (this.frozen > 0) { this.frozen--; return; }
    const m = this.maze;

    for (const t of this.tanks.values()) {
      if (!t.alive || this.locked(t)) continue;
      const inp = inputs.get(t.id) || {};
      moveTank(m, t, inp);
      if (inp.fire) {
        if (t.triggerReleased && this.weaponReady(t)) { t.triggerReleased = false; this.fire(t); }
      } else t.triggerReleased = true;
    }

    this.checkCrates();
    this.guns = this.guns.filter(g => this.stepGun(g));
    this.lasers = this.lasers.filter(L => this.stepLaser(L));

    const survivors = [];
    for (const b of this.bullets) {
      if (b.dead) continue;
      if (b.kind === 'shard') this.stepShard(b);
      else if (b.kind === 'homing') { if (this.stepHoming(b)) this.events.push({ type: 'bounce' }); }
      else if (stepBullet(m, b, b.substeps)) this.events.push({ type: 'bounce' });
      let dead = false;
      if (b.deadly === 0) {
        const hit = this.tankAt(b.x, b.y);
        if (hit) {
          this.kill(hit, b.owner);
          dead = true;
          if (b.kind === 'frag') this.detonate(b);
        }
      } else b.deadly--;
      if (!dead && b.kind === 'frag') {
        const o = this.tanks.get(b.owner);
        if (!o || !o.alive) { this.detonate(b); dead = true; }
      }
      if (!dead && b.kind === 'homing' && b.startup > 0 && --b.startup === 0) b.homing = true;
      if (!dead && --b.life <= 0) {
        dead = true;
        if (b.kind === 'frag') this.detonate(b);
        else if (b.kind !== 'shard') this.events.push({ type: 'poof', x: b.x, y: b.y });
      }
      if (dead || b.dead) {
        b.dead = true;
        const o = this.tanks.get(b.owner);
        if (o && b.kind === 'bullet') o.bulletsFired--;
        if (o && b.kind === 'homing') { o.homingReady = true; this.setWeapon(o, 'bullet'); }
      } else survivors.push(b);
    }
    // shards created by detonations this frame
    for (const b of this.bullets) if (!b.dead && !survivors.includes(b)) survivors.push(b);
    this.bullets = survivors;

    if (--this.crateTimer <= 0) this.spawnCrate();

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

  // Compact network snapshot (shared by the Node server and the P2P host).
  snapshot() {
    const r2 = v => Math.round(v * 100) / 100;
    return {
      t: 's', tick: this.tick, frozen: this.frozen, end: this.endCount,
      tanks: [...this.tanks.values()].map(t => [t.id, r2(t.x), r2(t.y), Math.round(t.rot * 1000) / 1000, t.alive ? 1 : 0, t.triggerReleased ? 1 : 0, t.bulletsFired, WEAPON_CODE[t.weapon], this.locked(t) ? 1 : 0, t.weapon === 'laser' && t.laserReady ? 1 : 0]),
      bullets: this.bullets.map(b => [b.id, r2(b.x), r2(b.y), PROJ_CODE[b.kind], b.kind === 'shard' ? b.life : 0]),
      lasers: this.lasers.map(L => [L.id, L.owner, L.trail.flat().map(r2)]),
      crates: this.crates.map(c => [c.id, r2(c.x), r2(c.y), Math.round(c.rot), WEAPON_CODE[c.weapon]]),
      guns: this.guns.map(g => [g.owner, g.spin]),
      players: [...this.players.values()].map(p => [p.id, p.name, p.color, p.score]),
    };
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
