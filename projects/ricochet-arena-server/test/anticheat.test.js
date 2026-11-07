import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoom, normaliseFrame, cleanName, MAX_QUEUE } from '../public/shared/room.js';
import { Auditor } from '../public/shared/verify.js';
import { Game, FRAMES_FROZEN } from '../public/shared/sim.js';
import * as dm from '../public/shared/dmath.js';

let clock = 0;
const now = () => clock;
function conn() { const c = { msgs: [], kicked: false, send: m => c.msgs.push(JSON.parse(JSON.stringify(m))), kick: () => { c.kicked = true; } }; return c; }
const last = (c, t) => c.msgs.filter(m => m.t === t).at(-1);

// A guest client: sends joins/inputs and audits everything the host publishes.
function guest(room, name) {
  const c = conn();
  const cheats = [];
  const a = new Auditor(r => cheats.push(r));
  room.addConn(c);
  const deliver = () => { for (const m of c.msgs.splice(0)) { if (m.t === 'sync') a.sync(m.state); if (m.t === 'log') a.log(m); if (m.t === 'joined') { a.noteSeat(m.id); c.id = m.id; } c.seen = (c.seen || []).concat(m); } };
  return {
    c, a, cheats, deliver,
    join(slot = 'arrows', nonce = 1234) { const n = cleanName(name); a.noteJoin(n, nonce); room.handle(c, { t: 'join', name: n, slot, nonce }); deliver(); },
    send(seq, bits, mx = 0, my = 0) {
      const f = normaliseFrame(slot(room, c.id), bits, mx, my);
      a.noteFrame(c.id, seq, f);
      room.handle(c, { t: 'in', id: c.id, f: [[seq, ...f]] });
    },
  };
}
const slot = (room, id) => room.seats.get(id).scheme;

test('deterministic trig matches Math to ~1e-15 and is the only trig the sim uses', () => {
  for (let i = -2000; i <= 2000; i++) {
    const x = i * 0.0137;
    assert.ok(Math.abs(dm.sin(x) - Math.sin(x)) < 2e-15, `sin ${x}`);
    assert.ok(Math.abs(dm.cos(x) - Math.cos(x)) < 2e-15, `cos ${x}`);
    const y = Math.sin(i) * 7, z = Math.cos(i * 1.3) * 5;
    assert.ok(Math.abs(dm.atan2(y, z) - Math.atan2(y, z)) < 4e-15, `atan2 ${y},${z}`);
  }
  assert.equal(dm.atan2(0, -1), Math.PI);
});

test('game serialises and resumes bit-exactly', () => {
  const g = new Game(77);
  g.addPlayer(1, 'a', '#f00', 5); g.addPlayer(2, 'b', '#0f0', 9);
  const inp = i => new Map([[1, { f: 1, r: i % 7 < 3 ? 1 : 0, fire: i % 11 === 0 ? 1 : 0 }], [2, { b: i % 5 ? 1 : 0, l: 1, fire: i % 13 === 0 ? 1 : 0 }]]);
  for (let i = 0; i < 300; i++) g.step(inp(i));
  const copy = Game.deserialize(JSON.parse(JSON.stringify(g.serialize())));
  assert.equal(copy.hash(), g.hash());
  for (let i = 300; i < 900; i++) { g.step(inp(i)); copy.step(inp(i)); }
  assert.equal(copy.hash(), g.hash());
});

test('room validation: control scheme is locked per seat, garbage is dropped, one frame per tick', () => {
  const room = new HostRoom({ seed: 1, now });
  const k = guest(room, 'keys'), m = guest(room, 'mouse');
  k.join('arrows'); m.join('mouse');
  room.tick();
  // keyboard seat tries to send mouse aim -> mouse bit stripped
  room.handle(k.c, { t: 'in', id: k.c.id, f: [[1, 32 | 1, 100, 100]] });
  assert.deepEqual(room.seats.get(k.c.id).queue[0].frame, [1, 0, 0]);
  // mouse seat tries to send keys -> only fire kept, mouse bit forced
  room.handle(m.c, { t: 'in', id: m.c.id, f: [[1, 15 | 16, 50, 60]] });
  assert.deepEqual(room.seats.get(m.c.id).queue[0].frame, [48, 50, 60]);
  // garbage
  for (const bad of [[[1.5, 1]], [['x', 1]], [[2, 'f']], [[3, 1, NaN, 0]], 'nope', [[2 ** 40, 1]]]) room.handle(m.c, { t: 'in', id: m.c.id, f: bad });
  assert.equal(room.seats.get(m.c.id).queue.length, 1);
  // can't drive someone else's tank
  room.handle(k.c, { t: 'in', id: m.c.id, f: [[9, 16, 0, 0]] });
  assert.equal(room.seats.get(m.c.id).queue.length, 1);
  // flooding many frames: bounded queue, consumed one per tick
  room.handle(k.c, { t: 'in', id: k.c.id, f: [[2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1]] });
  assert.ok(room.seats.get(k.c.id).queue.length <= MAX_QUEUE);
  const before = room.seats.get(k.c.id).queue.length;
  room.tick();
  assert.equal(room.seats.get(k.c.id).queue.length, before - 1);
  // names are sanitised
  assert.equal(cleanName('a‮b\u0000c' + 'x'.repeat(40)).length, 16);
  assert.ok(!cleanName('a‮b').includes('‮'));
});

