import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, makeArena, movePlayer, at, rng, dangerMap, CELL, COLS, ROWS, SPEEDS, FUSE, FLAME_TICKS, KICK_SPEED, THROW_SPEED, THROW_TICKS,
  LIVES, INVINCIBLE_TICKS, TELEPORT_COOLDOWN, FIRELINE_TICKS, ROUND_SECONDS, HEATS, SUDDEN_DEATH_SECONDS, FILL_EVERY, FILL_MAX,
  PICKUP_POOL, PICKUPS, BONUS_PER_SECOND, READY_TICKS, RESULT_TICKS, MATCH_OVER_TICKS, CORNERS, TICK_HZ, OPEN, WALL, CRATE, BOMB, BIT,
} from '../public/shared/sim.js';

const K = (i, j) => i * ROWS + j;
const step = (g, inputs = {}, n = 1) => { for (let i = 0; i < n; i++) g.step(new Map(Object.entries(inputs).map(([k, v]) => [+k, { bits: v }]))); };
// a two-player heat on an open arena (no crates), already in the play phase
function duel(arena = 'madness', opts = {}) {
  const g = new Game(7, { arena, ...opts });
  g.addPlayer(1, 'A', '#fff'); g.addPlayer(2, 'B', '#fff');
  step(g); assert.equal(g.phase, 'ready');
  step(g, {}, READY_TICKS); assert.equal(g.phase, 'play');
  g.events.length = 0;
  return [g, g.players.get(1), g.players.get(2)];
}
// make the board fully open (pillars and border only), with standard starting stats
function plain(g) {
  g.grid = makeArena('madness', 1).grid; g.floor = []; g.pickups.clear(); g.bombs = []; g.flames = []; g.burning.clear();
  for (const p of g.fighters()) Object.assign(p, { speed: 2, length: 2, bombs: 1, kick: false, canThrow: -1, laid: 0 });
}

test('recovered constants', () => {
  assert.equal(TICK_HZ, 24);
  assert.deepEqual(SPEEDS, [2, 3, 5, 6, 10]);
  assert.deepEqual([FUSE, FLAME_TICKS, KICK_SPEED, THROW_SPEED, THROW_TICKS], [60, 25, 10, 10, 9]);
  assert.deepEqual([LIVES, INVINCIBLE_TICKS, TELEPORT_COOLDOWN, FIRELINE_TICKS], [3, 75, 24, 25]);
  assert.deepEqual([ROUND_SECONDS, HEATS, SUDDEN_DEATH_SECONDS, FILL_EVERY, FILL_MAX], [180, 3, 40, 8, 80]);
  assert.deepEqual(PICKUP_POOL, [8, 8, 8, 4, 4]);
  assert.deepEqual(PICKUPS, ['flame', 'speed', 'bomb', 'kick', 'throw']);
  assert.equal(BONUS_PER_SECOND, 250);
  for (const s of SPEEDS) assert.equal(CELL % s, 0, 'every speed lands exactly on cell centres');
  assert.deepEqual(CORNERS, [[1, 1], [13, 11], [1, 11], [13, 1]]);
});

test('arenas: pillars on even/even, start corners clear, 20 random crates removed, specials placed', () => {
  for (let seed = 1; seed < 30; seed++) {
    const { grid } = makeArena('classic', seed);
    let crates = 0, openInside = 0;
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
      const v = grid[K(i, j)], border = i === 0 || j === 0 || i === COLS - 1 || j === ROWS - 1;
      if (border || (i % 2 === 0 && j % 2 === 0)) assert.equal(v, WALL);
      else { if (v === CRATE) crates++; else openInside++; }
    }
    for (const [cx, cy] of CORNERS) assert.equal(grid[K(cx, cy)], OPEN);
    assert.equal(openInside, 4 * 5 + 20, `5 per corner + 20 random (seed ${seed})`);
    assert.equal(crates, 13 * 11 - 6 * 5 - 40);
  }
  const fl = makeArena('firelines', 3);
  assert.ok(fl.floor.length > 20 && fl.floor.every(f => f.kind === 'fire' && fl.grid[K(f.i, f.j)] === OPEN));
  const tp = makeArena('teleport', 3);
  assert.equal(tp.floor.length, 4);
  for (const t of tp.floor) { assert.equal(tp.grid[K(t.i, t.j)], OPEN); assert.ok(tp.floor.some(o => o.i === t.to[0] && o.j === t.to[1] && o.to[0] === t.i)); }
  assert.ok(makeArena('madness', 3).grid.every(v => v !== CRATE));
});

