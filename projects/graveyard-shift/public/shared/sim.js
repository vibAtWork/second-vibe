// Graveyard Shift - shared game simulation (server: authoritative; browser:
// predicts its own player's movement with movePlayer()).
//
// The rules and numbers follow the game logic recovered from the supplied SWF
// (see ../../RE-NOTES.md): 50 frames/s, cell-based ranges, per-level spawn
// formulas, a team kill multiplier that unlocks 58 weapon/upgrade steps, the
// weapons' base stats and upgrade factors, creature stats and health regen,
// difficulty start points, and a deathmatch mode. Name, art, sounds and maps
// are original.

export const TICK_HZ = 50;                 // the original runs at 50 frames per second
export const FRAME_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY = 1;           // network updates every tick (50 Hz); the server can lower it with SNAPSHOT_HZ
export const TILE = 32;                    // one map cell
export const MAP_W = 30, MAP_H = 20;
export const WORLD_W = MAP_W * TILE, WORLD_H = MAP_H * TILE;
export const HUD_H = 64;
export const VIEW_W = WORLD_W, VIEW_H = WORLD_H + HUD_H;

export const PLAYER_R = 10;
export const PLAYER_SPEED = 2;             // recovered: player mSpeed 2 (px per frame)
export const DIAG = 0.7071067811865476;
export const PLAYER_HP = 100;              // recovered: creature mMaxLife 100
export const REGEN_PER_TICK = PLAYER_HP / (TICK_HZ * 30); // recovered: full regen over 30 s
export const ENEMY_R = 10;
export const REVIVE_TICKS = 100;
export const MAX_ENEMIES = 90;

// Creatures (recovered). speed: cells per frame (scaled by the level's speed-up).
export const ENEMIES = {
  shambler: { hp: 100, speed: 0.02, score: 100, dmg: 50, attackTicks: 50 },
  hexer: { hp: 1000, speed: 0.04, score: 1000, dmg: 50, castRange: 5, castTicks: 100 },
};

// Weapons, keys 1..0. Recovered base stats: fireRate (frames), damage, range (cells), auto, ammo.
export const WEAPONS = [
  { key: '1', id: 'pistol', name: 'Pistol', fireRate: 8, damage: 26, range: 8, auto: false, ammo: Infinity, kind: 'gun' },
  { key: '2', id: 'uzi', name: 'SMG', fireRate: 4, damage: 35, range: 8, auto: true, ammo: 100, kind: 'gun' },
  { key: '3', id: 'shotgun', name: 'Shotgun', fireRate: 12, damage: 51, range: 7, auto: false, ammo: 20, kind: 'shotgun' },
  { key: '4', id: 'barrel', name: 'Barrel', fireRate: 1, damage: 150, ammo: 10, kind: 'place', obj: 'barrel' },
  { key: '5', id: 'grenade', name: 'Grenade', fireRate: 12, damage: 150, range: 6, auto: false, onRelease: true, ammo: 20, kind: 'throw' },
  { key: '6', id: 'fakewall', name: 'Barricade', fireRate: 1, damage: 100, ammo: 10, kind: 'place', obj: 'barricade' },
  { key: '7', id: 'mine', name: 'Mine', fireRate: 1, damage: 150, ammo: 15, kind: 'place', obj: 'mine' },
  { key: '8', id: 'rocket', name: 'Rocket', fireRate: 12, damage: 250, range: 30, auto: false, ammo: 20, kind: 'rocket' },
  { key: '9', id: 'chargepack', name: 'Charge', fireRate: 1, damage: 150, ammo: 5, kind: 'charge' },
  { key: '0', id: 'railgun', name: 'Railgun', fireRate: 5, damage: 100, range: 10, auto: false, ammo: 20, kind: 'rail' },
];
const W = Object.fromEntries(WEAPONS.map((w, i) => [w.id, i]));
export const BARRICADE_HP = 1000;          // recovered: wall mMaxLife 1000
export const MAX_CHARGES = 3;
export const EXPLOSION_RADIUS = 2.2;       // cells; x1.5 per Big Bang level
export const FRIENDLY_EXPLOSION = 0.3;     // co-op: your own blasts hurt you a little

