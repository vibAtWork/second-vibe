// Graveyard Shift - shared game simulation (server: authoritative; browser:
// predicts its own player's movement with movePlayer()).
// Original game in the top-down co-op survival-shooter genre: hold off waves of
// shamblers (melee) and hexers (ranged), unlock weapons on keys 1-0 by scoring,
// chain kills for a score multiplier. All code, art, numbers and maps are original.

export const TICK_HZ = 30;
export const FRAME_MS = 1000 / TICK_HZ;
export const TILE = 32;
export const MAP_W = 30, MAP_H = 20;               // tiles -> 960 x 640 px arena
export const WORLD_W = MAP_W * TILE, WORLD_H = MAP_H * TILE;
export const HUD_H = 64;
export const VIEW_W = WORLD_W, VIEW_H = WORLD_H + HUD_H;

export const PLAYER_R = 10;          // half-size of the player's collision box
export const PLAYER_SPEED = 3.4;     // px per tick
export const DIAG = 0.7071067811865476;
export const PLAYER_HP = 100;
export const ENEMY_R = 10;
export const REVIVE_TICKS = 60;      // stand next to a downed teammate for 2 s
export const MAX_ENEMIES = 80;

// Weapons, by key 1..0 (index 0..9). cd: ticks between shots; auto: hold to fire.
export const WEAPONS = [
  { key: '1', name: 'Pistol', unlock: 0, ammo: Infinity, grant: 0, cd: 9, auto: true, kind: 'gun', dmg: 22, range: 420, pellets: 1, spread: 1.5 },
  { key: '2', name: 'SMG', unlock: 500, ammo: 200, grant: 120, cd: 3, auto: true, kind: 'gun', dmg: 12, range: 380, pellets: 1, spread: 5 },
  { key: '3', name: 'Shotgun', unlock: 1500, ammo: 40, grant: 24, cd: 24, auto: true, kind: 'gun', dmg: 15, range: 230, pellets: 7, spread: 16 },
  { key: '4', name: 'Barrel', unlock: 3000, ammo: 10, grant: 5, cd: 12, auto: false, kind: 'place', obj: 'barrel' },
  { key: '5', name: 'Grenade', unlock: 5000, ammo: 15, grant: 8, cd: 18, auto: true, kind: 'throw' },
  { key: '6', name: 'Barricade', unlock: 7500, ammo: 10, grant: 6, cd: 12, auto: false, kind: 'place', obj: 'barricade' },
  { key: '7', name: 'Mine', unlock: 10000, ammo: 10, grant: 6, cd: 12, auto: false, kind: 'place', obj: 'mine' },
  { key: '8', name: 'Rocket', unlock: 14000, ammo: 16, grant: 8, cd: 24, auto: true, kind: 'rocket' },
  { key: '9', name: 'Charge', unlock: 19000, ammo: 9, grant: 6, cd: 10, auto: false, kind: 'charge' },
  { key: '0', name: 'Railgun', unlock: 25000, ammo: 12, grant: 6, cd: 36, auto: true, kind: 'rail', dmg: 120, range: 900 },
];
export const MAX_CHARGES = 3;        // the 4th press detonates all your charges
export const ENEMIES = {
  shambler: { hp: 36, speed: 1.7, points: 10, dmg: 8, attackCd: 24 },
  hexer: { hp: 70, speed: 1.5, points: 30, castCd: 75, castRange: 320 },
};
export const EXPLOSION = { barrel: [84, 90], grenade: [70, 75], mine: [64, 90], rocket: [70, 90], charge: [96, 120] }; // [radius, damage]
export const FRIENDLY_EXPLOSION = 0.3; // players take 30% from explosions
export const COMBO_TICKS = 60;        // kill again within 2 s to grow the multiplier
export const MAX_MULT = 10;