test('movement: one axis at a time, lined up with the grid, at the speed table rates', () => {
  const g = makeArena('madness', 1).grid;
  const p = { x: 30, y: 30, dir: 2, speed: 2, kick: false };
  movePlayer(g, p, BIT.right); assert.deepEqual([p.x, p.y, p.dir], [35, 30, 4]);
  movePlayer(g, p, BIT.down); assert.deepEqual([p.x, p.y], [30, 30], 'off the column: no vertical move, the assist slides back to column 1');
  for (let i = 0; i < 6; i++) movePlayer(g, p, BIT.right);
  assert.deepEqual([p.x, p.y], [60, 30], 'exactly on the next centre');
  movePlayer(g, p, BIT.down); assert.deepEqual([p.x, p.y], [60, 30], 'pillar below (2,2) blocks');
  for (let i = 0; i < 6; i++) movePlayer(g, p, BIT.right);
  for (let i = 0; i < 6; i++) movePlayer(g, p, BIT.down);
  assert.deepEqual([p.x, p.y], [90, 60]);
  const left = { x: 30, y: 30, dir: 2, speed: 2 }; movePlayer(g, left, BIT.left); assert.equal(left.x, 30, 'the border wall blocks');
  for (const [s, n] of [[0, 15], [1, 10], [3, 5], [4, 3]]) {
    const q = { x: 30, y: 30, dir: 2, speed: s };
    for (let i = 0; i < n; i++) movePlayer(g, q, BIT.right);
    assert.equal(q.x, 60, `speed level ${s} takes ${n} ticks per cell`);
  }
});

test('movement: corner assist nudges you toward an open lane', () => {
  const g = makeArena('madness', 1).grid;
  const p = { x: 40, y: 30, dir: 4, speed: 2 }; // 10 past column 1 on row 1; (2,2) below-right is a pillar
  movePlayer(g, p, BIT.down);
  assert.deepEqual([p.x, p.y], [35, 30], 'slides back toward column 1');
  for (let i = 0; i < 2; i++) movePlayer(g, p, BIT.down);
  assert.deepEqual([p.x, p.y], [30, 35], 'then goes down');
  const q = { x: 80, y: 30, dir: 4, speed: 2 }; // 20 past column 2, nearest column 3 (open below)
  movePlayer(g, q, BIT.down); assert.equal(q.x, 85, 'toward column 3');
  const r = { x: 40, y: 30, dir: 4, speed: 2 };
  movePlayer(g, r, BIT.down | BIT.right); assert.equal(r.x, 45, 'no assist while also holding a side direction');
});

test('bombs: lay, block, fuse, flames out to their length, crates burn then clear', () => {
  const [g, a] = duel('classic');
  g.grid[K(3, 1)] = CRATE; g.grid[K(1, 3)] = OPEN; g.grid[K(2, 1)] = OPEN; g.grid[K(1, 2)] = OPEN; g.grid[K(1, 4)] = OPEN; g.grid[K(1, 5)] = OPEN;
  step(g, { 1: BIT.action }); step(g, { 1: 0 });
  assert.equal(at(g.grid, 1, 1), BOMB); assert.equal(a.laid, 1);
  step(g, { 1: BIT.action }); step(g, { 1: 0 }); assert.equal(g.bombs.length, 1, 'only 1 bomb at a time to start');
  for (let i = 0; i < 6; i++) step(g, { 1: BIT.down });
  assert.equal(a.y, 60, 'you can walk off your bomb');
  for (let i = 0; i < 6; i++) step(g, { 1: BIT.up });
  assert.equal(a.y, 60, "but not back onto it");
  for (let i = 0; i < 12; i++) step(g, { 1: BIT.down }); // to (1,3)... (1,4) is out of range 2? go to (1,4)
  const b = g.bombs[0];
  while (b.count < FUSE - 1) step(g);
  assert.equal(g.flames.length, 0);
  step(g);
  assert.ok(g.events.some(e => e.type === 'boom'));
  const cells = g.flames.map(f => `${f.i},${f.j}`).sort();
  assert.deepEqual(cells, ['1,2', '1,3', '2,1', '3,1'].sort(), 'two cells down; right: (2,1) then the crate at (3,1) stops it');
  assert.ok(g.burning.has(K(3, 1)));
  step(g, {}, FLAME_TICKS - 1);
  assert.equal(at(g.grid, 3, 1), CRATE, 'still there while burning');
  step(g); assert.equal(at(g.grid, 3, 1), OPEN, 'gone after 25 ticks');
  assert.equal(g.flames.length, 0, 'flames last 25 ticks');
  assert.equal(at(g.grid, 1, 1), OPEN, 'the bomb (solid while its flames burned) is gone at the same time');
  assert.equal(a.laid, 0, 'bomb returned');
});

