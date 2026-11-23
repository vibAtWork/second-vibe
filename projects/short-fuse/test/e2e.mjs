// End-to-end: real server + headless Chromium players. Run: npm run e2e [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { CELL, FUSE } from '../public/shared/sim.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL:', msg); if (!ok) process.exitCode = 1; };

const srv = await createServer({ port: 0, log: () => {} });
const browser = await chromium.launch();
const errors = [];
async function player(name, query) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await p.goto(`http://localhost:${srv.port}/?${query}`);
  await p.fill('#name', name);
  await p.click('#join');
  await p.click('canvas');
  return p;
}
async function hold(p, key, ms) { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); }
try {
  const a = await player('Ann', 'room=e2e&arena=madness'), b = await player('Bo', 'room=e2e');
  await a.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.length === 2, null, { timeout: 8000 });
  check(true, 'two players in a heat');
  const game = srv.rooms.get('e2e').game;
  check(game.arenaType === 'madness' && await b.evaluate(() => document.getElementById('arena').value) === 'madness', 'the first visitor\'s arena applies to the room (and shows for the second)');
  const ann = [...game.players.values()].find(p => p.name === 'Ann');

  // Movement prediction equals the server once the inputs are acknowledged.
  await hold(a, 'ArrowRight', 400); await hold(a, 'ArrowDown', 300);
  await sleep(500);
  const pred = await a.evaluate(() => window.__sf.seats[0].pred);
  check(pred && pred.x === ann.x && pred.y === ann.y && (ann.x !== CELL || ann.y !== CELL), `prediction matches the server (${pred?.x},${pred?.y} vs ${ann.x},${ann.y})`);

  // Drop a bomb, walk away, see it explode on the other screen.
  await a.keyboard.press('Space');
  await sleep(200);
  check(game.bombs.some(x => x.owner === ann.id), 'Ann laid a bomb through the real controls');
  await b.waitForFunction(() => window.__sf.latest.bombs.length > 0, null, { timeout: 2000 });
  check(true, 'Bo sees it');
  await hold(a, 'ArrowUp', 250); await hold(a, 'ArrowLeft', 400);
  await b.waitForFunction(() => window.__sf.latest.flames.length > 0, null, { timeout: (FUSE / 24) * 1000 + 2000 });
  check(true, 'Bo sees the explosion');
  if (out) await b.screenshot({ path: `${out}/sf-e2e.png` });

  // A second player on the same keyboard joins and waits for the next heat.
  await b.click('#join2'); await b.click('canvas');
  await b.waitForFunction(() => window.__sf.latest.players.length === 3, null, { timeout: 4000 });
  const bo2 = [...game.players.values()].find(p => p.name === 'Bo 2');
  check(bo2 && !bo2.fighting, 'a local second player joins and waits for the next heat');

  // Bots via the header: a new room with 2 bots.
  const c = await player('Cy', 'room=e2e-bots&arena=classic&bots=2');
  await c.waitForFunction(() => window.__sf.latest?.phase === 'play' && window.__sf.latest.players.filter(p => p.fighting).length === 3, null, { timeout: 8000 });
  check(true, 'a room with bots: one human plus two bots fight');
  await sleep(3000);
  if (out) await c.screenshot({ path: `${out}/sf-bots.png` });
  check(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
} catch (e) {
  check(false, e.message);
} finally {
  await browser.close();
  srv.close();
}
