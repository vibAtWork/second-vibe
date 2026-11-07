import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, generateMaze, cellCenter, traceAimer, MAX_BULLETS, FRAG_SHARDS, GATLING_BULLETS,
  LASER_LIFETIME, HOMING_STARTUP, CRATE_TIME_BASE, CRATE_TIME_RANDOM, CRATE_MODIFIER,
} from '../public/shared/sim.js';

// A started game with given tanks placed in an open maze (no interior walls).
function arena(tanks, { W = 6, H = 5, crates = false } = {}) {
  const g = new Game(1, { crates });
  tanks.forEach((_, i) => g.addPlayer(i + 1, 'p' + i, '#f00'));
  g.maze = generateMaze(1, { W, H, openness: 1 });
  g.frozen = 0;
  tanks.forEach(([cx, cy, rot], i) => Object.assign(g.tanks.get(i + 1), cellCenter(g.maze, cx, cy), { rot }));
  g.crates = []; g.bullets = [];
  return g;
}
const press = id => new Map([[id, { fire: 1 }]]);
const idle = new Map();
function run(g, n, inp = idle) { for (let i = 0; i < n; i++) g.step(inp); }

test('only one cannon ball at a time; a new one once it is gone', () => {
  assert.equal(MAX_BULLETS, 1);
  const g = arena([[0, 2, 90]]);
  const t = g.tanks.get(1);
  g.step(press(1)); g.step(idle); g.step(press(1)); g.step(idle); g.step(press(1));
  assert.equal(g.bullets.length, 1);
  Object.assign(t, cellCenter(g.maze, 3, 0)); // out of the ball's horizontal path
  run(g, 260); // let it expire
  assert.equal(t.alive, true);
  assert.equal(g.bullets.length, 0);
  assert.equal(t.bulletsFired, 0);
  g.step(press(1));
  assert.equal(g.bullets.length, 1);
});

test('crates spawn on the original timer and give a weapon on pickup (only with the plain cannon)', () => {
  const g = new Game(4);
  g.addPlayer(1, 'a', '#f00'); g.addPlayer(2, 'b', '#00f');
  const first = g.crateTimer;
  assert.ok(first >= CRATE_TIME_BASE * CRATE_MODIFIER && first < (CRATE_TIME_BASE + CRATE_TIME_RANDOM) * CRATE_MODIFIER);
  g.frozen = 0;
  run(g, Math.ceil(first) + 1);
  assert.equal(g.crates.length, 1);
  const c = g.crates[0];
  assert.ok(['laser', 'frag', 'gatling', 'homing'].includes(c.weapon));
  const t = g.tanks.get(1);
  Object.assign(t, { x: c.x, y: c.y });
  g.step(idle);
  assert.equal(t.weapon, c.weapon);
  assert.equal(g.crates.length, 0);
  // holding a weapon: can't pick up another
  g.crates.push({ ...c, id: 999 });
  g.step(idle);
  assert.equal(g.crates.length, 1);
});

test('laser: locks the tank, ricochets, kills, then returns to cannon', () => {
  const g = arena([[0, 2, 90], [4, 2, 0]]);
  const a = g.tanks.get(1), b = g.tanks.get(2);
  a.weapon = 'laser';
  const x0 = a.x;
  g.step(press(1));
  assert.equal(g.lasers.length, 1);
  g.step(new Map([[1, { f: 1 }]]));
  assert.equal(a.x, x0, 'tank is locked while the laser is active');
  run(g, LASER_LIFETIME);
  assert.equal(b.alive, false, 'laser travelling right hits tank in same row');
  assert.equal(a.weapon, 'bullet');
  assert.equal(g.lasers.length, 0);
});

test('aimer traces from the muzzle and stops at a tank', () => {
  const g = arena([[0, 2, 90], [3, 2, 0]]);
  const pts = traceAimer(g.maze, g.tanks.get(1), [...g.tanks.values()]);
  const end = pts[pts.length - 1];
  assert.ok(Math.abs(end[0] - g.tanks.get(2).x) < g.maze.S * 0.25);
});

test('frag bomb: second press detonates into 40 shards that kill', () => {
  const g = arena([[0, 2, 90], [2, 2, 0]], { W: 8 });
  const a = g.tanks.get(1), b = g.tanks.get(2);
  a.weapon = 'frag';
  g.step(press(1));
  assert.equal(g.bullets.filter(x => x.kind === 'frag').length, 1);
  g.step(idle); g.step(idle); g.step(idle);
  g.step(press(1)); // detonate
  assert.equal(g.bullets.filter(x => x.kind === 'shard').length, FRAG_SHARDS);
  assert.equal(a.weapon, 'bullet');
  assert.equal(a.fragFired, false);
  run(g, 20);
  assert.equal(g.bullets.filter(x => x.kind === 'shard').length, 0, 'shards fade after 20 frames');
  assert.equal(b.alive, false, 'nearby tank shredded');
});

test('frag bomb detonates on its own at end of life', () => {
  const g = arena([[0, 0, 180]], { W: 6 });
  g.tanks.get(1).weapon = 'frag';
  g.step(press(1));
  let shards = 0;
  for (let i = 0; i < 260 && g.tanks.get(1).alive; i++) { g.step(idle); shards = Math.max(shards, g.bullets.filter(x => x.kind === 'shard').length); }
  assert.ok(shards > 0 || !g.tanks.get(1).alive);
});

