// Four players on different connections (25-200 ms one way, with jitter), pressing random
// keys and bombs, simulated in virtual time against a real Room. Counts how often each
// player's predicted position had to be corrected by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../public/shared/room.js';
import { PredictedWorld, FRAME_MS } from '../public/shared/sim.js';

function simulate(arena, seed, seconds) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let now = 0; const events = []; const at = (t, fn) => events.push([t, fn]);
  const room = new Room({ seed, arena, now: () => now });
  const clients = [[25, 6], [60, 15], [120, 30], [200, 50]].map(([lat, jit]) => {
    const c = { lat, jit, pending: [], pred: null, world: null, seq: 0, up: 0, down: 0, dir: 0, held: 0, small: 0, big: 0 };
    c.conn = { send: m => { if (m.t === 'joined') c.id = m.id; }, sendText: t => { const m = JSON.parse(t); c.down = Math.max(now + lat + (rnd() * 2 - 1) * jit, c.down); at(c.down, () => onSnap(c, m)); } };
    room.addConn(c.conn); room.handle(c.conn, { t: 'join', name: 'P' });
    return c;
  });
  function onSnap(c, m) {
    const row = m.players.find(r => r[0] === c.id), ack = m.ack[c.id] ?? 0;
    c.pending = c.pending.filter(f => f.seq > ack);
    if (!row || m.phase !== 'play' || !row[5] || !row[18]) { c.pred = null; return; }
    const p = { x: row[1], y: row[2], dir: row[3], speed: row[7], kick: !!row[10], laid: row[20], bombs: row[9], canThrow: row[11], actionHeld: !!row[21] };
    c.world = new PredictedWorld(m);
    for (const f of c.pending) c.world.step(p, f.bits);
    if (c.pred) { const d = Math.abs(p.x - c.pred.x) + Math.abs(p.y - c.pred.y); if (d > 10) c.big++; else if (d) c.small++; }
    c.pred = p;
  }
  function clientTick(c) {
    if (rnd() < 0.08) c.dir = [1, 2, 4, 8, 0][Math.floor(rnd() * 5)];
    if (c.held > 0) c.held--; else if (rnd() < 0.04) c.held = 1 + Math.floor(rnd() * 3);
    const f = { seq: ++c.seq, bits: c.dir | (c.held ? 16 : 0) };
    c.pending.push(f);
    c.up = Math.max(now + c.lat + (rnd() * 2 - 1) * c.jit, c.up);
    const frames = c.pending.slice(-4).map(x => [x.seq, x.bits]);
    at(c.up, () => room.handle(c.conn, { t: 'in', id: c.id, f: frames }));
    if (c.pred) c.world.step(c.pred, f.bits);
  }
  let nextServer = 0; const nextClient = clients.map((_, i) => 3 + i * 9);
  while (now < seconds * 1000) {
    events.sort((a, b) => a[0] - b[0]);
    const tNext = Math.min(nextServer, ...nextClient, events.length ? events[0][0] : Infinity);
    now = tNext;
    if (events.length && events[0][0] === tNext) { events.shift()[1](); continue; }
    if (nextServer === tNext) { room.tick(); nextServer += FRAME_MS; continue; }
    const i = nextClient.indexOf(tNext); clientTick(clients[i]); nextClient[i] += FRAME_MS;
  }
  return clients;
}

test('4 players on 25-200 ms links: classic arena predictions almost never need correcting', () => {
  for (const seed of [1, 2]) {
    const cs = simulate('classic', seed, 120);
    for (const c of cs) assert.ok(c.big === 0 && c.small <= 3, `${c.lat} ms: ${c.small} small and ${c.big} big corrections in 2 minutes`);
  }
});

test('4 players on 25-200 ms links: madness (kicks, throws, 3 bombs each) stays close', () => {
  const cs = simulate('madness', 1, 120);
  for (const c of cs) assert.ok(c.big <= 3 && c.small <= 25, `${c.lat} ms: ${c.small} small and ${c.big} big corrections in 2 minutes (the rest are other players' new bombs and where thrown bombs land)`);
});
