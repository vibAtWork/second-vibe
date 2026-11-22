// End-to-end: real server + two headless Chromium players. Run: npm run e2e [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from '../server.js';
import { WEAPONS } from '../public/shared/sim.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL:', msg); if (!ok) process.exitCode = 1; };

const srv = await createServer({ port: 0, log: () => {} });
const browser = await chromium.launch();
const errors = [];
async function player(name, query = 'room=e2e', join = '#join') {
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await p.goto(`http://localhost:${srv.port}/?${query}`);
  await p.fill('#name', name);
  await p.click(join);
  return p;
}
try {
  const a = await player('Ann'), b = await player('Bo');
  await a.waitForFunction(() => window.__gs.latest?.players.length === 2, null, { timeout: 8000 });
  check(true, 'two players in the room');
  const game = srv.rooms.get('e2e').game;
  const ann = [...game.players.values()].find(p => p.name === 'Ann');

  // Movement prediction equals the server once the inputs are acknowledged.
  await a.click('canvas');
  await a.keyboard.down('ArrowRight'); await a.keyboard.down('ArrowDown');
  await sleep(500);
  await a.keyboard.up('ArrowDown'); await sleep(300); await a.keyboard.up('ArrowRight');
  await sleep(400);
  const pred = await a.evaluate(() => window.__gs.seats[0].pred);
  check(Math.abs(pred.x - ann.x) < 1e-6 && Math.abs(pred.y - ann.y) < 1e-6, `prediction matches server (${pred.x.toFixed(2)},${pred.y.toFixed(2)} vs ${ann.x.toFixed(2)},${ann.y.toFixed(2)})`);

  // Fight the first wave with the pistol.
  await a.waitForFunction(() => window.__gs.latest?.phase === 'level', null, { timeout: 8000 });
  check(await a.evaluate(() => window.__gs.latest.mode === 'coop' && window.__gs.latest.level === 1), 'co-op room, level 1 (beginner)');
  await sleep(4000);
  for (let i = 0; i < 4; i++) { await a.keyboard.down('Space'); await a.keyboard.press(['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'][i]); await sleep(700); await a.keyboard.up('Space'); }
  if (out) await a.screenshot({ path: `${out}/gs-wave.png` });

  // Unlock everything for Ann and try the special weapons through the real controls.
  for (const w of WEAPONS) game.unlocked.add(w.id);
  ann.ammo = WEAPONS.map(w => (Number.isFinite(w.ammo) ? w.ammo : Infinity)); ann.hp = 100; ann.alive = true;
  game.enemies = []; game.toSpawn = { shambler: 0, hexer: 0 }; // a quiet moment to build
  if (process.env.DEBUG) { const pl = game.place.bind(game); game.place = (p, k, st) => { const r = pl(p, k, st); console.log('  place', k, 'from', Math.round(p.x), Math.round(p.y), 'facing', p.fx, p.fy, '->', r, 'others', [...game.players.values()].filter(q => q !== p).map(q => Math.round(q.x) + ',' + Math.round(q.y)).join(' ')); return r; }; }
  if (process.env.DEBUG) { const st = game.step.bind(game); game.step = i => { const b = game.objects.map(o => o.kind).join(','); st(i); const a2 = game.objects.map(o => o.kind).join(','); if (b !== a2) console.log('  tick', game.tick, b, '->', a2, game.phase, game.events.map(e => e.type + (e.type === 'boom' ? '@' + Math.round(e.x) + ',' + Math.round(e.y) : '')).join(' '), 'enemies', game.enemies.length, 'shots', game.shots.map(x => x.kind).join(',')); }; }
  for (const key of ['Digit4', 'Digit6', 'Digit7']) {
    await a.keyboard.down('ArrowUp'); await sleep(350); await a.keyboard.up('ArrowUp'); // walk to a fresh spot (inside the clear centre)
    await a.keyboard.press(key); await sleep(120);
    await a.keyboard.press('ArrowRight'); await sleep(80); await a.keyboard.press('Space'); await sleep(150); // face away from Bo (a barrel can't land on a player)
  }
  check(game.objects.length === 3, `placed objects through the controls (${game.objects.map(o => o.kind).join(', ')})`);
  await sleep(200);
  const bSees = await b.evaluate(() => window.__gs.latest.objects.map(o => o.kind));
  check(bSees.length === 3, `the other player sees them (${bSees.join(', ')})`);
  await a.keyboard.press('Digit8'); await sleep(100); await a.keyboard.press('ArrowUp'); await a.keyboard.press('Space'); await sleep(250);
  await a.keyboard.press('Digit3'); await sleep(100); await a.keyboard.down('Space'); await sleep(300); await a.keyboard.up('Space');
  if (out) await a.screenshot({ path: `${out}/gs-weapons.png` });
  await a.keyboard.up('Space');
  const hud = await a.evaluate(() => window.__gs.latest.players.map(p => [p.name, p.weapon, p.score]));
  check(hud.some(([n, w]) => n === 'Ann' && w === 2), `weapon switching works (${JSON.stringify(hud)})`);

  // Deathmatch room: two other players, everything unlocked; Dee frags Eli with the railgun via the real keys.
  const d1 = await player('Dee', 'room=dm1&mode=deathmatch'), d2 = await player('Eli', 'room=dm1&mode=deathmatch');
  await d1.waitForFunction(() => window.__gs.latest?.players.length === 2 && window.__gs.latest.mode === 'deathmatch', null, { timeout: 8000 });
  const dm = srv.rooms.get('dm1').game;
  const [dee, eli] = ['Dee', 'Eli'].map(n => [...dm.players.values()].find(p => p.name === n));
  check(dm.unlocked.size === WEAPONS.length && dm.mult === 200, 'deathmatch starts with everything unlocked (multiplier 200)');
  dm.enemies = []; dm.toSpawn = { shambler: 0, hexer: 0 };
  Object.assign(dee, { x: 480, y: 300, shield: 0 }); Object.assign(eli, { x: 560, y: 300, shield: 0, hp: 100 });
  await sleep(300);
  await d1.click('canvas');
  await d1.keyboard.press('Digit0'); await sleep(100);
  await d1.keyboard.down('ArrowRight'); await sleep(40); await d1.keyboard.up('ArrowRight');
  Object.assign(eli, { x: dee.x + 70, y: dee.y, shield: 0 });
  await d1.keyboard.press('Space'); await sleep(300);
  check(dee.frags === 1 && !eli.alive, `railgun frag through the real controls (frags ${dee.frags}, Eli alive ${eli.alive})`);
  if (out) await d1.screenshot({ path: `${out}/gs-deathmatch.png` });
  const eliSees = await d2.evaluate(() => window.__gs.latest.players.find(p => p.name === 'Dee')?.frags);
  check(eliSees === 1, 'the fragged player sees the frag count');
} catch (e) {
  check(false, 'exception: ' + e.message);
} finally {
  check(errors.length === 0, 'no page errors ' + JSON.stringify(errors));
  await browser.close();
  srv.close();
  setTimeout(() => process.exit(), 100);
}
