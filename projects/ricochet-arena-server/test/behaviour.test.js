// Server-side behavioural anti-cheat: simulated human-style players must never
// be flagged; bots and scripted clients must be caught. Everything goes through
// the real room (validation -> game -> detector -> kick).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoom, STARVE_TICKS } from '../public/shared/room.js';
import { traceShot } from '../public/shared/anticheat.js';
import { rng, normRot, FRAMES_FROZEN } from '../public/shared/sim.js';

const DEG = 180 / Math.PI;
const gap = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---- behaviours: (game, me, rand, state) -> [bits, mx, my]
// bits: 1 forward, 2 back, 4 left, 8 right, 16 fire
function wanderer(g, me, r, st) { // random held key combos, fires now and then
  if (!st.hold || --st.hold <= 0) { st.keys = [0, 1, 1, 5, 9, 4, 8, 2][Math.floor(r() * 8)]; st.hold = 5 + Math.floor(r() * 20); }
  const fire = r() < 0.03 ? 16 : 0;
  return [st.keys | fire, 0, 0];
}

function nearestEnemy(g, me) {
  let best = null, bd = 1e9;
  for (const t of g.tanks.values()) if (t.id !== me.id && t.alive) { const d = Math.hypot(t.x - me.x, t.y - me.y); if (d < bd) { bd = d; best = t; } }
  return best;
}

function humanAimer(g, me, r, st) { // turns toward the nearest enemy, fires after a human reaction delay
  const e = nearestEnemy(g, me);
  if (!e) return wanderer(g, me, r, st);
  const want = normRot(Math.atan2(e.y - me.y, e.x - me.x) * DEG + 90);
  let d = want - me.rot; while (d > 180) d -= 360; while (d < -180) d += 360;
  let bits = Math.abs(d) > 6 ? (d > 0 ? 8 : 4) : 0;
  if (r() < 0.3) bits |= 1;
  if (Math.abs(d) <= 8) { st.lined = (st.lined || 0) + 1; } else st.lined = 0;
  if (st.lined === (st.delay ||= 5 + Math.floor(r() * 6))) { bits |= 16; st.delay = 0; }
  else if (r() < 0.01) bits |= 16; // the odd wild shot
  return [bits, 0, 0];
}

function smoothMouse(g, me, r, st) { // moves the pointer gradually toward the enemy, with wobble
  const e = nearestEnemy(g, me);
  const tx = e ? e.x + (r() - 0.5) * 30 : 200, ty = e ? e.y + (r() - 0.5) * 30 : 200;
  st.mx ??= me.x + 100; st.my ??= me.y;
  st.mx += Math.max(-12, Math.min(12, (tx - st.mx) * 0.2)); st.my += Math.max(-12, Math.min(12, (ty - st.my) * 0.2));
  return [r() < 0.03 ? 16 : 0, st.mx - g.maze.ox * 0, st.my];
}

function ricochetBot(g, me, r, st) { // scans by turning; fires the instant any shot (often a bank shot) would kill
  if (me.weapon === 'bullet' && me.bulletsFired === 0) {
    const shot = traceShot(g, me);
    if (shot && shot.victim !== me.id && !st.fired) { st.fired = true; return [16, 0, 0]; }
  }
  st.fired = false;
  st.walk = (st.walk || 0) + 1;
  return [(st.walk % 80 < 15 ? 1 : 0) | 8, 0, 0];
}

function mouseAimbot(g, me, r, st) { // pointer wanders, then snaps exactly onto the enemy and fires
  st.t = (st.t || 0) + 1;
  const e = nearestEnemy(g, me);
  if (e && st.t % 12 === 0) return [16, e.x, e.y];
  return [0, me.x + Math.cos(st.t) * 150, me.y + Math.sin(st.t * 1.3) * 150];
}

const jitterBot = (g, me, r, st) => [((st.t = (st.t || 0) + 1) % 2) ? 4 : 8, 0, 0];

// ---- harness
function arena(players, { ticks, seed = 1, framesPerTick = {} }) {
  let clock = 0;
  const room = new HostRoom({ seed, now: () => clock });
  const list = players.map(([name, brain, slot = 'arrows'], i) => {
    const c = { send: m => { if (m.t === 'joined') c.id = m.id; if (m.t === 'kicked') c.kicked = m.reason; }, kick() {} };
    room.addConn(c);
    room.handle(c, { t: 'join', name, slot, nonce: i + 1 });
    return { name, brain, c, r: rng(seed * 31 + i), st: {}, seq: 0 };
  });
  for (let k = 0; k < ticks; k++) {
    clock += 40;
    const g = room.game;
    for (const p of list) {
      const me = g.tanks.get(p.c.id);
      if (!me || p.c.kicked || p.stopAt <= k) continue;
      const [bits, mx, my] = me.alive && g.maze ? p.brain(g, me, p.r, p.st) : [0, 0, 0];
      const frames = [];
      for (let n = 0; n < (framesPerTick[p.name] || 1); n++) frames.push([++p.seq, bits, mx, my]);
      room.handle(p.c, { t: 'in', id: p.c.id, f: frames });
    }
    room.tick();
  }
  const verdicts = name => room.reports.filter(x => x.name === name);
  return { room, list, verdicts };
}

