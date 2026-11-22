import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, generateMap, flowField, movePlayer, blocked, weaponStats, multiplierTicks, levelSpec,
  WEAPONS, ENEMIES, UNLOCKS, DIFFICULTY, TILE, MAP_W, MAP_H, PLAYER_SPEED, DIAG, PLAYER_HP, REGEN_PER_TICK,
  REVIVE_TICKS, MAX_CHARGES, DM_FRAG_LIMIT, DM_RESPAWN_TICKS, DM_SPAWN_SHIELD, BARRICADE_HP,
} from '../public/shared/sim.js';

const step = (g, inputs = {}, n = 1) => { for (let i = 0; i < n; i++) g.step(new Map(Object.entries(inputs).map(([k, v]) => [+k, v]))); };
const idle = { bits: 0, w: -1 }, fire = { bits: 16, w: -1 };
function arena(players = 1, opts = {}) {
  const g = new Game(5, opts);
  for (let i = 1; i <= players; i++) g.addPlayer(i, 'p' + i, '#fff');
  step(g, Object.fromEntries([...g.players.keys()].map(k => [k, idle])), 101); // into level 1
  g.toSpawn = { shambler: 0, hexer: 0 }; g.enemies = []; g.drainEvents();
  return g;
}
const enemy = (g, x, y, kind = 'shambler', hp = ENEMIES[kind].hp) => { const e = { id: g.nextId++, kind, x, y, hp, maxHp: hp, speed: 0, cd: 999 }; g.enemies.push(e); return e; };
const killNow = (g, n) => { for (let i = 0; i < n; i++) g.kill({ id: -1, kind: 'shambler', x: 0, y: 0 }, 1); };

test('recovered unlock table: 58 steps, increasing thresholds, every weapon unlocked once in key order', () => {
  assert.equal(UNLOCKS.length, 58);
  for (let i = 1; i < UNLOCKS.length; i++) assert.ok(UNLOCKS[i][0] > UNLOCKS[i - 1][0]);
  const weapons = UNLOCKS.filter(u => !u[2]).map(u => u[1]);
  assert.deepEqual(weapons, ['uzi', 'shotgun', 'barrel', 'grenade', 'fakewall', 'mine', 'rocket', 'chargepack', 'railgun']);
  assert.deepEqual(UNLOCKS.filter(u => !u[2]).map(u => u[0]), [5, 10, 15, 20, 30, 40, 50, 55, 70]);
  assert.deepEqual(UNLOCKS.at(-1), [125, 'railgun', 'LongShot']);
});

test('recovered multiplier timing: 3 s at x1, 3 frames at x100', () => {
  assert.equal(multiplierTicks(1), 150);
  assert.ok(Math.abs(multiplierTicks(100) - 3) < 0.01, 'about 3 frames');
  assert.ok(multiplierTicks(50) > 25 && multiplierTicks(50) < 35);
});

test('recovered weapon upgrade factors', () => {
  const pistol = WEAPONS[0];
  assert.deepEqual([pistol.fireRate, pistol.damage, pistol.range, pistol.auto], [8, 26, 8, false]);
  const fast = weaponStats(pistol, { FastFire: true, DoubleDamage: true });
  assert.deepEqual([fast.fireRate, fast.auto, fast.damage], [4, true, 52]);
  const uzi = weaponStats(WEAPONS[1], { RapidFire: true, QuadAmmo: true, QuadDamage: true, LongShot: true });
  assert.deepEqual([uzi.fireRate, uzi.ammo, uzi.damage, uzi.range], [2, 400, 140, 12]);
  assert.equal(weaponStats(WEAPONS[1], { InfiniteRange: true }).range, 100);
  assert.equal(weaponStats(WEAPONS[2], { WiderShot: true }).wide, 2);
  assert.equal(weaponStats(WEAPONS[3], { BiggerBang: true }).bang, 2);
});

test('recovered level table', () => {
  assert.deepEqual(levelSpec(1), { zombieRate: 50, zombieMax: 10, zombieTotal: 10, speedUp: 1.1, devilRate: 500, devilMax: 0, devilTotal: 0 });
  assert.equal(levelSpec(11).zombieMax, 60);
  assert.equal(levelSpec(40).speedUp, 5);
  assert.ok(levelSpec(5).devilTotal >= 1, 'devils from level 5');
});

