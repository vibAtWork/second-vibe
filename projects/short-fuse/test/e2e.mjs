// End-to-end in headless Chromium: two players, the real keyboard, bombs seen by both, a local
// second player, bots, header buttons that must not steal game keys. Run: npm run e2e [shots-dir]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { CELL, FUSE, TICK_HZ } from '../public/shared/game.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2], sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL:', msg); if (!ok) process.exitCode = 1; };
const srv = await createServer({ port: 0, log: () => {} });
const browser = await chromium.launch(), errors = [];
async function player(name, query) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`)); p.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await p.goto(`http://localhost:${srv.port}/?${query}`);
  await p.fill('#name', name); await p.click('#join');
  return p;
}
const hold = async (p, key, ms) => { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); };
try {
  const a = await player('Ann', 'room=e2e&arena=madness'), b = await player('Bo', 'room=e2e');
  await a.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.length === 2, null, { timeout: 8000 });
  const game = srv.rooms.get('e2e').game, ann = [...game.players.values()].find(p => p.name === 'Ann');
  check(game.arena === 'madness' && await b.evaluate(() => document.getElementById('arena').value) === 'madness', 'the first visitor\'s arena applies, and shows in everyone\'s header');
  // keyboard focus is still on the Join button: Space must lay a bomb, not press a button
  await hold(a, 'ArrowRight', 400); await hold(a, 'ArrowDown', 300); await sleep(500);
  const pred = await a.evaluate(() => window.__sf.seats[0].pred?.p);
  check(pred && pred.x === ann.x && pred.y === ann.y && (ann.x !== CELL || ann.y !== CELL), `moving with the arrow keys; prediction = server (${pred?.x},${pred?.y})`);
  await a.click('#copy');                                     // focus on a header button again
  await a.keyboard.press('Space'); await sleep(200);
  check(game.bombs.some(x => x.owner === ann.id), 'Space lays a bomb (even with a header button focused)');
  check(await a.evaluate(() => window.__sf.seats.length) === 1, 'and does not press the focused button');
  await b.waitForFunction(() => window.__sf.latest.bombs.length > 0, null, { timeout: 2000 });
  check(true, 'the other player sees the bomb');
  await hold(a, 'ArrowUp', 250); await hold(a, 'ArrowLeft', 400);
  await b.waitForFunction(() => window.__sf.latest.flames.length > 0, null, { timeout: (FUSE / TICK_HZ) * 1000 + 2000 });
  check(true, 'and the explosion');
  if (out) await b.screenshot({ path: `${out}/e2e-explosion.png` });
  await a.focus('#arena'); await a.keyboard.press('ArrowDown'); await sleep(500);
  check(a.url().includes('room=e2e'), 'arrow keys do not change a focused arena menu');
  await b.click('#join2');
  await b.waitForFunction(() => window.__sf.latest.players.length === 3, null, { timeout: 4000 });
  check(![...game.players.values()].find(p => p.name === 'Bo 2').fighting, 'a local second player joins and waits for the next heat');
  const c = await player('Cy', 'room=e2e-bots&arena=classic&bots=2');
  await c.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.filter(p => p.fighting).length === 3, null, { timeout: 8000 });
  check(true, 'a room with bots: one human and two bots fight');
  await sleep(3000);
  if (out) await c.screenshot({ path: `${out}/e2e-bots.png` });
  check(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
} catch (e) { check(false, e.message); } finally { await browser.close(); srv.close(); }