// Multiplier -> unlock table, recovered in full (58 steps). [threshold, weapon, upgrade|null]
export const UNLOCKS = [
  [3, 'pistol', 'FastFire'], [5, 'uzi', null], [8, 'pistol', 'DoubleDamage'], [10, 'shotgun', null],
  [13, 'uzi', 'RapidFire'], [15, 'barrel', null], [17, 'uzi', 'DoubleAmmo'], [18, 'shotgun', 'FastFire'],
  [20, 'grenade', null], [21, 'shotgun', 'DoubleAmmo'], [23, 'uzi', 'LongShot'], [26, 'barrel', 'DoubleAmmo'],
  [30, 'fakewall', null], [31, 'shotgun', 'WideShot'], [32, 'barrel', 'BigBang'], [33, 'grenade', 'ClusterExplode'],
  [35, 'shotgun', 'LongShot'], [36, 'barrel', 'QuadAmmo'], [37, 'fakewall', 'DoubleAmmo'], [39, 'uzi', 'QuadAmmo'],
  [40, 'mine', null], [41, 'shotgun', 'QuadAmmo'], [42, 'grenade', 'DoubleAmmo'], [43, 'shotgun', 'RapidFire'],
  [44, 'barrel', 'BiggerBang'], [45, 'grenade', 'BigBang'], [47, 'mine', 'ClusterExplode'], [48, 'uzi', 'DoubleDamage'],
  [50, 'rocket', null], [51, 'shotgun', 'WiderShot'], [52, 'grenade', 'QuadAmmo'], [53, 'fakewall', 'QuadAmmo'],
  [54, 'mine', 'DoubleAmmo'], [55, 'chargepack', null], [56, 'shotgun', 'DoubleDamage'], [57, 'grenade', 'BiggerBang'],
  [58, 'mine', 'BigBang'], [59, 'rocket', 'FastFire'], [61, 'uzi', 'InfiniteRange'], [62, 'mine', 'BiggerBang'],
  [63, 'chargepack', 'ClusterExplode'], [64, 'mine', 'QuadAmmo'], [66, 'rocket', 'DoubleAmmo'], [68, 'chargepack', 'DoubleAmmo'],
  [70, 'railgun', null], [72, 'rocket', 'BigBang'], [74, 'chargepack', 'BigBang'], [76, 'chargepack', 'QuadAmmo'],
  [78, 'railgun', 'FastFire'], [80, 'railgun', 'DoubleAmmo'], [85, 'rocket', 'QuadAmmo'], [90, 'uzi', 'QuadDamage'],
  [95, 'chargepack', 'BiggerBang'], [100, 'railgun', 'RapidFire'], [105, 'rocket', 'BiggerBang'], [110, 'railgun', 'QuadAmmo'],
  [120, 'rocket', 'RapidFire'], [125, 'railgun', 'LongShot'],
];
const UPGRADE_LABEL = { FastFire: 'Fast Fire', RapidFire: 'Rapid Fire', DoubleDamage: 'Double Damage', QuadDamage: 'Quad Damage', DoubleAmmo: 'Double Ammo', QuadAmmo: 'Quad Ammo', LongShot: 'Long Shot', InfiniteRange: 'Infinite Range', WideShot: 'Wide Shot', WiderShot: 'Wider Shot', BigBang: 'Big Bang', BiggerBang: 'Bigger Bang', ClusterExplode: 'Cluster Explode' };
export const unlockLabel = ([, w, u]) => (u ? `${WEAPONS[W[w]].name}+: ${UPGRADE_LABEL[u]}` : `New weapon: ${WEAPONS[W[w]].name} (key ${WEAPONS[W[w]].key})`);

// Recovered: how long the multiplier holds before dropping by one.
export function multiplierTicks(m) {
  const i = 101 - Math.min(m, 100);
  return 3 + (TICK_HZ * 3 - 3) * i ** 2.5 / 100000;
}
// Recovered difficulty start points [level, multiplier]; deathmatch starts at multiplier 200.
export const DIFFICULTY = { beginner: [1, 1], intermediate: [10, 10], expert: [20, 30], nightmare: [35, 50] };
export const MODES = ['coop', 'deathmatch'];
export const DM_FRAG_LIMIT = 10;
export const DM_RESPAWN_TICKS = 150;
export const DM_SPAWN_SHIELD = 100;

// Recovered per-level spawn table (zombies always; devils from level 5).
export function levelSpec(n) {
  return {
    zombieRate: Math.max(1, TICK_HZ - (n - 1)),          // frames between zombie spawns
    zombieMax: Math.min(60, 10 + 5 * (n - 1)),          // alive at once
    zombieTotal: 10 + 5 * (n - 1),                      // to clear the level
    speedUp: Math.min(5, 1 + n / 10),
    devilRate: Math.max(TICK_HZ, TICK_HZ * 10 - (n - 1)),
    devilMax: n >= 5 ? Math.min(1 + Math.floor((n - 5) * 0.3), 8) : 0,
    devilTotal: n >= 5 ? Math.floor(1 + (n - 5) * 0.25) : 0,
  };
}

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

// ---------------------------------------------------------------- map (original, generated)
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
      if (Math.abs(x + w / 2 - MAP_W / 2) < 5 && Math.abs(y + h / 2 - MAP_H / 2) < 4) continue;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) t[yy][xx] = 1;
    }
    const dist = flowField(t, [[MAP_W / 2, MAP_H / 2]]);
    if (gates.every(([x, y]) => dist[y][x] >= 0) || attempt > 50) {
      const spawns = [[MAP_W / 2 * TILE, TILE / 2], [MAP_W / 2 * TILE, WORLD_H - TILE / 2], [TILE / 2, MAP_H / 2 * TILE], [WORLD_W - TILE / 2, MAP_H / 2 * TILE]];
      return { seed, tiles: t, spawns };
    }
  }
}

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

export function blocked(map, objects, x, y, r) {
  for (const [cx, cy] of [[x - r, y - r], [x + r - 0.001, y - r], [x - r, y + r - 0.001], [x + r - 0.001, y + r - 0.001]]) if (tileAt(map, cx, cy)) return true;
  for (const o of objects) {
    if (o.kind !== 'barrel' && o.kind !== 'barricade') continue;
    if (Math.abs(o.x - x) < r + TILE / 2 && Math.abs(o.y - y) < r + TILE / 2) return true;
  }
  return false;
}

