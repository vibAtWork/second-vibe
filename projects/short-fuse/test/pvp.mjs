// PvP through a lag proxy: two headless browsers, real keyboard. Checks that your own
// position never needs correcting, your bomb shows at once, dodging in time keeps you safe,
// a hit lands on both screens, and the heat result shows for both. Run: npm run pvp -- [one-way ms]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { lagProxy } from './lag-proxy.mjs';
import { CELL, FUSE, FLAME, LIVES, TICK_HZ, TICK_MS } from '../public/shared/game.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const LAT = +(process.argv[2] || 60), sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL:', msg); if (!ok) process.exitCode = 1; };
const srv = await createServer({ port: 0, log: () => {} });
const proxy = await lagProxy({ target: { port: srv.port }, latency: LAT, jitter: LAT / 4 });
const browser = await chromium.launch(), errors = [];
async function player(name, query) {
  const p = await browser.newPage(); p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await p.goto(`http://localhost:${proxy.port}/?${query}`); await p.fill('#name', name); await p.click('#join');
  return p;
}
const hold = async (p, key, ms) => { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); };
async function walk(p, key, axis, to) { await p.keyboard.down(key); await p.waitForFunction(([a, t]) => window.__sf.seats[0].pred?.p[a] === t, [axis, to], { timeout: 6000 }); await p.keyboard.up(key); }
const settle = () => sleep(4 * LAT + 300);
try {
  console.log(`one way ${LAT} ms ± ${LAT / 4} (round trip about ${2 * LAT} ms)`);
  const a = await player('Ann', 'room=pvp&arena=classic'), b = await player('Bo', 'room=pvp');
  await a.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.length === 2, null, { timeout: 15000 });
  const g = srv.rooms.get('pvp').game, ann = [...g.players.values()].find(p => p.name === 'Ann'), bo = [...g.players.values()].find(p => p.name === 'Bo');
  for (let c = 0; c < g.grid.length; c++) if (g.grid[c] === 2) g.grid[c] = 0; // an empty board for scripted moves
  await settle();
  for (const [k, ms] of [['ArrowRight', 500], ['ArrowDown', 400], ['ArrowLeft', 300], ['ArrowDown', 300], ['ArrowRight', 700], ['ArrowUp', 250]]) await hold(a, k, ms);
  await settle();
  const st = await a.evaluate(() => ({ p: window.__sf.seats[0].pred.p, s: window.__sf.stats }));
  check(st.p.x === ann.x && st.p.y === ann.y, `after moving around, prediction = server (${st.p.x},${st.p.y})`);
  check(st.s.corrections === 0, `no corrections (${st.s.corrections})`);
  Object.assign(ann, { x: 3 * CELL, y: 3 * CELL }); await settle();
  await a.evaluate(() => { window.__t = new Promise(res => addEventListener('keydown', function on() { removeEventListener('keydown', on); const t = performance.now(); (function poll() { if (window.__sf.seats[0].ghosts.length || window.__sf.latest.bombs.length) res(performance.now() - t); else setTimeout(poll, 1); })(); })); });
  await a.keyboard.press('Space');
  const shown = await a.evaluate(() => window.__t);
  check(shown < 1.5 * TICK_MS, `own bomb shown ${shown.toFixed(0)} ms after the key (a server reply takes ${2 * LAT} ms)`);
  await walk(a, 'ArrowDown', 'y', 5 * CELL); await walk(a, 'ArrowRight', 'x', 4 * CELL);
  await sleep(((FUSE + FLAME) / TICK_HZ) * 1000 + 4 * LAT);
  check(ann.lives === LIVES, `laid a bomb and walked clear in time: not hit (lives ${ann.lives})`);
  Object.assign(ann, { x: 5 * CELL, y: 5 * CELL }); Object.assign(bo, { x: 7 * CELL, y: 5 * CELL }); await settle();
  await a.keyboard.press('Space');
  await walk(a, 'ArrowUp', 'y', 3 * CELL); await walk(a, 'ArrowLeft', 'x', 4 * CELL);
  await Promise.all([a, b].map(p => p.waitForFunction(n => window.__sf.latest.players.find(q => q.name === 'Bo').lives === n, LIVES - 1, { timeout: ((FUSE + 10) / TICK_HZ) * 1000 + 4 * LAT })));
  check(bo.lives === LIVES - 1 && ann.lives === LIVES, 'Bo stood in the blast: a life lost on the server and both screens; Ann got away');
  await sleep(4000); bo.inv = 0; bo.lives = 1; g.hit(bo);
  await Promise.all([a, b].map(p => p.waitForFunction(() => window.__sf.latest.phase === 'result', null, { timeout: 4000 })));
  const res = await b.evaluate(() => window.__sf.latest.players.find(p => p.id === window.__sf.latest.winner)?.name);
  check(res === 'Ann', `heat over on both screens: ${res} wins`);
  check(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
} catch (e) { check(false, e.message); } finally { await browser.close(); proxy.close(); srv.close(); }