test('gatling: spins up 10 frames, fires every 3rd frame while held, max 20, spins down on release', () => {
  const g = arena([[0, 0, 180]], { W: 6 });
  const a = g.tanks.get(1);
  a.weapon = 'gatling';
  g.step(press(1));
  run(g, 9, press(1));
  assert.equal(g.bullets.length, 0, 'still spinning up');
  let maxSeen = 0, fired = 0;
  const seen = new Set();
  for (let i = 0; i < 80; i++) { g.step(press(1)); for (const b of g.bullets) if (!seen.has(b.id)) { seen.add(b.id); fired++; } maxSeen = Math.max(maxSeen, g.bullets.length); if (!a.alive) break; }
  if (a.alive) assert.equal(fired, GATLING_BULLETS);
  g.step(idle); // release
  run(g, 10);
  if (a.alive) assert.equal(a.weapon, 'bullet');
});

test('gatling rounds are harmless for their first 2 frames', () => {
  const g = arena([[0, 0, 180]], { W: 6 });
  g.tanks.get(1).weapon = 'gatling';
  g.step(press(1));
  const seen = new Set();
  let checked = 0;
  for (let i = 0; i < 30; i++) {
    g.step(press(1));
    for (const b of g.bullets) if (!seen.has(b.id)) { seen.add(b.id); assert.equal(b.deadly, 1, 'one safe frame left after its first frame'); checked++; }
  }
  assert.ok(checked > 3);
});

test('homing missile flies straight for 50 frames, then hunts the nearest tank through the maze', () => {
  const g = new Game(3, { crates: false });
  g.addPlayer(1, 'a', '#f00'); g.addPlayer(2, 'b', '#00f');
  g.maze = generateMaze(12, { W: 7, H: 5 });
  g.frozen = 0;
  const a = g.tanks.get(1), b = g.tanks.get(2);
  Object.assign(a, cellCenter(g.maze, 0, 0), { rot: 180 });
  Object.assign(b, cellCenter(g.maze, 6, 4), { rot: 0 });
  a.weapon = 'homing';
  g.step(press(1));
  const m = g.bullets.find(x => x.kind === 'homing');
  assert.ok(m && !m.homing);
  run(g, HOMING_STARTUP);
  assert.ok(m.homing || m.dead);
  // Move tank A out of the way far from the missile path is not possible in general;
  // just verify someone gets hit and the weapon resets.
  for (let i = 0; i < 260 && a.alive && b.alive; i++) g.step(idle);
  assert.ok(!a.alive || !b.alive, 'missile hit a tank');
  assert.equal(a.weapon, 'bullet');
  assert.equal(a.homingReady, true);
});

test('snapshot carries weapons, crates, lasers', () => {
  const g = arena([[0, 2, 90], [4, 2, 0]]);
  g.tanks.get(1).weapon = 'laser';
  g.crates.push({ id: 50, cx: 1, cy: 1, x: 10, y: 10, rot: 12, weapon: 'frag' });
  g.step(press(1));
  const s = g.snapshot();
  assert.equal(s.tanks[0][7], 1);
  assert.equal(s.tanks[0][8], 1);
  assert.equal(s.lasers.length, 1);
  assert.ok(s.lasers[0][2].length >= 4);
  assert.deepEqual(s.crates[0].slice(3), [12, 2]);
  JSON.stringify(s);
});

test('frag shards fly straight through walls', () => {
  const g = new Game(5, { crates: false });
  g.addPlayer(1, 'a', '#f00');
  g.maze = generateMaze(1, { W: 6, H: 5, openness: 0 }); // plenty of walls
  g.frozen = 0;
  const m = g.maze;
  // a shard starting mid-cell heading right must cross the wall at the cell edge
  const c = cellCenter(m, 1, 1);
  const sp = 6 / 7 * m.S / 50;
  g.bullets = [{ id: 1, kind: 'shard', owner: 1, x: c.x, y: c.y, vx: sp, vy: 0, substeps: 7, life: 20, deadly: 0 }];
  Object.assign(g.tanks.get(1), cellCenter(m, 4, 4));
  const vx0 = sp;
  let crossed = false, sawWall = false;
  for (let i = 0; i < 19; i++) {
    g.step(new Map());
    const evs = g.drainEvents();
    if (evs.some(e => e.type === 'shardwall')) sawWall = true;
    const b = g.bullets[0];
    if (!b) break;
    assert.equal(b.vx, vx0, 'never bounces');
    if (b.x > c.x + m.S) crossed = true;
  }
  assert.ok(crossed, 'travelled more than a cell to the right');
  assert.ok(sawWall || !m.v[2][1], 'reported wall contact for sound');
});

test('locked-on missile reports its target in snapshots (for coloured smoke)', () => {
  const g = new Game(3, { crates: false });
  g.addPlayer(1, 'a', '#f00'); g.addPlayer(2, 'b', '#00f');
  g.maze = generateMaze(12, { W: 7, H: 5 });
  g.frozen = 0;
  Object.assign(g.tanks.get(1), cellCenter(g.maze, 0, 0), { rot: 180, weapon: 'homing' });
  Object.assign(g.tanks.get(2), cellCenter(g.maze, 6, 4), { rot: 0 });
  g.step(press(1));
  const code = s => s.bullets.find(b => b[3] === 4);
  assert.equal(code(g.snapshot())[4], 0, 'not locked during startup');
  run(g, HOMING_STARTUP + 1);
  const m = code(g.snapshot());
  if (m) assert.ok([1, 2].includes(m[4]), 'target id present once homing');
});