test('flames: stopped by walls, pass over pickups, set off other bombs a tick later', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(a, { x: 30, y: 30 }); Object.assign(b, { x: 390, y: 330, bombs: 1 });
  a.length = 4; a.bombs = 2;
  g.pickups.set(K(3, 1), 0);
  g.layBomb(a, 1, 1); g.layBomb(a, 5, 1); a.laid = 2;
  const first = g.bombs[0], second = g.bombs[1];
  first.count = FUSE - 1; second.count = 5;
  step(g);
  assert.ok(g.flames.some(f => f.i === 3 && f.j === 1) && g.flames.some(f => f.i === 4 && f.j === 1), 'through the pickup');
  assert.ok(!g.flames.some(f => f.i === 5), 'the bomb cell stops the flame');
  assert.ok(g.pickups.has(K(3, 1)), 'flames do not destroy pickups');
  assert.ok(!g.flames.some(f => f.j === 0 || f.i === 0), 'walls stop flames');
  assert.equal(second.count, FUSE - 1, 'chain reaction primed');
  step(g); assert.equal(second.count, FUSE, 'goes off on the next tick');
});

test('hits: lose a life, 75 ticks of invincibility (blinking), out at 0 lives', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(a, { x: 90, y: 30 }); Object.assign(b, { x: 390, y: 330 });
  g.hit(a); assert.deepEqual([a.lives, a.inv], [2, INVINCIBLE_TICKS]);
  g.hit(a); assert.equal(a.lives, 2, 'invincible');
  step(g, {}, INVINCIBLE_TICKS);
  g.hit(a); g.hit(a); assert.equal(a.lives, 1);
  a.inv = 0; g.hit(a);
  assert.equal(a.alive, false);
  assert.ok(g.events.some(e => e.type === 'out' && e.id === 1));
  step(g); assert.equal(g.phase, 'result'); assert.equal(g.winner, 2);
});

test('hits: a flame arm is used up by its first hit, but hits everyone in it on that tick (fair to all slots); hit boxes match the clip sizes', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(a, { x: 30, y: 90 }); Object.assign(b, { x: 30, y: 90 }); // both in the same cell below the bomb
  g.layBomb(b, 1, 1); g.bombs[0].count = FUSE - 1;
  step(g);
  assert.deepEqual([a.lives, b.lives], [LIVES - 1, LIVES - 1], 'both players in the arm are hit, whatever their slot');
  const [g3, c3, d3] = duel(); plain(g3);
  Object.assign(c3, { x: 30, y: 90 }); Object.assign(d3, { x: 90, y: 90 });
  g3.layBomb(d3, 1, 1); g3.bombs[0].count = FUSE - 1;
  step(g3);
  assert.equal(c3.lives, LIVES - 1);
  Object.assign(d3, { x: 30, y: 90, inv: 0 }); step(g3);
  assert.equal(d3.lives, LIVES, 'walking into a used-up arm later does not hurt (the original rule)');
  // box sizes: a vertical arm reaches 18 + 7.65 along and 6.4 + 7.65 across
  const [g2, c, d] = duel(); plain(g2);
  Object.assign(d, { x: 390, y: 330 });
  for (const [dx, hit] of [[14, true], [14.1, false]]) {
    g2.flames = [{ x: 90, y: 90, i: 3, j: 3, dir: 1, end: false, life: 5, spent: false }];
    Object.assign(c, { x: 90 + dx, y: 90, inv: 0, lives: 3 });
    g2.updateFlames(g2.fighters());
    assert.equal(c.lives < 3, hit, `across offset ${dx}`);
  }
  for (const [dy, hit] of [[25.6, true], [25.7, false]]) {
    g2.flames = [{ x: 90, y: 90, i: 3, j: 3, dir: 1, end: false, life: 5, spent: false }];
    Object.assign(c, { x: 90, y: 90 + dy, inv: 0, lives: 3 });
    g2.updateFlames(g2.fighters());
    assert.equal(c.lives < 3, hit, `along offset ${dy}`);
  }
});

