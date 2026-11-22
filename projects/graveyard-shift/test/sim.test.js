import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, generateMap, flowField, movePlayer, blocked, WEAPONS, ENEMIES, TILE, MAP_W, MAP_H, PLAYER_SPEED, DIAG,
  REVIVE_TICKS, COMBO_TICKS, MAX_CHARGES, PLAYER_HP,
} from '../public/shared/sim.js';

const step = (g, inputs = {}, n = 1) => { for (let i = 0; i < n; i++) g.step(new Map(Object.entries(inputs).map(([k, v]) => [+k, v]))); };
const idle = { bits: 0, w: -1 };
// A game in the fighting phase with one player standing in the clear centre.
function arena(players = 1) {
  const g = new Game(5);
  for (let i = 1; i <= players; i++) g.addPlayer(i, 'p' + i, '#fff');
  g.phase = 'wave'; g.toSpawn = []; g.drainEvents();
  return g;
}
const enemy = (g, x, y, kind = 'shambler', hp = ENEMIES[kind].hp) => { const e = { id: g.nextId++, kind, x, y, hp, maxHp: hp, speed: 0, cd: 999 }; g.enemies.push(e); return e; };

test('maps: closed border, open gates, clear centre, every gate reachable', () => {
  for (let seed = 1; seed < 40; seed++) {
    const m = generateMap(seed);
    assert.equal(m.tiles.length, MAP_H); assert.equal(m.tiles[0].length, MAP_W);
    assert.equal(m.tiles[MAP_H / 2][MAP_W / 2], 0);
    const d = flowField(m.tiles, [[MAP_W / 2, MAP_H / 2]]);
    for (const [x, y] of m.spawns) assert.ok(d[Math.floor(y / TILE)][Math.floor(x / TILE)] >= 0, `seed ${seed}: spawn unreachable`);
    assert.equal(m.tiles[5][0], 1, 'border closed away from gates');
  }
});

test('movement: speed, diagonal normalisation, walls stop you, facing follows movement', () => {
  const m = generateMap(2), objs = [];
  const p = { x: MAP_W / 2 * TILE, y: MAP_H / 2 * TILE, fx: 0, fy: -1 };
  movePlayer(m, objs, p, 8);
  assert.equal(p.x, MAP_W / 2 * TILE + PLAYER_SPEED);
  assert.deepEqual([p.fx, p.fy], [1, 0]);
  const q = { ...p };
  movePlayer(m, objs, q, 2 | 4);
  assert.ok(Math.abs(q.x - (p.x - PLAYER_SPEED * DIAG)) < 1e-9 && Math.abs(q.y - (p.y + PLAYER_SPEED * DIAG)) < 1e-9);
  for (let i = 0; i < 400; i++) movePlayer(m, objs, q, 1);
  assert.ok(!blocked(m, objs, q.x, q.y, 10), 'never inside a wall');
  assert.ok(q.y >= 10, 'stopped at the map edge (the top gate is open, the world ends there)');
});

test('enemies on every map find a stationary player (no one stuck at a gate)', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const g = new Game(seed); g.addPlayer(1, 'a', '#fff');
    const p = g.players.get(1);
    for (let i = 0; i < 2400; i++) { step(g, { 1: idle }); p.hp = PLAYER_HP; p.alive = true; g.drainEvents(); }
    assert.ok(g.enemies.length > 0);
    assert.equal(g.enemies.filter(e => Math.hypot(e.x - p.x, e.y - p.y) > 60).length, 0, `seed ${seed}`);
  }
});

test('pistol hits the first enemy in line; kills score with a growing multiplier', () => {
  const g = arena(), p = g.players.get(1);
  p.fx = 1; p.fy = 0;
  const e = enemy(g, p.x + 80, p.y, 'shambler', 20);
  const behind = enemy(g, p.x + 120, p.y, 'shambler', 20);
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(g.enemies.includes(e), false, 'front enemy died');
  assert.ok(g.enemies.includes(behind), 'pistol does not pierce');
  assert.equal(p.score, ENEMIES.shambler.points);
  step(g, { 1: idle }, WEAPONS[0].cd);
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(p.mult, 2, 'second kill within the combo window doubles');
  assert.equal(p.score, ENEMIES.shambler.points * 3);
  step(g, { 1: idle }, COMBO_TICKS + 1);
  assert.equal(p.mult, 1, 'multiplier resets when the window passes');
});

