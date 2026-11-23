// Automated playtest: bots and random-input players, with invariants checked every tick.
// Run: node test/playtest.mjs [seconds per scenario]   (prints a report; exits 1 on any violation)
import { Game, at, CELL, COLS, ROWS, LIVES, FUSE, FLAME_TICKS, TICK_HZ, ROUND_SECONDS, RESULT_TICKS, READY_TICKS, OPEN, WALL, CRATE, BOMB } from '../public/shared/sim.js';

const SECONDS = +(process.argv[2] || 900);
const problems = [];
const note = (name, tick, msg) => { if (problems.length < 60) problems.push(`[${name} @${tick}] ${msg}`); };

// a button-mashing player: holds a direction for a while, drops bombs now and then
function randomInput(mem, rand) {
  if (!mem.left || --mem.left <= 0) { mem.dir = [1, 2, 4, 8, 0, 5, 10][Math.floor(rand() * 7)]; mem.left = 3 + Math.floor(rand() * 30); }
  mem.fire = mem.fire ? rand() < 0.6 : rand() < 0.06;
  return mem.dir | (mem.fire ? 16 : 0);
}

function check(name, g, fillCells) {
  const t = g.tick;
  for (const p of g.fighters()) {
    if (![p.x, p.y].every(Number.isFinite)) note(name, t, `${p.name} has a non-finite position`);
    if (p.lives < 0 || p.lives > LIVES) note(name, t, `${p.name} lives ${p.lives}`);
    if (p.laid < 0 || p.laid > p.bombs) note(name, t, `${p.name} laid ${p.laid} of ${p.bombs}`);
    if (!p.alive) continue;
    if (p.x < CELL || p.x > (COLS - 2) * CELL || p.y < CELL || p.y > (ROWS - 2) * CELL) note(name, t, `${p.name} outside the arena at ${p.x},${p.y}`);
    const v = at(g.grid, Math.round(p.x / CELL), Math.round(p.y / CELL));
    if (v === CRATE) note(name, t, `${p.name} inside a crate at ${p.x},${p.y}`);
    if (v === WALL && !fillCells.has(Math.round(p.x / CELL) * ROWS + Math.round(p.y / CELL))) note(name, t, `${p.name} inside a wall at ${p.x},${p.y}`);
    if (p.canThrow === 0 && !g.bombs.some(b => b.held === p.id)) note(name, t, `${p.name} carries a bomb that doesn't exist`);
  }
  for (const b of g.bombs) {
    if (b.count < 0 || b.count > FUSE + FLAME_TICKS) note(name, t, `bomb count ${b.count}`);
    if (b.held) { const h = g.players.get(b.held); if (!h || !h.alive || h.canThrow !== 0) note(name, t, 'a carried bomb without a carrier'); }
  }
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
    const v = g.grid[i * ROWS + j];
    if (![OPEN, WALL, CRATE, BOMB].includes(v)) note(name, t, `grid value ${v}`);
    if (v === BOMB && !g.bombs.some(b => b.bx === i && b.by === j)) note(name, t, `ghost bomb cell at ${i},${j}`);
  }
}

const scenarios = [];
for (const arena of ['classic', 'firelines', 'teleport', 'madness']) {
  scenarios.push([`${arena}-3bots`, arena, 3, 1, 'idle']);     // bots against each other (an untouchable idle human keeps heats going)
  scenarios.push([`${arena}-4random`, arena, 0, 4, 'random']);  // four button-mashers
  scenarios.push([`${arena}-2random+2bots`, arena, 2, 2, 'random']);
  scenarios.push([`${arena}-sittingduck`, arena, 3, 1, 'duck']);  // an idle human: how long do the bots take?
}
for (const [name, arena, bots, humans, style] of scenarios) {
  const g = new Game(1000 + name.length, { arena, bots });
  const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42 + name.length);
  for (let i = 1; i <= humans; i++) g.addPlayer(i, 'P' + i, '#fff');
  const mem = new Map([...Array(humans)].map((_, i) => [i + 1, {}]));
  const stats = { heats: 0, results: 0, draws: 0, hits: 0, botHits: 0, outs: 0, booms: 0, kicks: 0, throws: 0, teleports: 0, fires: 0, fills: 0, pickups: 0, matches: 0, maxMs: 0, totalMs: 0, maxSnap: 0, heatTicks: [], duck: [] };
  let fillCells = new Set(), heatStart = 0;
  for (let t = 0; t < SECONDS * TICK_HZ; t++) {
    if (style === 'idle') g.players.get(1).inv = 99;
    const inputs = new Map([...mem].map(([id, m]) => [id, { bits: style === 'random' ? randomInput(m, rand) : 0 }]));
    const t0 = performance.now();
    g.step(inputs);
    const ms = performance.now() - t0; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms);
    for (const e of g.drainEvents()) {
      if (e.type === 'heat') { stats.heats++; fillCells = new Set(); heatStart = g.tick; }
      if (e.type === 'result') { stats.results++; if (e.winner == null) stats.draws++; stats.heatTicks.push(g.tick - heatStart); }
      if (e.type === 'hit') { stats.hits++; if (g.players.get(e.id)?.bot) stats.botHits++; }
      if (e.type === 'out') { stats.outs++; if (e.id === 1 && style === 'duck') stats.duck.push((g.tick - heatStart - READY_TICKS) / TICK_HZ); }
      if (e.type === 'boom') stats.booms++;
      if (e.type === 'kick') stats.kicks++;
      if (e.type === 'throw') stats.throws++;
      if (e.type === 'teleport') stats.teleports++;
      if (e.type === 'fire') stats.fires++;
      if (e.type === 'fill') { stats.fills++; fillCells.add(e.i * ROWS + e.j); }
      if (e.type === 'pickup') stats.pickups++;
      if (e.type === 'match') stats.matches++;
    }
    if (g.phase === 'play' && g.tick - heatStart > (ROUND_SECONDS + 5) * TICK_HZ + READY_TICKS) note(name, g.tick, 'a heat ran past its time limit');
    if (t % 24 === 0) stats.maxSnap = Math.max(stats.maxSnap, JSON.stringify(g.snapshot()).length);
    check(name, g, fillCells);
  }
  const avgHeat = stats.heatTicks.length ? stats.heatTicks.reduce((a, b) => a + b) / stats.heatTicks.length / TICK_HZ : 0;
  console.log(name.padEnd(26), `heats ${stats.results} (draws ${stats.draws}, avg ${avgHeat.toFixed(0)} s)`, `matches ${stats.matches}`, `hits ${stats.hits} (bots ${stats.botHits})`, `outs ${stats.outs}`,
    `booms ${stats.booms}`, `kicks ${stats.kicks}`, `throws ${stats.throws}`, `teleports ${stats.teleports}`, `fire ${stats.fires}`, `walls ${stats.fills}`, `pickups ${stats.pickups}`,
    ...(style === 'duck' ? [`idle human out after ${stats.duck.length ? (stats.duck.reduce((a, b) => a + b) / stats.duck.length).toFixed(0) : '-'} s avg (${stats.duck.length} heats)`] : []),
    `snapshot ${(stats.maxSnap / 1024).toFixed(1)} KB`, `${(stats.totalMs / (SECONDS * TICK_HZ)).toFixed(3)} ms/tick (worst ${stats.maxMs.toFixed(1)})`);
}
console.log(problems.length ? `\n${problems.length} problem(s):\n` + problems.join('\n') : '\nno invariant violations');
process.exitCode = problems.length ? 1 : 0;
void RESULT_TICKS;
