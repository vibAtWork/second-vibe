import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, makeArena, move, at, cell, rng, dangerMap, Prediction, CELL, COLS, ROWS, SPEEDS, FUSE, FLAME, SLIDE, FLY_TICKS,
  LIVES, INVINCIBLE, TELEPORT_WAIT, FIRE_TICKS, ROUND_SECONDS, SUDDEN_DEATH, WALL_EVERY, WALL_MAX, POOL, BONUS,
  READY_TICKS, RESULT_TICKS, TICK_HZ, CORNERS, UP, DOWN, LEFT, RIGHT, BOMB_KEY, OPEN, WALL, CRATE, BOMB,
} from '../public/shared/game.js';

const step = (g, keys = {}, n = 1) => { for (let i = 0; i < n; i++) g.step(new Map(Object.entries(keys).map(([id, k]) => [+id, { frames: [{ keys: k }] }]))); };
function duel(arena = 'madness') { // two players, in play
  const g = new Game({ seed: 7, arena });
  g.addPlayer(1, 'A', '#fff'); g.addPlayer(2, 'B', '#fff');
  step(g); step(g, {}, READY_TICKS);
  assert.equal(g.phase, 'play');
  g.drain();
  return [g, g.players.get(1), g.players.get(2)];
}
function open(g) { // pillars only, standard starting stats, B parked far away
  g.grid = makeArena('madness', 1).grid; g.floor = []; g.bombs = []; g.flames = []; g.burning.clear(); g.powerups.clear();
  for (const p of g.fighters()) Object.assign(p, { speed: 2, length: 2, bombs: 1, laid: 0, kick: false, glove: -1 });
  Object.assign(g.players.get(2), { x: 13 * CELL, y: 11 * CELL });
}

test('recovered numbers', () => {
  assert.equal(TICK_HZ, 24);
  assert.deepEqual(SPEEDS, [2, 3, 5, 6, 10]);
  assert.deepEqual([FUSE, FLAME, SLIDE, FLY_TICKS, LIVES, INVINCIBLE, TELEPORT_WAIT, FIRE_TICKS], [60, 25, 10, 9, 3, 75, 24, 25]);
  assert.deepEqual([ROUND_SECONDS, SUDDEN_DEATH, WALL_EVERY, WALL_MAX, BONUS], [180, 40, 8, 80, 250]);
  assert.deepEqual(POOL, [8, 8, 8, 4, 4]);
  assert.deepEqual(CORNERS, [[1, 1], [13, 11], [1, 11], [13, 1]]);
  for (const v of SPEEDS) assert.equal(CELL % v, 0, 'every speed lands exactly on cell centres');
});

test('arenas: border and even/even pillars; start corners clear; 20 random crates removed', () => {
  for (let seed = 1; seed < 40; seed++) {
    const { grid } = makeArena('classic', seed);
    let crates = 0, open = 0;
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
      const v = grid[cell(i, j)];
      if (i === 0 || j === 0 || i === COLS - 1 || j === ROWS - 1 || (i % 2 === 0 && j % 2 === 0)) assert.equal(v, WALL);
      else if (v === CRATE) crates++; else open++;
    }
    assert.equal(open, 4 * 5 + 20); assert.equal(crates, 13 * 11 - 6 * 5 - 40);
  }
  const f = makeArena('firelines', 2), t = makeArena('teleport', 2);
  assert.ok(f.floor.length > 20 && f.floor.every(x => f.grid[cell(x.i, x.j)] === OPEN));
  assert.equal(t.floor.length, 4); assert.ok(t.floor.every(x => t.grid[cell(x.i, x.j)] === OPEN));
  assert.ok(makeArena('madness', 2).grid.every(v => v !== CRATE));
});

test('movement: one axis at a time, lined up with the grid, at the table speeds; walls block', () => {
  const g = makeArena('madness', 1).grid, p = { x: 30, y: 30, dir: 2, speed: 2 };
  move(g, p, RIGHT); assert.deepEqual([p.x, p.y, p.dir], [35, 30, 4]);
  move(g, p, DOWN); assert.deepEqual([p.x, p.y], [30, 30], 'off the column: no vertical move; the assist slides back');
  for (let i = 0; i < 6; i++) move(g, p, RIGHT);
  assert.equal(p.x, 60);
  move(g, p, DOWN); assert.equal(p.y, 30, 'the pillar at (2,2) blocks');
  const q = { x: 30, y: 30, dir: 2, speed: 2 }; move(g, q, LEFT); assert.equal(q.x, 30, 'the border blocks');
  for (const [s, n] of [[0, 15], [1, 10], [3, 5], [4, 3]]) { const r = { x: 30, y: 30, dir: 2, speed: s }; for (let i = 0; i < n; i++) move(g, r, RIGHT); assert.equal(r.x, 60); }
});

