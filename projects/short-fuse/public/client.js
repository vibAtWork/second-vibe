// Browser client: keyboard -> input frames, prediction of your own player, interpolation of
// everyone else, events -> effects and sounds, and the draw loop.
import { TICK_MS, CELL, ROWS, UP, DOWN, LEFT, RIGHT, BOMB_KEY, Prediction } from './shared/game.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { loadSkin } from './skin.js';

const RESEND = 4;              // each message repeats the last few frames (loss tolerance)
const SMOOTH = 0.8;            // how fast a prediction correction fades (per drawn frame)
const JUMP = 40;               // corrections bigger than this (a teleport) jump instead of gliding
const DELAY = { min: 50, max: 300, margin: 10 }; // others are drawn this far in the past (adaptive)
const KEYS = {
  p1: { [UP]: ['ArrowUp'], [DOWN]: ['ArrowDown'], [LEFT]: ['ArrowLeft'], [RIGHT]: ['ArrowRight'], [BOMB_KEY]: ['Space', 'Enter', 'Semicolon'] },
  p2: { [UP]: ['KeyW'], [DOWN]: ['KeyS'], [LEFT]: ['KeyA'], [RIGHT]: ['KeyD'], [BOMB_KEY]: ['KeyF', 'Backslash'] },
};
const GAME_KEYS = new Set(Object.values(KEYS).flatMap(k => Object.values(k).flat()));
const lerp = (a, b, t) => a + (b - a) * t;

// snapshot rows -> objects (the field order is Game.snapshot's)
function decode(s) {
  const players = s.players.map(([id, x, y, dir, alive, fighting, lives, inv, speed, length, bombs, laid, kick, glove, button, carrying, name, color, bot, slot, wins, points]) =>
    ({ id, x, y, dir, alive: !!alive, fighting: !!fighting, lives, inv: !!inv, speed, length, bombs, laid, kick: !!kick, glove, button: !!button, carrying: !!carrying, name, color, bot: !!bot, slot, wins, points }));
  return {
    ...s, players, byId: new Map(players.map(p => [p.id, p])),
    cells: Array.from(s.grid, Number),
    bombs: s.bombs.map(([id, x, y, count, state, owner]) => ({ id, x, y, count, state, owner })),
    flames: s.flames.map(([x, y, dir, end, life]) => ({ x, y, dir, end: !!end, life })),
  };
}

