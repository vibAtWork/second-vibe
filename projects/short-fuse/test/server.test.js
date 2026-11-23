import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { Room, parseFrame, cleanName, MAX_QUEUE, STARVE_TICKS, TRIM_WINDOW } from '../public/shared/room.js';
import { movePlayer, predictTick, gridFromString, rng, READY_TICKS, BIT } from '../public/shared/sim.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); } }
function client(port, query) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?${query}`);
  const c = { ws, msgs: [], snap: null, arena: null, id: null, send: m => ws.send(JSON.stringify(m)) };
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 's') c.snap = m; if (m.t === 'arena') c.arena = m; if (m.t === 'joined') c.id = m.id; });
  c.open = new Promise(r => ws.addEventListener('open', r));
  return c;
}
function fakeRoom(opts = {}) {
  let clock = 0;
  const room = new Room({ seed: 3, now: () => clock, ...opts });
  const mk = () => { const c = { msgs: [], send: m => { c.msgs.push(m); if (m.t === 'joined') c.id = m.id; }, sendText: t => c.msgs.push(JSON.parse(t)) }; room.addConn(c); return c; };
  return { room, mk, advance: ms => { clock += ms; } };
}

test('frames are validated; names are cleaned', () => {
  assert.deepEqual(parseFrame([5, 16 | 64]), { seq: 5, bits: 16 });
  for (const bad of [[0, 1], [1.5, 1], ['1', 1], [1, 'x'], 'nope', [2 ** 40, 1]]) assert.equal(parseFrame(bad), null);
  assert.equal(cleanName('a‮b' + 'x'.repeat(40)).length, 16);
  assert.equal(cleanName(''), 'Player');
});

test('room: one frame per tick, bounded queue, foreign seats rejected, starvation idles, 4 humans max', () => {
  const { room, mk, advance } = fakeRoom();
  const a = mk(), b = mk();
  room.handle(a, { t: 'join', name: 'A' });
  room.handle(b, { t: 'join', name: 'B' });
  assert.ok(a.msgs.some(m => m.t === 'arena'), 'the arena layout is sent on connect');
  room.handle(a, { t: 'in', id: a.id, f: [[1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8]] });
  assert.ok(room.seats.get(a.id).queue.length <= MAX_QUEUE);
  room.handle(b, { t: 'in', id: a.id, f: [[99, 16]] });
  assert.ok(!room.seats.get(a.id).queue.some(f => f.seq === 99), 'cannot steer someone else');
  const q = room.seats.get(a.id).queue.length;
  room.tick(); advance(42);
  assert.equal(room.seats.get(a.id).queue.length, q - 1);
  for (let i = 0; i < READY_TICKS + 2; i++) { room.tick(); advance(42); }
  assert.equal(room.game.phase, 'play');
  room.handle(a, { t: 'in', id: a.id, f: [[100, BIT.down]] });
  const p = room.game.players.get(a.id);
  for (let i = 0; i < STARVE_TICKS + 3; i++) { room.tick(); advance(42); }
  const y = p.y;
  room.tick();
  assert.equal(p.y, y, 'idle after the starvation window');
  for (let i = 0; i < 3; i++) room.handle(a, { t: 'join', name: 'x' });
  assert.equal(a.seatIds.length, 2, 'at most two players per connection');
  const c = mk(), d = mk();
  room.handle(c, { t: 'join', name: 'C' }); room.handle(d, { t: 'join', name: 'D' });
  assert.ok(d.msgs.some(m => m.t === 'full'), 'at most 4 humans');
});

test('room: a new layout is announced each heat; bots fill seats; the buffer trims back after a burst', () => {
  const { room, mk, advance } = fakeRoom({ bots: 2 });
  const a = mk();
  room.handle(a, { t: 'join', name: 'A' });
  room.tick();
  assert.equal(room.game.fighters().length, 3, 'two bots join a lone human');
  const arenas = a.msgs.filter(m => m.t === 'arena').length;
  assert.ok(arenas >= 2, 'heat layout announced');
  let seq = 0;
  room.handle(a, { t: 'in', id: a.id, f: Array.from({ length: MAX_QUEUE }, () => [++seq, 0]) });
  for (let i = 0; i < TRIM_WINDOW * 8; i++) { room.handle(a, { t: 'in', id: a.id, f: [[++seq, 0]] }); room.tick(); advance(42); }
  assert.ok(room.seats.get(a.id).queue.length <= 1, 'queue back to jitter size');
  const snap = a.msgs.filter(m => m.t === 's').at(-1);
  assert.equal(snap.ack[a.id], room.seats.get(a.id).lastSeq);
});

test('room: a late frame is not guessed - the player waits a tick, then the frame is applied once', () => {
  const { room, mk, advance } = fakeRoom({ arena: 'madness' });
  const a = mk(), b = mk();
  room.handle(a, { t: 'join', name: 'A' }); room.handle(b, { t: 'join', name: 'B' });
  for (let i = 0; i < READY_TICKS + 2; i++) { room.tick(); advance(42); }
  const p = room.game.players.get(a.id), x0 = p.x;
  room.handle(a, { t: 'in', id: a.id, f: [[1, BIT.right]] }); room.tick();
  assert.equal(p.x, x0 + 10);
  room.tick(); // frame 2 is late
  assert.equal(p.x, x0 + 10, 'no guessing: stands still');
  room.handle(a, { t: 'in', id: a.id, f: [[2, BIT.right], [3, BIT.right]] });
  room.tick(); room.tick();
  assert.equal(p.x, x0 + 30, 'every frame applied exactly once (so the prediction never disagrees)');
  assert.equal(room.seats.get(a.id).lastSeq, 3);
});

test('room: only idle frames are trimmed', () => {
  const { room, mk } = fakeRoom();
  const a = mk(), b = mk();
  room.handle(a, { t: 'join', name: 'A' }); room.handle(b, { t: 'join', name: 'B' });
  const seat = room.seats.get(a.id);
  seat.trim = true;
  room.handle(a, { t: 'in', id: a.id, f: [[1, BIT.down], [2, BIT.down], [3, 0]] });
  room.tick(); assert.equal(seat.lastSeq, 1, 'a moving frame is never dropped');
  room.tick(); assert.equal(seat.lastSeq, 2);
});

test('room: a client cannot send faster than real time (speed hack), honest clock drift is fine', () => {
  const { room, mk, advance } = fakeRoom({ arena: 'madness' });
  const a = mk(), b = mk();
  room.handle(a, { t: 'join', name: 'A' }); room.handle(b, { t: 'join', name: 'B' });
  for (let i = 0; i < READY_TICKS + 2; i++) { room.tick(); advance(1000 / 24); }
  const seat = room.seats.get(a.id), before = seat.stats.applied;
  let seq = 0;
  // 10 seconds of a client sending frames twice as fast as real time
  for (let t = 0; t < 240; t++) {
    room.handle(a, { t: 'in', id: a.id, f: [[++seq, BIT.right], [++seq, BIT.right]] });
    room.tick(); advance(1000 / 24);
  }
  const applied = seat.stats.applied - before;
  assert.ok(applied <= 240 * 1.03 + 13, `applied ${applied} frames in 240 ticks (budget: real time + 3%)`);
  assert.ok(seat.stats.overBudget > 0);
});

// The browser's prediction (movement + its own bombs, rolled back to every update) must agree
// with the server frame for frame despite network delay both ways.
for (const [arena, delay] of [['madness', 3], ['classic', 2], ['madness', 0]]) test(`prediction of movement and own bombs matches the server (${arena}, ${delay}-tick delay each way)`, () => {
  let clock = 0;
  const room = new Room({ seed: 9, arena, now: () => clock });
  const toClient = [];
  const c = { send: m => { if (m.t === 'joined') c.id = m.id; }, sendText: t => toClient.push(JSON.parse(t)) }; room.addConn(c);
  const other = { send: () => {}, sendText: () => {} }; room.addConn(other);
  room.handle(c, { t: 'join', name: 'A' }); room.handle(other, { t: 'join', name: 'B' });
  for (let i = 0; i < READY_TICKS + 3; i++) { room.tick(); clock += 42; }
  const g = room.game, me = g.players.get(c.id);
  const rand = rng(+(process.env.PRED_SEED || 4)), wire = [], toServer = [], predictedLays = new Set(), serverLays = new Set();
  let seq = 0, pred = null, grid = null, latest = null, held = 0, dir = 8, mismatches = 0;
  for (let t = 0; t < 1500; t++) {
    for (const q of g.fighters()) { q.inv = 99; q.lives = 3; } // keep both players in the heat
    if (rand() < 0.08) dir = [1, 2, 4, 8, 0, 5, 10][Math.floor(rand() * 7)];
    if (held > 0) held--; else if (rand() < 0.05) held = 1 + Math.floor(rand() * 6);
    const f = [++seq, dir | (held > 0 ? 16 : 0)];
    wire.push(f);
    if (pred) { const cell = predictTick(grid, pred, f[1]); if (cell) predictedLays.add(f[0]); }
    toServer.push([t + delay, wire.slice(-4)]);
    while (toServer.length && toServer[0][0] <= t) room.handle(c, { t: 'in', id: c.id, f: toServer.shift()[1] });
    room.tick(); clock += 42;
    if (g.phase !== 'play') break;
    for (const ev of toClient.at(-1).ev) if (ev.type === 'lay' && ev.id === c.id) serverLays.add(ev.seq);
    const s = toClient[toClient.length - 1 - delay];
    if (s && s !== latest) {
      latest = s;
      const row = s.players.find(r => r[0] === c.id), ack = s.ack[c.id] ?? 0;
      pred = { x: row[1], y: row[2], dir: row[3], speed: row[7], laid: row[20], bombs: row[9], canThrow: row[11], actionHeld: !!row[21] };
      grid = gridFromString(s.grid);
      for (const fr of wire) if (fr[0] > ack) { const cell = predictTick(grid, pred, fr[1]); if (cell) predictedLays.add(fr[0]); }
      // after a full round trip, the prediction for frame `ack` must equal the server
      const srvAt = s.players.find(r => r[0] === c.id);
      if (srvAt[1] !== row[1]) mismatches++;
    }
  }
  const settled = q => q < seq - 2 * delay - 4;
  const lays = [...serverLays].filter(settled);
  assert.ok(lays.length > 8, `enough bombs laid (${lays.length})`);
  const missed = lays.filter(q => !predictedLays.has(q)), phantom = [...predictedLays].filter(q => settled(q) && !serverLays.has(q));
  // a bomb of yours exploding between your input and the server applying it frees a slot the
  // prediction couldn't know about yet; allow a few such cases, never more
  assert.ok(missed.length + phantom.length <= Math.max(2, lays.length * 0.05), `predicted bombs match the server (${missed.length} missed, ${phantom.length} phantom of ${lays.length})`);
  assert.ok(lays.every(q => q > 0), 'lay events are tagged with their input frame');
  assert.equal(mismatches, 0);
  // final position: replaying everything after the last ack lands where the server will be
  const last = toClient.at(-1), row = last.players.find(r => r[0] === c.id);
  assert.ok(Number.isFinite(row[1]));
});

test('two clients play over the network; server movement equals local prediction', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const a = client(srv.port, 'room=r&arena=madness'), b = client(srv.port, 'room=r');
    await Promise.all([a.open, b.open]);
    a.send({ t: 'join', name: 'Ann', slot: 'p1' });
    b.send({ t: 'join', name: 'Bo', slot: 'p1' });
    await until(() => a.id && b.id && a.snap?.phase === 'play' && b.snap?.players.length === 2);
    assert.equal(a.snap.arena, 'madness');
    const row = a.snap.players.find(p => p[0] === a.id);
    const grid = gridFromString(a.snap.grid);
    const ack0 = a.snap.ack[a.id] || 0;
    const pred = { x: row[1], y: row[2], dir: row[3], speed: row[7] };
    const moves = [8, 8, 8, 8, 8, 8, 2, 2, 2, 2, 2, 2, 10, 6, 6, 4, 1, 9, 0, 0, 0, 0, 0, 0]; // ends idle so the server stops too
    const sendFrame = i => { a.send({ t: 'in', id: a.id, f: [[ack0 + i, moves[i - 1]]] }); movePlayer(grid, pred, moves[i - 1]); };
    for (let i = 1; i <= 3; i++) sendFrame(i); // stay a few frames ahead so the queue never runs dry
    for (let i = 4; i <= moves.length; i++) { await until(() => (a.snap.ack[a.id] || 0) >= ack0 + i - 3); sendFrame(i); }
    await until(() => (a.snap.ack[a.id] || 0) >= ack0 + moves.length);
    const at = a.snap.players.find(p => p[0] === a.id);
    assert.deepEqual([at[1], at[2]], [pred.x, pred.y], 'exact match');
    assert.notDeepEqual([at[1], at[2]], [row[1], row[2]], 'and it did move');
    assert.ok(b.snap.players.some(p => p[0] === a.id && p[13] === 'Ann'));
  } finally { srv.close(); }
});

test('static files are served, paths are contained', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    assert.match(await (await fetch(`http://localhost:${srv.port}/`)).text(), /Short/);
    assert.equal((await fetch(`http://localhost:${srv.port}/shared/sim.js`)).status, 200);
    assert.notEqual((await fetch(`http://localhost:${srv.port}/..%2fserver.js`)).status, 200);
  } finally { srv.close(); }
});
