// End-to-end: real server + two headless Chromium players.
// Run: npm run e2e   (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { cellCenter } from '../public/shared/sim.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (cond, msg) => { console.log(cond ? 'ok -' : 'FAIL:', msg); if (!cond) process.exitCode = 1; };

const srv = await createServer({ port: 0, log: () => {} });
const browser = await chromium.launch();
const errors = [];
async function player(name) {
  const p = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await p.goto(`http://localhost:${srv.port}/?room=e2e`);
  await p.fill('#name', name);
  await p.click('#join');
  return p;
}
try {
  const a = await player('Alice'), b = await player('Bob');
  await a.waitForFunction(() => window.__ra.latest?.tanks.length === 2 && window.__ra.latest.frozen === 0, null, { timeout: 10000 });
  check(true, 'both players in a running round');

  // Drive Alice; her prediction must equal the server's state once input is acknowledged.
  await a.click('canvas');
  await a.keyboard.down('ArrowUp'); await a.keyboard.down('ArrowRight');
  await sleep(600);
  await a.keyboard.up('ArrowRight'); await a.keyboard.up('ArrowUp');
  await sleep(400);
  const id = await a.evaluate(() => window.__ra.seats[0].id);
  const server = srv.rooms.get('e2e').game.tanks.get(id);
  const pred = await a.evaluate(() => window.__ra.seats[0].pred);
  check(Math.abs(pred.x - server.x) < 0.05 && Math.abs(pred.y - server.y) < 0.05, `prediction matches server (${pred.x.toFixed(2)},${pred.y.toFixed(2)} vs ${server.x.toFixed(2)},${server.y.toFixed(2)})`);
  const bobSees = await b.evaluate(id => window.__ra.latest.tankById.get(id), id);
  check(Math.abs(bobSees.x - server.x) < 5, 'Bob sees Alice where the server has her');

  // One cannon ball at a time.
  const g = srv.rooms.get('e2e').game;
  Object.assign(g.tanks.get(id), cellCenter(g.maze, 0, 0), { rot: 180 });
  for (let i = 0; i < 3; i++) { await a.keyboard.press('KeyM'); await sleep(80); }
  check(g.bullets.filter(x => x.owner === id && x.kind === 'bullet').length <= 1, 'only one cannon ball in play');

  // Give everyone a weapon and fire it, making sure every weapon renders without errors.
  for (const [i, w] of ['laser', 'frag', 'homing'].entries()) {
    const t = g.tanks.get(id);
    if (!t?.alive) break;
    t.weapon = w; t.busy = false;
    await sleep(100);
    await a.keyboard.press('KeyM'); await sleep(300);
    if (w === 'frag') { await a.keyboard.press('KeyM'); await sleep(200); }
    if (out) await a.screenshot({ path: `${out}/e2e-${i}-${w}.png` });
  }
  check(await a.evaluate(() => window.__ra.cheat === null), 'no false cheat alarm against the server');

  // Anti-cheat reports reach the other player, who can vote the suspect out.
  const room = srv.rooms.get('e2e');
  const bobId = await b.evaluate(() => window.__ra.seats[0].id);
  room.onVerdict(bobId, 'flag', 'unusually many ricochet kill shots', { test: true });
  await a.waitForSelector('#reports:not([hidden]) button', { timeout: 3000 });
  const panel = await a.textContent('#reports');
  check(/Bob: unusually many ricochet kill shots/.test(panel), `Alice sees the report: "${panel.trim()}"`);
  const bobPanel = await b.textContent('#reports');
  check(/You: .*other players can vote to remove you/.test(bobPanel), 'Bob is told he was flagged');
  if (out) await a.screenshot({ path: `${out}/e2e-report.png` });
  await a.click('#reports button');
  await b.waitForFunction(() => window.__ra.seats.length === 0, null, { timeout: 3000 }).then(() => {}, () => {});
  check(!room.game.players.has(bobId) || !room.seats.has(bobId), 'Alice\'s vote (majority of 1) removed Bob');
} catch (e) {
  check(false, 'exception: ' + e.message);
} finally {
  check(errors.length === 0, 'no page errors ' + JSON.stringify(errors));
  await browser.close();
  srv.close();
  setTimeout(() => process.exit(), 100);
}
