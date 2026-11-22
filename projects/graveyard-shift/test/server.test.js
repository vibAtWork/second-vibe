import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { Room, parseFrame, cleanName, MAX_QUEUE, STARVE_TICKS, TRIM_WINDOW } from '../public/shared/room.js';
import { movePlayer, gunStep, rng } from '../public/shared/sim.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); } }
function client(port, room) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?room=${room}`);
  const c = { ws, msgs: [], snap: null, map: null, id: null, send: m => ws.send(JSON.stringify(m)) };
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 's') c.snap = m; if (m.t === 'map') c.map = m; if (m.t === 'joined') c.id = m.id; });
  c.open = new Promise(r => ws.addEventListener('open', r));
  return c;
}

test('frames are validated', () => {
  assert.deepEqual(parseFrame([5, 16 | 64, 3]), { seq: 5, bits: 16, w: 3 });
  assert.deepEqual(parseFrame([5, 1, 42]), { seq: 5, bits: 1, w: -1 });
  for (const bad of [[0, 1], [1.5, 1], ['1', 1], [1, 'x'], 'nope', [2 ** 40, 1]]) assert.equal(parseFrame(bad), null);
  assert.equal(cleanName('a‮b' + 'x'.repeat(40)).length, 16);
});

test('room: one frame per tick, bounded queue, foreign seats rejected, starvation idles', () => {
  let clock = 0;
  const room = new Room({ seed: 1, now: () => clock });
  const mk = () => { const c = { send: m => { if (m.t === 'joined') c.id = m.id; } }; room.addConn(c); return c; };
  const a = mk(), b = mk();
  room.handle(a, { t: 'join', name: 'A' });
  room.handle(b, { t: 'join', name: 'B' });
  room.handle(a, { t: 'in', id: a.id, f: [[1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8]] });
  assert.ok(room.seats.get(a.id).queue.length <= MAX_QUEUE);
  room.handle(b, { t: 'in', id: a.id, f: [[99, 16]] });
  assert.ok(!room.seats.get(a.id).queue.some(f => f.seq === 99));
  const q = room.seats.get(a.id).queue.length;
  room.tick();
  assert.equal(room.seats.get(a.id).queue.length, q - 1);
  const p = room.game.players.get(a.id);
  for (let i = 0; i < STARVE_TICKS + 3; i++) room.tick();
  const x = p.x;
  room.tick();
  assert.equal(p.x, x, 'idle after the starvation window');
  for (let i = 0; i < 3; i++) room.handle(a, { t: 'join', name: 'x' });
  assert.equal(a.seatIds.length, 2, 'at most two players per connection');
});

test('a weapon switch or fire tap in a dropped (overflowing) frame is not lost', () => {
  const room = new Room({ seed: 1, now: () => 0 });
  const c = { send: m => { if (m.t === 'joined') c.id = m.id; } }; room.addConn(c);
  room.handle(c, { t: 'join', name: 'A' });
  room.game.unlocked.add('uzi'); room.game.players.get(c.id).ammo[1] = 100;
  room.handle(c, { t: 'in', id: c.id, f: [[1, 16, 1], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]] });
  const q = room.seats.get(c.id).queue;
  assert.equal(q.length, MAX_QUEUE);
  assert.equal(q[0].w, 1); assert.equal(q[0].bits & 16, 16);
  room.tick();
  assert.equal(room.game.players.get(c.id).weapon, 1);
});

test('latency: a backed-up input buffer shrinks back to jitter size; snapshots carry each connection\'s ack', () => {
  const room = new Room({ seed: 1, now: () => 0 });
  const texts = [];
  const c = { send: m => { if (m.t === 'joined') c.id = m.id; }, sendText: t => texts.push(t) }; room.addConn(c);
  room.handle(c, { t: 'join', name: 'A' });
  let seq = 0;
  const feed = n => room.handle(c, { t: 'in', id: c.id, f: Array.from({ length: n }, () => [++seq, 8]) });
  feed(MAX_QUEUE); // a lag spike delivered a burst
  for (let i = 0; i < TRIM_WINDOW * 4; i++) { feed(1); room.tick(); }
  const q = room.seats.get(c.id).queue.length;
  assert.ok(q <= 1, `queue back to ${q} frame(s) between ticks`);
  const m = JSON.parse(texts.at(-1));
  assert.equal(m.t, 's'); assert.equal(m.ack[c.id], room.seats.get(c.id).lastSeq);
});

// The browser's shot prediction (gunStep, rolled back to every snapshot like movement)
// must call exactly the shots the server fires, frame for frame, despite network delay.
function shotPrediction(mode, delay, shielded) {
  let clock = 0; // the rate limiter refills with time
  const room = new Room({ seed: 3, mode, now: () => clock, snapshotEvery: 1 });
  const toClient = [];
  const c = { send: m => { if (m.t === 'joined') c.id = m.id; }, sendText: t => toClient.push(JSON.parse(t)) }; room.addConn(c);
  room.handle(c, { t: 'join', name: 'A' });
  const g = room.game;
  if (mode === 'coop') g.setMultiplier(80); // most weapons and fire-rate upgrades
  const rand = rng(+(process.env.SHOT_SEED || 7)), wire = [], toServer = [], predicted = new Set(), fired = new Set();
  let seq = 0, gun = null, held = 0, latest = null, first = 0, deaths = 0;
  for (let t = 0; t < 4000; t++) {
    g.enemies = []; g.toSpawn = { shambler: 0, hexer: 0 }; g.pickups = []; // no zombies, nothing refills ammo
    if (shielded) g.players.get(c.id).shield = 1e6; // and (unless testing deaths) nobody dies
    // a jittery player: bursts of holding fire, taps, weapon switches
    if (held > 0) held--; else if (rand() < 0.08) held = 1 + Math.floor(rand() * 40);
    const w = rand() < 0.03 ? Math.floor(rand() * 10) : -1;
    const f = [++seq, (held > 0 || rand() < 0.05 ? 16 : 0) | (1 << Math.floor(rand() * 4)), w];
    wire.push(f);
    if (gun && latest) { const i = gunStep(gun, f[1], f[2], latest); if (i >= 0) predicted.add(f[0]); } else first = seq; // no snapshot yet: the server's event plays instead
    toServer.push([t + delay, wire.slice(-4)]);
    while (toServer.length && toServer[0][0] <= t) room.handle(c, { t: 'in', id: c.id, f: toServer.shift()[1] });
    const wasAlive = g.players.get(c.id).alive;
    room.tick(); clock += 20;
    if (wasAlive && !g.players.get(c.id).alive) deaths++;
    const snap = toClient.at(-1);
    for (const ev of snap.ev) if (ev.id === c.id && ['shot', 'rocketfire', 'throw'].includes(ev.type)) { assert.ok(ev.seq > 0, 'shot tagged with its frame'); fired.add(ev.seq); }
    // the client sees snapshots `delay` ticks late
    const s = toClient[toClient.length - 1 - delay];
    if (s && s !== latest) {
      latest = s;
      const me = s.players.find(r => r[0] === c.id), ack = s.ack[c.id] ?? 0;
      gun = { alive: !!me[6], respawn: me[15], weapon: me[7], cd: me[16], held: !!me[17], charging: 0, ammo: me[10].map(a => (a < 0 ? Infinity : a)) };
      for (const fr of wire) if (fr[0] > ack) gunStep(gun, fr[1], fr[2], s);
    }
  }
  const settled = [...fired].filter(q => q > first && q < seq - 20);
  const missed = settled.filter(q => !predicted.has(q)), phantom = [...predicted].filter(q => q < seq - 40 && !fired.has(q));
  return { shots: settled.length, missed, phantom, deaths };
}
for (const [mode, delay] of [['deathmatch', 3], ['coop', 5], ['deathmatch', 0]]) test(`shot prediction matches the server exactly (${mode}, ${delay}-tick delay each way)`, () => {
  const r = shotPrediction(mode, delay, true);
  assert.ok(r.shots > 100, `enough shots fired (${r.shots})`);
  assert.deepEqual([r.missed, r.phantom], [[], []], 'predicted shots == server shots');
});
test('shot prediction through deaths and respawns stays close (deathmatch, own rockets can kill)', () => {
  const r = shotPrediction('deathmatch', 4, false);
  if (process.env.SHOT_SEED) console.log(`deaths ${r.deaths} shots ${r.shots} missed ${r.missed.length} phantom ${r.phantom.length}`);
  assert.ok(r.deaths > 3, `the player died a few times (${r.deaths})`);
  // Death isn't predictable, so a shot or two around each death can be off; a missed one
  // still plays when the server's event arrives. Respawns are predicted exactly.
  assert.ok(r.missed.length + r.phantom.length <= r.deaths * 3, `${r.missed.length} missed + ${r.phantom.length} phantom for ${r.deaths} deaths, ${r.shots} shots`);
});

test('snapshot rate: every tick by default, every other tick with SNAPSHOT_HZ=25', () => {
  for (const [every, want] of [[undefined, 10], [2, 5]]) {
    const room = new Room({ seed: 1, now: () => 0, ...(every ? { snapshotEvery: every } : {}) });
    let n = 0; room.addConn({ send: () => {}, sendText: () => n++ });
    for (let i = 0; i < 10; i++) room.tick();
    assert.equal(n, want);
  }
});

test('two clients play together; server movement equals local prediction', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const a = client(srv.port, 'r'), b = client(srv.port, 'r');
    await Promise.all([a.open, b.open]);
    a.send({ t: 'join', name: 'Ann', slot: 'p1' });
    b.send({ t: 'join', name: 'Bo', slot: 'p1' });
    await until(() => a.id && b.id && a.snap?.players.length === 2 && b.snap?.players.length === 2);
    const row = a.snap.players.find(p => p[0] === a.id);
    const ack0 = a.snap.ack[a.id] || 0;
    const pred = { x: row[1], y: row[2], fx: row[3], fy: row[4] };
    const moves = [8, 8, 8, 1, 1, 9, 9, 2, 6, 6, 0, 0, 0, 0]; // end with idle frames so the server stops too
    const sendFrame = i => { a.send({ t: 'in', id: a.id, f: [[ack0 + i, moves[i - 1], -1]] }); movePlayer(a.map, [], pred, moves[i - 1]); };
    for (let i = 1; i <= 3; i++) sendFrame(i); // stay a few frames ahead so the queue never runs dry
    for (let i = 4; i <= moves.length; i++) { await until(() => (a.snap.ack[a.id] || 0) >= ack0 + i - 3); sendFrame(i); }
    await until(() => (a.snap.ack[a.id] || 0) >= ack0 + moves.length);
    const at = a.snap.players.find(p => p[0] === a.id);
    assert.deepEqual([at[1], at[2]], [pred.x, pred.y], 'exact match');
    assert.ok(b.snap.players.some(p => p[0] === a.id && p[12] === 'Ann'));
  } finally { srv.close(); }
});

test('static files are served, paths are contained', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    assert.match(await (await fetch(`http://localhost:${srv.port}/`)).text(), /Graveyard/);
    assert.equal((await fetch(`http://localhost:${srv.port}/shared/sim.js`)).status, 200);
    assert.notEqual((await fetch(`http://localhost:${srv.port}/..%2fserver.js`)).status, 200);
  } finally { srv.close(); }
});