test('human-style players are never flagged (many games, mixed styles)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { room } = arena([['Wanda', wanderer], ['Aimee', humanAimer], ['Hugo', humanAimer], ['Mo', smoothMouse, 'mouse']], { ticks: 6000, seed });
    assert.deepEqual(room.reports, [], `seed ${seed}: ${JSON.stringify(room.reports)}`);
  }
});

test('a ricochet bot is detected and kicked', () => {
  const { verdicts, list } = arena([['Bot', ricochetBot], ['Aimee', humanAimer], ['Wanda', wanderer]], { ticks: 15000, seed: 3 });
  const v = verdicts('Bot');
  assert.ok(v.some(x => x.level === 'kick'), `bot verdicts: ${JSON.stringify(v)}`);
  assert.ok(list[0].c.kicked, 'bot connection was told it was kicked');
  assert.deepEqual(verdicts('Aimee').concat(verdicts('Wanda')), [], 'humans in the same game untouched');
});

test('a mouse aimbot (snapping onto targets) is kicked', () => {
  const { verdicts } = arena([['Snappy', mouseAimbot, 'mouse'], ['Wanda', wanderer], ['Hugo', humanAimer]], { ticks: 6000, seed: 2 });
  assert.ok(verdicts('Snappy').some(x => x.level === 'kick' && /aimbot/.test(x.reason)), JSON.stringify(verdicts('Snappy')));
});

test('frame-perfect scripted input is flagged', () => {
  const { verdicts } = arena([['Jitter', jitterBot], ['Wanda', wanderer]], { ticks: 1200, seed: 4 });
  assert.ok(verdicts('Jitter').some(x => /frame-perfect/.test(x.reason)), JSON.stringify(verdicts('Jitter')));
});

test('a client sending inputs faster than real time gains nothing and is flagged', () => {
  const { verdicts, room, list } = arena([['Speedy', wanderer], ['Wanda', wanderer]], { ticks: 1200, seed: 5, framesPerTick: { Speedy: 2 } });
  assert.ok(verdicts('Speedy').some(x => /clock/.test(x.reason)), JSON.stringify(verdicts('Speedy')));
  assert.ok(room.seats.get(list[0].c.id).queue.length <= 4, 'queue stays bounded');
});

test('kicked players cannot rejoin from the same connection', () => {
  const { room, list } = arena([['Snappy', mouseAimbot, 'mouse'], ['Wanda', wanderer]], { ticks: 6000, seed: 2 });
  const bot = list[0].c;
  assert.ok(bot.kicked);
  const got = [];
  bot.send = m => got.push(m);
  room.handle(bot, { t: 'join', name: 'Snappy again', slot: 'arrows' });
  assert.equal(got[0].t, 'banned');
  assert.ok(!room.game.players.has(bot.id));
});

test('a seat whose inputs stop arriving goes idle instead of repeating its last input', () => {
  const drive = () => [1, 0, 0];
  const { room, list } = arena([['Lag', drive], ['Wanda', wanderer]], { ticks: FRAMES_FROZEN + 20, seed: 6 });
  list[0].stopAt = 0;
  const t = room.game.tanks.get(list[0].c.id);
  const positions = [];
  for (let k = 0; k < STARVE_TICKS + 6; k++) { room.tick(); positions.push([t.x, t.y]); }
  const [a, b] = [positions.at(-2), positions.at(-1)];
  assert.deepEqual(a, b, 'tank stopped after the starvation window');
});

test('anti-cheat can be set to report-only or off', () => {
  for (const mode of ['flag', 'off']) {
    let clock = 0;
    const room = new HostRoom({ seed: 2, anticheat: mode, now: () => clock });
    const c = { send: m => { if (m.t === 'joined') c.id = m.id; if (m.t === 'kicked') c.kicked = true; }, kick() {} };
    room.addConn(c);
    room.handle(c, { t: 'join', name: 'x', slot: 'mouse' });
    room.onVerdict(c.id, 'kick', 'test', {});
    assert.ok(!c.kicked, `${mode}: no kick`);
    assert.equal(room.reports.length, 1);
  }
});

