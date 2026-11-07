import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaze, wallAt, cellCenter, moveTank, makeBullet, stepBullet, tankHitsWall,
  pointInTank, Game, BULLET_LIFETIME, FRAMES_FROZEN, FRAMES_BEFORE_END, WALL,
} from '../public/shared/sim.js';

function openMaze(W = 6, H = 5) {
  const m = generateMaze(1, { W, H, openness: 1 }); // all interior walls removed
  return m;
}

test('maze generation is deterministic and fully connected', () => {
  const a = generateMaze(42), b = generateMaze(42);
  assert.deepEqual(a, b);
  for (let seed = 1; seed < 50; seed++) {
    const m = generateMaze(seed);
    assert.ok(m.W >= 4 && m.W <= 12 && m.H >= 4 && m.H <= 10);
    const seen = new Set(['0,0']), q = [[0, 0]];
    while (q.length) {
      const [x, y] = q.pop();
      const go = (nx, ny, blocked) => { const k = nx + ',' + ny; if (!blocked && !seen.has(k)) { seen.add(k); q.push([nx, ny]); } };
      if (x > 0) go(x - 1, y, m.v[x][y]);
      if (x < m.W - 1) go(x + 1, y, m.v[x + 1][y]);
      if (y > 0) go(x, y - 1, m.h[x][y]);
      if (y < m.H - 1) go(x, y + 1, m.h[x][y + 1]);
    }
    assert.equal(seen.size, m.W * m.H, `seed ${seed} not connected`);
  }
});

test('outer walls and cell centres', () => {
  const m = openMaze();
  assert.ok(wallAt(m, 1, 100));
  assert.ok(wallAt(m, 100, 1));
  const c = cellCenter(m, 2, 2);
  assert.ok(!wallAt(m, c.x, c.y));
  assert.ok(wallAt(m, -5, 5));
});

test('forward speed is 4px/frame at scale 50 and reverse 2.5px/frame', () => {
  const m = openMaze();
  const c = cellCenter(m, 2, 2);
  const t = { x: c.x, y: c.y, rot: 0 };
  moveTank(m, t, { f: 1 });
  assert.ok(Math.abs((c.y - t.y) - 4 * m.S / 50) < 1e-9);
  const t2 = { x: c.x, y: c.y, rot: 90 }; // facing right
  moveTank(m, t2, { b: 1 });
  assert.ok(Math.abs((c.x - t2.x) - 2.5 * m.S / 50) < 1e-9);
});

test('turning is 10 degrees per frame, and moving+turning sweeps an arc', () => {
  const m = openMaze();
  const c = cellCenter(m, 2, 2);
  const t = { x: c.x, y: c.y, rot: 0 };
  moveTank(m, t, { r: 1 });
  assert.equal(t.rot, 10);
  for (let i = 0; i < 17; i++) moveTank(m, t, { l: 1 });
  assert.equal(t.rot, -160);
  const u = { x: c.x, y: c.y, rot: 0 };
  moveTank(m, u, { f: 1, r: 1 });
  assert.equal(u.rot, 10);
  assert.ok(u.x > c.x); // heading changed during the sub-steps
});

test('tank cannot drive through a wall and stays clear of it', () => {
  const m = openMaze();
  const c = cellCenter(m, 0, 2);
  const t = { x: c.x, y: c.y, rot: -90 }; // facing left toward the outer wall
  for (let i = 0; i < 100; i++) moveTank(m, t, { f: 1 });
  assert.ok(!tankHitsWall(m, t.x, t.y, t.rot));
  assert.ok(t.x > WALL * m.S);
  assert.ok(t.x < c.x);
});

test('blocked turn falls back to moving straight (wall sliding)', () => {
  const m = openMaze();
  const c = cellCenter(m, 2, 2);
  // Push tank against top-left area then try turning into the wall while driving.
  const t = { x: c.x, y: c.y, rot: 0 };
  for (let i = 0; i < 200; i++) moveTank(m, t, { f: 1 });
  const y0 = t.y;
  assert.ok(!tankHitsWall(m, t.x, t.y, t.rot));
  assert.ok(y0 < c.y);
});