test('maps: closed border, open gates, clear centre, every gate reachable', () => {
  for (let seed = 1; seed < 40; seed++) {
    const m = generateMap(seed);
    const d = flowField(m.tiles, [[MAP_W / 2, MAP_H / 2]]);
    for (const [x, y] of m.spawns) assert.ok(d[Math.floor(y / TILE)][Math.floor(x / TILE)] >= 0, `seed ${seed}`);
    assert.equal(m.tiles[5][0], 1);
  }
});

test('movement: recovered speed, diagonals, walls', () => {
  const m = generateMap(2), p = { x: MAP_W / 2 * TILE, y: MAP_H / 2 * TILE, fx: 0, fy: -1 };
  movePlayer(m, [], p, 8);
  assert.equal(p.x, MAP_W / 2 * TILE + PLAYER_SPEED);
  const q = { ...p };
  movePlayer(m, [], q, 2 | 4);
  assert.ok(Math.abs(q.x - (p.x - PLAYER_SPEED * DIAG)) < 1e-9);
  for (let i = 0; i < 600; i++) movePlayer(m, [], q, 1);
  assert.ok(!blocked(m, [], q.x, q.y, 10) && q.y >= 10);
});

test('every kill raises the team multiplier, which unlocks weapons for everyone; it drains when idle', () => {
  const g = arena(2), [a, b] = [g.players.get(1), g.players.get(2)];
  killNow(g, 4);
  assert.equal(g.mult, 5);
  assert.ok(g.unlocked.has('uzi'));
  assert.equal(a.ammo[1], WEAPONS[1].ammo); assert.equal(b.ammo[1], WEAPONS[1].ammo, 'team-wide');
  assert.ok(g.ups.pistol.FastFire, 'x3 unlocked Pistol+: Fast Fire');
  assert.ok(g.drainEvents().some(e => e.type === 'unlock' && /SMG \(key 2\)/.test(e.text)));
  step(g, { 1: idle, 2: idle }, Math.ceil(multiplierTicks(5)) + 2);
  assert.equal(g.mult, 4, 'drops one step when the timer runs out');
  assert.ok(g.unlocked.has('uzi'), 'unlocks are kept');
  const before = a.score;
  g.kill({ id: -1, kind: 'hexer', x: 0, y: 0 }, 1);
  assert.equal(a.score - before, ENEMIES.hexer.score * g.mult, 'score = creature score x multiplier');
});

test('pistol is semi-automatic until Fast Fire; grenades throw on release', () => {
  const g = arena(), p = g.players.get(1);
  g.unlockIndex = UNLOCKS.length; // freeze upgrades for this test
  step(g, { 1: fire }); const shots1 = g.drainEvents().filter(e => e.type === 'shot').length;
  step(g, { 1: fire }, 30); const held = g.drainEvents().filter(e => e.type === 'shot').length;
  assert.equal(shots1, 1); assert.equal(held, 0, 'holding fire does not repeat');
  g.ups.pistol = { FastFire: true };
  step(g, { 1: fire }, 30);
  assert.ok(g.drainEvents().filter(e => e.type === 'shot').length >= 6, 'auto with Fast Fire');
  g.unlocked.add('grenade'); p.ammo[4] = 5;
  step(g, { 1: { bits: 0, w: 4 } }); g.drainEvents();
  step(g, { 1: fire }, 20);
  assert.equal(g.shots.length, 0, 'nothing thrown while held');
  step(g, { 1: idle });
  assert.equal(g.shots.filter(s => s.kind === 'grenade').length, 1, 'thrown on release');
  step(g, { 1: idle }, 61);
  assert.ok(g.drainEvents().some(e => e.type === 'boom'));
});

test('recovered creature stats: shambler hits for 50, hexer has 1000 hp and casts within 5 cells; health regenerates', () => {
  const g = arena(), p = g.players.get(1);
  const s = enemy(g, p.x + 20, p.y); s.cd = 0;
  step(g, { 1: idle });
  assert.ok(Math.abs(p.hp - (PLAYER_HP - 50 + REGEN_PER_TICK)) < 1e-9 || Math.abs(p.hp - (PLAYER_HP - 50)) < 1e-9);
  g.enemies = [];
  const before = p.hp;
  step(g, { 1: idle }, 50);
  assert.ok(p.hp > before, 'regenerating');
  const h = enemy(g, p.x + 4 * TILE, p.y, 'hexer'); h.cd = 0;
  assert.equal(h.hp, 1000);
  step(g, { 1: idle });
  assert.equal(g.shots.filter(x => x.kind === 'fireball').length, 1);
});

