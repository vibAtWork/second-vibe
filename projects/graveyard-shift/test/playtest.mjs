// Automated playtest: bots that play sensibly, with invariants checked every tick.
// Run: node test/playtest.mjs [ticks]   (prints a report; exits 1 on any violation)
import { Game, WEAPONS, TILE, PLAYER_R, PLAYER_HP, blocked } from '../public/shared/sim.js';

const TICKS = +(process.argv[2] || 30000);
const problems = [];
const note = (scenario, tick, msg) => { if (problems.length < 60) problems.push(`[${scenario} @${tick}] ${msg}`); };

// 8-way input that points from (x, y) toward (tx, ty)
function toward(x, y, tx, ty) {
  const a = Math.atan2(ty - y, tx - x), oct = Math.round(a / (Math.PI / 4));
  const dirs = { 0: 8, 1: 8 | 2, 2: 2, 3: 2 | 4, 4: 4, '-4': 4, '-3': 4 | 1, '-2': 1, '-1': 1 | 8 };
  return dirs[oct];
}

// A reasonable player: pick a target, face it, fire, keep some distance, revive friends, build sometimes.
function bot(g, p, t, mem) {
  if (!p.alive) return { bits: 0, w: -1 };
  const foes = [...g.enemies, ...(g.mode === 'deathmatch' ? [...g.players.values()].filter(q => q !== p && q.alive) : [])];
  const downed = g.mode === 'coop' && [...g.players.values()].find(q => !q.alive);
  // best usable weapon (highest unlocked with ammo), switching now and then
  let w = -1;
  if (t % 120 === mem.offset) {
    const usable = WEAPONS.map((x, i) => i).filter(i => g.unlocked.has(WEAPONS[i].id) && (p.ammo[i] > 0) && !['place', 'charge'].includes(WEAPONS[i].kind));
    w = usable[Math.floor(Math.random() * usable.length)] ?? 0;
    if (Math.random() < 0.15 && g.unlocked.has('fakewall') && p.ammo[5] > 0) w = 5;
    if (Math.random() < 0.1 && g.unlocked.has('chargepack')) w = 8;
  }
  let bits = 0;
  const kind = WEAPONS[p.weapon].kind;
  if (downed && Math.hypot(downed.x - p.x, downed.y - p.y) > 14) bits = toward(p.x, p.y, downed.x, downed.y);
  else if (foes.length) {
    const f = foes.reduce((a, b) => (Math.hypot(b.x - p.x, b.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? b : a));
    const d = Math.hypot(f.x - p.x, f.y - p.y);
    const explosive = kind === 'rocket' || kind === 'throw';
    const want = explosive ? 150 : 110; // kite: keep this far away
    if (d < want - 20 && mem.phase !== 'aim') { bits = toward(f.x, f.y, p.x, p.y); if (++mem.flee > 25) { mem.phase = 'aim'; mem.flee = 0; } }
    else { bits = toward(p.x, p.y, f.x, f.y); mem.phase = 'move'; if (d < want + 40 && t % 2) bits &= 16; } // face it, mostly stand
    if (mem.phase === 'aim') { bits = toward(p.x, p.y, f.x, f.y); if (++mem.aim > 3) { mem.phase = 'move'; mem.aim = 0; } }
    const safe = !explosive || d > 90;
    if (safe && t % 6 < 3) bits |= 16;
  } else bits = [1, 8, 2, 4][Math.floor(t / 90 + mem.offset) % 4];
  return { bits, w };
}

function check(name, g, t) {
  for (const p of g.players.values()) {
    if (![p.x, p.y, p.hp].every(Number.isFinite)) note(name, t, `player ${p.name} has non-finite state`);
    if (p.alive && blocked(g.map, [], p.x, p.y, PLAYER_R)) note(name, t, `player ${p.name} inside a wall at ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    if (p.hp < 0 || p.hp > PLAYER_HP + 1e-9) note(name, t, `player hp out of range ${p.hp}`);
    if (p.ammo.some(a => a < 0 || Number.isNaN(a))) note(name, t, `negative ammo ${p.ammo}`);
    if (!g.unlocked.has(WEAPONS[p.weapon].id)) note(name, t, `holding a locked weapon ${p.weapon}`);
  }
  for (const e of g.enemies) {
    if (![e.x, e.y].every(Number.isFinite)) note(name, t, 'enemy non-finite');
    if (blocked(g.map, [], e.x, e.y, 9)) note(name, t, `enemy inside a wall at ${e.x.toFixed(1)},${e.y.toFixed(1)}`);
  }
  for (const s of g.shots) if (!Number.isFinite(s.x) || s.x < -64 || s.x > 2000) note(name, t, `shot escaped ${s.kind} ${s.x}`);
  if (g.mult < 1 || g.mult > 999) note(name, t, `multiplier ${g.mult}`);
}

const scenarios = [
  ['coop-beginner-2p', { mode: 'coop', difficulty: 'beginner' }, 2],
  ['coop-intermediate-3p', { mode: 'coop', difficulty: 'intermediate' }, 3],
  ['coop-expert-4p', { mode: 'coop', difficulty: 'expert' }, 4],
  ['coop-nightmare-4p', { mode: 'coop', difficulty: 'nightmare' }, 4],
  ['coop-solo', { mode: 'coop', difficulty: 'beginner' }, 1],
  ['deathmatch-4p', { mode: 'deathmatch' }, 4],
];
for (const [name, opts, n] of scenarios) {
  const g = new Game(1234 + n, opts);
  const mem = new Map();
  for (let i = 1; i <= n; i++) { g.addPlayer(i, 'bot' + i, '#fff'); mem.set(i, { offset: i * 17 % 120, flee: 0, aim: 0, phase: 'move' }); }
  const stats = { kills: 0, downs: 0, frags: 0, winners: 0, unlocks: 0, levels: new Set(), maxEnemies: 0, maxSnap: 0, maxMs: 0, boom: 0, gameovers: 0, joinLeave: 0, selfKills: 0 };
  let total = 0;
  try {
    for (let t = 0; t < TICKS; t++) {
      // churn: someone leaves and rejoins mid-game now and then
      if (n > 1 && t % 7001 === 7000) { g.removePlayer(n); g.addPlayer(n, 'bot' + n, '#fff'); stats.joinLeave++; }
      const inputs = new Map([...g.players.values()].map(p => [p.id, bot(g, p, t, mem.get(p.id))]));
      const t0 = performance.now();
      g.step(inputs);
      const ms = performance.now() - t0; total += ms; stats.maxMs = Math.max(stats.maxMs, ms);
      for (const e of g.drainEvents()) {
        if (e.type === 'kill') stats.kills++;
        if (e.type === 'down') { stats.downs++; if (e.by === e.id) stats.selfKills++; }
        if (e.type === 'frag') stats.frags++;
        if (e.type === 'winner') stats.winners++;
        if (e.type === 'unlock') stats.unlocks++;
        if (e.type === 'boom') stats.boom++;
        if (e.type === 'gameover') stats.gameovers++;
      }
      stats.levels.add(g.level);
      stats.maxEnemies = Math.max(stats.maxEnemies, g.enemies.length);
      if (t % 50 === 0) stats.maxSnap = Math.max(stats.maxSnap, JSON.stringify(g.snapshot()).length);
      check(name, g, t);
    }
  } catch (err) { note(name, g.tick, 'EXCEPTION ' + err.stack.split('\n').slice(0, 3).join(' | ')); }
  console.log(name.padEnd(22), `levels ${Math.min(...stats.levels)}-${Math.max(...stats.levels)}`, `kills ${stats.kills}`, `downs ${stats.downs}`, `gameovers ${stats.gameovers}`,
    `frags ${stats.frags}`, `self-kills ${stats.selfKills}`, `top frags ${Math.max(...[...g.players.values()].map(p => p.frags))}`, `winners ${stats.winners}`, `unlocks ${stats.unlocks}`, `booms ${stats.boom}`, `max enemies ${stats.maxEnemies}`,
    `max snapshot ${(stats.maxSnap / 1024).toFixed(1)} KB`, `avg ${(total / TICKS).toFixed(3)} ms/tick, worst ${stats.maxMs.toFixed(1)} ms`);
}
console.log(problems.length ? `\n${problems.length} problem(s):\n` + problems.join('\n') : '\nno invariant violations');
process.exitCode = problems.length ? 1 : 0;