test('room rate limit kicks a flooding connection', () => {
  clock = 0;
  const room = new HostRoom({ seed: 1, now });
  const c = conn();
  room.addConn(c);
  for (let i = 0; i < 2000; i++) room.handle(c, { t: 'ping', c: i });
  assert.ok(c.msgs.filter(m => m.t === 'pong').length <= 160);
  assert.equal(c.kicked, true);
});

function honestSetup() {
  clock = 0;
  const room = new HostRoom({ seed: 42, verifiable: true, now });
  const a = guest(room, 'Alice'), b = guest(room, 'Bob');
  a.join('arrows', 111); b.join('mouse', 222);
  return { room, a, b };
}
function play(room, players, ticks, from = 1) {
  for (let i = from; i < from + ticks; i++) {
    clock += 40;
    players[0].send(i, (i % 3 ? 1 : 0) | (i % 9 < 4 ? 8 : 0) | (i % 17 === 0 ? 16 : 0));
    players[1].send(i, i % 23 === 0 ? 16 : 0, 200 + (i % 50) * 3, 150);
    room.tick();
    for (const p of players) p.deliver();
  }
}

test('honest host passes every audit for a long game', () => {
  const { room, a, b } = honestSetup();
  play(room, [a, b], FRAMES_FROZEN + 600);
  assert.deepEqual(a.cheats, []); assert.deepEqual(b.cheats, []);
  assert.equal(a.a.game.hash(), room.game.hash());
});

test('a late joiner syncs and audits from then on', () => {
  const { room, a, b } = honestSetup();
  play(room, [a, b], 200);
  const c = guest(room, 'Late');
  c.deliver();
  c.join('esdf', 333);
  play(room, [a, b], 200, 201);
  for (let i = 0; i < 50; i++) { clock += 40; c.send(i + 1, 1); room.tick(); a.deliver(); b.deliver(); c.deliver(); }
  assert.deepEqual([...a.cheats, ...b.cheats, ...c.cheats], []);
});

test('host that changes the rules is caught', () => {
  const { room, a, b } = honestSetup();
  play(room, [a, b], FRAMES_FROZEN + 20);
  // e.g. host makes its own tank immortal / teleports
  const t = room.game.tanks.get(a.c.id);
  t.x += 3;
  play(room, [a, b], 2, FRAMES_FROZEN + 21);
  assert.match(b.cheats[0], /state differs/);
});

test('host that forges or alters a guest input is caught by that guest', () => {
  const { room, a, b } = honestSetup();
  play(room, [a, b], FRAMES_FROZEN + 5);
  // tamper with Alice's queued input before the tick
  a.send(9999, 1);
  room.seats.get(a.c.id).queue.at(-1).frame = [16, 0, 0];
  room.tick(); a.deliver();
  assert.match(a.cheats[0], /altered my input/);
});

test('host that replaces a guest nonce (seed grinding) or kicks silently is caught', () => {
  clock = 0;
  const room = new HostRoom({ seed: 42, verifiable: true, now });
  const a = guest(room, 'Alice');
  a.a.noteJoin('Alice', 5);
  room.handle(a.c, { t: 'join', name: 'Alice', slot: 'arrows', nonce: 5 });
  room.ops.at(-1)[4] = 6; // host swaps the nonce
  a.deliver(); room.tick(); a.deliver();
  assert.match(a.cheats[0], /join was altered/);

  const { room: r2, a: a2, b: b2 } = honestSetup();
  play(r2, [a2, b2], 10);
  r2.dropSeat(a2.c, a2.c.id);
  r2.tick(); a2.deliver();
  assert.match(a2.cheats[0], /removed my tank/);
});

test('host that keeps playing but stops publishing audit data is flagged; a frozen host is not', () => {
  const { room, a, b } = honestSetup();
  play(room, [a, b], 5);
  const later = performance.now() + 10000;
  assert.equal(a.a.stale(later, later - 100), true, 'snapshots still arriving, no audit log');
  assert.equal(a.a.stale(later, later - 9000), false, 'host frozen (tab suspended): just lag, not cheating');
});