test('movement: corner assist', () => {
  const g = makeArena('madness', 1).grid;
  const p = { x: 40, y: 30, dir: 4, speed: 2 }; move(g, p, DOWN); assert.equal(p.x, 35, 'toward the open column 1');
  move(g, p, DOWN); move(g, p, DOWN); assert.deepEqual([p.x, p.y], [30, 35]);
  const q = { x: 80, y: 30, dir: 4, speed: 2 }; move(g, q, DOWN); assert.equal(q.x, 85, 'toward column 3');
  const r = { x: 40, y: 30, dir: 4, speed: 2 }; move(g, r, DOWN | RIGHT); assert.equal(r.x, 45, 'no assist while holding a side key');
});

test('bombs: lay, block, 60-tick fuse, flames reach their length, crates burn 25 ticks then clear', () => {
  const [g, a] = duel('classic');
  for (const c of [cell(2, 1), cell(1, 2), cell(1, 3), cell(1, 4)]) g.grid[c] = OPEN;
  g.grid[cell(3, 1)] = CRATE;
  step(g, { 1: BOMB_KEY }); step(g, { 1: 0 });
  assert.equal(at(g.grid, 1, 1), BOMB); assert.equal(a.laid, 1);
  step(g, { 1: BOMB_KEY }); step(g, { 1: 0 }); assert.equal(g.bombs.length, 1, 'one bomb at a time to start');
  for (let i = 0; i < 6; i++) step(g, { 1: DOWN });
  assert.equal(a.y, 60, 'walk off your bomb');
  for (let i = 0; i < 6; i++) step(g, { 1: UP });
  assert.equal(a.y, 60, 'but not back onto it');
  for (let i = 0; i < 12; i++) step(g, { 1: DOWN });
  const b = g.bombs[0];
  while (b.count < FUSE - 1) step(g);
  step(g);
  assert.deepEqual(g.flames.map(f => `${f.i},${f.j}`).sort(), ['1,2', '1,3', '2,1', '3,1']);
  assert.ok(g.burning.has(cell(3, 1)));
  step(g, {}, FLAME - 1); assert.equal(at(g.grid, 3, 1), CRATE, 'still solid while burning');
  step(g); assert.equal(at(g.grid, 3, 1), OPEN); assert.equal(g.flames.length, 0);
  assert.equal(at(g.grid, 1, 1), OPEN); assert.equal(a.laid, 0, 'the bomb comes back');
});

test('a burnt crate leaves an open cell and at most a power-up - never a bomb', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = new Game({ seed }); g.pool = [1e9, 1e9, 1e9, 1e9, 1e9];
    g.grid[cell(3, 3)] = CRATE; g.burning.set(cell(3, 3), FLAME - 1);
    g.phase = 'play'; g.addPlayer(1, 'A', '#fff'); g.addPlayer(2, 'B', '#fff');
    for (const p of g.players.values()) Object.assign(p, { fighting: true, alive: true, slot: p.id, x: 30, y: 30, lives: 3, inv: 0, speed: 2, length: 2, bombs: 1, laid: 0, glove: -1, padWait: 0 });
    g.players.get(2).x = 390;
    g.play(new Map());
    assert.equal(at(g.grid, 3, 3), OPEN);
    assert.equal(g.bombs.length, 0);
  }
});