test('kick: with boots, walking into a bomb sends it sliding at 10/tick until something blocks it', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(b, { x: 390, y: 330 });
  Object.assign(a, { x: 30, y: 30, kick: true });
  g.layBomb(b, 3, 1); b.laid = 1;
  for (let i = 0; i < 6; i++) step(g, { 1: BIT.right });
  assert.equal(a.x, 60);
  step(g, { 1: BIT.right });
  const bomb = g.bombs[0];
  assert.equal(bomb.moving, 1); assert.equal(at(g.grid, 3, 1), OPEN, 'a sliding bomb leaves the grid');
  assert.equal(bomb.x, 100, 'moved 10 on the kick tick');
  step(g); assert.equal(bomb.x, 110);
  step(g, {}, 40);
  assert.equal(bomb.moving, 0); assert.equal(bomb.bx, 13, 'stops at the wall'); assert.equal(at(g.grid, 13, 1), BOMB);
  const [g2, c, d] = duel(); plain(g2);
  Object.assign(d, { x: 390, y: 330 }); Object.assign(c, { x: 30, y: 30 });
  g2.layBomb(d, 3, 1);
  for (let i = 0; i < 10; i++) step(g2, { 1: BIT.right });
  assert.equal(g2.bombs[0].moving, 0, 'no boots: no kick'); assert.equal(c.x, 60);
});

test('throw: with a glove, press on your bomb to pick it up, release to throw it 3 cells (wrapping round the edges)', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(b, { x: 390, y: 330 });
  Object.assign(a, { x: 90, y: 30, canThrow: 1, bombs: 2 });
  step(g, { 1: BIT.action }); step(g, { 1: 0 });
  const bomb = g.bombs[0];
  step(g, { 1: BIT.action });
  assert.equal(bomb.held, 1); assert.equal(a.canThrow, 0); assert.equal(at(g.grid, 3, 1), OPEN);
  const count = bomb.count;
  step(g, { 1: BIT.action | BIT.right }, 6);
  assert.equal(bomb.count, count, 'a carried bomb does not count down');
  assert.equal(bomb.x, a.x, 'and follows its carrier');
  step(g, { 1: 0 });
  assert.equal(bomb.thrown, 4);
  step(g, {}, THROW_TICKS);
  assert.equal(bomb.thrown, 0); assert.equal(bomb.x, a.x + 90, 'lands 3 cells on'); assert.equal(bomb.count, count, 'no countdown in flight');
  step(g); assert.equal(at(g.grid, bomb.bx, bomb.by), BOMB);
  // thrown at the edge: wraps round to the far side
  const [g2, c, d] = duel(); plain(g2);
  Object.assign(d, { x: 390, y: 330 }); Object.assign(c, { x: 360, y: 90, canThrow: 1, dir: 4 });
  g2.layBomb(c, 12, 3); c.laid = 1;
  step(g2, { 1: BIT.action }); step(g2, { 1: 0 });
  const wb = g2.bombs[0];
  for (let i = 0; i < 30 && wb.thrown; i++) step(g2);
  assert.ok(wb.x < 200, `wrapped to the left side (landed at x ${wb.x})`);
  step(g2); assert.equal(g2.grid[K(wb.bx, wb.by)], BOMB, 'solid from the tick after landing');
});

