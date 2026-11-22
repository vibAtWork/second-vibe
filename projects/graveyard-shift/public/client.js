// Browser client: input, prediction of your own movement, interpolation of
// everything else, events -> effects/sounds, and the render loop.
import { FRAME_MS, VIEW_W, VIEW_H, WEAPONS, movePlayer, gunStep } from './shared/sim.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';

// Others are drawn in the past by one snapshot interval plus the jitter seen lately
// (about 50 ms on a steady connection, more on a jittery one).
const INTERP_MIN = 30, INTERP_MAX = 200, INTERP_MARGIN = 6, JITTER_WINDOW = 100; // window: ~2 s at 50 updates/s
const SEND_REDUNDANCY = 4;  // resend recent input frames (packet-loss tolerance)
const SMOOTH = 0.7;         // fade-out of prediction corrections
// Controls. Player 1: arrows, Space, 1-0 or Z/X to switch. Player 2 (same keyboard): WASD, F, R/T to switch.
const KEYS = {
  p1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Space', prev: 'KeyZ', next: 'KeyX', numbers: true },
  p2: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyF', prev: 'KeyR', next: 'KeyT', numbers: false },
};
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const GAME_KEYS = new Set([...Object.values(KEYS).flatMap(k => [k.up, k.down, k.left, k.right, k.fire, k.prev, k.next]), ...DIGITS]);
const lerp = (a, b, t) => a + (b - a) * t;

// Snapshot rows -> objects (field order defined by Game.snapshot in shared/sim.js).
function decode(s) {
  const players = s.players.map(([id, x, y, fx, fy, hp, alive, weapon, score, frags, ammo, revive, name, color, shield, respawn, cd, held]) => ({ id, x, y, fx, fy, hp, alive: !!alive, weapon, score, frags, ammo, revive, name, color, shield: !!shield, respawn, cd, held: !!held }));
  return {
    ...s, players,
    playerById: new Map(players.map(p => [p.id, p])),
    enemies: s.enemies.map(([id, h, x, y, hp]) => ({ id, hexer: !!h, x, y, hp })),
    shots: s.shots.map(([id, kind, x, y]) => ({ id, kind, x, y })),
    objects: s.objects.map(([id, kind, x, y, hp, owner]) => ({ id, kind, x, y, hp, owner })),
    pickups: s.pickups.map(([id, kind, x, y]) => ({ id, kind, x, y })),
  };
}

