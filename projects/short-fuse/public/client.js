// Browser client: input, prediction of your own movement, interpolation of everyone
// else, events -> effects/sounds, and the render loop.
import { FRAME_MS, CELL, movePlayer, gridFromString } from './shared/sim.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';

// Others are drawn one update interval plus the recently measured jitter in the past.
const INTERP_MIN = 45, INTERP_MAX = 250, INTERP_MARGIN = 8, JITTER_WINDOW = 50; // window: ~2 s at 24 updates/s
const SEND_REDUNDANCY = 4;  // resend recent input frames (packet-loss tolerance)
const SMOOTH = 0.75;        // fade-out of prediction corrections per drawn frame
const SNAP_DIST = 40;       // corrections bigger than this (a teleport) jump instead of gliding
// Controls. Player 1: arrows + Space (or Enter / ;). Player 2 on the same keyboard: WASD + F (or \).
const KEYS = {
  p1: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], action: ['Space', 'Enter', 'Semicolon'] },
  p2: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], action: ['KeyF', 'Backslash'] },
};
const GAME_KEYS = new Set(Object.values(KEYS).flatMap(k => Object.values(k).flat()));
const lerp = (a, b, t) => a + (b - a) * t;

// Snapshot rows -> objects (field order defined by Game.snapshot in shared/sim.js).
function decode(s) {
  const players = s.players.map(([id, x, y, dir, lives, alive, inv, speed, length, bombs, kick, canThrow, holding, name, color, wins, points, bot, fighting, slot]) =>
    ({ id, x, y, dir, lives, alive: !!alive, inv: !!inv, speed, length, bombs, kick: !!kick, canThrow, holding: !!holding, name, color, wins, points, bot: !!bot, fighting: !!fighting, slot }));
  return {
    ...s, players,
    playerById: new Map(players.map(p => [p.id, p])),
    gridArr: gridFromString(s.grid),
    bombs: s.bombs.map(([id, x, y, count, state]) => ({ id, x, y, count, state })),
    flames: s.flames.map(([x, y, dir, end, life]) => ({ x, y, dir, end: !!end, life })),
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
  // Arena and bots travel in the invite link; the room's first visitor sets them.
  const ARENA_IDS = ['classic', 'firelines', 'teleport', 'madness'];
  $('arena').value = ARENA_IDS.includes(params.get('arena')) ? params.get('arena') : 'classic';
  $('bots').value = ['0', '1', '2', '3'].includes(params.get('bots')) ? params.get('bots') : '0';
  const newRoom = () => { location.search = '?' + new URLSearchParams({ room: Math.random().toString(36).slice(2, 8), arena: $('arena').value, bots: $('bots').value }); };
  $('arena').onchange = newRoom; $('bots').onchange = newRoom;
  try { $('name').value = localStorage.getItem('sf-name') || ''; } catch { /* private mode */ }

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
  let ws = null, latest = null, arena = null, clockOffset = null, rtt = 0, banner = null, interpMs = 80, snapGap = FRAME_MS;
  const seats = [];   // local players: { slot, id, seq, pending, pred, prev, off, lastFire, pressNext }
  const snaps = [], offsets = [];
  let lastTick = performance.now();

  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${new URLSearchParams({ room, arena: $('arena').value, bots: $('bots').value })}`);
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
    const base = $('name').value.trim() || 'Bomber';
    try { localStorage.setItem('sf-name', base); } catch { /* private mode */ }
    seats.push({ slot, id: null, seq: 0, pending: [], pred: null, prev: null, off: { x: 0, y: 0 }, lastFire: false, pressNext: false });
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
    if (m.t === 'arena') arena = m;
    else if (m.t === 'joined') { const s = seats.find(s => s.slot === m.slot && s.id == null); if (s) s.id = m.id; }
    else if (m.t === 'full') { seats.pop(); updateButtons(); statusEl.textContent = 'room is full (4 players)'; }
    else if (m.t === 'pong') rtt = performance.now() - m.c;
    else if (m.t === 's') onSnapshot(decode(m));
  }

  function onSnapshot(s) {
    const now = performance.now();
    if (!latest || latest.arena !== s.arena) $('arena').value = s.arena; // the header shows what the room actually plays
    if (snaps.length) snapGap = Math.max(1, Math.min(10, s.tick - snaps.at(-1).tick)) * FRAME_MS;
    latest = s;
    snaps.push(s); if (snaps.length > 30) snaps.shift();
    offsets.push(now - s.tick * FRAME_MS); if (offsets.length > JITTER_WINDOW) offsets.shift();
    const best = Math.min(...offsets);
    clockOffset = clockOffset == null ? best : clockOffset + (best - clockOffset) * 0.1;
    const late = Math.max(...offsets) - best;
    const want = Math.max(INTERP_MIN, Math.min(INTERP_MAX, snapGap + late + INTERP_MARGIN));
    interpMs += (want - interpMs) * (want > interpMs ? 0.5 : 0.02); // back off fast, tighten slowly
    for (const ev of s.ev) onEvent(ev, s);
    // prediction: the authoritative position at the acknowledged input + inputs not yet applied
    for (const seat of seats) {
      const p = seat.id != null && s.playerById.get(seat.id);
      if (!p || !p.fighting || !p.alive) { seat.pred = seat.prev = null; continue; }
      seat.pending = seat.pending.filter(f => f.seq > (s.ack[seat.id] ?? 0));
      const pred = { x: p.x, y: p.y, dir: p.dir, speed: p.speed, kick: false };
      if (s.phase === 'play') for (const f of seat.pending) movePlayer(s.gridArr, pred, f.bits);
      if (seat.pred) {
        const dx = pred.x - seat.pred.x, dy = pred.y - seat.pred.y;
        if (Math.abs(dx) + Math.abs(dy) > SNAP_DIST) { seat.off = { x: 0, y: 0 }; seat.prev = null; }
        else { seat.off.x -= dx; seat.off.y -= dy; if (seat.prev) { seat.prev.x += dx; seat.prev.y += dy; } }
      }
      seat.pred = pred;
    }
  }

  const nameOf = (s, id) => s.playerById.get(id)?.name ?? '?';
  function onEvent(ev, s) {
    const mine = seats.some(x => x.id === ev.id);
    switch (ev.type) {
      case 'lay': audio.lay(); break;
      case 'boom': fx.boom(ev.x, ev.y); audio.boom(); break;
      case 'crate': fx.crate(ev.x, ev.y); audio.crate(); break;
      case 'hit': { const p = s.playerById.get(ev.id); if (p) fx.text(p.x, p.y, ev.lives > 0 ? `-1 ♥` : 'OUT!', '#ff8a80'); audio.hit(); break; }
      case 'out': fx.ring(ev.x, ev.y, '#ff5252'); audio.out(); break;
      case 'pickup': { const p = s.playerById.get(ev.id); if (p) fx.text(p.x, p.y, `+${ev.kind}`, '#ffe082'); if (mine) audio.pickup(); break; }
      case 'kick': audio.kick(); break;
      case 'throw': audio.throw(); break;
      case 'land': audio.land(); break;
      case 'teleport': { const p = s.playerById.get(ev.id); if (p) fx.ring(p.x, p.y, '#4dd0e1'); audio.teleport(); break; }
      case 'fire': audio.fire(); break;
      case 'fill': fx.fill(ev.i, ev.j); audio.fill(); break;
      case 'heat': audio.heat(); break;
      case 'result': if (ev.winner != null) audio.win(); break;
      case 'match': banner = { text: ev.winner != null ? `${nameOf(s, ev.winner)} wins the match!` : 'Match drawn', until: performance.now() + 4000 }; break;
    }
  }

  // ---- input tick at the simulation rate (a timer, so input keeps flowing in background tabs)
  function localTick() {
    for (const seat of seats) {
      if (seat.id == null) continue;
      const k = KEYS[seat.slot], on = codes => codes.some(c => keys.has(c) || tapped.has(c));
      // bomb button released and pressed again within one frame: send the release now and
      // the press next frame, or the server would see one long press
      let fire = on(k.action);
      if (seat.pressNext) { fire = true; seat.pressNext = false; }
      else if (fire && seat.lastFire && k.action.some(c => released.has(c))) { fire = false; seat.pressNext = true; }
      seat.lastFire = fire;
      const bits = (on(k.up) ? 1 : 0) | (on(k.down) ? 2 : 0) | (on(k.left) ? 4 : 0) | (on(k.right) ? 8 : 0) | (fire ? 16 : 0);
      const seq = ++seat.seq;
      seat.pending.push({ seq, bits, wire: [seq, bits] });
      if (seat.pending.length > 120) seat.pending.shift();
      send({ t: 'in', id: seat.id, f: seat.pending.slice(-SEND_REDUNDANCY).map(f => f.wire) });
      if (seat.pred && latest?.phase === 'play') { seat.prev = { x: seat.pred.x, y: seat.pred.y }; movePlayer(latest.gridArr, seat.pred, bits); }
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
  function interpolated() {
    if (!snaps.length || clockOffset == null) return null;
    const rt = (performance.now() - clockOffset - interpMs) / FRAME_MS;
    let a = snaps[0], b = snaps.at(-1);
    for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].tick <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    const t = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 1;
    const blend = (listA, listB) => {
      const byId = new Map(listA.map(o => [o.id, o]));
      return listB.map(o => { const p = byId.get(o.id); if (!p || Math.abs(p.x - o.x) + Math.abs(p.y - o.y) > SNAP_DIST * 2) return { ...o, moving: false }; return { ...o, x: lerp(p.x, o.x, t), y: lerp(p.y, o.y, t), moving: p.x !== o.x || p.y !== o.y }; });
    };
    return { players: blend(a.players, b.players), bombs: blend(a.bombs, b.bombs) };
  }

  function frame() {
    requestAnimationFrame(frame);
    const it = interpolated();
    const mine = new Set(seats.map(s => s.id).filter(id => id != null));
    const alpha = Math.max(0, Math.min(1, (performance.now() - lastTick) / FRAME_MS));
    const players = (it?.players || []).map(p => {
      const seat = seats.find(s => s.id === p.id);
      if (!seat?.pred) return p;
      seat.off.x *= SMOOTH; seat.off.y *= SMOOTH;
      const from = seat.prev || seat.pred;
      return { ...p, x: lerp(from.x, seat.pred.x, alpha) + seat.off.x, y: lerp(from.y, seat.pred.y, alpha) + seat.off.y, dir: seat.pred.dir, moving: from.x !== seat.pred.x || from.y !== seat.pred.y };
    });
    // a carried bomb follows its (possibly predicted) carrier
    const bombs = (it?.bombs || latest?.bombs || []).filter(b => b.state !== 3);
    draw({
      grid: latest?.gridArr, floor: arena?.floor || [], fire: latest?.fire, burning: latest?.burning || [], pickups: latest?.pickups || [],
      flames: latest?.flames || [], bombs, players, phase: latest?.phase, timer: latest?.timer, heat: latest?.heat || 0, arena: latest?.arena,
      clock: latest?.clock, winner: latest?.winner, matchWinner: latest?.matchWinner, rtt, mine, seated: seats.length > 0, banner,
    });
  }

  updateButtons();
  connect();
  frame();
  window.__sf = { seats, get latest() { return latest; }, get interpMs() { return interpMs; } }; // for automated tests
}