// bits: 1 up, 2 down, 4 left, 8 right, 16 fire. Pure arithmetic: browser prediction matches exactly.
export function movePlayer(map, objects, p, bits) {
  const dx = ((bits & 8) ? 1 : 0) - ((bits & 4) ? 1 : 0);
  const dy = ((bits & 2) ? 1 : 0) - ((bits & 1) ? 1 : 0);
  if (!dx && !dy) return;
  p.fx = dx; p.fy = dy;
  const s = dx && dy ? PLAYER_SPEED * DIAG : PLAYER_SPEED;
  const nx = p.x + dx * s;
  if (!blocked(map, objects, nx, p.y, PLAYER_R)) p.x = nx;
  const ny = p.y + dy * s;
  if (!blocked(map, objects, p.x, ny, PLAYER_R)) p.y = ny;
}

function wallDistance(map, x, y, ux, uy, max) {
  for (let d = 0; d < max; d += 4) if (tileAt(map, x + ux * d, y + uy * d)) return d;
  return max;
}
function rayCircle(x, y, ux, uy, cx, cy, r) {
  const ox = cx - x, oy = cy - y, t = ox * ux + oy * uy;
  if (t < 0) return Infinity;
  const d2 = ox * ox + oy * oy - t * t;
  return d2 > r * r ? Infinity : t - Math.sqrt(r * r - d2);
}

// A weapon's live stats after the upgrades the team has unlocked (recovered factors).
// The trigger, shared by the server and the browser's shot prediction so both agree on
// exactly which tick a weapon fires: counts the cooldown down, then fires on press
// (semi-automatic), while held (automatic) or on release (grenades).
export function trigger(p, fire, s) {
  if (p.cd > 0) p.cd--;
  let shoot;
  if (s.onRelease) { shoot = !fire && p.held && p.cd === 0; if (fire) p.charging++; }
  else shoot = fire && p.cd === 0 && (s.auto || !p.held);
  p.held = fire;
  return shoot;
}

// Shot prediction for the browser: one tick of Game.step's weapon handling on a copy of a
// player's weapon state ({ alive, respawn, weapon, cd, held, charging, ammo }), using the snapshot's
// `unlocked` and `wfire` (fire rate and auto after upgrades). Returns the weapon index if a
// weapon that always fires (guns, rocket, grenade) fired this tick, else -1. Placing can fail,
// so it isn't predicted, and its ammo is corrected by the next snapshot.
const PREDICTED = new Set(['gun', 'rail', 'shotgun', 'rocket', 'throw']);
export function gunStep(g, bits, w, snap) {
  if (!g.alive) { if (g.respawn > 0 && --g.respawn <= 0) g.alive = true; return -1; } // deathmatch respawn countdown
  if (w >= 0 && snap.unlocked[w] && (g.ammo[w] > 0 || WEAPONS[w].kind === 'charge')) { g.weapon = w; g.charging = 0; }
  const i = g.weapon, kind = WEAPONS[i].kind, [fireRate, auto] = snap.wfire[i], fire = !!(bits & 16);
  const shoot = trigger(g, fire, { fireRate, auto: !!auto, onRelease: WEAPONS[i].onRelease });
  if (WEAPONS[i].onRelease && !fire) g.charging = 0;
  if (!shoot) return -1;
  if (Number.isFinite(g.ammo[i]) && kind !== 'charge') g.ammo[i]--; // Game.fire's bookkeeping
  g.cd = fireRate;
  if (g.ammo[i] <= 0 && kind !== 'charge') g.weapon = 0;
  return PREDICTED.has(kind) ? i : -1;
}

export function weaponStats(base, ups = {}) {
  const s = { ...base, wide: 0, bang: 0, cluster: false };
  if (ups.DoubleDamage) s.damage = base.damage * 2;
  if (ups.QuadDamage) s.damage = base.damage * 4;
  if (ups.FastFire) { s.fireRate = Math.round(Math.max(2, base.fireRate / 2)); s.auto = true; }
  if (ups.RapidFire) { s.fireRate = Math.round(Math.max(2, base.fireRate / 4)); s.auto = true; }
  if (ups.DoubleAmmo) s.ammo = base.ammo * 2;
  if (ups.QuadAmmo) s.ammo = base.ammo * 4;
  if (ups.LongShot) s.range = base.range * 1.5;
  if (ups.InfiniteRange) s.range = 100;
  if (ups.WideShot) s.wide = 1;
  if (ups.WiderShot) s.wide = 2;
  if (ups.BigBang) s.bang = 1;
  if (ups.BiggerBang) s.bang = 2;
  if (ups.ClusterExplode) s.cluster = true;
  return s;
}

// ---------------------------------------------------------------- game
export class Game {
  // opts: { mode: 'coop' | 'deathmatch', difficulty: 'beginner' | 'intermediate' | 'expert' | 'nightmare' }
  constructor(seed = (Math.random() * 2 ** 32) >>> 0, opts = {}) {
    this.mode = MODES.includes(opts.mode) ? opts.mode : 'coop';
    this.difficulty = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'beginner';
    this.rand = rng(seed ^ 0x2545F491);
    this.seedRng = rng(seed);
    this.tick = 0;
    this.nextId = 1;
    this.players = new Map();
    this.events = [];
    this.pendingBlasts = [];
    this.newGame();
  }

