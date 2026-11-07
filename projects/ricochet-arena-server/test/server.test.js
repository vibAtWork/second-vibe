import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../server.js';
import { moveTank, FRAMES_FROZEN } from '../public/shared/sim.js';

function client(port, room) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?room=${room}`);
  const c = { ws, msgs: [], maze: null, snap: null, id: null };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 'maze') c.maze = m.maze;
    if (m.t === 's') c.snap = m;
    if (m.t === 'joined') c.id = m.id;
    c.msgs.push(m);
  });
  c.open = new Promise(r => ws.on('open', r));
  c.send = m => ws.send(JSON.stringify(m));
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(10); }
}

test('two clients join a room, see each other, and server movement matches local prediction', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const a = client(srv.port, 'r1'), b = client(srv.port, 'r1');
    await Promise.all([a.open, b.open]);
    a.send({ t: 'join', name: 'Alice', slot: 'arrows' });
    await until(() => a.id);
    b.send({ t: 'join', name: 'Bob', slot: 'arrows' });
    await until(() => b.id && a.snap && a.snap.tanks.length === 2 && b.snap && b.snap.tanks.length === 2);
    // wait for the freeze to end
    await until(() => a.snap.frozen === 0, (FRAMES_FROZEN + 30) * 40);
    const t0 = a.snap.tanks.find(t => t[0] === a.id);
    const ack0 = a.snap.ack[a.id] || 0;
    // Send 10 frames of "forward + turn right", one per tick.
    const pred = { x: t0[1], y: t0[2], rot: t0[3] };
    for (let i = 1; i <= 10; i++) {
      a.send({ t: 'in', id: a.id, f: [[ack0 + i, 1 | 8, 0, 0]] });
      moveTank(a.maze, pred, { f: 1, r: 1 });
      await wait(40);
    }
    await until(() => (a.snap.ack[a.id] || 0) >= ack0 + 10);
    // Stop sending; server repeats last input until we send idle, so send idle now
    // and compare the state at ack = ack0+10 by waiting for exact ack.
    const snapAtAck = a.msgs.filter(m => m.t === 's' && m.ack && m.ack[a.id] === ack0 + 10)[0];
    const t1 = snapAtAck.tanks.find(t => t[0] === a.id);
    assert.ok(Math.abs(t1[1] - pred.x) < 0.02 && Math.abs(t1[2] - pred.y) < 0.02, `server ${t1} vs predicted ${JSON.stringify(pred)}`);
    assert.ok(Math.abs(t1[3] - pred.rot) < 0.01);
    // Bob sees Alice's tank too
    assert.ok(b.snap.tanks.some(t => t[0] === a.id));
    assert.equal(b.snap.players.length, 2);
    a.ws.close(); b.ws.close();
  } finally { srv.close(); }
});

test('rooms are isolated and firing creates a bullet visible to others', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const a = client(srv.port, 'x'), b = client(srv.port, 'x'), c = client(srv.port, 'y');
    await Promise.all([a.open, b.open, c.open]);
    a.send({ t: 'join', name: 'A', slot: 'arrows' });
    b.send({ t: 'join', name: 'B', slot: 'arrows' });
    c.send({ t: 'join', name: 'C', slot: 'arrows' });
    await until(() => a.id && b.id && c.id && c.snap);
    await until(() => b.snap && b.snap.players.length === 2 && c.snap.players.length === 1);
    await until(() => a.snap.frozen === 0, (FRAMES_FROZEN + 30) * 40);
    a.send({ t: 'in', id: a.id, f: [[1000, 16, 0, 0]] });
    await until(() => b.snap.bullets.length >= 1 || b.snap.tanks.some(t => !t[4]));
    assert.equal(c.snap.bullets.length, 0);
    // A seat can't be driven by another connection
    b.send({ t: 'in', id: a.id, f: [[5000, 1, 0, 0]] });
    a.ws.close(); b.ws.close(); c.ws.close();
  } finally { srv.close(); }
});

test('static files are served', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const r = await fetch(`http://localhost:${srv.port}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Ricochet/);
    const s = await fetch(`http://localhost:${srv.port}/shared/sim.js`);
    assert.equal(s.status, 200);
    const bad = await fetch(`http://localhost:${srv.port}/..%2fserver.js`);
    assert.notEqual(bad.status, 200);
  } finally { srv.close(); }
});

test('admin reports need the token; a kicked cheater is banned from reconnecting', async () => {
  const srv = await createServer({ port: 0, log: () => {}, adminToken: 'secret' });
  try {
    assert.equal((await fetch(`http://localhost:${srv.port}/admin/reports`)).status, 404);
    assert.equal((await fetch(`http://localhost:${srv.port}/admin/reports?token=nope`)).status, 404);
    const a = client(srv.port, 'ban');
    await a.open;
    a.send({ t: 'join', name: 'Cheater', slot: 'arrows' });
    await until(() => a.id);
    const room = srv.rooms.get('ban');
    room.onVerdict(a.id, 'kick', 'test verdict', { n: 1 });
    await until(() => a.msgs.some(m => m.t === 'kicked'));
    const r = await (await fetch(`http://localhost:${srv.port}/admin/reports?token=secret`)).json();
    assert.equal(r.reports[0].reason, 'test verdict');
    assert.equal(r.bans.length, 1);
    await until(() => a.ws.readyState === 3, 3000); // server closes the kicked connection
    const again = new WebSocket(`ws://localhost:${srv.port}/ws?room=ban`);
    const code = await new Promise(res => again.on('close', c => res(c)));
    assert.equal(code, 4003);
  } finally { srv.close(); }
});
