// PvP under realistic network lag: two headless Chromium players connect through a proxy
// that adds latency and jitter both ways. Run: node test/pvp.mjs [one-way ms] [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { lagProxy } from './lag-proxy.mjs';
import { CELL, FUSE, FLAME_TICKS, LIVES, TICK_HZ } from '../public/shared/sim.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const LAT = +(process.argv[2] || 60), out = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL:', msg); if (!ok) process.exitCode = 1; };

const srv = await createServer({ port: 0, log: () => {} });
const proxy = await lagProxy({ target: { port: srv.port }, latency: LAT, jitter: LAT / 4 });
const browser = await chromium.launch();
const errors = [];
async function player(name, query) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await p.goto(`http://localhost:${proxy.port}/?${query}`);
  await p.fill('#name', name); await p.click('#join'); await p.click('canvas');
  return p;
}
const hold = async (p, key, ms) => { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); };
// hold a key until the player's own (predicted) position reaches a value on one axis
async function walk(p, key, axis, target) {
  await p.keyboard.down(key);
  await p.waitForFunction(([ax, t]) => window.__sf.seats[0].pred?.[ax] === t, [axis, target], { timeout: 5000 });
  await p.keyboard.up(key);
}
try {
  console.log(`one-way latency ${LAT} ms ± ${LAT / 4} (round trip about ${2 * LAT} ms)`);
  const a = await player('Ann', 'room=pvp&arena=classic'), b = await player('Bo', 'room=pvp');
  await a.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.length === 2, null, { timeout: 15000 });
  const game = srv.rooms.get('pvp').game;
  const ann = [...game.players.values()].find(p => p.name === 'Ann'), bo = [...game.players.values()].find(p => p.name === 'Bo');
  // give both players an open board so the scripted moves are predictable
  for (let i = 1; i < 14; i++) for (let j = 1; j < 12; j++) if (game.grid[i * 13 + j] === 2) game.grid[i * 13 + j] = 0;
  await sleep(4 * LAT + 300); // let both screens see the cleared board before moving

  // 1. Movement under lag: the prediction should never need correcting.
  let maxQ = 0; const qWatch = setInterval(() => { maxQ = Math.max(maxQ, srv.rooms.get('pvp').seats.get(ann.id)?.queue.length || 0); }, 5);
  const t0 = performance.now();
  for (const [k, ms] of [['ArrowRight', 500], ['ArrowDown', 400], ['ArrowLeft', 300], ['ArrowDown', 300], ['ArrowRight', 700], ['ArrowUp', 250]]) await hold(a, k, ms);
  await sleep(4 * LAT + 300);
  clearInterval(qWatch);
  const st = await a.evaluate(() => ({ pred: window.__sf.seats[0].pred, stats: window.__sf.predStats }));
  check(st.pred.x === ann.x && st.pred.y === ann.y && (ann.x !== CELL || ann.y !== CELL), `after ${((performance.now() - t0) / 1000).toFixed(1)} s of moving, prediction = server (${st.pred.x},${st.pred.y})`);
  console.log('   server input stats for Ann:', JSON.stringify(srv.rooms.get('pvp').seats.get(ann.id).stats), 'max queue', maxQ);
  check(st.stats.corrections === 0, `no prediction corrections while moving (${st.stats.corrections}, largest ${st.stats.max})`);

  // 2. Your bomb shows at once; the other player sees it about half a round trip later.
  Object.assign(ann, { x: 3 * CELL, y: 3 * CELL }); // a known cell, (3,3)
  await sleep(4 * LAT + 200);
  // measured inside the page: from the key event to the bomb being in the drawn state
  const t1 = await a.evaluate(() => { window.__t = new Promise(res => { addEventListener('keydown', function on() { removeEventListener('keydown', on); const t = performance.now(); (function poll() { if (window.__sf.seats[0].ghosts.length || window.__sf.latest.bombs.length) res(performance.now() - t); else setTimeout(poll, 1); })(); }); }); return 0; });
  void t1;
  await a.keyboard.press('Space');
  const local = await a.evaluate(() => window.__t);
  check(local < 1.5 * 1000 / TICK_HZ, `own bomb shown ${local.toFixed(0)} ms after the key press (the next input tick; a server reply takes ${2 * LAT} ms)`);
  const pressedAt = Date.now();
  await b.waitForFunction(() => window.__sf.latest.bombs.length > 0, null, { timeout: 3000 });
  const seenByOther = Date.now() - pressedAt;
  check(seenByOther < 4 * LAT + 200, `the other player sees it ${seenByOther} ms later`);
  // 3. Fair dodging: run out of the blast in time and you're safe. Bomb at (3,3), flame 2:
  // go down to (3,5) and step right to (4,5), out of both lines.
  await walk(a, 'ArrowDown', 'y', 5 * CELL);
  await walk(a, 'ArrowRight', 'x', 4 * CELL);
  await sleep(((FUSE + FLAME_TICKS) / TICK_HZ) * 1000 + 4 * LAT);
  check(ann.lives === LIVES, `Ann laid a bomb and walked out of range in time: not hit (lives ${ann.lives})`);

  // 4. A player who stays in the blast is hit, and both screens agree. Ann at (5,5), Bo two
  // cells right at (7,5); Ann bombs and escapes up to (5,3) and left to (4,3).
  Object.assign(ann, { x: 5 * CELL, y: 5 * CELL }); Object.assign(bo, { x: 7 * CELL, y: 5 * CELL });
  await sleep(4 * LAT + 200);
  await a.keyboard.press('Space');
  await walk(a, 'ArrowUp', 'y', 3 * CELL);
  await walk(a, 'ArrowLeft', 'x', 4 * CELL);
  const lost = `window.__sf.latest.players.find(p => p.name === 'Bo').lives === ${LIVES - 1}`;
  await Promise.all([a, b].map(p => p.waitForFunction(lost, null, { timeout: ((FUSE + 10) / TICK_HZ) * 1000 + 4 * LAT })));
  check(bo.lives === LIVES - 1 && ann.lives === LIVES, `Bo stood in the blast and lost a life on the server and both screens; Ann escaped (lives ${ann.lives})`);
  if (out) await b.screenshot({ path: `${out}/sf-pvp.png` });

  // 5. Last life: the heat ends on both screens with the right winner.
  await sleep(((INV_TICKS()) / TICK_HZ) * 1000);
  bo.lives = 1; bo.inv = 0;
  game.hit(bo);
  await Promise.all([a, b].map(p => p.waitForFunction(() => window.__sf.latest.phase === 'result', null, { timeout: 3000 })));
  const res = await b.evaluate(() => ({ phase: window.__sf.latest.phase, winner: window.__sf.latest.players.find(p => p.id === window.__sf.latest.winner)?.name }));
  check(res.phase === 'result' && res.winner === 'Ann', `heat over on both screens, ${res.winner} wins`);
  const bStats = await b.evaluate(() => window.__sf.predStats);
  check(bStats.corrections <= 1, `Bo's prediction: ${bStats.corrections} correction(s) (the server moved him once in this test)`);
  check(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
} catch (e) {
  check(false, e.message);
} finally {
  await browser.close(); proxy.close(); srv.close();
}
function INV_TICKS() { return 80; }