// ---------------------------------------------------------------- RNG
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- map
// tiles[y][x]: 1 = wall/obstacle. Four gates (2-tile gaps) in the outer wall are
// where enemies come in. The centre is kept clear for players; every gate is
// reachable from the centre.
export function generateMap(seed) {
  const r = rng(seed);
  for (let attempt = 0; ; attempt++) {
    const t = Array.from({ length: MAP_H }, (_, y) => Array.from({ length: MAP_W }, (_, x) => (x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1 ? 1 : 0)));
    const gates = [[MAP_W / 2 - 1, 0], [MAP_W / 2, 0], [MAP_W / 2 - 1, MAP_H - 1], [MAP_W / 2, MAP_H - 1], [0, MAP_H / 2 - 1], [0, MAP_H / 2], [MAP_W - 1, MAP_H / 2 - 1], [MAP_W - 1, MAP_H / 2]];
    for (const [x, y] of gates) t[y][x] = 0;
    const blocks = 14 + Math.floor(r() * 8);
    for (let i = 0; i < blocks; i++) {
      const w = 1 + Math.floor(r() * 3), h = 1 + Math.floor(r() * 2);
      const x = 2 + Math.floor(r() * (MAP_W - 4 - w)), y = 2 + Math.floor(r() * (MAP_H - 4 - h));
      const nearCentre = Math.abs(x + w / 2 - MAP_W / 2) < 5 && Math.abs(y + h / 2 - MAP_H / 2) < 4;
      if (nearCentre) continue;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) t[yy][xx] = 1;
    }
    const dist = flowField(t, [[MAP_W / 2, MAP_H / 2]]);
    if (gates.every(([x, y]) => dist[y][x] >= 0) || attempt > 50) {
      // enemy entry points: the middle of each 2-tile gate, inside the map
      const spawns = [[MAP_W / 2 * TILE, TILE / 2], [MAP_W / 2 * TILE, WORLD_H - TILE / 2], [TILE / 2, MAP_H / 2 * TILE], [WORLD_W - TILE / 2, MAP_H / 2 * TILE]];
      return { seed, tiles: t, spawns };
    }
  }
}

// BFS distance (in tiles, 4-neighbour) from the given tiles; -1 = unreachable.
export function flowField(tiles, sources) {
  const d = tiles.map(row => row.map(() => -1));
  const q = [];
  for (const [x, y] of sources) if (tiles[y]?.[x] === 0 && d[y][x] < 0) { d[y][x] = 0; q.push([x, y]); }
  for (let k = 0; k < q.length; k++) {
    const [x, y] = q[k];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (ny >= 0 && ny < MAP_H && nx >= 0 && nx < MAP_W && tiles[ny][nx] === 0 && d[ny][nx] < 0) { d[ny][nx] = d[y][x] + 1; q.push([nx, ny]); }
    }
  }
  return d;
}

const tileAt = (map, x, y) => {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return 1;
  return map.tiles[ty][tx];
};

// Does a box (centre x,y, half-size r) overlap a wall tile or a blocking object?
export function blocked(map, objects, x, y, r) {
  for (const [cx, cy] of [[x - r, y - r], [x + r - 0.001, y - r], [x - r, y + r - 0.001], [x + r - 0.001, y + r - 0.001]]) {
    if (tileAt(map, cx, cy)) return true;
  }
  for (const o of objects) {
    if (o.kind !== 'barrel' && o.kind !== 'barricade') continue;
    if (Math.abs(o.x - x) < r + TILE / 2 && Math.abs(o.y - y) < r + TILE / 2) return true;
  }
  return false;
}

// bits: 1 up, 2 down, 4 left, 8 right, 16 fire. Mutates p.x, p.y, p.fx, p.fy.
// Pure arithmetic only, so the browser's prediction matches the server exactly.
export function movePlayer(map, objects, p, bits) {
  let dx = ((bits & 8) ? 1 : 0) - ((bits & 4) ? 1 : 0);
  let dy = ((bits & 2) ? 1 : 0) - ((bits & 1) ? 1 : 0);
  if (!dx && !dy) return;
  p.fx = dx; p.fy = dy; // face where you walk
  const s = dx && dy ? PLAYER_SPEED * DIAG : PLAYER_SPEED;
  const nx = p.x + dx * s;
  if (!blocked(map, objects, nx, p.y, PLAYER_R)) p.x = nx;
  const ny = p.y + dy * s;
  if (!blocked(map, objects, p.x, ny, PLAYER_R)) p.y = ny;
}

// Distance along a ray until it hits a wall tile (stepping in small increments).
function wallDistance(map, x, y, ux, uy, max) {
  for (let d = 0; d < max; d += 4) if (tileAt(map, x + ux * d, y + uy * d)) return d;
  return max;
}