test('flames: walls stop them, power-ups let them through, other bombs go off a tick later', () => {
  const [g, a] = duel(); open(g);
  Object.assign(a, { x: 30, y: 30, length: 4, bombs: 2 });
  g.powerups.set(cell(3, 1), 0);
  step(g, { 1: BOMB_KEY }); step(g, { 1: 0 });
  Object.assign(a, { x: 150, y: 30 }); step(g, { 1: BOMB_KEY }); step(g, { 1: 0 });
  Object.assign(a, { x: 90, y: 90 });
  const [first, second] = g.bombs;
  first.count = FUSE - 1; second.count = 5;
  step(g);
  assert.ok(g.flames.some(f => f.i === 3 && f.j === 1) && g.flames.some(f => f.i === 4 && f.j === 1));
  assert.ok(!g.flames.some(f => f.i === 5 && f.j === 1), 'the other bomb\'s cell stops the flame');
  assert.ok(g.powerups.has(cell(3, 1)), 'power-ups survive flames');
  assert.equal(second.count, FUSE - 1);
  step(g); assert.equal(second.count, FUSE, 'chain: next tick');
});

test('hits: a life, 75 ticks of invincibility, out at zero; everyone in an arm is hit; hit box sizes', () => {
  const [g, a, b] = duel(); open(g);
  Object.assign(a, { x: 90, y: 30 });
  g.hit(a); assert.deepEqual([a.lives, a.inv], [2, INVINCIBLE]);
  g.hit(a); assert.equal(a.lives, 2);
  a.inv = 0; g.hit(a); a.inv = 0; g.hit(a);
  assert.equal(a.alive, false);
  step(g); assert.equal(g.phase, 'result'); assert.equal(g.winner, 2);
  const [h, c, d] = duel(); open(h);
  Object.assign(c, { x: 30, y: 90 }); Object.assign(d, { x: 30, y: 90 });
  h.bombs.push({ id: 99, owner: 1, x: 30, y: 30, cx: 1, cy: 1, count: FUSE - 1, length: 2, state: 'still' });
  step(h);
  assert.deepEqual([c.lives, d.lives], [LIVES - 1, LIVES - 1], 'both players in the arm');
  const [k, e] = duel(); open(k);
  for (const [dx, dy, hit] of [[14, 0, true], [14.1, 0, false], [0, 25.6, true], [0, 25.7, false]]) {
    k.flames = [{ i: 3, j: 3, x: 90, y: 90, dir: 1, end: false, life: 5, spent: false }];
    Object.assign(e, { x: 90 + dx, y: 90 + dy, inv: 0, lives: 3 });
    k.updateFlames(k.fighters());
    assert.equal(e.lives < 3, hit, `offset ${dx},${dy}`);
  }
});

test('kick: with boots, walking into a bomb slides it at 10/tick until blocked', () => {
  const [g, a, b] = duel(); open(g);
  Object.assign(a, { x: 30, y: 30, kick: true });
  g.bombs.push({ id: 9, owner: 2, x: 90, y: 30, cx: 3, cy: 1, count: 0, length: 2, state: 'still' }); g.grid[cell(3, 1)] = BOMB;
  for (let i = 0; i < 7; i++) step(g, { 1: RIGHT });
  const bomb = g.bombs[0];
  assert.equal(bomb.state, 'slide'); assert.equal(at(g.grid, 3, 1), OPEN);
  step(g, {}, 40);
  assert.equal(bomb.state, 'still'); assert.equal(bomb.cx, 13); assert.equal(at(g.grid, 13, 1), BOMB);
  const [h, c] = duel(); open(h);
  Object.assign(c, { x: 30, y: 30 });
  h.bombs.push({ id: 9, owner: 2, x: 90, y: 30, cx: 3, cy: 1, count: 0, length: 2, state: 'still' }); h.grid[cell(3, 1)] = BOMB;
  for (let i = 0; i < 10; i++) step(h, { 1: RIGHT });
  assert.equal(h.bombs[0].state, 'still', 'no boots, no kick'); assert.equal(c.x, 60);
});