  newGame() {
    this.map = generateMap((this.seedRng() * 2 ** 32) >>> 0);
    this.enemies = []; this.shots = []; this.objects = []; this.pickups = [];
    this.field = null;
    this.unlocked = new Set(['pistol']);   // team-wide (the original keeps upgrades on the world)
    this.ups = {};                          // weapon id -> { upgrade: true }
    this.unlockIndex = 0;
    const [level, mult] = this.mode === 'deathmatch' ? [1, 200] : DIFFICULTY[this.difficulty];
    this.level = 0; this.phase = 'break'; this.phaseTimer = 100; this.winner = null;
    this.mult = 1; this.multTimer = 0;
    this.startLevel = level;
    this.setMultiplier(mult, true);
    for (const p of this.players.values()) this.resetPlayer(p);
  }

  resetPlayer(p) {
    Object.assign(p, { score: 0, frags: 0, deaths: 0, kills: 0, weapon: 0, cd: 0, held: false, revive: 0, respawn: 0, shield: 0, charging: 0 });
    p.ammo = WEAPONS.map((w, i) => (this.unlocked.has(w.id) ? this.stats(i).ammo : 0));
    this.respawn(p);
  }

  stats(i) { return weaponStats(WEAPONS[i], this.ups[WEAPONS[i].id]); }

  // The team multiplier. Reaching a threshold unlocks that step for good (silently at game start).
  setMultiplier(m, silent = false) {
    this.mult = Math.max(1, Math.min(999, m));
    this.multTimer = multiplierTicks(this.mult);
    while (this.unlockIndex < UNLOCKS.length && UNLOCKS[this.unlockIndex][0] <= this.mult) {
      const step = UNLOCKS[this.unlockIndex++], [, w, u] = step, i = W[w];
      if (u) { (this.ups[w] ||= {})[u] = true; } else this.unlocked.add(w);
      for (const p of this.players.values()) {
        const s = this.stats(i);
        if (!u) p.ammo[i] = s.ammo;
        else if (/Ammo/.test(u) && Number.isFinite(s.ammo)) p.ammo[i] = s.ammo;
      }
      if (!silent) this.events.push({ type: 'unlock', text: unlockLabel(step), weapon: i });
    }
  }

  spawnPoint(p) {
    if (this.mode === 'deathmatch') { // a random open cell away from other players
      for (let k = 0; k < 50; k++) {
        const tx = 2 + Math.floor(this.rand() * (MAP_W - 4)), ty = 2 + Math.floor(this.rand() * (MAP_H - 4));
        if (this.map.tiles[ty][tx]) continue;
        const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
        if ([...this.players.values()].every(q => !q.alive || Math.hypot(q.x - x, q.y - y) > TILE * 6)) return [x, y];
      }
    }
    // co-op: one of four spots around the centre, the player's own seat order picks which
    const i = Math.max(0, [...this.players.values()].indexOf(p));
    return [WORLD_W / 2 + ((i % 2) ? 20 : -20), WORLD_H / 2 + ((i % 4) > 1 ? 20 : -20)];
  }

  respawn(p) {
    const [x, y] = this.spawnPoint(p);
    Object.assign(p, { x, y, fx: 0, fy: -1, hp: PLAYER_HP, alive: true, revive: 0, respawn: 0, shield: this.mode === 'deathmatch' ? DM_SPAWN_SHIELD : 0 });
  }

  addPlayer(id, name, color) {
    const p = { id, name, color };
    this.players.set(id, p);
    this.resetPlayer(p);
    this.events.push({ type: 'join', id, name });
  }

  removePlayer(id) {
    this.players.delete(id);
    this.objects = this.objects.filter(o => !(o.owner === id && o.kind === 'charge'));
    if (this.players.size === 0) this.newGame();
  }

  // ------------------------------------------------ levels
  startLevel_() {
    const first = !this.level;
    // deathmatch has no level progression: the zombies just keep coming at level-1 strength
    this.level = first || this.mode === 'deathmatch' ? this.startLevel : this.level + 1;
    this.phase = 'level';
    this.spec = levelSpec(this.level);
    this.toSpawn = { shambler: this.spec.zombieTotal, hexer: this.spec.devilTotal };
    this.spawnTimer = { shambler: 0, hexer: this.spec.devilRate };
    if (this.mode === 'coop') for (const p of this.players.values()) if (!p.alive) { this.respawn(p); p.hp = PLAYER_HP / 2; }
    if (this.mode === 'coop') this.events.push({ type: 'level', level: this.level });
  }

  spawnEnemy(kind) {
    const s = this.map.spawns[Math.floor(this.rand() * this.map.spawns.length)];
    const base = ENEMIES[kind];
    this.enemies.push({ id: this.nextId++, kind, x: s[0] + (this.rand() - 0.5) * 8, y: s[1] + (this.rand() - 0.5) * 8, hp: base.hp, maxHp: base.hp, speed: base.speed * TILE * this.spec.speedUp, cd: 30 });
  }