test('weapons unlock by score in key order and come with ammo; out of ammo falls back to pistol', () => {
  const g = arena(), p = g.players.get(1);
  p.score = WEAPONS[3].unlock - 10;
  p.fx = 1; p.fy = 0;
  enemy(g, p.x + 60, p.y, 'shambler', 1);
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(p.unlocked, 4, 'SMG, shotgun and barrel unlocked');
  assert.equal(p.ammo[1], WEAPONS[1].grant);
  assert.ok(g.drainEvents().some(e => e.type === 'unlock' && /Barrel \(key 4\)/.test(e.text)));
  step(g, { 1: { bits: 0, w: 2 } });
  assert.equal(p.weapon, 2);
  step(g, { 1: { bits: 0, w: 9 } });
  assert.equal(p.weapon, 2, 'cannot select a locked weapon');
  p.ammo[2] = 1; p.cd = 0;
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(p.weapon, 0, 'shotgun empty -> pistol');
});

test('shotgun fires several pellets; railgun pierces a whole line', () => {
  const g = arena(), p = g.players.get(1);
  p.fx = 1; p.fy = 0; p.unlocked = 10; p.ammo = WEAPONS.map(w => w.ammo);
  p.weapon = 2;
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(g.drainEvents().filter(e => e.type === 'tracer').length, WEAPONS[2].pellets);
  const line = [60, 90, 120].map(d => enemy(g, p.x + d, p.y, 'hexer', 100));
  p.weapon = 9; p.cd = 0;
  step(g, { 1: { bits: 16, w: -1 } });
  for (const e of line) assert.equal(g.enemies.includes(e), false, 'railgun killed every enemy in line');
});

test('barrels: placed in front, block movement, explode when shot, and chain', () => {
  const g = arena(), p = g.players.get(1);
  p.fx = 1; p.fy = 0; p.unlocked = 10; p.ammo = WEAPONS.map(w => w.ammo); p.weapon = 3;
  step(g, { 1: { bits: 16, w: -1 } });
  step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(g.objects.filter(o => o.kind === 'barrel').length, 1, 'placing needs a fresh press (and a free tile)');
  const b1 = g.objects[0];
  assert.ok(blocked(g.map, g.objects, b1.x, b1.y, 10));
  g.objects.push({ id: g.nextId++, kind: 'barrel', x: b1.x + TILE * 2, y: b1.y, hp: 1, owner: 1 });
  const victim = enemy(g, b1.x + TILE * 2 + 20, b1.y, 'shambler', 80);
  p.weapon = 0; p.cd = 0;
  step(g, { 1: { bits: 16, w: -1 } }); // shoot the first barrel
  step(g, { 1: idle }, 2);             // chain reaction next tick
  assert.equal(g.objects.length, 0, 'both barrels went up');
  assert.equal(g.enemies.includes(victim), false, 'the chained barrel killed the enemy');
  assert.ok(p.hp < PLAYER_HP, 'standing close to your own barrel hurts');
});

test('grenades, rockets, mines and charges explode', () => {
  const g = arena(), p = g.players.get(1);
  p.fx = 1; p.fy = 0; p.unlocked = 10; p.ammo = WEAPONS.map(w => w.ammo);
  const boomsIn = n => { step(g, { 1: idle }, n); return g.drainEvents().filter(e => e.type === 'boom').length; };
  p.weapon = 4; step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(boomsIn(40), 1, 'grenade fuse');
  p.weapon = 7; p.cd = 0; enemy(g, p.x + 200, p.y, 'shambler', 999); step(g, { 1: { bits: 16, w: -1 } });
  assert.equal(boomsIn(30), 1, 'rocket hits');
  p.weapon = 6; p.cd = 0; step(g, { 1: { bits: 16, w: -1 } });
  const mine = g.objects.find(o => o.kind === 'mine');
  enemy(g, mine.x, mine.y, 'shambler', 999);
  assert.equal(boomsIn(3), 1, 'mine triggers');
  g.enemies = [];
  p.weapon = 8;
  for (let i = 0; i <= MAX_CHARGES; i++) { p.cd = 0; step(g, { 1: { bits: 16, w: -1 } }); step(g, { 1: idle }); g.players.get(1).y += TILE * 2; }
  assert.ok(g.drainEvents().filter(e => e.type === 'boom').length + boomsIn(2) >= MAX_CHARGES, 'the 4th press detonates the charges');
  assert.equal(g.objects.filter(o => o.kind === 'charge').length, 0);
});

