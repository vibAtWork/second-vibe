// Automated playtest: bots and button-mashers in every arena, with the game's invariants
// checked every tick. Run: node test/playtest.mjs [seconds per scenario]  (exit 1 on a problem)
import { Game, at, cell, CELL, COLS, ROWS, LIVES, FUSE, FLAME, TICK_HZ, ROUND_SECONDS, READY_TICKS, OPEN, WALL, CRATE, BOMB, UP, DOWN, LEFT, RIGHT, BOMB_KEY } from '../public/shared/game.js';

const SECONDS = +(process.argv[2] || 600);
const problems = [];
const report = (name, g, msg) => { if (problems.length < 50) problems.push(`[${name} tick ${g.tick}] ${msg}`); };

function check(name, g, walls) {
  for (const p of g.fighters()) {
    if (p.lives < 0 || p.lives > LIVES) report(name, g, `${p.name} has ${p.lives} lives`);
    if (p.laid < 0 || p.laid > p.bombs) report(name, g, `${p.name} laid ${p.laid} of ${p.bombs}`);
    if (!p.alive) continue;
    if (![p.x, p.y].every(Number.isFinite) || p.x < CELL || p.y < CELL || p.x > (COLS - 2) * CELL || p.y > (ROWS - 2) * CELL) report(name, g, `${p.name} out of the arena at ${p.x},${p.y}`);
    const c = cell(Math.round(p.x / CELL), Math.round(p.y / CELL));
    if (g.grid[c] === CRATE) report(name, g, `${p.name} inside a crate`);
    if (g.grid[c] === WALL && !walls.has(c)) report(name, g, `${p.name} inside a wall`);
    if (p.glove === 0 && !g.bombs.some(b => b.state === 'held' && b.carrier === p.id)) report(name, g, `${p.name} carries nothing`);
  }
  for (const b of g.bombs) {
    if (b.count < 0 || b.count > FUSE + FLAME) report(name, g, `bomb count ${b.count}`);
    if (b.state === 'still' && b.count < FUSE && at(g.grid, b.cx, b.cy) !== BOMB) report(name, g, `a bomb at ${b.cx},${b.cy} sits on grid value ${at(g.grid, b.cx, b.cy)}`);
    if (b.state === 'held' && !g.players.get(b.carrier)?.alive) report(name, g, 'a carried bomb without a carrier');
  }
  for (let c = 0; c < COLS * ROWS; c++) {
    if (![OPEN, WALL, CRATE, BOMB].includes(g.grid[c])) report(name, g, `grid value ${g.grid[c]}`);
    if (g.grid[c] === BOMB && !g.bombs.some(b => cell(b.cx, b.cy) === c && b.state === 'still')) report(name, g, `a bomb cell with no bomb at ${Math.floor(c / ROWS)},${c % ROWS}`);
  }
  for (const c of g.burning.keys()) if (g.grid[c] !== CRATE) report(name, g, 'a burning cell that is not a crate');
  for (const c of g.powerups.keys()) if (g.grid[c] !== OPEN && g.grid[c] !== BOMB) report(name, g, `a power-up on grid value ${g.grid[c]}`);
}

function masher(m, rand) { // a button-masher: holds a direction a while, drops bombs now and then
  if (!(m.left > 0)) { m.dir = [UP, DOWN, LEFT, RIGHT, 0, UP | LEFT, DOWN | RIGHT][Math.floor(rand() * 7)]; m.left = 3 + Math.floor(rand() * 30); }
  m.left--; m.bomb = m.bomb ? rand() < 0.6 : rand() < 0.06;
  return m.dir | (m.bomb ? BOMB_KEY : 0);
}

const scenarios = [];
for (const arena of ['classic', 'firelines', 'teleport', 'madness']) scenarios.push([arena, 'bots', 3, 1], [arena, 'mashers', 0, 4], [arena, 'mixed', 2, 2], [arena, 'duck', 3, 1]);
for (const [arena, style, bots, humans] of scenarios) {
  const name = `${arena}-${style}`, g = new Game({ seed: 1000 + name.length, arena, bots });
  const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42 + name.length);
  for (let i = 1; i <= humans; i++) g.addPlayer(i, 'P' + i, '#fff');
  const mem = new Map([...Array(humans)].map((_, i) => [i + 1, {}]));
  const st = { heats: 0, draws: 0, hits: 0, booms: 0, kicks: 0, throws: 0, teleports: 0, fires: 0, walls: 0, powerups: 0, duck: [], ms: 0, worst: 0, snap: 0 };
  let walls = new Set(), start = 0;
  for (let t = 0; t < SECONDS * TICK_HZ; t++) {
    if (style === 'bots') g.players.get(1).inv = 99; // an untouchable idle human keeps the heats going
    const inputs = new Map([...mem].map(([id, m]) => [id, { frames: [{ keys: style === 'mashers' || style === 'mixed' ? masher(m, rand) : 0 }] }]));
    const t0 = performance.now(); g.step(inputs); const ms = performance.now() - t0; st.ms += ms; st.worst = Math.max(st.worst, ms);
    for (const e of g.drain()) {
      if (e.type === 'heat') { walls = new Set(); start = g.tick; }
      if (e.type === 'result') { st.heats++; if (e.winner == null) st.draws++; }
      if (e.type === 'hit') st.hits++;
      if (e.type === 'out' && e.id === 1 && style === 'duck') st.duck.push((g.tick - start - READY_TICKS) / TICK_HZ);
      if (e.type === 'boom') st.booms++;
      if (e.type === 'kick') st.kicks++;
      if (e.type === 'throw') st.throws++;
      if (e.type === 'teleport') st.teleports++;
      if (e.type === 'fire') st.fires++;
      if (e.type === 'wall') { st.walls++; walls.add(cell(e.i, e.j)); }
      if (e.type === 'powerup') st.powerups++;
    }
    if (g.phase === 'play' && g.tick - start > (ROUND_SECONDS + 3) * TICK_HZ + READY_TICKS) report(name, g, 'a heat ran past the clock');
    if (t % 48 === 0) st.snap = Math.max(st.snap, JSON.stringify(g.snapshot()).length);
    check(name, g, walls);
  }
  const duck = st.duck.length ? `, idle human out after ${(st.duck.reduce((a, b) => a + b) / st.duck.length).toFixed(0)} s` : '';
  console.log(name.padEnd(20), `heats ${st.heats} (draws ${st.draws})${duck}, hits ${st.hits}, booms ${st.booms}, kicks ${st.kicks}, throws ${st.throws}, teleports ${st.teleports}, fire ${st.fires}, walls ${st.walls}, power-ups ${st.powerups}, update ${(st.snap / 1024).toFixed(1)} KB, ${(st.ms / (SECONDS * TICK_HZ)).toFixed(3)} ms/tick (worst ${st.worst.toFixed(1)})`);
}
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join('\n')}` : '\nno invariant violations');
process.exitCode = problems.length ? 1 : 0;