test('glove: pick up your bomb, carry it (no countdown), let go to throw 3 cells; throws wrap round the edges', () => {
  const [g, a] = duel(); open(g);
  Object.assign(a, { x: 90, y: 30, glove: 1, bombs: 2 });
  step(g, { 1: BOMB_KEY }); step(g, { 1: 0 });
  const bomb = g.bombs[0];
  step(g, { 1: BOMB_KEY });
  assert.equal(bomb.state, 'held'); assert.equal(at(g.grid, 3, 1), OPEN);
  const count = bomb.count;
  step(g, { 1: BOMB_KEY | RIGHT }, 6);
  assert.equal(bomb.count, count); assert.equal(bomb.x, a.x);
  step(g, { 1: 0 }); assert.equal(bomb.state, 'fly');
  step(g, {}, FLY_TICKS - 1);
  assert.equal(bomb.state, 'still'); assert.equal(bomb.x, a.x + 90); assert.equal(bomb.count, count);
  assert.equal(at(g.grid, bomb.cx, bomb.cy), BOMB, 'a landed bomb claims its cell at once');
  const [h, c] = duel(); open(h);
  Object.assign(c, { x: 360, y: 90, glove: 1, dir: 4 });
  step(h, { 1: BOMB_KEY }); step(h, { 1: 0 }); step(h, { 1: BOMB_KEY }); step(h, { 1: 0 });
  const w = h.bombs[0];
  for (let i = 0; i < 40 && w.state !== 'still'; i++) step(h);
  assert.ok(w.x < 200, `wrapped to the far side (x ${w.x})`);
  step(h); assert.equal(at(h.grid, w.cx, w.cy), BOMB);
});

test('bug fixes over the original: the layer gets a thrown bomb back; a carried bomb follows its carrier', () => {
  const [g, a, b] = duel(); open(g);
  Object.assign(a, { x: 90, y: 30, glove: 1 });
  g.bombs.push({ id: 9, owner: 2, x: 90, y: 30, cx: 3, cy: 1, count: 0, length: 2, state: 'still' }); g.grid[cell(3, 1)] = BOMB; b.laid = 1;
  step(g, { 1: BOMB_KEY }); step(g, { 1: BOMB_KEY | DOWN }, 6);
  assert.equal(g.bombs[0].y, a.y);
  step(g, { 1: 0 }); step(g, {}, FUSE + FLAME + 15);
  assert.equal(g.bombs.length, 0); assert.deepEqual([a.laid, b.laid], [0, 0]);
});

test('power-ups: only on the cell centre; speed caps at level 4; drop odds and pool', () => {
  const [g, a] = duel(); open(g);
  Object.assign(a, { x: 30, y: 30 });
  [1, 0, 2, 3, 4].forEach((t, n) => g.powerups.set(cell(2 + n, 1), t));
  step(g, { 1: RIGHT }, 2); assert.ok(g.powerups.has(cell(2, 1)));
  for (let i = 0; i < 40 && g.powerups.size; i++) step(g, { 1: RIGHT });
  assert.deepEqual([a.speed, a.length, a.bombs, a.kick, a.glove], [3, 3, 2, true, 1]);
  a.speed = 4; g.powerups.set(cell(near(a.x) + 1, 1), 1); step(g, { 1: RIGHT }, 3); assert.equal(a.speed, 4);
  const h = new Game({ seed: 1 }); h.pool = [1e9, 1e9, 1e9, 1e9, 1e9]; const n = [0, 0, 0, 0, 0];
  for (let k = 0; k < 20000; k++) { h.powerups.clear(); h.dropPowerup(14); if (h.powerups.has(14)) n[h.powerups.get(14)]++; }
  const total = n.reduce((x, y) => x + y);
  assert.ok(Math.abs(total / 20000 - 0.5) < 0.02); assert.ok(Math.abs(n[4] / total - 0.16) < 0.02);
  const p = new Game({ seed: 2 }); let got = 0;
  for (let k = 0; k < 5000; k++) { p.powerups.clear(); p.dropPowerup(14); if (p.powerups.size) got++; }
  assert.equal(got, 32, 'the pool runs out at 32');
});
const near = v => Math.round(v / CELL);

test('teleporters and fire lines', () => {
  const [g, a] = duel('teleport'); open(g); g.floor = makeArena('teleport', 1).floor;
  Object.assign(a, { x: 30, y: 210 });
  step(g, { 1: UP }); assert.deepEqual([a.x, a.y], [30, 205]);
  step(g, { 1: UP }); assert.deepEqual([a.x, a.y], [390, 180], 'on the partner pad');
  step(g, {}, TELEPORT_WAIT - 1); assert.deepEqual([a.x, a.y], [390, 180]);
  step(g); assert.deepEqual([a.x, a.y], [30, 180], 'stand still after the wait: sent back');
  const [h, c] = duel('firelines'); open(h); h.floor = makeArena('firelines', 1).floor;
  Object.assign(c, { x: 150, y: 300 });
  h.flames = [{ i: 9, j: 2, x: 270, y: 60, dir: 1, end: true, life: 3, spent: false }];
  step(h); assert.equal(h.fireOn, true); assert.equal(c.lives, LIVES - 1);
  step(h, {}, FIRE_TICKS); assert.equal(h.fireOn, false);
});