test('bug fixes: a thrown bomb returns to its layer; a bomb follows whoever carries it', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(a, { x: 90, y: 30, canThrow: 1 }); Object.assign(b, { x: 390, y: 330 });
  g.layBomb(b, 3, 1); b.laid = 1; // b's bomb under a
  step(g, { 1: BIT.action });
  const bomb = g.bombs[0];
  assert.equal(bomb.held, 1);
  step(g, { 1: BIT.action | BIT.down }, 6);
  assert.equal(bomb.y, a.y, 'follows the carrier, not the layer');
  step(g, { 1: 0 });
  step(g, {}, FUSE + FLAME_TICKS + 15);
  assert.equal(g.bombs.length, 0);
  assert.deepEqual([a.laid, b.laid], [0, 0], 'b got its bomb back; a did not gain one');
});

test('pickups: collected on the cell centre; speed caps at the top level; crate drops follow the recovered odds and pool', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(b, { x: 390, y: 330 }); Object.assign(a, { x: 30, y: 30 });
  g.pickups.set(K(2, 1), 1); g.pickups.set(K(3, 1), 0); g.pickups.set(K(4, 1), 2); g.pickups.set(K(5, 1), 3); g.pickups.set(K(6, 1), 4);
  for (let i = 0; i < 2; i++) step(g, { 1: BIT.right });
  assert.ok(g.pickups.has(K(2, 1)), 'not yet on the centre');
  step(g, {}, 0);
  for (let i = 0; i < 40 && g.pickups.size; i++) step(g, { 1: BIT.right });
  assert.equal(g.pickups.size, 0);
  assert.deepEqual([a.speed, a.length, a.bombs, a.kick, a.canThrow], [3, 3, 2, true, 1]);
  a.speed = 4; g.pickups.set(K(Math.round(a.x / CELL) + 1, 1), 1);
  for (let i = 0; i < 3; i++) step(g, { 1: BIT.right });
  assert.equal(a.speed, 4, 'speed caps at level 4 (10 per tick)');
  // drop odds: half the crates drop; throw is rarer; never more than the pool
  const h = new Game(1); h.pool = [1e9, 1e9, 1e9, 1e9, 1e9]; const counts = [0, 0, 0, 0, 0];
  for (let n = 0; n < 20000; n++) { h.pickups.clear(); h.dropPickup(1, 1); const t = h.pickups.get(K(1, 1)); if (t !== undefined) counts[t]++; }
  const total = counts.reduce((x, y) => x + y);
  assert.ok(Math.abs(total / 20000 - 0.5) < 0.02, `drop rate ${total / 20000}`);
  assert.ok(Math.abs(counts[4] / total - 0.16) < 0.02, `throw share ${counts[4] / total} (recovered 4/25)`);
  const p2 = new Game(2); p2.pool = [...PICKUP_POOL]; let dropped = 0;
  for (let n = 0; n < 5000; n++) { p2.pickups.clear(); p2.dropPickup(1, 1); if (p2.pickups.size) dropped++; }
  assert.equal(dropped, PICKUP_POOL.reduce((x, y) => x + y), 'pool exhausted at 32');
});

test('teleporters: a pad sends you to its partner, with a 24-tick cooldown', () => {
  const [g, a, b] = duel('teleport'); plain(g);
  g.floor = makeArena('teleport', 1).floor;
  Object.assign(b, { x: 390, y: 330 });
  Object.assign(a, { x: 30, y: 210 }); // cell (1,7), just below the pad at (1,6)
  step(g, { 1: BIT.up });
  assert.deepEqual([a.x, a.y], [30, 205], 'not yet: the hit marker has to overlap the pad');
  step(g, { 1: BIT.up });
  assert.deepEqual([a.x, a.y], [390, 180], 'arrived on the partner pad (13,6)');
  step(g, {}, TELEPORT_COOLDOWN - 2);
  assert.deepEqual([a.x, a.y], [390, 180]);
  step(g, {}, 2);
  assert.deepEqual([a.x, a.y], [30, 180], 'standing still after the cooldown sends you back');
});

test('fire lines: a flame on the track lights all of it for 25 ticks and hurts anyone on it', () => {
  const [g, a, b] = duel('firelines'); plain(g);
  g.floor = makeArena('firelines', 1).floor;
  Object.assign(a, { x: 150, y: 300 }); // on the track at (5,10)
  Object.assign(b, { x: 390, y: 330 });
  g.flames = [{ x: 270, y: 60, i: 9, j: 2, dir: 1, end: true, life: 3, spent: false }]; // the far end of the other line
  step(g);
  assert.equal(g.fireOn, 1); assert.equal(a.lives, LIVES - 1);
  step(g, {}, FIRELINE_TICKS);
  assert.equal(g.fireOn, 0);
});