  // ------------------------------------------------ combat
  kill(e, by) {
    this.events.push({ type: 'kill', id: e.id, kind: e.kind, x: e.x, y: e.y, by });
    const r = this.rand();
    if (r < 0.05) this.pickups.push({ id: this.nextId++, kind: 'health', x: e.x, y: e.y, ttl: 750 });
    else if (r < 0.15) this.pickups.push({ id: this.nextId++, kind: 'ammo', x: e.x, y: e.y, ttl: 750 });
    const p = this.players.get(by);
    if (this.mode === 'coop') {
      this.setMultiplier(this.mult + 1);           // recovered: every kill adds one
      if (p) { p.kills++; p.score += ENEMIES[e.kind].score * this.mult; }
    } else if (p) { p.kills++; p.score += ENEMIES[e.kind].score; }
  }

  damageEnemy(e, dmg, by) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    if (e.hp <= 0) this.kill(e, by);
  }

  hurtPlayer(p, dmg, by = 0) {
    if (!p.alive || p.shield > 0 || this.phase === 'over') return; // nothing counts once the match is decided
    p.hp -= dmg;
    this.events.push({ type: 'hurt', id: p.id });
    if (p.hp > 0) return;
    p.hp = 0; p.alive = false; p.deaths++;
    this.events.push({ type: 'down', id: p.id, x: p.x, y: p.y, by });
    if (this.mode === 'deathmatch') {
      p.respawn = DM_RESPAWN_TICKS;
      const killer = this.players.get(by);
      if (killer && killer !== p) {
        killer.frags++;
        this.events.push({ type: 'frag', id: by, victim: p.id });
        if (killer.frags >= DM_FRAG_LIMIT) { this.phase = 'over'; this.phaseTimer = 300; this.winner = by; this.events.push({ type: 'winner', id: by }); }
      } else if (killer === p) p.frags = Math.max(0, p.frags - 1);
    }
  }

  // players a shot from `p` can hurt: everyone else in deathmatch, nobody in co-op
  targets(p) { return this.mode === 'deathmatch' ? [...this.players.values()].filter(q => q !== p && q.alive) : []; }

  explode(x, y, kind, by, dmg, bang = 0, cluster = false) {
    const r = EXPLOSION_RADIUS * TILE * (1 + 0.5 * bang);
    this.events.push({ type: 'boom', x, y, r });
    for (const e of this.enemies) if (Math.hypot(e.x - x, e.y - y) < r + ENEMY_R) this.damageEnemy(e, dmg, by);
    for (const p of this.players.values()) {
      if (Math.hypot(p.x - x, p.y - y) >= r) continue;
      this.hurtPlayer(p, this.mode === 'deathmatch' ? dmg : dmg * FRIENDLY_EXPLOSION, by);
    }
    for (const o of this.objects) {
      if (o.dead || Math.hypot(o.x - x, o.y - y) >= r + TILE / 2) continue;
      if (o.kind === 'barricade') { o.hp -= dmg; if (o.hp <= 0) o.dead = true; }
      else { o.dead = true; this.pendingBlasts.push([o.x, o.y, o.kind, o.owner ?? by, o.dmg, o.bang, o.cluster]); }
    }
    if (cluster) { // recovered upgrade: the blast throws out smaller bomblets
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2 + this.rand() * 0.5;
        this.shots.push({ id: this.nextId++, kind: 'cluster', x, y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, owner: by, fuse: 16 + Math.floor(this.rand() * 10), dmg: dmg / 2 });
      }
    }
  }

  hitscan(p, angle, s, pierce) {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const sx = p.x + ux * 12, sy = p.y + uy * 12, range = s.range * TILE;
    const wall = wallDistance(this.map, sx, sy, ux, uy, range);
    const victims = [...this.enemies.filter(e => e.hp > 0), ...this.targets(p)];
    let end = wall;
    if (pierce) {
      for (const v of victims) if (rayCircle(sx, sy, ux, uy, v.x, v.y, ENEMY_R) < wall) this.hitThing(v, s.damage, p.id);
    } else {
      let best = null, bt = wall;
      for (const v of victims) { const t = rayCircle(sx, sy, ux, uy, v.x, v.y, ENEMY_R); if (t < bt) { bt = t; best = v; } }
      for (const o of this.objects) {
        if (o.dead || (o.kind !== 'barrel' && o.kind !== 'barricade')) continue;
        const t = rayCircle(sx, sy, ux, uy, o.x, o.y, TILE / 2);
        if (t < bt) { bt = t; best = o; }
      }
      end = bt;
      if (best?.kind === 'barrel') { best.dead = true; this.explode(best.x, best.y, 'barrel', p.id, best.dmg, best.bang, best.cluster); }
      else if (best && best.kind !== 'barricade') this.hitThing(best, s.damage, p.id);
    }
    this.events.push({ type: 'tracer', id: p.id, x1: sx, y1: sy, x2: sx + ux * end, y2: sy + uy * end, rail: pierce ? 1 : 0 });
  }

  hitThing(v, dmg, by) { if (v.kind) this.damageEnemy(v, dmg, by); else this.hurtPlayer(v, dmg, by); } // enemies have a kind, players don't

  place(p, kind, s) {
    // the first tile ahead that doesn't overlap the placer (depends on where you stand within your tile)
    const overlapsMe = (x, y) => Math.abs(p.x - x) < PLAYER_R + TILE / 2 && Math.abs(p.y - y) < PLAYER_R + TILE / 2;
    let x, y;
    for (const d of [TILE, TILE * 1.5]) {
      x = Math.floor((p.x + p.fx * d) / TILE) * TILE + TILE / 2;
      y = Math.floor((p.y + p.fy * d) / TILE) * TILE + TILE / 2;
      if (!overlapsMe(x, y)) break;
    }
    if (tileAt(this.map, x, y)) return false;
    if (this.objects.some(o => !o.dead && Math.abs(o.x - x) < TILE && Math.abs(o.y - y) < TILE)) return false;
    const solid = kind === 'barrel' || kind === 'barricade';
    if (solid && ([...this.players.values()].some(q => q.alive && Math.abs(q.x - x) < PLAYER_R + TILE / 2 && Math.abs(q.y - y) < PLAYER_R + TILE / 2)
      || this.enemies.some(e => Math.abs(e.x - x) < ENEMY_R + TILE / 2 && Math.abs(e.y - y) < ENEMY_R + TILE / 2))) return false;
    this.objects.push({ id: this.nextId++, kind, x, y, hp: kind === 'barricade' ? BARRICADE_HP : 1, owner: p.id, dmg: s.damage, bang: s.bang, cluster: s.cluster });
    this.events.push({ type: 'place', kind, x, y });
    return true;
  }

  fire(p) {
    const i = p.weapon, s = this.stats(i), facing = Math.atan2(p.fy, p.fx);
    let used = true;
    if (s.kind === 'gun' || s.kind === 'rail') this.hitscan(p, facing + (this.rand() - 0.5) * (s.id === 'uzi' ? 0.12 : 0.03), s, s.kind === 'rail');
    else if (s.kind === 'shotgun') {
      const pellets = 5 + 2 * s.wide, spread = 0.28 + 0.14 * s.wide; // Wide/Wider Shot widen the cone
      for (let k = 0; k < pellets; k++) this.hitscan(p, facing + (k / (pellets - 1) - 0.5) * spread, s, false);
    } else if (s.kind === 'place') used = this.place(p, s.obj, s);
    else if (s.kind === 'charge') {
      const mine = this.objects.filter(o => o.kind === 'charge' && o.owner === p.id && !o.dead);
      if (mine.length >= MAX_CHARGES || p.ammo[i] <= 0) {
        for (const o of mine) { o.dead = true; this.pendingBlasts.push([o.x, o.y, 'charge', p.id, o.dmg, o.bang, o.cluster]); }
        used = false;
      } else used = this.place(p, 'charge', s);
    } else if (s.kind === 'throw') { // grenade: thrown on release; holding longer throws further
      const power = Math.min(1, 0.35 + p.charging / 40), ux = Math.cos(facing), uy = Math.sin(facing);
      const dist = s.range * TILE * power, v = dist / 30;
      this.shots.push({ id: this.nextId++, kind: 'grenade', x: p.x + ux * 12, y: p.y + uy * 12, vx: ux * v, vy: uy * v, owner: p.id, fuse: 60, dmg: s.damage, bang: s.bang, cluster: s.cluster, fly: 30 });
      this.events.push({ type: 'throw', id: p.id, x: p.x, y: p.y });
    } else { // rocket
      const ux = Math.cos(facing), uy = Math.sin(facing);
      this.shots.push({ id: this.nextId++, kind: 'rocket', x: p.x + ux * 12, y: p.y + uy * 12, vx: ux * 7, vy: uy * 7, owner: p.id, fuse: 150, dmg: s.damage, bang: s.bang, cluster: s.cluster });
      this.events.push({ type: 'rocketfire', id: p.id, x: p.x, y: p.y });
    }
    if (used && Number.isFinite(p.ammo[i])) p.ammo[i]--;
    if (s.kind === 'gun' || s.kind === 'rail' || s.kind === 'shotgun') this.events.push({ type: 'shot', id: p.id, weapon: i, x: p.x, y: p.y });
    p.cd = s.fireRate;
    if (p.ammo[i] <= 0 && s.kind !== 'charge') p.weapon = 0;
  }

  // ------------------------------------------------ step
  step(inputs) {
    this.tick++;
    const players = [...this.players.values()];
    if (!players.length) return;
    for (const b of this.pendingBlasts.splice(0)) this.explode(...b);
    this.objects = this.objects.filter(o => !o.dead);

    if (this.phase === 'break' && --this.phaseTimer <= 0) this.startLevel_();
    if (this.phase === 'over' && --this.phaseTimer <= 0) { this.newGame(); this.events.push({ type: 'restart' }); return; }

    // multiplier drains one step at a time (co-op)
    if (this.mode === 'coop' && this.mult > 1 && --this.multTimer < 0) { this.mult--; this.multTimer = multiplierTicks(this.mult); }

    for (const p of players) {
      const inp = inputs.get(p.id) || { bits: 0, w: -1 };
      if (!p.alive) { if (this.mode === 'deathmatch' && --p.respawn <= 0) this.respawn(p); continue; }
      if (p.shield > 0) p.shield--;
      if (p.hp < PLAYER_HP) p.hp = Math.min(PLAYER_HP, p.hp + REGEN_PER_TICK); // recovered regen
      if (inp.w >= 0 && this.unlocked.has(WEAPONS[inp.w].id) && (p.ammo[inp.w] > 0 || WEAPONS[inp.w].kind === 'charge')) { p.weapon = inp.w; p.charging = 0; }
      movePlayer(this.map, this.objects, p, inp.bits);
      const fire = !!(inp.bits & 16), s = this.stats(p.weapon);
      if (trigger(p, fire, s)) this.fire(p);
      if (s.onRelease && !fire) p.charging = 0; // grenades wind up while held; the throw reads the wind-up first
      for (const k of this.pickups) {
        if (k.dead || Math.abs(k.x - p.x) > 18 || Math.abs(k.y - p.y) > 18) continue;
        if (k.kind === 'health') { if (p.hp >= PLAYER_HP) continue; p.hp = Math.min(PLAYER_HP, p.hp + 50); }
        else {
          const have = WEAPONS.map((w, i) => i).filter(i => i > 0 && this.unlocked.has(WEAPONS[i].id));
          if (!have.length) continue;
          for (const i of have) p.ammo[i] = this.stats(i).ammo; // ammo crate refills everything
        }
        k.dead = true;
        this.events.push({ type: 'pickup', id: p.id, kind: k.kind });
      }
    }
    if (this.mode === 'coop') for (const p of players) { // revive downed teammates
      if (p.alive) continue;
      const helper = players.some(q => q.alive && Math.abs(q.x - p.x) < 28 && Math.abs(q.y - p.y) < 28);
      p.revive = helper ? p.revive + 1 : 0;
      if (p.revive >= REVIVE_TICKS) { p.alive = true; p.hp = PLAYER_HP / 2; p.revive = 0; this.events.push({ type: 'revive', id: p.id }); }
    }
    this.pickups = this.pickups.filter(k => !k.dead && --k.ttl > 0);

    // spawning (recovered per-level rates and caps)
    if (this.phase === 'level') {
      const alive = kind => this.enemies.filter(e => e.kind === kind).length;
      for (const kind of ['shambler', 'hexer']) {
        const max = kind === 'shambler' ? this.spec.zombieMax : this.spec.devilMax;
        const rate = kind === 'shambler' ? this.spec.zombieRate : this.spec.devilRate;
        if (this.toSpawn[kind] > 0 && --this.spawnTimer[kind] <= 0 && alive(kind) < max && this.enemies.length < MAX_ENEMIES) {
          this.spawnEnemy(kind); this.toSpawn[kind]--; this.spawnTimer[kind] = rate;
        }
      }
    }

    // enemies
    const alivePlayers = players.filter(p => p.alive);
    if (!this.field || this.tick % 15 === 0) this.field = flowField(this.map.tiles, alivePlayers.map(p => [Math.floor(p.x / TILE), Math.floor(p.y / TILE)]));
    for (const e of this.enemies) {
      if (e.hp <= 0 || !alivePlayers.length) continue;
      const target = alivePlayers.reduce((a, b) => (Math.hypot(b.x - e.x, b.y - e.y) < Math.hypot(a.x - e.x, a.y - e.y) ? b : a));
      const dist = Math.hypot(target.x - e.x, target.y - e.y), def = ENEMIES[e.kind];
      if (e.cd > 0) e.cd--;
      let gx = target.x, gy = target.y;
      const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
      if (dist > TILE * 1.5 && this.field[ty]?.[tx] > 0) {
        let best = this.field[ty][tx];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const v = this.field[ty + dy]?.[tx + dx];
          if (v >= 0 && v < best) { best = v; gx = (tx + dx) * TILE + TILE / 2; gy = (ty + dy) * TILE + TILE / 2; }
        }
      }
      if (!(e.kind === 'hexer' && dist < TILE * 3)) {
        const d = Math.hypot(gx - e.x, gy - e.y) || 1, vx = (gx - e.x) / d * e.speed, vy = (gy - e.y) / d * e.speed;
        let moved = false;
        if (Math.abs(vx) > 0.01 && !blocked(this.map, this.objects, e.x + vx, e.y, ENEMY_R)) { e.x += vx; moved = true; }
        if (Math.abs(vy) > 0.01 && !blocked(this.map, this.objects, e.x, e.y + vy, ENEMY_R)) { e.y += vy; moved = true; }
        if (!moved && e.cd === 0) {
          const o = this.objects.find(o => (o.kind === 'barricade' || o.kind === 'barrel') && Math.abs(o.x - e.x) < TILE && Math.abs(o.y - e.y) < TILE);
          if (o) { o.hp -= def.dmg; e.cd = 50; if (o.hp <= 0) { o.dead = true; if (o.kind === 'barrel') this.pendingBlasts.push([o.x, o.y, 'barrel', o.owner, o.dmg, o.bang, o.cluster]); } }
        }
      }
      if (e.kind === 'shambler' && dist < PLAYER_R + ENEMY_R + 6 && e.cd === 0) { this.hurtPlayer(target, def.dmg); e.cd = def.attackTicks; }
      if (e.kind === 'hexer' && dist < def.castRange * TILE && e.cd === 0 && wallDistance(this.map, e.x, e.y, (target.x - e.x) / dist, (target.y - e.y) / dist, dist) >= dist) {
        this.shots.push({ id: this.nextId++, kind: 'fireball', x: e.x, y: e.y, vx: (target.x - e.x) / dist * 3.5, vy: (target.y - e.y) / dist * 3.5, owner: 0, fuse: 120 });
        e.cd = def.castTicks;
        this.events.push({ type: 'cast', x: e.x, y: e.y });
      }
      for (const o of this.objects) if (o.kind === 'mine' && !o.dead && Math.abs(o.x - e.x) < 20 && Math.abs(o.y - e.y) < 20) { o.dead = true; this.pendingBlasts.push([o.x, o.y, 'mine', o.owner, o.dmg, o.bang, o.cluster]); }
    }
    if (this.mode === 'deathmatch') for (const o of this.objects) { // mines also catch other players
      if (o.kind !== 'mine' || o.dead) continue;
      if (players.some(q => q.alive && q.id !== o.owner && Math.abs(o.x - q.x) < 20 && Math.abs(o.y - q.y) < 20)) { o.dead = true; this.pendingBlasts.push([o.x, o.y, 'mine', o.owner, o.dmg, o.bang, o.cluster]); }
    }
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
      const solid = tileAt(this.map, s.x, s.y) || this.objects.some(o => (o.kind === 'barricade' || o.kind === 'barrel') && Math.abs(o.x - s.x) < TILE / 2 && Math.abs(o.y - s.y) < TILE / 2);
      if (s.kind === 'fireball') {
        const p = alivePlayers.find(p => Math.abs(p.x - s.x) < PLAYER_R + 4 && Math.abs(p.y - s.y) < PLAYER_R + 4);
        if (p) this.hurtPlayer(p, ENEMIES.hexer.dmg);
        if (p || solid || --s.fuse <= 0) s.dead = true;
      } else if (s.kind === 'rocket') {
        const owner = this.players.get(s.owner);
        const hit = this.enemies.some(e => Math.abs(e.x - s.x) < ENEMY_R + 4 && Math.abs(e.y - s.y) < ENEMY_R + 4)
          || (owner && this.targets(owner).some(q => Math.abs(q.x - s.x) < PLAYER_R + 4 && Math.abs(q.y - s.y) < PLAYER_R + 4));
        if (hit || solid || --s.fuse <= 0) { s.dead = true; this.explode(s.x - s.vx * 0.5, s.y - s.vy * 0.5, 'rocket', s.owner, s.dmg, s.bang, s.cluster); }
      } else { // grenade / cluster bomblet: fly, stop at walls, explode when the fuse runs out
        if (solid) { s.x -= s.vx; s.y -= s.vy; s.vx = s.vy = 0; }
        if (s.fly !== undefined && --s.fly <= 0) { s.vx = s.vy = 0; }
        if (s.kind === 'cluster') { s.vx *= 0.9; s.vy *= 0.9; }
        if (--s.fuse <= 0) { s.dead = true; this.explode(s.x, s.y, s.kind, s.owner, s.dmg, s.kind === 'cluster' ? -0.5 : s.bang, s.kind === 'cluster' ? false : s.cluster); }
      }
    }
    this.shots = this.shots.filter(s => !s.dead);
    this.enemies = this.enemies.filter(e => e.hp > 0);

    // level cleared / team wiped
    if (this.phase === 'level' && !this.toSpawn.shambler && !this.toSpawn.hexer && !this.enemies.length) {
      this.phase = 'break'; this.phaseTimer = 150;
      this.events.push({ type: 'cleared', level: this.level });
    }
    if (this.mode === 'coop' && this.phase !== 'over' && players.every(p => !p.alive)) {
      this.phase = 'over'; this.phaseTimer = 250;
      this.events.push({ type: 'gameover', level: this.level, score: players.reduce((a, p) => a + p.score, 0) });
    }
  }

  // Network snapshot (field order decoded in client.js).
  snapshot() {
    const r1 = v => Math.round(v * 10) / 10;
    return {
      t: 's', tick: this.tick, mode: this.mode, difficulty: this.difficulty, level: this.level, phase: this.phase, timer: this.phaseTimer,
      left: this.phase === 'level' ? this.toSpawn.shambler + this.toSpawn.hexer + this.enemies.length : 0,
      mult: this.mult, multRatio: Math.max(0, Math.min(1, this.multTimer / multiplierTicks(this.mult))), winner: this.winner,
      unlocked: WEAPONS.map(w => (this.unlocked.has(w.id) ? 1 : 0)),
      wfire: WEAPONS.map((w, i) => { const st = this.stats(i); return [st.fireRate, st.auto ? 1 : 0]; }), // after upgrades, for shot prediction nextUnlock: UNLOCKS[this.unlockIndex] ? [UNLOCKS[this.unlockIndex][0], unlockLabel(UNLOCKS[this.unlockIndex])] : null,
      players: [...this.players.values()].map(p => [p.id, p.x, p.y, p.fx, p.fy, Math.ceil(p.hp), p.alive ? 1 : 0, p.weapon, p.score, p.frags, p.ammo.map(a => (Number.isFinite(a) ? a : -1)), p.revive, p.name, p.color, p.shield > 0 ? 1 : 0, p.respawn, p.cd, p.held ? 1 : 0]),
      enemies: this.enemies.map(e => [e.id, e.kind === 'hexer' ? 1 : 0, r1(e.x), r1(e.y), Math.round(e.hp / e.maxHp * 100)]),
      shots: this.shots.map(s => [s.id, s.kind, r1(s.x), r1(s.y)]),
      objects: this.objects.map(o => [o.id, o.kind, o.x, o.y, o.hp, o.owner]),
      pickups: this.pickups.map(k => [k.id, k.kind, r1(k.x), r1(k.y)]),
    };
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
