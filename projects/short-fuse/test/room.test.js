import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, parseFrame, cleanName, BUDGET, CATCH_UP_WINDOW, IDLE_AFTER } from '../room.js';
import { createServer } from '../server.js';
import { Prediction, READY_TICKS, TICK_MS, RIGHT, DOWN, BOMB_KEY, CELL } from '../public/shared/game.js';

function setup(opts = {}) {
  let clock = 0;
  const room = new Room({ seed: 3, arena: 'madness', now: () => clock, ...opts });
  const conn = () => { const c = { msgs: [], send: m => { c.msgs.push(m); if (m.t === 'joined') c.id ??= m.id; }, sendText: t => c.msgs.push(JSON.parse(t)) }; room.addConn(c); return c; };
  const a = conn(), b = conn();
  room.handle(a, { t: 'join', name: 'A' }); room.handle(b, { t: 'join', name: 'B' });
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { room.tick(); clock += TICK_MS; } };
  tick(READY_TICKS + 2);
  return { room, a, b, tick, conn, player: room.game.players.get(a.id), seat: room.seats.get(a.id) };
}

test('frames and names are validated', () => {
  assert.deepEqual(parseFrame([5, 16 | 64]), { seq: 5, keys: 16 });
  for (const bad of [[0, 1], [1.5, 1], ['1', 1], [1, 'x'], 'x', [2 ** 40, 1]]) assert.equal(parseFrame(bad), null);
  assert.equal(cleanName('a‮b' + 'x'.repeat(40)).length, 16); assert.equal(cleanName(''), 'Player');
});

test('every frame is applied once, in order; a late frame is waited for, never guessed', () => {
  const { room, a, tick, player, seat } = setup();
  const x0 = player.x;
  room.handle(a, { t: 'in', id: a.id, f: [[1, RIGHT]] }); tick();
  assert.equal(player.x, x0 + 10);
  tick(); assert.equal(player.x, x0 + 10, 'frame 2 is late: stand still');
  room.handle(a, { t: 'in', id: a.id, f: [[1, RIGHT], [2, RIGHT], [3, RIGHT]] }); // 1 is a re-sent copy
  tick(2); assert.equal(player.x, x0 + 30); assert.equal(seat.lastSeq, 3);
  room.handle(a, { t: 'in', id: a.id, f: [[4, RIGHT]] }); tick(IDLE_AFTER + 3);
  const x1 = player.x; tick(); assert.equal(player.x, x1, 'idle after 1.5 s without input');
});

test('a backlog is caught up two frames a tick, never dropped', () => {
  const { room, a, tick, seat } = setup();
  let seq = 0;
  room.handle(a, { t: 'in', id: a.id, f: [[++seq, 0], [++seq, 0], [++seq, 0], [++seq, 0], [++seq, 0]] });
  for (let i = 0; i < CATCH_UP_WINDOW * 4; i++) { room.handle(a, { t: 'in', id: a.id, f: [[++seq, 0]] }); tick(); }
  assert.ok(seat.buffer.length <= 1, `buffer back to ${seat.buffer.length}`);
  assert.equal(seat.stats.applied + seat.buffer.length, seq, 'nothing dropped');
  assert.ok(seat.stats.caughtUp > 0);
});

test('a client cannot send faster than real time (no speed hack)', () => {
  const { room, a, tick, seat } = setup();
  const before = seat.stats.applied; let seq = 0;
  for (let t = 0; t < 240; t++) { room.handle(a, { t: 'in', id: a.id, f: [[++seq, RIGHT], [++seq, RIGHT]] }); tick(); }
  assert.ok(seat.stats.applied - before <= 240 * BUDGET.perSecond / 24 + BUDGET.burst + 1, `${seat.stats.applied - before} frames in 240 ticks`);
});

test('seats: foreign seats rejected, 2 per connection, 4 humans, same names numbered; updates carry acks and lay tags', () => {
  const { room, a, b, tick, conn } = setup();
  room.handle(b, { t: 'in', id: a.id, f: [[50, DOWN]] }); assert.equal(room.seats.get(a.id).buffer.length, 0);
  room.handle(a, { t: 'join', name: 'A' });
  room.handle(a, { t: 'join', name: 'A' }); assert.equal(a.seats.length, 2);
  assert.equal(a.msgs.find(m => m.t === 'joined' && m.slot === 'p1' && m.name === 'A 2') ? true : room.game.humans().some(p => p.name === 'A 2'), true);
  const c = conn(); room.handle(c, { t: 'join', name: 'C' }); room.handle(c, { t: 'join', name: 'D' });
  assert.ok(c.msgs.some(m => m.t === 'full'));
  room.handle(a, { t: 'in', id: a.id, f: [[1, BOMB_KEY]] }); tick();
  const s = a.msgs.filter(m => m.t === 's').at(-1);
  assert.equal(s.ack[a.id], 1); assert.ok(s.ev.some(e => e.type === 'lay' && e.seq === 1));
});

test('over a real WebSocket: the browser\'s prediction equals the server', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); } };
  const client = q => { const ws = new WebSocket(`ws://localhost:${srv.port}/ws?${q}`), c = { ws, send: m => ws.send(JSON.stringify(m)) }; ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 's') c.s = m; if (m.t === 'joined') c.id = m.id; }; c.open = new Promise(r => { ws.onopen = r; }); return c; };
  try {
    const a = client('room=r&arena=madness'), b = client('room=r');
    await Promise.all([a.open, b.open]);
    a.send({ t: 'join', name: 'Ann' }); b.send({ t: 'join', name: 'Bo' });
    await until(() => a.id && a.s?.phase === 'play');
    const row = a.s.players.find(r => r[0] === a.id), ack0 = a.s.ack[a.id] ?? 0;
    const pred = new Prediction(a.s, { id: row[0], x: row[1], y: row[2], dir: row[3], speed: row[8], kick: !!row[12], laid: row[11], bombs: row[10], glove: row[13], button: !!row[14] });
    const moves = [8, 8, 8, 8, 8, 8, 2, 2, 2, 2, 2, 2, 10, 6, 6, 4, 1, 9, 0, 0, 0, 0, 0, 0];
    const sendFrame = i => { a.send({ t: 'in', id: a.id, f: [[ack0 + i, moves[i - 1]]] }); pred.step(moves[i - 1]); };
    for (let i = 1; i <= 3; i++) sendFrame(i);
    for (let i = 4; i <= moves.length; i++) { await until(() => (a.s.ack[a.id] ?? 0) >= ack0 + i - 3); sendFrame(i); }
    await until(() => (a.s.ack[a.id] ?? 0) >= ack0 + moves.length);
    const now = a.s.players.find(r => r[0] === a.id);
    assert.deepEqual([now[1], now[2]], [pred.p.x, pred.p.y]);
    assert.notDeepEqual([now[1], now[2]], [CELL, CELL]);
    assert.match(await (await fetch(`http://localhost:${srv.port}/`)).text(), /Short/);
    assert.equal(await (await fetch(`http://localhost:${srv.port}/skin/skin.json`)).text(), '{}', 'no skin: built-in art');
    assert.notEqual((await fetch(`http://localhost:${srv.port}/..%2fserver.js`)).status, 200);
    assert.notEqual((await fetch(`http://localhost:${srv.port}/skin/..%2f..%2fserver.js`)).status, 200);
  } finally { srv.close(); }
});
