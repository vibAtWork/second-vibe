import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoom } from '../public/room.js';
import { moveTank, FRAMES_FROZEN } from '../public/shared/sim.js';

function fakeConn() { const c = { seatIds: [], msgs: [], send: m => c.msgs.push(JSON.parse(JSON.stringify(m))) }; return c; }
const last = (c, t) => c.msgs.filter(m => m.t === t).at(-1);

test('host room: join, maze broadcast, snapshots with per-connection acks', () => {
  const room = new HostRoom({ seed: 5 });
  const host = fakeConn(), guest = fakeConn();
  room.addConn(host); room.addConn(guest);
  room.handle(host, { t: 'join', name: 'H', slot: 'arrows' });
  room.handle(guest, { t: 'join', name: 'G', slot: 'arrows' });
  const hid = last(host, 'joined').id, gid = last(guest, 'joined').id;
  assert.notEqual(hid, gid);
  assert.ok(last(guest, 'maze'));
  assert.deepEqual(last(guest, 'maze').maze, last(host, 'maze').maze);
  room.tick();
  const s = last(guest, 's');
  assert.equal(s.tanks.length, 2);
  assert.deepEqual(Object.keys(s.ack), [String(gid)]);
});

test('host room: prediction on a guest matches host simulation', () => {
  const room = new HostRoom({ seed: 8 });
  const a = fakeConn(), b = fakeConn();
  room.addConn(a); room.addConn(b);
  room.handle(a, { t: 'join', name: 'A' });
  room.handle(b, { t: 'join', name: 'B' });
  const id = last(b, 'joined').id;
  for (let i = 0; i < FRAMES_FROZEN; i++) room.tick();
  const maze = last(b, 'maze').maze;
  const t0 = last(b, 's').tanks.find(t => t[0] === id);
  const pred = { x: t0[1], y: t0[2], rot: t0[3] };
  for (let i = 1; i <= 15; i++) {
    room.handle(b, { t: 'in', id, f: [[i, i % 3 ? 1 | 4 : 2, 0, 0]] });
    moveTank(maze, pred, i % 3 ? { f: 1, l: 1 } : { b: 1 });
    room.tick();
  }
  const s = last(b, 's');
  assert.equal(s.ack[id], 15);
  const t = s.tanks.find(t => t[0] === id);
  assert.ok(Math.abs(t[1] - pred.x) < 0.01 && Math.abs(t[2] - pred.y) < 0.01 && Math.abs(t[3] - pred.rot) < 0.01);
});

test('host room: redundant/duplicate input frames are applied once, foreign seats rejected', () => {
  const room = new HostRoom({ seed: 1 });
  const a = fakeConn(), b = fakeConn();
  room.addConn(a); room.addConn(b);
  room.handle(a, { t: 'join', name: 'A' });
  const id = last(a, 'joined').id;
  room.handle(a, { t: 'in', id, f: [[1, 1], [2, 1]] });
  room.handle(a, { t: 'in', id, f: [[1, 1], [2, 1], [3, 1]] });
  assert.deepEqual(room.seats.get(id).queue.map(q => q.seq), [1, 2, 3]);
  room.handle(b, { t: 'in', id, f: [[9, 1]] });
  assert.equal(room.seats.get(id).queue.length, 3);
  room.handle(a, { t: 'in', id, f: [[4, 1], [5, 1], [6, 1]] });
  assert.ok(room.seats.get(id).queue.length <= 4);
});

test('host room: disconnect removes players and caps seats', () => {
  const room = new HostRoom({ seed: 2 });
  const a = fakeConn();
  room.addConn(a);
  for (let i = 0; i < 4; i++) room.handle(a, { t: 'join', name: 'x' + i });
  assert.equal(a.seatIds.length, 3);
  assert.ok(last(a, 'full'));
  room.removeConn(a);
  assert.equal(room.game.players.size, 0);
});
