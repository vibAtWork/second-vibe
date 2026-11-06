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
  await waitFor(a, () => window.__ra.isHost === true);
  check(true, 'first browser became host');
  const b = await page('B');
  await waitFor(b, () => /connected to host/.test(document.getElementById('status').textContent));
  check(await b.evaluate(() => !window.__ra.isHost), 'second browser joined as guest');

  await a.fill('#name', 'Host'); await a.click('#join');
  await b.fill('#name', 'Guest'); await b.click('#join');
  await waitFor(b, () => window.__ra.latest && window.__ra.latest.tanks.length === 2 && window.__ra.latest.frozen === 0);
  check(true, 'both tanks visible on guest, round started');

  // Guest drives; verify host sees guest movement and guest prediction == host state.
  const gid = await b.evaluate(() => window.__ra.seats[0].id);
  const start0 = await a.evaluate(id => window.__ra.latest.tanks.find(t => t[0] === id), gid);
  await b.click('canvas');
  await b.keyboard.down('ArrowUp'); await b.keyboard.down('ArrowLeft');
  await sleep(600);
  await b.keyboard.up('ArrowLeft'); await b.keyboard.up('ArrowUp');
  await sleep(500);
  const onHost = await a.evaluate(id => window.__ra.latest.tanks.find(t => t[0] === id), gid);
  const pred = await b.evaluate(() => window.__ra.seats[0].pred);
  check(onHost[1] !== start0[1] || onHost[2] !== start0[2] || onHost[3] !== start0[3], 'host sees guest tank move');
  check(Math.abs(pred.x - onHost[1]) < 0.05 && Math.abs(pred.y - onHost[2]) < 0.05, `guest prediction matches host (${pred.x.toFixed(2)},${pred.y.toFixed(2)} vs ${onHost[1]},${onHost[2]})`);

  await b.keyboard.press('KeyM');
  await waitFor(a, () => window.__ra.latest.bullets.length > 0 || window.__ra.latest.tanks.some(t => !t[4]), 3000).then(() => check(true, 'guest shot reached host'), () => check(false, 'guest shot reached host'));
  if (out) { await a.screenshot({ path: out + '/p2p-host.png' }); await b.screenshot({ path: out + '/p2p-guest.png' }); }

  // Host migration: close host page; guest should take over hosting and keep playing.
  await a.close();
  for (let i = 0; i < 6 && process.env.DEBUG; i++) { await sleep(2000); console.log('status:', await b.evaluate(() => document.getElementById('status').textContent + ' host=' + window.__ra.isHost + ' tanks=' + (window.__ra.latest && window.__ra.latest.tanks.length))); }
  await waitFor(b, () => window.__ra.isHost === true && window.__ra.latest && window.__ra.latest.tanks.length === 1, 20000);
  check(true, 'guest took over as host after host left');
} catch (e) {
  check(false, 'exception: ' + e.message);
} finally {
  check(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await browser.close();
  srv.close();
  setTimeout(() => process.exit(), 200);
}