test('difficulty sets the starting level and multiplier (recovered table)', () => {
  for (const [name, [level, mult]] of Object.entries(DIFFICULTY)) {
    const g = new Game(1, { difficulty: name }); g.addPlayer(1, 'a', '#fff');
    assert.equal(g.mult, mult);
    step(g, { 1: idle }, 101);
    assert.equal(g.level, level);
    assert.equal(g.unlocked.size, 1 + UNLOCKS.filter(u => !u[2] && u[0] <= mult).length);
  }
});

test('barrels chain, barricades soak damage, charges detonate on the 4th press, railgun pierces', () => {
  const g = arena(), p = g.players.get(1);
  p.fx = 1; p.fy = 0;
  for (const w of ['barrel', 'fakewall', 'chargepack', 'railgun']) g.unlocked.add(w);
  p.ammo = WEAPONS.map(w => (Number.isFinite(w.ammo) ? w.ammo : Infinity));
  p.weapon = 3; step(g, { 1: fire }); step(g, { 1: idle });
  const b1 = g.objects.find(o => o.kind === 'barrel');
  assert.ok(b1 && blocked(g.map, g.objects, b1.x, b1.y, 10));
  g.objects.push({ id: g.nextId++, kind: 'barrel', x: b1.x + TILE * 2, y: b1.y, hp: 1, owner: 1, dmg: 150, bang: 0 });
  const victim = enemy(g, b1.x + TILE * 2 + 20, b1.y, 'shambler', 140);
  p.weapon = 0; p.cd = 0; step(g, { 1: fire }); step(g, { 1: idle }, 2);
  assert.equal(g.objects.filter(o => o.kind === 'barrel').length, 0, 'chain reaction');
  assert.equal(g.enemies.includes(victim), false);
  p.weapon = 5; p.cd = 0; step(g, { 1: fire }); step(g, { 1: idle });
  assert.equal(g.objects.find(o => o.kind === 'barricade').hp, BARRICADE_HP);
  g.objects = [];
  p.weapon = 8;
  for (let i = 0; i <= MAX_CHARGES; i++) { p.cd = 0; step(g, { 1: fire }); step(g, { 1: idle }); p.y += TILE * 2; }
  step(g, { 1: idle }, 2);
  assert.equal(g.objects.filter(o => o.kind === 'charge').length, 0);
  p.y -= TILE * 8;
  const line = [60, 90, 120].map(d => enemy(g, p.x + d, p.y, 'shambler', 100));
  p.weapon = 9; p.cd = 0; p.fx = 1; p.fy = 0; step(g, { 1: fire });
  for (const e of line) assert.equal(g.enemies.includes(e), false);
});

test('co-op: revive a downed teammate; everyone down -> game over -> restart', () => {
  const g = arena(2), [a, b] = [g.players.get(1), g.players.get(2)];
  g.hurtPlayer(a, 999);
  b.x = a.x + 10; b.y = a.y;
  step(g, { 1: idle, 2: idle }, REVIVE_TICKS);
  assert.equal(a.alive, true);
  killNow(g, 30);
  g.hurtPlayer(a, 999); g.hurtPlayer(b, 999);
  step(g, { 1: idle, 2: idle });
  assert.equal(g.phase, 'over');
  step(g, { 1: idle, 2: idle }, 260);
  assert.equal(g.mult, 1); assert.equal(g.unlocked.size, 1); assert.ok(a.alive && b.alive);
});

test('enemies on every map reach a stationary player', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const g = new Game(seed); g.addPlayer(1, 'a', '#fff');
    const p = g.players.get(1);
    p.shield = 1e9; // invulnerable, so the wave never resets
    for (let i = 0; i < 4500; i++) { step(g, { 1: idle }); g.drainEvents(); }
    assert.equal(g.level, 1);
    assert.ok(g.enemies.length > 0);
    assert.equal(g.enemies.filter(e => Math.hypot(e.x - p.x, e.y - p.y) > 60).length, 0, `seed ${seed}`);
  }
});