test('sudden death spiral and costs a life; heats, bonus, best of 3, corners rotate', () => {
  const [g, a, b] = duel(); open(g);
  Object.assign(a, { x: 60, y: 30 }); Object.assign(b, { x: 210, y: 210 });
  g.elapsed = ROUND_SECONDS - SUDDEN_DEATH + 1;
  step(g, {}, WALL_EVERY * 3);
  assert.deepEqual(g.drain().filter(e => e.type === 'wall').map(e => [e.i, e.j]), [[1, 1], [2, 1], [3, 1]]);
  assert.equal(a.lives, LIVES - 1);
  const [h, c, d] = duel();
  assert.deepEqual([c.x, c.y], [30, 30]);
  h.elapsed = 100; d.lives = 1; h.hit(d); step(h);
  assert.equal(c.wins, 1); assert.equal(c.points, 80 * BONUS);
  step(h, {}, RESULT_TICKS); assert.equal(h.heat, 2);
  assert.deepEqual([c.x, c.y], [390, 330], 'corners swap in heat 2');
  step(h, {}, READY_TICKS); h.elapsed = ROUND_SECONDS - 1; step(h, {}, TICK_HZ);
  assert.equal(h.winner, null, 'time up: a draw');
  step(h, {}, RESULT_TICKS + READY_TICKS); c.lives = 1; h.hit(c); step(h);
  step(h, {}, RESULT_TICKS); assert.equal(h.phase, 'matchover');
  assert.equal(h.matchWinner, 2, 'one win each: more points wins');
});

test('bots: fill seats, never play alone, the heat ends when every human is out, rarely blow themselves up', () => {
  const g = new Game({ seed: 11, bots: 3 });
  step(g, {}, 30); assert.equal(g.phase, 'waiting');
  g.addPlayer(1, 'H', '#fff'); step(g); assert.equal(g.fighters().length, 4);
  let hits = 0;
  for (let t = 0; t < TICK_HZ * 120; t++) { g.players.get(1).inv = 99; step(g); hits += g.drain().filter(e => e.type === 'hit').length; }
  assert.ok(hits < 40, `${hits} hits in 2 minutes`);
  const h = new Game({ seed: 12, bots: 2 }); h.addPlayer(1, 'H', '#fff'); step(h); step(h, {}, READY_TICKS);
  const me = h.players.get(1); me.lives = 1; h.hit(me); step(h); assert.equal(h.phase, 'result');
  const [d, x] = duel(); open(d);
  Object.assign(x, { bombs: 3 });
  d.bombs.push({ id: 1, owner: 1, x: 30, y: 30, cx: 1, cy: 1, count: 50, length: 2, state: 'still' }, { id: 2, owner: 1, x: 90, y: 30, cx: 3, cy: 1, count: 0, length: 2, state: 'still' });
  assert.equal(dangerMap(d)[cell(5, 1)], 11, 'chain reactions in the danger map');
});

test('prediction: the browser\'s replay of its own inputs matches the server exactly', () => {
  const [g, a] = duel('madness');
  const r = rng(3);
  for (let t = 0; t < 600; t++) {
    const snap = g.snapshot(), me = { ...a, kick: a.kick, glove: a.glove, button: a.button };
    const keys = [UP, DOWN, LEFT, RIGHT, 0][Math.floor(r() * 5)] | (r() < 0.05 ? BOMB_KEY : 0);
    const pred = new Prediction(snap, me);
    pred.step(keys);
    for (const p of g.fighters()) { p.inv = 99; p.lives = 3; }
    step(g, { 1: keys });
    assert.deepEqual([pred.p.x, pred.p.y], [a.x, a.y], `tick ${t}`);
  }
});

test('snapshot: compact and complete', () => {
  const [g] = duel('classic'), s = g.snapshot();
  assert.equal(s.grid.length, COLS * ROWS); assert.equal(s.players[0].length, 22); assert.ok(JSON.stringify(s).length < 3000);
});