// Ray vs circle: distance along the ray to the circle, or Infinity.
function rayCircle(x, y, ux, uy, cx, cy, r) {
  const ox = cx - x, oy = cy - y, t = ox * ux + oy * uy;
  if (t < 0) return Infinity;
  const d2 = ox * ox + oy * oy - t * t;
  return d2 > r * r ? Infinity : t - Math.sqrt(r * r - d2);
}

// ---------------------------------------------------------------- game
export class Game {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.rand = rng(seed ^ 0x2545F491);
    this.seedRng = rng(seed);
    this.tick = 0;
    this.nextId = 1;
    this.players = new Map();
    this.enemies = [];
    this.shots = [];      // rockets, grenades, fireballs
    this.objects = [];    // barrels, barricades, mines, charges
    this.pickups = [];
    this.events = [];
    this.pendingBlasts = [];
    this.newMap();
  }

  newMap() {
    this.map = generateMap((this.seedRng() * 2 ** 32) >>> 0);
    this.wave = 0;
    this.phase = 'break';          // 'break' (between waves) | 'wave' | 'over'
    this.phaseTimer = 90;
    this.toSpawn = [];
    this.enemies = []; this.shots = []; this.objects = []; this.pickups = [];
    this.field = null;
  }

  spawnPoint(i) {
    const x = WORLD_W / 2 + (i % 2 ? 1 : -1) * 20 * Math.ceil(i / 2), y = WORLD_H / 2 + (i % 4 > 1 ? 20 : -20);
    return [Math.max(TILE * 2, Math.min(WORLD_W - TILE * 2, x)), y];
  }

  addPlayer(id, name, color) {
    const p = { id, name, color, score: 0, mult: 1, multTimer: 0, ammo: WEAPONS.map(w => (w.unlock === 0 ? w.ammo : 0)), unlocked: 1, weapon: 0, cd: 0, held: false, revive: 0, kills: 0 };
    this.players.set(id, p);
    this.respawn(p, this.players.size - 1);
    this.events.push({ type: 'join', id, name });
  }

  respawn(p, i = 0) {
    const [x, y] = this.spawnPoint(i);
    Object.assign(p, { x, y, fx: 0, fy: -1, hp: PLAYER_HP, alive: true, revive: 0 });
  }

  removePlayer(id) {
    this.players.delete(id);
    for (const o of this.objects) if (o.owner === id && o.kind === 'charge') o.dead = true;
    this.objects = this.objects.filter(o => !o.dead);
    if (this.players.size === 0) this.newMap();
  }

  // ------------------------------------------------ waves
  startWave() {
    this.wave++;
    this.phase = 'wave';
    const n = this.wave, list = [];
    for (let i = 0; i < 8 + n * 5; i++) list.push('shambler');
    for (let i = 0; i < Math.max(0, n - 1) * 2; i++) list.splice(Math.floor(this.rand() * list.length), 0, 'hexer');
    this.toSpawn = list;
    this.spawnTimer = 0;
    for (const [i, p] of [...this.players.values()].entries()) if (!p.alive) { this.respawn(p, i); p.hp = PLAYER_HP / 2; }
    this.events.push({ type: 'wave', wave: n, count: list.length });
  }

  spawnEnemy(kind) {
    const s = this.map.spawns[Math.floor(this.rand() * this.map.spawns.length)];
    const base = ENEMIES[kind], scale = 1 + (this.wave - 1) * 0.06;
    this.enemies.push({
      id: this.nextId++, kind, x: s[0] + (this.rand() - 0.5) * 8, y: s[1] + (this.rand() - 0.5) * 8,
      hp: Math.round(base.hp * scale), maxHp: Math.round(base.hp * scale),
      speed: Math.min(3, base.speed + this.rand() * 0.7 + this.wave * 0.04), cd: 30,
    });
  }

  // ------------------------------------------------ combat helpers
  awardKill(e, playerId) {
    const p = this.players.get(playerId);
    this.events.push({ type: 'kill', id: e.id, kind: e.kind, x: e.x, y: e.y, by: playerId });
    const r = this.rand();
    if (r < 0.05) this.pickups.push({ id: this.nextId++, kind: 'health', x: e.x, y: e.y, ttl: 450 });
    else if (r < 0.14) this.pickups.push({ id: this.nextId++, kind: 'ammo', x: e.x, y: e.y, ttl: 450 });
    if (!p) return;
    p.mult = p.multTimer > 0 ? Math.min(MAX_MULT, p.mult + 1) : 1;
    p.multTimer = COMBO_TICKS;
    p.kills++;
    p.score += ENEMIES[e.kind].points * p.mult;
    while (p.unlocked < WEAPONS.length && p.score >= WEAPONS[p.unlocked].unlock) {
      const w = WEAPONS[p.unlocked];
      p.ammo[p.unlocked] = w.grant;
      p.unlocked++;
      this.events.push({ type: 'unlock', id: p.id, weapon: p.unlocked - 1, text: `New weapon: ${w.name} (key ${w.key})` });
    }
  }

  damageEnemy(e, dmg, by) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    if (e.hp <= 0) this.awardKill(e, by);
  }

  hurtPlayer(p, dmg) {
    if (!p.alive) return;
    p.hp -= dmg;
    this.events.push({ type: 'hurt', id: p.id });
    if (p.hp <= 0) { p.hp = 0; p.alive = false; this.events.push({ type: 'down', id: p.id, x: p.x, y: p.y }); }
  }

  explode(x, y, kind, by) {
    const [r, dmg] = EXPLOSION[kind];
    this.events.push({ type: 'boom', x, y, r });
    for (const e of this.enemies) if (Math.hypot(e.x - x, e.y - y) < r + ENEMY_R) this.damageEnemy(e, dmg, by);
    for (const p of this.players.values()) if (Math.hypot(p.x - x, p.y - y) < r) this.hurtPlayer(p, dmg * FRIENDLY_EXPLOSION);
    for (const o of this.objects) {
      if (o.dead || Math.hypot(o.x - x, o.y - y) >= r + TILE / 2) continue;
      if (o.kind === 'barricade') { o.hp -= dmg; if (o.hp <= 0) o.dead = true; }
      else { o.dead = true; this.pendingBlasts.push([o.x, o.y, o.kind, o.owner ?? by]); } // chain reaction next tick
    }
  }

  // Hitscan: first enemy or barrel along the ray (railgun pierces enemies).
  hitscan(p, angle, w) {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const sx = p.x + ux * 12, sy = p.y + uy * 12;
    const wall = wallDistance(this.map, sx, sy, ux, uy, w.range);
    let end = wall;
    if (w.kind === 'rail') {
      for (const e of this.enemies) if (rayCircle(sx, sy, ux, uy, e.x, e.y, ENEMY_R) < wall) this.damageEnemy(e, w.dmg, p.id);
    } else {
      let best = null, bt = wall;
      for (const e of this.enemies) { if (e.hp <= 0) continue; const t = rayCircle(sx, sy, ux, uy, e.x, e.y, ENEMY_R); if (t < bt) { bt = t; best = e; } }
      for (const o of this.objects) {
        if (o.dead || (o.kind !== 'barrel' && o.kind !== 'barricade')) continue;
        const t = rayCircle(sx, sy, ux, uy, o.x, o.y, TILE / 2);
        if (t < bt) { bt = t; best = o; }
      }
      end = bt;
      if (best?.kind === 'barrel') { best.dead = true; this.explode(best.x, best.y, 'barrel', p.id); }
      else if (best && best.kind !== 'barricade') this.damageEnemy(best, w.dmg, p.id);
    }
    this.events.push({ type: 'tracer', x1: sx, y1: sy, x2: sx + ux * end, y2: sy + uy * end, rail: w.kind === 'rail' ? 1 : 0 });
  }

  // Place an object on the tile in front of the player (if free).
  place(p, kind) {
    const tx = Math.floor((p.x + p.fx * TILE) / TILE), ty = Math.floor((p.y + p.fy * TILE) / TILE);
    const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
    if (tileAt(this.map, x, y)) return false;
    if (this.objects.some(o => !o.dead && Math.abs(o.x - x) < TILE && Math.abs(o.y - y) < TILE)) return false;
    const solid = kind === 'barrel' || kind === 'barricade';
    if (solid && ([...this.players.values()].some(q => q.alive && Math.abs(q.x - x) < PLAYER_R + TILE / 2 && Math.abs(q.y - y) < PLAYER_R + TILE / 2)
      || this.enemies.some(e => Math.abs(e.x - x) < ENEMY_R + TILE / 2 && Math.abs(e.y - y) < ENEMY_R + TILE / 2))) return false;
    this.objects.push({ id: this.nextId++, kind, x, y, hp: kind === 'barricade' ? 160 : 1, owner: p.id });
    this.events.push({ type: 'place', kind, x, y });
    return true;
  }

  fire(p) {
    const w = WEAPONS[p.weapon];
    const facing = Math.atan2(p.fy, p.fx);
    let used = true;
    if (w.kind === 'gun' || w.kind === 'rail') {
      for (let i = 0; i < (w.pellets || 1); i++) this.hitscan(p, facing + (this.rand() - 0.5) * 2 * (w.spread || 0) * Math.PI / 180, w);
      this.events.push({ type: 'shot', weapon: p.weapon, x: p.x, y: p.y });
    } else if (w.kind === 'place') used = this.place(p, w.obj);
    else if (w.kind === 'charge') {
      const mine = this.objects.filter(o => o.kind === 'charge' && o.owner === p.id && !o.dead);
      if (mine.length >= MAX_CHARGES || p.ammo[p.weapon] <= 0) { // detonate all
        for (const o of mine) { o.dead = true; this.pendingBlasts.push([o.x, o.y, 'charge', p.id]); }
        used = false;
      } else used = this.place(p, 'charge');
    } else { // projectile
      const sp = w.kind === 'rocket' ? 11 : 7, ux = Math.cos(facing), uy = Math.sin(facing);
      this.shots.push({ id: this.nextId++, kind: w.kind === 'rocket' ? 'rocket' : 'grenade', x: p.x + ux * 12, y: p.y + uy * 12, vx: ux * sp, vy: uy * sp, owner: p.id, fuse: w.kind === 'rocket' ? 90 : 36 });
      this.events.push({ type: w.kind === 'rocket' ? 'rocketfire' : 'throw', x: p.x, y: p.y });
    }
    if (used && Number.isFinite(p.ammo[p.weapon])) p.ammo[p.weapon]--;
    p.cd = w.cd;
    if (p.ammo[p.weapon] <= 0 && w.kind !== 'charge') p.weapon = 0; // out of ammo -> pistol
  }

  // ------------------------------------------------ step
  // inputs: Map id -> { bits, w } (w: weapon slot to select, or -1)
  step(inputs) {
    this.tick++;
    const players = [...this.players.values()];
    if (!players.length) return;

    for (const b of this.pendingBlasts.splice(0)) this.explode(...b);
    this.objects = this.objects.filter(o => !o.dead);

    // phases
    if (this.phase === 'break' && --this.phaseTimer <= 0) this.startWave();
    if (this.phase === 'over' && --this.phaseTimer <= 0) {
      for (const p of players) Object.assign(p, { score: 0, mult: 1, unlocked: 1, weapon: 0, ammo: WEAPONS.map(w => (w.unlock === 0 ? w.ammo : 0)), kills: 0 });
      this.newMap();
      players.forEach((p, i) => this.respawn(p, i));
      this.events.push({ type: 'restart' });
    }

    // players
    for (const p of players) {
      const inp = inputs.get(p.id) || { bits: 0, w: -1 };
      if (p.multTimer > 0 && --p.multTimer === 0) p.mult = 1;
      if (!p.alive) continue;
      if (inp.w >= 0 && inp.w < p.unlocked && (p.ammo[inp.w] > 0 || WEAPONS[inp.w].kind === 'charge')) p.weapon = inp.w;
      movePlayer(this.map, this.objects, p, inp.bits);
      if (p.cd > 0) p.cd--;
      const fire = !!(inp.bits & 16), w = WEAPONS[p.weapon];
      if (fire && p.cd === 0 && (w.auto || !p.held)) this.fire(p);
      p.held = fire;
      // pickups
      for (const k of this.pickups) {
        if (k.dead || Math.abs(k.x - p.x) > 18 || Math.abs(k.y - p.y) > 18) continue;
        if (k.kind === 'health') { if (p.hp >= PLAYER_HP) continue; p.hp = Math.min(PLAYER_HP, p.hp + 35); }
        else {
          const have = WEAPONS.map((w, i) => i).filter(i => i > 0 && i < p.unlocked);
          if (!have.length) continue;
          const i = have[Math.floor(this.rand() * have.length)];
          p.ammo[i] = Math.min(WEAPONS[i].ammo, p.ammo[i] + WEAPONS[i].grant);
        }
        k.dead = true;
        this.events.push({ type: 'pickup', id: p.id, kind: k.kind });
      }
    }
    // revive downed teammates by standing next to them
    for (const p of players) {
      if (p.alive) continue;
      const helper = players.some(q => q.alive && Math.abs(q.x - p.x) < 28 && Math.abs(q.y - p.y) < 28);
      p.revive = helper ? p.revive + 1 : 0;
      if (p.revive >= REVIVE_TICKS) { p.alive = true; p.hp = PLAYER_HP / 2; p.revive = 0; this.events.push({ type: 'revive', id: p.id }); }
    }
    this.pickups = this.pickups.filter(k => !k.dead && --k.ttl > 0);

    // spawning
    if (this.phase === 'wave' && this.toSpawn.length && --this.spawnTimer <= 0 && this.enemies.length < MAX_ENEMIES) {
      this.spawnEnemy(this.toSpawn.shift());
      this.spawnTimer = Math.max(6, 16 - this.wave);
    }

    // enemies: follow the flow field toward the nearest living player
    const alive = players.filter(p => p.alive);
    if (!this.field || this.tick % 10 === 0) {
      this.field = flowField(this.map.tiles, alive.map(p => [Math.floor(p.x / TILE), Math.floor(p.y / TILE)]));
    }
    for (const e of this.enemies) {
      if (e.hp <= 0 || !alive.length) continue;
      const target = alive.reduce((a, b) => (Math.hypot(b.x - e.x, b.y - e.y) < Math.hypot(a.x - e.x, a.y - e.y) ? b : a));
      const dist = Math.hypot(target.x - e.x, target.y - e.y);
      const def = ENEMIES[e.kind];
      if (e.cd > 0) e.cd--;
      // where to walk: straight at the target when close, else downhill on the flow field
      let gx = target.x, gy = target.y;
      const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
      if (dist > TILE * 1.5 && this.field[ty]?.[tx] > 0) {
        let best = this.field[ty][tx];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const v = this.field[ty + dy]?.[tx + dx];
          if (v >= 0 && v < best) { best = v; gx = (tx + dx) * TILE + TILE / 2; gy = (ty + dy) * TILE + TILE / 2; }
        }
      }
      const keepAway = e.kind === 'hexer' && dist < 140; // hexers keep their distance
      if (!keepAway) {
        const d = Math.hypot(gx - e.x, gy - e.y) || 1;
        const vx = (gx - e.x) / d * e.speed, vy = (gy - e.y) / d * e.speed;
        let moved = false; // only real progress counts (a zero step along a free axis isn't movement)
        if (Math.abs(vx) > 0.05 && !blocked(this.map, this.objects, e.x + vx, e.y, ENEMY_R)) { e.x += vx; moved = true; }
        if (Math.abs(vy) > 0.05 && !blocked(this.map, this.objects, e.x, e.y + vy, ENEMY_R)) { e.y += vy; moved = true; }
        if (!moved && e.cd === 0) { // stuck against a barricade or barrel: smash it
          const o = this.objects.find(o => (o.kind === 'barricade' || o.kind === 'barrel') && Math.abs(o.x - e.x) < TILE && Math.abs(o.y - e.y) < TILE);
          if (o) { o.hp -= 20; e.cd = 24; if (o.hp <= 0) { o.dead = true; if (o.kind === 'barrel') this.pendingBlasts.push([o.x, o.y, 'barrel', o.owner]); } }
        }
      }
      if (e.kind === 'shambler' && dist < PLAYER_R + ENEMY_R + 4 && e.cd === 0) { this.hurtPlayer(target, def.dmg); e.cd = def.attackCd; }
      if (e.kind === 'hexer' && dist < def.castRange && e.cd === 0 && wallDistance(this.map, e.x, e.y, (target.x - e.x) / dist, (target.y - e.y) / dist, dist) >= dist) {
        const sp = 5;
        this.shots.push({ id: this.nextId++, kind: 'fireball', x: e.x, y: e.y, vx: (target.x - e.x) / dist * sp, vy: (target.y - e.y) / dist * sp, owner: 0, fuse: 120 });
        e.cd = def.castCd;
        this.events.push({ type: 'cast', x: e.x, y: e.y });
      }
      // mines
      for (const o of this.objects) if (o.kind === 'mine' && !o.dead && Math.abs(o.x - e.x) < 20 && Math.abs(o.y - e.y) < 20) { o.dead = true; this.pendingBlasts.push([o.x, o.y, 'mine', o.owner]); }
    }
    // keep enemies from stacking on one spot
    for (let i = 0; i < this.enemies.length; i++) for (let j = i + 1; j < this.enemies.length; j++) {
      const a = this.enemies[i], b = this.enemies[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 < (ENEMY_R * 2) ** 2) {
        const d = Math.sqrt(d2), push = (ENEMY_R * 2 - d) / 2, ux = dx / d, uy = dy / d;
        if (!blocked(this.map, this.objects, a.x - ux * push, a.y - uy * push, ENEMY_R)) { a.x -= ux * push; a.y -= uy * push; }
        if (!blocked(this.map, this.objects, b.x + ux * push, b.y + uy * push, ENEMY_R)) { b.x += ux * push; b.y += uy * push; }
      }
    }
    this.enemies = this.enemies.filter(e => e.hp > 0);

    // projectiles
    for (const s of this.shots) {
      s.x += s.vx; s.y += s.vy;
      if (s.kind === 'grenade') { s.vx *= 0.94; s.vy *= 0.94; }
      const hitWall = tileAt(this.map, s.x, s.y) || this.objects.some(o => (o.kind === 'barricade' || o.kind === 'barrel') && Math.abs(o.x - s.x) < TILE / 2 && Math.abs(o.y - s.y) < TILE / 2);
      if (s.kind === 'fireball') {
        const p = alive.find(p => Math.abs(p.x - s.x) < PLAYER_R + 4 && Math.abs(p.y - s.y) < PLAYER_R + 4);
        if (p) this.hurtPlayer(p, 12);
        if (p || hitWall || --s.fuse <= 0) s.dead = true;
      } else if (s.kind === 'rocket') {
        const hit = this.enemies.some(e => Math.abs(e.x - s.x) < ENEMY_R + 4 && Math.abs(e.y - s.y) < ENEMY_R + 4);
        if (hit || hitWall || --s.fuse <= 0) { s.dead = true; this.explode(s.x - s.vx * 0.5, s.y - s.vy * 0.5, 'rocket', s.owner); }
      } else { // grenade: stops at walls, explodes when its fuse runs out
        if (hitWall) { s.x -= s.vx; s.y -= s.vy; s.vx = s.vy = 0; }
        if (--s.fuse <= 0) { s.dead = true; this.explode(s.x, s.y, 'grenade', s.owner); }
      }
    }
    this.shots = this.shots.filter(s => !s.dead);
    this.enemies = this.enemies.filter(e => e.hp > 0);

    // wave cleared / everyone down
    if (this.phase === 'wave' && !this.toSpawn.length && !this.enemies.length) {
      this.phase = 'break'; this.phaseTimer = 150;
      this.events.push({ type: 'cleared', wave: this.wave });
    }
    if (this.phase !== 'over' && players.every(p => !p.alive)) {
      this.phase = 'over'; this.phaseTimer = 150;
      this.events.push({ type: 'gameover', wave: this.wave, score: players.reduce((a, p) => a + p.score, 0) });
    }
  }

  // Network snapshot: compact arrays (field order documented in client.js).
  snapshot() {
    const r1 = v => Math.round(v * 10) / 10;
    return {
      t: 's', tick: this.tick, wave: this.wave, phase: this.phase, timer: this.phaseTimer, left: this.toSpawn.length + this.enemies.length,
      players: [...this.players.values()].map(p => [p.id, p.x, p.y, p.fx, p.fy, Math.ceil(p.hp), p.alive ? 1 : 0, p.weapon, p.score, p.mult, p.unlocked, p.ammo.map(a => (Number.isFinite(a) ? a : -1)), p.revive, p.name, p.color]),
      enemies: this.enemies.map(e => [e.id, e.kind === 'hexer' ? 1 : 0, r1(e.x), r1(e.y), Math.round(e.hp / e.maxHp * 100)]),
      shots: this.shots.map(s => [s.id, s.kind, r1(s.x), r1(s.y)]),
      objects: this.objects.map(o => [o.id, o.kind, o.x, o.y, o.hp, o.owner]),
      pickups: this.pickups.map(k => [k.id, k.kind, r1(k.x), r1(k.y)]),
    };
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