test('sudden death: in the last 40 s a wall drops every 8 ticks, spiralling in; it costs a life', () => {
  const [g, a, b] = duel(); plain(g);
  Object.assign(a, { x: 60, y: 30 }); Object.assign(b, { x: 210, y: 210 });
  g.elapsed = ROUND_SECONDS - SUDDEN_DEATH_SECONDS + 1; g.frames = 0;
  step(g, {}, FILL_EVERY * 3);
  const fills = g.events.filter(e => e.type === 'fill').map(e => [e.i, e.j]);
  assert.deepEqual(fills, [[1, 1], [2, 1], [3, 1]]);
  assert.equal(a.lives, LIVES - 1, 'crushed at (2,1)');
  step(g, {}, FILL_EVERY * 200);
  assert.ok(g.fill.count <= FILL_MAX);
});

test('heats and match: winner gets a win and seconds left x opponents x 250; best of 3; a new match follows', () => {
  const [g, a, b] = duel();
  g.elapsed = 100;
  b.inv = 0; b.lives = 1; g.hit(b);
  step(g);
  assert.equal(g.phase, 'result'); assert.equal(a.wins, 1); assert.equal(a.points, 80 * 1 * BONUS_PER_SECOND);
  step(g, {}, RESULT_TICKS); assert.equal(g.phase, 'ready'); assert.equal(g.heat, 2);
  step(g, {}, READY_TICKS);
  g.elapsed = ROUND_SECONDS - 1; step(g, {}, TICK_HZ);
  assert.equal(g.phase, 'result'); assert.equal(g.winner, null, 'time up: a draw');
  step(g, {}, RESULT_TICKS + READY_TICKS);
  a.inv = 0; a.lives = 1; g.hit(a); step(g);
  assert.equal(g.winner, 2);
  step(g, {}, RESULT_TICKS);
  assert.equal(g.phase, 'matchover');
  assert.ok(b.points > a.points, 'b won its heat with more time left');
  assert.equal(g.matchWinner, 2, 'one win each: points decide');
});

test('bots: fill seats, never start a heat alone, survive their own bombs most of the time', () => {
  const g = new Game(11, { bots: 3 });
  step(g, {}, 50); assert.equal(g.phase, 'waiting', 'no humans, no heat');
  g.addPlayer(1, 'Human', '#fff');
  step(g); assert.equal(g.phase, 'ready'); assert.equal(g.fighters().length, 4);
  const human = g.players.get(1);
  let selfHits = 0, hits = 0;
  for (let t = 0; t < TICK_HZ * 150; t++) {
    human.inv = 99; // an idle, untouchable human keeps the heat going
    step(g);
    for (const e of g.events.splice(0)) if (e.type === 'hit') hits++;
  }
  void selfHits;
  assert.ok(hits < 40, `bots rarely blow themselves up (${hits} hits in 150 s)`);
  // the heat ends as soon as every human is out
  const g2 = new Game(12, { bots: 2 }); g2.addPlayer(1, 'H', '#fff'); step(g2); step(g2, {}, READY_TICKS);
  const h = g2.players.get(1); h.lives = 1; g2.hit(h); step(g2);
  assert.equal(g2.phase, 'result');
  assert.ok(g.heat >= 1);
  // the danger map sees chain reactions
  const [d] = duel(); plain(d);
  const [p1, p2] = d.fighters();
  Object.assign(p1, { x: 30, y: 30, bombs: 3 }); Object.assign(p2, { x: 390, y: 330 });
  d.layBomb(p1, 1, 1); d.layBomb(p1, 3, 1); d.bombs[0].count = 50;
  const map = dangerMap(d);
  assert.equal(map[K(5, 1)], 11, 'the second bomb goes off a tick after the first reaches it');
});

test('snapshot carries what the client draws; rng is deterministic', () => {
  const [g] = duel('classic');
  const s = g.snapshot();
  assert.equal(s.grid.length, COLS * ROWS);
  assert.equal(s.players[0].length, 22);
  assert.ok(JSON.stringify(s).length < 3000);
  const r1 = rng(5), r2 = rng(5); assert.equal(r1(), r2());
});