test('shamblers bite, hexers cast fireballs, barricades get smashed', () => {
  const g = arena(), p = g.players.get(1);
  const s = enemy(g, p.x + 20, p.y, 'shambler'); s.cd = 0;
  step(g, { 1: idle });
  assert.equal(p.hp, PLAYER_HP - ENEMIES.shambler.dmg);
  g.enemies = [];
  const h = enemy(g, p.x + 200, p.y, 'hexer'); h.cd = 0;
  step(g, { 1: idle });
  assert.equal(g.shots.filter(x => x.kind === 'fireball').length, 1);
  step(g, { 1: idle }, 60);
  assert.ok(p.hp < PLAYER_HP - ENEMIES.shambler.dmg, 'fireball hit');
  g.enemies = []; g.shots = [];
  const bar = { id: g.nextId++, kind: 'barricade', x: p.x + TILE * 2, y: p.y, hp: 160, owner: 1 };
  g.objects.push(bar);
  const z = enemy(g, bar.x + TILE, bar.y, 'shambler'); z.speed = 1.5; z.cd = 0;
  step(g, { 1: idle }, 400);
  assert.ok(bar.hp < 160 || !g.objects.includes(bar), 'the shambler attacked the barricade in its way');
});

test('downed players are revived by a teammate; everyone down -> game over -> restart', () => {
  const g = arena(2), [a, b] = [g.players.get(1), g.players.get(2)];
  g.hurtPlayer(a, 999);
  assert.equal(a.alive, false);
  b.x = a.x + 10; b.y = a.y;
  step(g, { 1: idle, 2: idle }, REVIVE_TICKS);
  assert.equal(a.alive, true);
  assert.equal(a.hp, PLAYER_HP / 2);
  a.score = 5000; a.unlocked = 5;
  g.hurtPlayer(a, 999); g.hurtPlayer(b, 999);
  step(g, { 1: idle, 2: idle });
  assert.equal(g.phase, 'over');
  step(g, { 1: idle, 2: idle }, 160);
  assert.equal(g.phase, 'break');
  assert.ok(a.alive && b.alive);
  assert.equal(a.score, 0); assert.equal(a.unlocked, 1);
});

test('waves: break, spawn, clear, next wave bigger; dead players respawn at wave start', () => {
  const g = new Game(9); g.addPlayer(1, 'a', '#fff'); g.addPlayer(2, 'b', '#fff');
  step(g, { 1: idle, 2: idle }, 91);
  assert.equal(g.phase, 'wave'); assert.equal(g.wave, 1);
  const first = g.toSpawn.length + g.enemies.length;
  g.hurtPlayer(g.players.get(2), 999);
  g.toSpawn = []; g.enemies = [];
  step(g, { 1: idle, 2: idle });
  assert.equal(g.phase, 'break');
  step(g, { 1: idle, 2: idle }, 151);
  assert.equal(g.wave, 2);
  assert.ok(g.toSpawn.length + g.enemies.length > first);
  assert.equal(g.players.get(2).alive, true, 'respawned for the new wave');
});

test('pickups heal and refill ammo', () => {
  const g = arena(), p = g.players.get(1);
  p.hp = 50; p.unlocked = 3; p.ammo[1] = 0; p.ammo[2] = 0;
  g.pickups.push({ id: 1, kind: 'health', x: p.x, y: p.y, ttl: 100 }, { id: 2, kind: 'ammo', x: p.x, y: p.y, ttl: 100 });
  step(g, { 1: idle });
  assert.equal(p.hp, 85);
  assert.ok(p.ammo[1] + p.ammo[2] > 0);
  assert.equal(g.pickups.length, 0);
});

test('a long game with four players stays fast and consistent', () => {
  const g = new Game(11);
  for (let i = 1; i <= 4; i++) g.addPlayer(i, 'p' + i, '#fff');
  const t0 = performance.now();
  for (let i = 0; i < 6000; i++) {
    const inp = {};
    for (let k = 1; k <= 4; k++) inp[k] = { bits: [1, 2, 4, 8, 9, 6][Math.floor((i + k * 37) / 45) % 6] | (i % 7 < 4 ? 16 : 0), w: i % 300 === 0 ? (i / 300) % 10 : -1 };
    step(g, inp);
    g.drainEvents();
    for (const p of g.players.values()) assert.ok(!blocked(g.map, [], p.x, p.y, 10));
  }
  const ms = (performance.now() - t0) / 6000;
  assert.ok(ms < 3, `avg ${ms.toFixed(3)} ms per tick (tick budget 33 ms)`);
  JSON.stringify(g.snapshot());
});
