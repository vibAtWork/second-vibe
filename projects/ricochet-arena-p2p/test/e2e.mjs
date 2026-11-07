// End-to-end: local PeerJS signalling + two headless Chromium pages over real WebRTC.
// Run: npm run e2e   (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
import { start } from '../dev-server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); }

const srv = await start({ port: 8139, signal: true, signalPort: 9137 });
await sleep(500);
const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const url = `http://localhost:${srv.port}/?room=e2e&peerhost=localhost&peerport=9137&peersecure=0&ice=[]`;
const errs = [];
async function page(name) {
  const p = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  p.on('pageerror', e => errs.push(name + ': ' + e.message));
  await p.goto(url);
  return p;
}
const waitFor = (p, fn, ms = 15000) => p.waitForFunction(fn, null, { timeout: ms });

try {
  const a = await page('A');
  await waitFor(a, () => window.__ra.net.isHost === true);
  check(true, 'first browser became host');
  const b = await page('B');
  await waitFor(b, () => /connected to host/.test(document.getElementById('status').textContent));
  check(await b.evaluate(() => !window.__ra.net.isHost), 'second browser joined as guest');

  await a.fill('#name', 'Host'); await a.click('#join');
  await b.fill('#name', 'Guest'); await b.click('#join');
  await waitFor(b, () => window.__ra.latest && window.__ra.latest.tanks.length === 2 && window.__ra.latest.frozen === 0);
  check(true, 'both tanks visible on guest, round started');

  // Guest drives; verify host sees guest movement and guest prediction == host state.
  const gid = await b.evaluate(() => window.__ra.seats[0].id);
  const tankOn = (p, id) => p.evaluate(id => { const t = window.__ra.latest.tankById.get(id); return t && [t.id, t.x, t.y, t.rot, t.alive]; }, id);
  const start0 = await tankOn(a, gid);
  await b.click('canvas');
  await b.keyboard.down('ArrowUp'); await b.keyboard.down('ArrowLeft');
  await sleep(600);
  await b.keyboard.up('ArrowLeft'); await b.keyboard.up('ArrowUp');
  await sleep(500);
  const onHost = await a.evaluate(id => { const t = window.__ra.net.hostRoom.game.tanks.get(id); return [t.id, t.x, t.y, t.rot]; }, gid);
  const pred = await b.evaluate(() => window.__ra.seats[0].pred);
  check(onHost[1] !== start0[1] || onHost[2] !== start0[2] || onHost[3] !== start0[3], 'host sees guest tank move');
  check(Math.abs(pred.x - onHost[1]) < 0.05 && Math.abs(pred.y - onHost[2]) < 0.05, `guest prediction matches host (${pred.x.toFixed(2)},${pred.y.toFixed(2)} vs ${onHost[1]},${onHost[2]})`);

  await b.keyboard.press('KeyM');
  await waitFor(a, () => window.__ra.latest.bullets.length > 0 || window.__ra.latest.tanks.some(t => !t.alive), 3000).then(() => check(true, 'guest shot reached host'), () => check(false, 'guest shot reached host'));
  if (out) { await a.screenshot({ path: out + '/p2p-host.png' }); await b.screenshot({ path: out + '/p2p-guest.png' }); }

  // Honest host so far: the guest's auditor must not have complained.
  check(await b.evaluate(() => window.__ra.cheat === null), 'guest audited an honest host with no false alarm');

  // A cheating host (edits its game state, e.g. teleports its tank) is caught by the guest.
  const hid = await a.evaluate(() => window.__ra.seats[0].id);
  await a.evaluate(id => { const t = window.__ra.net.hostRoom.game.tanks.get(id); if (t) t.x += 4; else window.__ra.net.hostRoom.game.crateTimer += 7; }, hid);
  await waitFor(b, () => window.__ra.cheat !== null, 5000).then(() => {}, () => {});
  const reason = await b.evaluate(() => window.__ra.cheat);
  check(/differs/.test(reason || ''), `guest detected the cheating host (${reason})`);

  // Host migration: close host page; a new guest should take over hosting and keep playing.
  const c = await page('C');
  await waitFor(c, () => /connected to host/.test(document.getElementById('status').textContent));
  await a.close();
  await waitFor(c, () => window.__ra.net.isHost === true, 20000);
  check(await c.evaluate(() => window.__ra.cheat === null), 'guest took over as host after host left, no false alarm');
} catch (e) {
  check(false, 'exception: ' + e.message);
} finally {
  check(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await browser.close();
  srv.close();
  setTimeout(() => process.exit(), 200);
}
