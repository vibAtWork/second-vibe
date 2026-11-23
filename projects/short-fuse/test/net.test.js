// Players on real-world connections, simulated in virtual time against a real Room: network
// latency and jitter both ways, computer clocks running a little fast or slow, people who
// keep moving. Counts how often a player's own predicted position had to be corrected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { Prediction, TICK_MS, UP, DOWN, LEFT, RIGHT, BOMB_KEY } from '../public/shared/game.js';

function simulate({ arena = 'classic', seed = 1, seconds = 120, links, input, keepAlive = false }) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let now = 0; const queue = []; const later = (t, fn) => queue.push([t, fn]);
  const room = new Room({ seed, arena, now: () => now });
  const players = links.map(({ lat, jit, clock = 0 }, n) => {
    const c = { lat, jit, clock, pending: [], pred: null, seq: 0, up: 0, down: 0, mem: {}, small: 0, big: 0, lag: [], next: 3 + n * 9 };
    c.conn = { send: m => { if (m.t === 'joined') c.id = m.id; }, sendText: t => { const m = JSON.parse(t); c.down = Math.max(now + lat + (rnd() * 2 - 1) * jit, c.down); later(c.down, () => receive(c, m)); } };
    room.addConn(c.conn); room.handle(c.conn, { t: 'join', name: 'P' + n });
    return c;
  });
  if (players.length === 1) { const o = { send() {}, sendText() {} }; room.addConn(o); room.handle(o, { t: 'join', name: 'idle' }); }
  function receive(c, m) {
    const row = m.players.find(r => r[0] === c.id), ack = m.ack[c.id] ?? 0;
    c.lag.push(c.seq - ack); c.pending = c.pending.filter(f => f.seq > ack);
    if (!row || m.phase !== 'play' || !row[4] || !row[5]) { c.pred = null; return; }
    const pred = new Prediction(m, { id: row[0], x: row[1], y: row[2], dir: row[3], speed: row[8], kick: !!row[12], laid: row[11], bombs: row[10], glove: row[13], button: !!row[14] });
    for (const f of c.pending) pred.step(f.keys);
    if (c.pred) { const d = Math.abs(pred.p.x - c.pred.p.x) + Math.abs(pred.p.y - c.pred.p.y); if (d > 10) c.big++; else if (d) c.small++; }
    c.pred = pred;
  }
  function press(c) {
    const f = { seq: ++c.seq, keys: input(c.mem, rnd) };
    c.pending.push(f);
    c.up = Math.max(now + c.lat + (rnd() * 2 - 1) * c.jit, c.up);
    const frames = c.pending.slice(-4).map(x => [x.seq, x.keys]);
    later(c.up, () => room.handle(c.conn, { t: 'in', id: c.id, f: frames }));
    c.pred?.step(f.keys);
  }
  let server = 0;
  while (now < seconds * 1000) {
    queue.sort((a, b) => a[0] - b[0]);
    const t = Math.min(server, ...players.map(c => c.next), queue.length ? queue[0][0] : Infinity); now = t;
    if (queue.length && queue[0][0] === t) { queue.shift()[1](); continue; }
    if (server === t) {
      if (keepAlive) { for (const p of room.game.fighters()) { p.inv = 99; p.lives = 3; } room.game.elapsed = 0; }
      room.tick(); server += TICK_MS; continue;
    }
    const c = players.find(x => x.next === t); press(c); c.next += TICK_MS / (1 + c.clock);
  }
  return players.map(c => { const tail = c.lag.slice(-300); return { lat: c.lat, clock: c.clock, small: c.small, big: c.big, lagMs: tail.reduce((a, b) => a + b, 0) / tail.length * TICK_MS }; });
}
const mover = (m, rnd) => { if (!m.dir || rnd() < 0.04) m.dir = [UP, DOWN, LEFT, RIGHT][Math.floor(rnd() * 4)]; return m.dir; }; // never stops
const masher = (m, rnd) => { if (rnd() < 0.08) m.dir = [UP, DOWN, LEFT, RIGHT, 0][Math.floor(rnd() * 5)]; if (m.b > 0) m.b--; else if (rnd() < 0.04) m.b = 1 + Math.floor(rnd() * 3); return (m.dir || 0) | (m.b ? BOMB_KEY : 0); };

test('always moving, clock up to 1% fast or slow, 50-400 ms round trip: no corrections, lag = round trip', () => {
  for (const link of [{ lat: 60, jit: 15, clock: 0.01 }, { lat: 60, jit: 15, clock: -0.01 }, { lat: 120, jit: 30, clock: 0.003 }, { lat: 200, jit: 50, clock: 0.01 }, { lat: 25, jit: 6 }]) {
    const [r] = simulate({ arena: 'madness', seconds: 300, links: [link], input: mover, keepAlive: true });
    assert.equal(r.small + r.big, 0, `${link.lat} ms, clock ${link.clock ?? 0}: ${r.small + r.big} corrections`);
    assert.ok(r.lagMs < 2 * link.lat + link.jit + 3 * TICK_MS, `${link.lat} ms: input lag ${r.lagMs.toFixed(0)} ms`);
  }
});

test('4 players mashing keys and bombs on 25-200 ms links: classic needs (almost) no corrections', () => {
  const links = [{ lat: 25, jit: 6 }, { lat: 60, jit: 15, clock: 0.005 }, { lat: 120, jit: 30 }, { lat: 200, jit: 50, clock: -0.005 }];
  for (const seed of [1, 2]) for (const r of simulate({ seed, links, input: masher })) assert.ok(r.big === 0 && r.small <= 3, `${r.lat} ms: ${r.small} small, ${r.big} big corrections`);
});

test('4 players in madness (kicks, throws, 3 bombs each): only what nobody could predict', () => {
  const links = [{ lat: 25, jit: 6 }, { lat: 60, jit: 15 }, { lat: 120, jit: 30 }, { lat: 200, jit: 50 }];
  // what's left is other players' bombs moving into your path: kicked bombs coming to rest and
  // thrown bombs landing (not predicted, by design: it would mean simulating everyone's bombs)
  for (const seed of [1, 2]) for (const r of simulate({ seed, arena: 'madness', links, input: masher })) assert.ok(r.big <= 8 && r.small + r.big <= 20, `${r.lat} ms: ${r.small} small, ${r.big} big corrections in 2 minutes of four button-mashers`);
});
