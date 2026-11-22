import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { Room, parseFrame, cleanName, MAX_QUEUE, STARVE_TICKS } from '../public/shared/room.js';
import { movePlayer } from '../public/shared/sim.js';

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