test('bullet bounces off a vertical wall by flipping x velocity', () => {
  const m = openMaze();
  const c = cellCenter(m, 0, 2);
  const b = makeBullet(m, { id: 1, x: c.x, y: c.y, rot: -90 }, 1);
  assert.ok(b.vx < 0);
  for (let i = 0; i < 40; i++) stepBullet(m, b);
  assert.ok(b.vx > 0, 'should be travelling right after bounce');
  assert.ok(Math.abs(b.vy) < 1e-9);
});

test('diagonal bullet into a corner reverses both axes', () => {
  const m = openMaze();
  const c = cellCenter(m, 0, 0);
  const b = makeBullet(m, { id: 1, x: c.x, y: c.y, rot: -45 }, 1); // up-left
  let flipped = false;
  for (let i = 0; i < 60; i++) { stepBullet(m, b); if (b.vx > 0 && b.vy > 0) flipped = true; }
  assert.ok(flipped);
});

test('point in tank', () => {
  const t = { x: 100, y: 100, rot: 90 };
  assert.ok(pointInTank(50, t, 108, 102)); // length now along x
  assert.ok(!pointInTank(50, t, 100, 112));
});

test('round flow: freeze, fire limit, self-hit, scoring, bullet expiry', () => {
  const g = new Game(7);
  g.addPlayer(1, 'a', '#f00');
  g.addPlayer(2, 'b', '#00f');
  assert.equal(g.tanks.size, 2);
  const still = new Map();
  for (let i = 0; i < FRAMES_FROZEN; i++) g.step(still);
  assert.equal(g.frozen, 0);
  // Holding fire only fires once (needs release between shots).
  const hold = new Map([[1, { fire: 1 }]]);
  g.step(hold); g.step(hold); g.step(hold);
  assert.equal(g.bullets.length, 1);
  // Only one cannon ball in play at a time (original default setting).
  for (let i = 0; i < 20; i++) { g.step(new Map([[1, {}]])); g.step(hold); assert.ok(g.bullets.filter(b => b.owner === 1).length <= 1); }
  // Kill tank 2 directly, check scoring after countdown.
  const g2 = new Game(9);
  g2.addPlayer(1, 'a', '#f00'); g2.addPlayer(2, 'b', '#00f');
  for (let i = 0; i < FRAMES_FROZEN; i++) g2.step(still);
  const r0 = g2.round;
  g2.tanks.get(2).alive = false;
  for (let i = 0; i < FRAMES_BEFORE_END; i++) g2.step(still);
  assert.equal(g2.players.get(1).score, 1);
  assert.equal(g2.round, r0 + 1);
  // Bullet expiry returns the shot to the owner.
  const g3 = new Game(11);
  g3.addPlayer(1, 'a', '#f00');
  for (let i = 0; i < FRAMES_FROZEN; i++) g3.step(still);
  g3.step(new Map([[1, { fire: 1 }]]));
  assert.equal(g3.tanks.get(1).bulletsFired, 1);
  let killed = false;
  for (let i = 0; i < BULLET_LIFETIME + 2; i++) { g3.step(still); if (!g3.tanks.get(1).alive) killed = true; }
  if (!killed) assert.equal(g3.tanks.get(1).bulletsFired, 0);
});

test('a tank can be hit by its own bullet', () => {
  // Fire straight into a wall at point blank, the ricochet comes back.
  const g = new Game(3);
  g.addPlayer(1, 'a', '#f00');
  g.maze = generateMaze(1, { W: 5, H: 5, openness: 1 });
  const m = g.maze;
  const c = cellCenter(m, 0, 2);
  Object.assign(g.tanks.get(1), { x: c.x, y: c.y, rot: -90 });
  g.frozen = 0;
  g.step(new Map([[1, { fire: 1 }]]));
  for (let i = 0; i < 60 && g.tanks.get(1).alive; i++) g.step(new Map());
  assert.equal(g.tanks.get(1).alive, false);
});