test('deathmatch: everything unlocked, players hurt each other, frags, respawn shield, winner at the frag limit', () => {
  const g = arena(2, { mode: 'deathmatch' }), [a, b] = [g.players.get(1), g.players.get(2)];
  assert.equal(g.mult, 200);
  assert.equal(g.unlocked.size, WEAPONS.length);
  a.shield = b.shield = 0;
  b.x = a.x + 60; b.y = a.y; a.fx = 1; a.fy = 0; a.weapon = 9; a.ammo[9] = 10; // railgun
  step(g, { 1: fire, 2: idle });
  assert.equal(b.alive, false);
  assert.equal(a.frags, 1);
  step(g, { 1: idle, 2: idle }, DM_RESPAWN_TICKS);
  assert.equal(b.alive, true);
  assert.ok(b.shield > DM_SPAWN_SHIELD - 5, 'spawn shield');
  b.shield = 1; g.hurtPlayer(b, 999, 1);
  assert.equal(b.alive, true, 'shielded right after respawn');
  for (let i = a.frags; i < DM_FRAG_LIMIT; i++) { b.alive = true; b.shield = 0; b.hp = PLAYER_HP; g.hurtPlayer(b, 999, 1); }
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 1);
});

test('a long four-player game stays fast', () => {
  const g = new Game(11);
  for (let i = 1; i <= 4; i++) g.addPlayer(i, 'p' + i, '#fff');
  const t0 = performance.now();
  for (let i = 0; i < 8000; i++) {
    const inp = {};
    for (let k = 1; k <= 4; k++) inp[k] = { bits: [1, 2, 4, 8, 9, 6][Math.floor((i + k * 37) / 70) % 6] | (i % 9 < 4 ? 16 : 0), w: i % 500 === 0 ? (i / 500) % 10 : -1 };
    step(g, inp); g.drainEvents();
  }
  const ms = (performance.now() - t0) / 8000;
  assert.ok(ms < 2, `avg ${ms.toFixed(3)} ms per tick (budget 20 ms)`);
  JSON.stringify(g.snapshot());
});

test('placing works wherever you stand within your tile (never on top of yourself)', () => {
  const g = arena(), p = g.players.get(1);
  g.unlocked.add('barrel'); g.unlocked.add('fakewall');
  for (const off of [-9, -4, 0, 4, 9]) {
    g.objects = [];
    Object.assign(p, { x: MAP_W / 2 * TILE + 16 + off, y: MAP_H / 2 * TILE + 16, fx: 1, fy: 0, cd: 0, held: false, weapon: 3 });
    p.ammo[3] = 5;
    step(g, { 1: fire }); step(g, { 1: idle });
    const b = g.objects.find(o => o.kind === 'barrel');
    assert.ok(b, `placed at sub-tile offset ${off}`);
    assert.ok(Math.abs(b.x - p.x) >= 10 + TILE / 2, 'not overlapping the placer');
  }
});

test('co-op: players start and respawn on separate spots', () => {
  const g = arena(4);
  const spots = () => new Set([...g.players.values()].map(p => `${p.x},${p.y}`)).size;
  assert.equal(spots(), 4, 'start spots differ');
  for (const p of g.players.values()) p.alive = false;
  g.phase = 'break'; g.phaseTimer = 1; step(g, {}, 1); // next level respawns the downed
  assert.ok([...g.players.values()].every(p => p.alive));
  assert.equal(spots(), 4, 'respawn spots differ');
});

test('deathmatch: no level escalation and no level banners', () => {
  const g = arena(2, { mode: 'deathmatch' });
  for (let k = 0; k < 5; k++) { g.toSpawn = { shambler: 0, hexer: 0 }; g.enemies = []; step(g, {}, 200); }
  assert.equal(g.level, 1);
  assert.ok(!g.drainEvents().some(e => e.type === 'level'));
});

test('deathmatch: once someone wins, nobody can be hurt or fragged', () => {
  const g = arena(2, { mode: 'deathmatch' }), [a, b] = [g.players.get(1), g.players.get(2)];
  a.frags = DM_FRAG_LIMIT - 1; b.shield = 0;
  g.hurtPlayer(b, 999, 1);
  assert.equal(g.phase, 'over');
  step(g, {}, DM_RESPAWN_TICKS + 1); // b respawns during the 'over' phase
  b.shield = 0; a.shield = 0;
  g.hurtPlayer(b, 999, 1); g.hurtPlayer(a, 999, 2);
  assert.equal(a.frags, DM_FRAG_LIMIT); assert.equal(b.frags, 0);
  assert.equal(g.drainEvents().filter(e => e.type === 'winner').length, 1);
});
