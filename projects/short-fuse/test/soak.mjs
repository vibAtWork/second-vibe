// Soak test: four browsers play by themselves (?autoplay) in one room, each through its own
// lag proxy (25/60/120/200 ms each way, with jitter), for a few minutes. Reports page errors,
// how often each player's own position had to be corrected, and checks the server's game
// state continuously. Run: node test/soak.mjs [seconds] [arena] [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { lagProxy } from './lag-proxy.mjs';
import { cell, COLS, ROWS, FUSE, BOMB } from '../public/shared/game.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SECONDS = +(process.argv[2] || 120), ARENA = process.argv[3] || 'classic', out = process.argv[4];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = await createServer({ port: 0, log: () => {} });
const links = [25, 60, 120, 200], proxies = await Promise.all(links.map(l => lagProxy({ target: { port: srv.port }, latency: l, jitter: l / 4 })));
const browser = await chromium.launch(), errors = [], problems = new Set();
const pages = [];
for (const [n, proxy] of proxies.entries()) {
  const p = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  p.on('pageerror', e => errors.push(`P${n}: ${e.message}`));
  await p.goto(`http://localhost:${proxy.port}/?room=soak&arena=${ARENA}&autoplay=${n + 1}`);
  await p.fill('#name', `P${n} ${links[n]}ms`); await p.click('#join');
  pages.push(p);
}
const room = () => srv.rooms.get('soak');
const watch = setInterval(() => { // the server's state stays consistent
  const g = room()?.game; if (!g) return;
  for (const b of g.bombs) if (b.state === 'still' && b.count < FUSE && g.grid[cell(b.cx, b.cy)] !== BOMB) problems.add(`a bomb without its cell at ${b.cx},${b.cy}`);
  for (let c = 0; c < COLS * ROWS; c++) if (g.grid[c] === BOMB && !g.bombs.some(b => cell(b.cx, b.cy) === c && b.state === 'still')) problems.add(`a bomb cell without a bomb at ${Math.floor(c / ROWS)},${c % ROWS}`);
}, 50);
let heats = 0, shot = 0, last = 0;
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await sleep(5000);
  const h = room()?.game.heat ?? last; if (h !== last && h > 0) { heats++; last = h; }
  if (out && Date.now() - t0 > (shot + 1) * 30000) { shot++; await pages[0].screenshot({ path: `${out}/soak-${ARENA}-${shot}.png` }); }
}
clearInterval(watch);
const stats = await Promise.all(pages.map(p => p.evaluate(() => ({ ...window.__sf.stats, delay: Math.round(window.__sf.delay) }))));
const seats = [...room().seats.values()].map(s => s.stats);
console.log(`${ARENA}, ${SECONDS} s, heats started: ${heats}`);
stats.forEach((s, n) => console.log(`  ${links[n]} ms: ${s.corrections} corrections (largest ${s.largest}), others drawn ${s.delay} ms behind, server: ${JSON.stringify(seats[n])}`));
console.log(problems.size ? `server state problems: ${[...problems].join('; ')}` : 'server state consistent throughout');
console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(' | ')}` : 'no page errors');
await browser.close(); for (const p of proxies) p.close(); srv.close();
process.exitCode = errors.length || problems.size ? 1 : 0;