export function startClient() {
  const $ = id => document.getElementById(id);
  const canvas = $('c'), statusEl = $('status');
  const { draw, fx } = createRenderer(canvas);
  const audio = createAudio();
  const params = new URLSearchParams(location.search);
  if (!params.get('room')) { params.set('room', Math.random().toString(36).slice(2, 8)); history.replaceState(null, '', '?' + params); }
  const room = params.get('room');
  // Mode and difficulty travel in the invite link; the room's first visitor sets them.
  $('mode').value = params.get('mode') === 'deathmatch' ? 'deathmatch' : 'coop';
  $('diff').value = ['beginner', 'intermediate', 'expert', 'nightmare'].includes(params.get('diff')) ? params.get('diff') : 'beginner';
  const newRoom = () => { const p = new URLSearchParams({ room: Math.random().toString(36).slice(2, 8), mode: $('mode').value, diff: $('diff').value }); location.search = '?' + p; };
  $('mode').onchange = newRoom; $('diff').onchange = newRoom;
  const showMode = (mode, diff) => { // the header shows what the room actually plays
    $('mode').value = mode; if (diff) $('diff').value = diff;
    $('diff').disabled = mode === 'deathmatch';
  };
  showMode($('mode').value);
  try { $('name').value = localStorage.getItem('gs-name') || ''; } catch { /* private mode */ }

  // ---- input
  const keys = new Set(), tapped = new Set(), released = new Set(); // tapped/released: since the last input frame
  addEventListener('keydown', e => {
    audio.unlock();
    if (document.activeElement === $('name') || !GAME_KEYS.has(e.code)) return;
    keys.add(e.code); if (!e.repeat) tapped.add(e.code); e.preventDefault();
  });
  addEventListener('keyup', e => { keys.delete(e.code); released.add(e.code); });
  addEventListener('blur', () => keys.clear());
  addEventListener('pointerdown', () => audio.unlock());

  // ---- state
  let ws = null, map = null, latest = null, clockOffset = null, rtt = 0, banner = null, interpMs = 80, snapGap = 40;
  const seats = [];   // local players: { slot, id, seq, pending, pred, off }
  const snaps = [], offsets = [];

  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${new URLSearchParams({ room, mode: $('mode').value, diff: $('diff').value })}`);
    ws.onopen = () => {
      statusEl.textContent = `room "${room}"`;
      const slots = seats.splice(0).map(s => s.slot);
      snaps.length = offsets.length = 0; clockOffset = latest = null; interpMs = 80;
      slots.forEach(join);
    };
    ws.onclose = () => { statusEl.textContent = 'disconnected - retrying…'; setTimeout(connect, 1500); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ } };
  }

  function join(slot) {
    if (seats.some(s => s.slot === slot)) return;
    const base = $('name').value.trim() || 'Survivor';
    try { localStorage.setItem('gs-name', base); } catch { /* private mode */ }
    seats.push({ slot, id: null, seq: 0, pending: [], pred: null, off: { x: 0, y: 0 }, gun: null, played: new Set() });
    send({ t: 'join', name: slot === 'p1' ? base : `${base} 2`, slot });
    audio.unlock();
    updateButtons();
  }
  const updateButtons = () => { $('join').disabled = seats.some(s => s.slot === 'p1'); $('join2').disabled = seats.some(s => s.slot === 'p2'); };
  $('join').onclick = () => join('p1');
  $('join2').onclick = () => join('p2');
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied!'; } catch { prompt('Copy this link:', location.href); }
    setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 1500);
  };

  function onMessage(m) {
    if (m.t === 'map') { map = m; snaps.length = 0; for (const s of seats) s.pred = null; }
    else if (m.t === 'joined') { const s = seats.find(s => s.slot === m.slot && s.id == null); if (s) s.id = m.id; }
    else if (m.t === 'full') { seats.pop(); updateButtons(); statusEl.textContent = 'room is full (4 players)'; }
    else if (m.t === 'pong') rtt = performance.now() - m.c;
    else if (m.t === 's') onSnapshot(decode(m));
  }

  function onSnapshot(s) {
    const now = performance.now();
    if (!latest || latest.mode !== s.mode || latest.difficulty !== s.difficulty) showMode(s.mode, s.difficulty);
    latest = s;
    if (snaps.length) snapGap = Math.max(1, Math.min(10, s.tick - snaps.at(-1).tick)) * FRAME_MS; // the server's update interval
    snaps.push(s); if (snaps.length > 40) snaps.shift();
    offsets.push(now - s.tick * FRAME_MS); if (offsets.length > JITTER_WINDOW) offsets.shift();
    const best = Math.min(...offsets);
    clockOffset = clockOffset == null ? best : clockOffset + (best - clockOffset) * 0.1;
    const late = Math.max(...offsets) - best; // worst lateness over the last ~2 s
    const want = Math.max(INTERP_MIN, Math.min(INTERP_MAX, snapGap + late + INTERP_MARGIN));
    interpMs += (want - interpMs) * (want > interpMs ? 0.5 : 0.02); // back off fast, tighten slowly
    for (const ev of s.ev) onEvent(ev, s);
    // prediction: authoritative position at the acknowledged input + inputs not yet applied
    for (const seat of seats) {
      const p = seat.id != null && s.playerById.get(seat.id);
      if (!p || !map) { seat.pred = null; seat.gun = null; continue; }
      const ack = s.ack[seat.id] ?? 0;
      seat.pending = seat.pending.filter(f => f.seq > ack);
      for (const q of seat.played) if (q <= ack) seat.played.delete(q); // the server has reported those frames' shots
      // the trigger: the same rollback, so played shots line up with the server's
      seat.gun = { alive: p.alive, respawn: p.respawn, weapon: p.weapon, cd: p.cd, held: p.held, charging: 0, ammo: p.ammo.map(a => (a < 0 ? Infinity : a)) };
      for (const f of seat.pending) gunStep(seat.gun, f.bits, f.wire[2], s);
      const before = seat.pred;
      const pred = { x: p.x, y: p.y, fx: p.fx, fy: p.fy, alive: p.alive };
      if (p.alive) for (const f of seat.pending) movePlayer(map, s.objects, pred, f.bits);
      seat.pred = pred;
      if (before?.alive && pred.alive) {
        seat.off.x += before.x - pred.x; seat.off.y += before.y - pred.y;
        if (Math.abs(seat.off.x) + Math.abs(seat.off.y) > 64) seat.off = { x: 0, y: 0 };
      }
    }
  }

  const nameOf = (s, id) => s.playerById.get(id)?.name ?? '?';
  function onEvent(ev, s) {
    const mine = seats.some(x => x.id === ev.id);
    switch (ev.type) {
      case 'tracer': fx.tracer(ev.x1, ev.y1, ev.x2, ev.y2, ev.rail); if (!alreadyPlayed(ev)) fx.flash(ev.x1, ev.y1); break;
      case 'shot': if (!alreadyPlayed(ev)) { audio.shot[ev.weapon]?.(); if (mine) shotStats.late++; } break;
      case 'boom': fx.boom(ev.x, ev.y, ev.r); audio.boom(); break;
      case 'kill': fx.goo(ev.x, ev.y, ev.kind === 'hexer'); audio.kill(); break;
      case 'hurt': if (mine) audio.hurt(); break;
      case 'down': fx.text(ev.x, ev.y, s.mode === 'deathmatch' ? `${nameOf(s, ev.id)} fragged` : `${nameOf(s, ev.id)} is down!`, '#ff8a80'); break;
      case 'frag': if (mine) audio.unlockWeapon(); break;
      case 'winner': banner = { text: `${nameOf(s, ev.id)} wins the deathmatch!`, color: '#ffe082', until: performance.now() + 5000 }; audio.wave(); break;
      case 'revive': audio.revive(); break;
      case 'cast': audio.cast(); break;
      case 'place': audio.place(); break;
      case 'throw': if (!alreadyPlayed(ev)) audio.throw(); break;
      case 'rocketfire': if (!alreadyPlayed(ev)) audio.rocketfire(); break;
      case 'pickup': if (mine) audio.pickup(); break;
      case 'unlock': banner = { text: ev.text, color: '#ffe082', until: performance.now() + 2200 }; audio.unlockWeapon(); break; // team-wide
      case 'level': banner = { text: `Level ${ev.level}`, color: '#ff8a65', until: performance.now() + 2000 }; audio.wave(); break;
      case 'gameover': audio.wave(); break;
    }
  }

  // ---- shot prediction (gunStep in sim.js): your own shots play at once, not a round trip later
  const FLASHES = new Set(['gun', 'rail', 'shotgun']);
  const playFire = i => { const k = WEAPONS[i].kind; if (k === 'rocket') audio.rocketfire(); else if (k === 'throw') audio.throw(); else audio.shot[i]?.(); };
  // a shot from one of our seats whose sound/flash we already played locally
  const alreadyPlayed = ev => !!ev.seq && seats.some(x => x.id === ev.id && x.played.has(ev.seq));
  const shotStats = { instant: 0, late: 0 }; // own shots played at once vs. only when the server reported them

  // ---- 50 Hz input tick (a timer, so input keeps flowing in background tabs)
  function weaponChange(seat, k) {
    const me = latest?.playerById.get(seat.id);
    if (!me) return -1;
    const usable = i => latest.unlocked[i] && (me.ammo[i] !== 0 || WEAPONS[i].kind === 'charge');
    if (k.numbers) for (let i = 0; i < DIGITS.length; i++) if (tapped.has(DIGITS[i]) && usable(i)) return i;
    const step = tapped.has(k.next) ? 1 : tapped.has(k.prev) ? -1 : 0;
    if (!step) return -1;
    for (let n = 1, i = me.weapon; n <= WEAPONS.length; n++) { i = (i + step + WEAPONS.length) % WEAPONS.length; if (usable(i)) return i; }
    return -1;
  }
  let lastTick = performance.now();
  function localTick() {
    for (const seat of seats) {
      if (seat.id == null) continue;
      const k = KEYS[seat.slot], on = c => keys.has(c) || tapped.has(c);
      // Fire released and pressed again within one frame: send the release now and the press
      // next frame, or the server would see one long hold (a lost pistol shot or grenade throw).
      let fire = on(k.fire);
      if (seat.pressNext) { fire = true; seat.pressNext = false; }
      else if (fire && seat.lastFire && released.has(k.fire)) { fire = false; seat.pressNext = true; }
      seat.lastFire = fire;
      const bits = (on(k.up) ? 1 : 0) | (on(k.down) ? 2 : 0) | (on(k.left) ? 4 : 0) | (on(k.right) ? 8 : 0) | (fire ? 16 : 0);
      const seq = ++seat.seq;
      seat.pending.push({ seq, bits, wire: [seq, bits, weaponChange(seat, k)] });
      if (seat.pending.length > 120) seat.pending.shift();
      send({ t: 'in', id: seat.id, f: seat.pending.slice(-SEND_REDUNDANCY).map(f => f.wire) });
      if (seat.pred?.alive && map && latest) movePlayer(map, latest.objects, seat.pred, bits);
      const shot = seat.gun && latest ? gunStep(seat.gun, bits, seat.pending.at(-1).wire[2], latest) : -1;
      if (shot >= 0) { // your own shot: sound and muzzle flash now, not a round trip later
        seat.played.add(seq); shotStats.instant++;
        playFire(shot);
        if (seat.pred && FLASHES.has(WEAPONS[shot].kind)) fx.flash(seat.pred.x + seat.off.x + seat.pred.fx * 12, seat.pred.y + seat.off.y + seat.pred.fy * 12);
      }
    }
    tapped.clear(); released.clear();
  }
  setInterval(() => {
    const now = performance.now();
    for (let n = 0; now - lastTick >= FRAME_MS && n < 4; n++) { localTick(); lastTick += FRAME_MS; }
    if (now - lastTick > 500) lastTick = now;
  }, 4);
  setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

  // ---- render: others interpolated between snapshots, own players predicted
  function interpolate() {
    if (!snaps.length || clockOffset == null) return null;
    const rt = (performance.now() - clockOffset - interpMs) / FRAME_MS;
    let a = snaps[0], b = snaps.at(-1);
    for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].tick <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    const t = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 1;
    const blend = (listA, listB) => {
      const byId = new Map(listA.map(o => [o.id, o]));
      return listB.map(o => { const p = byId.get(o.id) || o; return { ...o, x: lerp(p.x, o.x, t), y: lerp(p.y, o.y, t), dx: o.x - p.x, dy: o.y - p.y }; });
    };
    return { players: blend(a.players, b.players), enemies: blend(a.enemies, b.enemies), shots: blend(a.shots, b.shots) };
  }

  function frame() {
    requestAnimationFrame(frame);
    const st = interpolate();
    const mine = new Map(seats.filter(s => s.id != null).map(s => [s.id, s]));
    const players = (st?.players || []).map(p => {
      const seat = mine.get(p.id);
      if (!seat?.pred) return p;
      seat.off.x *= SMOOTH; seat.off.y *= SMOOTH;
      return { ...p, x: seat.pred.x + seat.off.x, y: seat.pred.y + seat.off.y, fx: seat.pred.fx, fy: seat.pred.fy };
    });
    // enemies face where they are going; give still ones a sensible default
    const enemies = (st?.enemies || []).map(e => (e.dx || e.dy ? e : { ...e, dx: 1, dy: 0 }));
    draw({
      map, players, enemies, shots: st?.shots || [], objects: latest?.objects || [], pickups: latest?.pickups || [],
      mine, level: latest?.level || 0, left: latest?.left || 0, phase: latest?.phase, timer: latest?.timer || 0, banner, rtt,
      mode: latest?.mode, mult: latest?.mult || 1, multRatio: latest?.multRatio || 0, nextUnlock: latest?.nextUnlock, winner: latest?.winner, nameOf: id => latest && nameOf(latest, id),
      spectating: !seats.length, hudPlayers: latest?.players || [],
    });
  }

  connect();
  requestAnimationFrame(frame);
  window.__gs = { seats, get latest() { return latest; }, get map() { return map; }, get interpMs() { return interpMs; }, shotStats }; // for automated tests
}