export function startClient() {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  if (!params.get('room')) { params.set('room', Math.random().toString(36).slice(2, 8)); history.replaceState(null, '', '?' + params); }
  const room = params.get('room');
  const skin = {};
  const view = createRenderer($('c'), skin), audio = createAudio(skin);
  loadSkin().then(s => { Object.assign(skin, s); audio.skinReady(); });

  // ---- header controls (buttons give the keyboard back to the game after a click)
  $('arena').value = ['classic', 'firelines', 'teleport', 'madness'].includes(params.get('arena')) ? params.get('arena') : 'classic';
  $('bots').value = ['0', '1', '2', '3'].includes(params.get('bots')) ? params.get('bots') : '0';
  const newRoom = () => { location.search = '?' + new URLSearchParams({ room: Math.random().toString(36).slice(2, 8), arena: $('arena').value, bots: $('bots').value }); };
  $('arena').onchange = newRoom; $('bots').onchange = newRoom;
  try { $('name').value = localStorage.getItem('sf-name') || ''; } catch { /* private mode */ }
  const showToggles = () => { $('music').textContent = audio.musicOn ? '♪ Music on' : '♪ Music off'; $('sound').textContent = audio.sfxOn ? '🔊 Sound on' : '🔇 Sound off'; };
  $('music').onclick = () => { audio.unlock(); audio.setMusic(!audio.musicOn); showToggles(); };
  $('sound').onclick = () => { audio.unlock(); audio.setSfx(!audio.sfxOn); showToggles(); };
  $('join').onclick = () => join('p1');
  $('join2').onclick = () => join('p2');
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied!'; } catch { prompt('Copy this link:', location.href); }
    setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 1500);
  };
  for (const b of document.querySelectorAll('header button')) b.addEventListener('click', () => b.blur());
  showToggles();

  // ---- keyboard. Game keys never reach the page (no scrolling, no pressing a focused button,
  // no changing a focused menu); typing your name is left alone.
  const held = new Set(), down = new Set(), up = new Set(); // down/up: since the last input tick
  const typing = e => e.target === $('name');
  addEventListener('keydown', e => {
    audio.unlock();
    if (typing(e) || !GAME_KEYS.has(e.code)) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (!held.has(e.code)) down.add(e.code);
    held.add(e.code);
  }, true);
  addEventListener('keyup', e => {
    if (typing(e) || !GAME_KEYS.has(e.code)) return;
    e.preventDefault(); held.delete(e.code); up.add(e.code);
  }, true);
  addEventListener('blur', () => held.clear());
  addEventListener('pointerdown', () => audio.unlock());

  // ---- connection
  let ws = null, latest = null, floor = [], rtt = 0, banner = null;
  const seats = []; // local players: { slot, id, seq, pending, pred, prev, offset, ghosts, sounded, held, pressLater }
  const snaps = [];
  let clockOffset = null, delay = 100, gap = TICK_MS;
  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${new URLSearchParams({ room, arena: $('arena').value, bots: $('bots').value })}`);
    ws.onopen = () => {
      $('status').textContent = `room "${room}"`;
      const slots = seats.splice(0).map(s => s.slot);
      snaps.length = 0; latest = null; clockOffset = null;
      slots.forEach(join);
    };
    ws.onclose = () => { $('status').textContent = 'disconnected - reconnecting…'; setTimeout(connect, 1500); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } receive(m); };
  }
  function join(slot) {
    if (seats.some(s => s.slot === slot)) return;
    const name = $('name').value.trim() || 'Bomber';
    try { localStorage.setItem('sf-name', name); } catch { /* private mode */ }
    seats.push({ slot, id: null, seq: 0, pending: [], pred: null, prev: null, offset: { x: 0, y: 0 }, ghosts: [], sounded: new Set(), held: false, pressLater: false });
    send({ t: 'join', name: slot === 'p1' ? name : `${name} 2`, slot });
    audio.unlock();
    $('join').disabled = seats.some(s => s.slot === 'p1'); $('join2').disabled = seats.some(s => s.slot === 'p2');
  }
  function receive(m) {
    if (m.t === 's') return update(decode(m));
    if (m.t === 'floor') floor = m.floor;
    else if (m.t === 'joined') { const s = seats.find(x => x.slot === m.slot && x.id == null); if (s) s.id = m.id; }
    else if (m.t === 'full') { seats.pop(); $('status').textContent = 'the room is full (4 players)'; $('join').disabled = seats.some(s => s.slot === 'p1'); $('join2').disabled = seats.some(s => s.slot === 'p2'); }
    else if (m.t === 'pong') rtt = performance.now() - m.c;
  }

  // ---- a server update
  function update(s) {
    if (latest && s.tick <= latest.tick) return;
    const now = performance.now();
    if (latest) gap = Math.max(1, Math.min(10, s.tick - latest.tick)) * TICK_MS;
    if (!latest || latest.arena !== s.arena) $('arena').value = s.arena;
    latest = s;
    snaps.push(s); if (snaps.length > 40) snaps.shift();
    // others: drawn one update plus the jitter seen lately in the past
    const arrival = now - s.tick * TICK_MS, recent = snaps.slice(-48).map(x => x.arrival ?? arrival);
    s.arrival = arrival; recent.push(arrival);
    const best = Math.min(...recent), worst = Math.max(...recent);
    clockOffset = clockOffset == null ? best : clockOffset + (best - clockOffset) * 0.1;
    const want = Math.max(DELAY.min, Math.min(DELAY.max, gap + (worst - best) + DELAY.margin));
    delay += (want - delay) * (want > delay ? 0.5 : 0.02);
    for (const ev of s.ev) event(ev, s);
    // you: the server's position at the last input it applied, plus your inputs since
    for (const seat of seats) {
      const me = seat.id != null && s.byId.get(seat.id);
      const ack = s.ack[seat.id] ?? 0;
      seat.pending = seat.pending.filter(f => f.seq > ack);
      for (const q of seat.sounded) if (q <= ack) seat.sounded.delete(q);
      if (!me || !me.fighting || !me.alive || s.phase !== 'play') { seat.pred = seat.prev = null; seat.ghosts = []; continue; }
      const pred = new Prediction(s, me), ghosts = [];
      for (const f of seat.pending) { const c = pred.step(f.keys); if (c) ghosts.push(c); }
      if (seat.pred) {
        const dx = pred.p.x - seat.pred.p.x, dy = pred.p.y - seat.pred.p.y;
        if (dx || dy) { stats.corrections++; stats.largest = Math.max(stats.largest, Math.abs(dx) + Math.abs(dy)); }
        if (Math.abs(dx) + Math.abs(dy) > JUMP) { seat.offset = { x: 0, y: 0 }; seat.prev = null; }
        else { seat.offset.x -= dx; seat.offset.y -= dy; if (seat.prev) { seat.prev.x += dx; seat.prev.y += dy; } }
      }
      seat.pred = pred; seat.ghosts = ghosts;
    }
  }
  const stats = { corrections: 0, largest: 0 };

  const nameOf = (s, id) => s.byId.get(id)?.name ?? '?';
  function event(ev, s) {
    const mine = seats.some(x => x.id === ev.id);
    switch (ev.type) {
      case 'lay': if (!(ev.seq && seats.some(x => x.id === ev.id && x.sounded.has(ev.seq)))) audio.play('lay'); break; // yours already sounded
      case 'boom': view.fx.boom(ev.x, ev.y); audio.play('boom'); break;
      case 'crate': view.fx.crate(ev.x, ev.y); audio.play('crate'); break;
      case 'hit': view.fx.text(ev.x, ev.y, ev.lives > 0 ? '-1 ♥' : 'OUT!', '#ff8a80'); audio.play('hit'); break;
      case 'out': view.fx.ring(ev.x, ev.y, '#ff5252'); audio.play('out'); break;
      case 'powerup': view.fx.text(ev.x, ev.y, '+' + ev.kind, '#ffe082'); if (mine) audio.play('powerup'); break;
      case 'kick': audio.play('kick'); break;
      case 'throw': audio.play('throw'); break;
      case 'land': audio.play('land'); break;
      case 'teleport': view.fx.ring(ev.x, ev.y, '#4dd0e1'); audio.play('teleport'); break;
      case 'fire': audio.play('fire'); break;
      case 'wall': view.fx.wall(ev.i, ev.j); audio.play('wall'); break;
      case 'heat': audio.play('heat'); break;
      case 'result': if (ev.winner != null) audio.play('win'); break;
      case 'join': if (!ev.bot && s.phase !== 'waiting' && s.byId.get(ev.id)?.fighting === false) banner = { text: `${ev.name} joined - plays from the next heat`, until: performance.now() + 2500 }; break;
      case 'leave': if (!ev.bot) banner = { text: `${ev.name} left`, until: performance.now() + 2500 }; break;
      case 'match': banner = { text: ev.winner != null ? `${nameOf(s, ev.winner)} wins the match!` : 'The match is a draw', until: performance.now() + 4000 }; break;
    }
  }

  // ---- input, sampled at the game's tick rate on a timer (keeps going in background tabs)
  const auto = params.get('autoplay') ? autoplayer(+params.get('autoplay') || 1) : null; // for automated tests
  let tickAt = performance.now();
  function inputTick() {
    for (const seat of seats) {
      if (seat.id == null) continue;
      const k = KEYS[seat.slot], on = bit => k[bit].some(c => held.has(c) || down.has(c));
      let keys = auto ? auto() : (on(UP) ? UP : 0) | (on(DOWN) ? DOWN : 0) | (on(LEFT) ? LEFT : 0) | (on(RIGHT) ? RIGHT : 0);
      // the bomb key: released and pressed again within one tick -> release now, press next tick
      let bomb = auto ? !!(keys & BOMB_KEY) : on(BOMB_KEY);
      if (seat.pressLater) { bomb = true; seat.pressLater = false; }
      else if (bomb && seat.held && k[BOMB_KEY].some(c => up.has(c))) { bomb = false; seat.pressLater = true; }
      seat.held = bomb;
      keys = (keys & 15) | (bomb ? BOMB_KEY : 0);
      const seq = ++seat.seq;
      seat.pending.push({ seq, keys });
      if (seat.pending.length > 240) seat.pending.shift();
      send({ t: 'in', id: seat.id, f: seat.pending.slice(-RESEND).map(f => [f.seq, f.keys]) });
      if (seat.pred) {
        seat.prev = { x: seat.pred.p.x, y: seat.pred.p.y };
        const c = seat.pred.step(keys);
        if (c) { seat.ghosts.push(c); seat.sounded.add(seq); audio.play('lay'); } // your bomb shows and sounds at once
      }
    }
    down.clear(); up.clear();
  }
  setInterval(() => {
    const now = performance.now();
    for (let n = 0; now - tickAt >= TICK_MS && n < 5; n++) { inputTick(); tickAt += TICK_MS; }
    if (now - tickAt > 500) tickAt = now;
  }, 4);
  setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

  // ---- drawing
  function others() {
    if (!snaps.length || clockOffset == null) return null;
    const t = (performance.now() - clockOffset - delay) / TICK_MS;
    if (t > snaps.at(-1).tick) delay = Math.min(DELAY.max, delay + 1); // ran out of updates: draw a little further back
    let a = snaps[0], b = snaps.at(-1);
    for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].tick <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
    const k = b.tick > a.tick ? Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick))) : 1;
    const blend = (as, bs) => { const m = new Map(as.map(o => [o.id, o])); return bs.map(o => { const p = m.get(o.id); return !p || Math.abs(p.x - o.x) + Math.abs(p.y - o.y) > JUMP ? { ...o, moving: false } : { ...o, x: lerp(p.x, o.x, k), y: lerp(p.y, o.y, k), moving: p.x !== o.x || p.y !== o.y }; }); };
    return { players: blend(a.players, b.players), bombs: blend(a.bombs, b.bombs) };
  }
  function frame() {
    requestAnimationFrame(frame);
    const o = others(), alpha = Math.max(0, Math.min(1, (performance.now() - tickAt) / TICK_MS));
    const mine = new Set(seats.map(s => s.id));
    const players = (o?.players || []).map(p => {
      const seat = seats.find(s => s.id === p.id);
      if (!seat?.pred) return p;
      seat.offset.x *= SMOOTH; seat.offset.y *= SMOOTH;
      const from = seat.prev || seat.pred.p, to = seat.pred.p;
      return { ...p, x: lerp(from.x, to.x, alpha) + seat.offset.x, y: lerp(from.y, to.y, alpha) + seat.offset.y, dir: to.dir, moving: from.x !== to.x || from.y !== to.y };
    });
    const bombs = (o?.bombs || []).filter(b => b.state !== 'h');
    for (const seat of seats) for (const [i, j] of seat.ghosts) if (latest && latest.cells[i * ROWS + j] !== 3) bombs.push({ id: 'g' + i + ',' + j, x: i * CELL, y: j * CELL, count: 0, state: 's' });
    view.draw({ s: latest, floor, players, bombs, mine, rtt, banner, seated: seats.length > 0 });
  }

  connect();
  frame();
  window.__sf = { seats, stats, get latest() { return latest; }, get delay() { return delay; } }; // for automated tests
}

// Human-like random play for automated soak tests (?autoplay=seed): holds a direction for a
// while, turns, stops now and then, taps the bomb key.
function autoplayer(seed) {
  let s = seed >>> 0 || 1, dir = RIGHT, left = 0, bomb = 0;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return () => {
    if (--left <= 0) { dir = [UP, DOWN, LEFT, RIGHT, UP, DOWN, LEFT, RIGHT, 0][Math.floor(r() * 9)]; left = 6 + Math.floor(r() * 30); }
    if (bomb > 0) bomb--; else if (r() < 0.03) bomb = 1 + Math.floor(r() * 3);
    return dir | (bomb ? BOMB_KEY : 0);
  };
}