test('a short network hiccup keeps the tank moving (no stutter for honest players)', () => {
  const spin = () => [8, 0, 0]; // turning right (can't be blocked by a wall for long)
  const { room, list } = arena([['Wifi', spin], ['Wanda', wanderer]], { ticks: FRAMES_FROZEN + 20, seed: 6 });
  const t = room.game.tanks.get(list[0].c.id);
  room.seats.get(list[0].c.id).queue.length = 0;
  const seen = new Set();
  for (let k = 0; k < STARVE_TICKS - 1; k++) { room.tick(); seen.add(t.rot); } // ~1.5 s gap: still on the last input
  assert.ok(seen.size > 10, 'tank kept turning through the gap');
});

test('a detector error never stops the game', () => {
  const { room } = arena([['A', wanderer], ['B', wanderer]], { ticks: FRAMES_FROZEN + 5, seed: 7 });
  room.watch.afterTick = () => { throw new Error('boom'); };
  const tick0 = room.game.tick;
  for (let k = 0; k < 10; k++) room.tick();
  assert.equal(room.game.tick, tick0 + 10);
  assert.equal(room.watch, null, 'detector switched itself off');
});

test('anti-cheat adds little time per tick, even in a full room', () => {
  const players = Array.from({ length: 8 }, (_, i) => [`P${i}`, i % 2 ? humanAimer : wanderer]);
  const time = anticheat => {
    let clock = 0;
    const room = new HostRoom({ seed: 9, anticheat, verifiable: true, now: () => clock });
    const cs = players.map(([name], i) => { const c = { send: m => { if (m.t === 'joined') c.id = m.id; } }; room.addConn(c); room.handle(c, { t: 'join', name, nonce: i + 1 }); return c; });
    const rs = cs.map((_, i) => rng(i + 5)), sts = cs.map(() => ({}));
    let seq = 0;
    const t0 = performance.now();
    for (let k = 0; k < 2000; k++) {
      clock += 40; seq++;
      cs.forEach((c, i) => { const me = room.game.tanks.get(c.id); if (me?.alive && room.game.maze) room.handle(c, { t: 'in', id: c.id, f: [[seq, ...players[i][1](room.game, me, rs[i], sts[i])]] }); });
      room.tick();
    }
    return (performance.now() - t0) / 2000;
  };
  const off = time('off'), on = time('kick');
  console.log(`  ms per tick, 8 players: anti-cheat off ${off.toFixed(3)}, on ${on.toFixed(3)} (budget 40)`);
  assert.ok(on < 4, 'well inside the 40 ms tick');
  assert.ok(on - off < 2, 'detector costs < 2 ms per tick');
});

test('flags are reported to every player, with every snapshot', () => {
  const { room, list } = arena([['Sus', wanderer], ['Ann', wanderer], ['Bea', wanderer]], { ticks: FRAMES_FROZEN + 5, seed: 8 });
  const msgs = [];
  list[1].c.send = m => msgs.push(m);
  room.onVerdict(list[0].c.id, 'flag', 'unusually many ricochet kill shots', {});
  room.tick(); room.tick();
  const snaps = msgs.filter(m => m.t === 's');
  assert.ok(snaps[0].ev.some(e => e.type === 'flag' && e.name === 'Sus'), 'announced once as an event');
  for (const s of snaps) assert.deepEqual(s.flags, [[list[0].c.id, ['unusually many ricochet kill shots'], 0, 2]], 'and listed in every snapshot');
});

test('players can vote a flagged player out by majority; votes are limited to flagged players', () => {
  const { room, list } = arena([['Sus', wanderer], ['Ann', wanderer], ['Bea', wanderer], ['Cy', wanderer]], { ticks: FRAMES_FROZEN + 5, seed: 8 });
  const [sus, ann, bea, cy] = list.map(p => p.c);
  room.handle(ann, { t: 'vote', id: bea.id });           // Bea isn't flagged: ignored
  assert.ok(room.seats.has(bea.id));
  room.onVerdict(sus.id, 'flag', 'inhumanly fast reactions', {});
  room.handle(sus, { t: 'vote', id: sus.id });           // can't vote on yourself
  room.handle(ann, { t: 'vote', id: sus.id });
  room.handle(ann, { t: 'vote', id: sus.id });           // one vote per player
  assert.ok(room.seats.has(sus.id), '1 of 3 is not a majority');
  room.handle(bea, { t: 'vote', id: sus.id });           // 2 of 3
  assert.ok(!room.seats.has(sus.id), 'majority removes the flagged player');
  assert.match(sus.kicked, /voted out/);
  room.tick();
  assert.ok(!room.game.players.has(sus.id));
  assert.ok(room.reports.some(r => r.reason === 'player vote'));
});
