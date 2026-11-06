import {
  FRAME_MS, VIEW_W, VIEW_H, BOTTOM_BAR, WALL, TANK_W, TANK_L, BULLET_SPAWN,
  moveTank,
} from './shared/sim.js';

const INTERP_MS = 90;        // render remote objects this far in the past
const SEND_REDUNDANCY = 4;   // resend last N input frames each packet (loss tolerance)
const SMOOTH = 0.75;         // per-frame decay of prediction-correction offset

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);
const statusEl = $('status');

const params = new URLSearchParams(location.search);
let roomName = params.get('room');
if (!roomName) {
  roomName = Math.random().toString(36).slice(2, 8);
  params.set('room', roomName);
  history.replaceState(null, '', '?' + params);
}
$('name').value = localStorageGet('ra-name') || '';

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ------------------------------------------------------------- input
const keys = new Set();
const tapped = new Set(); // keys pressed since the last tick, so very short taps still count
const SCHEMES = {
  arrows: { f: 'ArrowUp', b: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight', fire: 'KeyM' },
  esdf: { f: 'KeyE', b: 'KeyD', l: 'KeyS', r: 'KeyF', fire: 'KeyQ' },
};
const GAME_KEYS = new Set(Object.values(SCHEMES).flatMap(s => Object.values(s)));
addEventListener('keydown', e => {
  if (document.activeElement === $('name')) return;
  if (GAME_KEYS.has(e.code)) { keys.add(e.code); if (!e.repeat) tapped.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', e => { keys.delete(e.code); });
addEventListener('blur', () => keys.clear());
const mouse = { x: 0, y: 0, down: false };
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / r.width * VIEW_W;
  mouse.y = (e.clientY - r.top) / r.height * VIEW_H;
});
canvas.addEventListener('pointerdown', e => { mouse.down = true; mouse.tapped = true; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ------------------------------------------------------------- state
let ws = null;
let maze = null;
const seats = [];            // local players: {slot, id, seq, pending, pred, off}
const snaps = [];            // recent snapshots for interpolation
let latest = null;           // latest snapshot
let clockOffset = null;      // estimate of (local time - server tick time)
const offsets = [];
const particles = [];
let banner = null;           // {text, until}
let rtt = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomName)}`);
  ws.onopen = () => {
    statusEl.textContent = `room "${roomName}"`;
    for (const s of seats.splice(0)) join(s.slot); // rejoin after reconnect
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected - retrying…'; setTimeout(connect, 1500); };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
}

function sendMsg(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function join(slot) {
  if (seats.some(s => s.slot === slot)) return;
  const base = $('name').value.trim() || 'Player';
  localStorageSet('ra-name', base);
  const name = slot === 'arrows' ? base : `${base} ${slot === 'esdf' ? '2' : '(mouse)'}`;
  seats.push({ slot, id: null, seq: 0, pending: [], pred: null, off: { x: 0, y: 0, r: 0 } });
  sendMsg({ t: 'join', name, slot });
  audio.unlock();
  updateButtons();
}

function updateButtons() {
  $('join').disabled = seats.some(s => s.slot === 'arrows');
  $('join2').disabled = seats.some(s => s.slot === 'esdf');
  $('join3').disabled = seats.some(s => s.slot === 'mouse');
}

$('join').onclick = () => join('arrows');
$('join2').onclick = () => join('esdf');
$('join3').onclick = () => join('mouse');
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied!'; }
  catch { prompt('Copy this link:', location.href); }
  setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 1500);
};

function onMessage(m) {
  if (m.t === 'maze') {
    maze = m.maze;
    for (const s of seats) { s.pred = null; s.off = { x: 0, y: 0, r: 0 }; }
    snaps.length = 0;
  } else if (m.t === 'joined') {
    const s = seats.find(s => s.slot === m.slot && s.id == null);
    if (s) s.id = m.id;
  } else if (m.t === 'full') {
    seats.pop(); updateButtons();
    statusEl.textContent = 'room is full';
  } else if (m.t === 's') {
    onSnapshot(m);
  } else if (m.t === 'pong') {
    rtt = performance.now() - m.c;
  }
}

function onSnapshot(s) {
  const now = performance.now();
  s.recv = now;
  s.tankMap = new Map(s.tanks.map(t => [t[0], t]));
  s.bulletMap = new Map(s.bullets.map(b => [b[0], b]));
  latest = s;
  snaps.push(s);
  while (snaps.length > 40) snaps.shift();

  // Clock sync: smallest observed (arrival - tick time) = least-delayed packet.
  offsets.push(now - s.tick * FRAME_MS);
  while (offsets.length > 60) offsets.shift();
  const best = Math.min(...offsets);
  clockOffset = clockOffset == null ? best : clockOffset + (best - clockOffset) * 0.1;

  for (const ev of s.ev) handleEvent(ev);
  reconcile(s);
}

// Client-side prediction: start from the server's authoritative tank state
// at the acknowledged input, then re-apply inputs the server has not yet used.
function reconcile(s) {
  if (!maze) return;
  for (const seat of seats) {
    if (seat.id == null) continue;
    const t = s.tankMap.get(seat.id);
    if (!t) { seat.pred = null; continue; }
    const ack = s.ack ? s.ack[seat.id] ?? 0 : 0;
    seat.pending = seat.pending.filter(p => p.seq > ack);
    const before = seat.pred ? { ...seat.pred } : null;
    const pred = { x: t[1], y: t[2], rot: t[3], alive: !!t[4] };
    if (pred.alive) {
      let frozen = s.frozen;
      for (const p of seat.pending) {
        if (frozen > 0) { frozen--; continue; }
        moveTank(maze, pred, p.input);
      }
    }
    seat.pred = pred;
    if (before && before.alive && pred.alive) {
      // Keep what's on screen continuous; fade the correction out over a few frames.
      seat.off.x += before.x - pred.x;
      seat.off.y += before.y - pred.y;
      seat.off.r += angDiff(before.rot, pred.rot);
      if (Math.hypot(seat.off.x, seat.off.y) > maze.S) seat.off = { x: 0, y: 0, r: 0 }; // teleport-sized: snap
    }
  }
}

function angDiff(a, b) { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

// ------------------------------------------------------------- local tick
let lastTick = performance.now();
let localFrozen = 0;
function localTick() {
  for (const seat of seats) {
    if (seat.id == null) continue;
    let bits = 0, input;
    if (seat.slot === 'mouse') {
      const mx = mouse.x - (maze ? maze.ox : 0), my = mouse.y - (maze ? maze.oy : 0);
      const fire = mouse.down || mouse.tapped;
      bits = 32 | (fire ? 16 : 0);
      input = { mouse: { x: mx, y: my }, fire };
      seat.lastMouse = [Math.round(mx * 10) / 10, Math.round(my * 10) / 10];
    } else {
      const k = SCHEMES[seat.slot];
      const down = c => keys.has(c) || tapped.has(c);
      input = { f: down(k.f), b: down(k.b), l: down(k.l), r: down(k.r), fire: down(k.fire) };
      bits = (input.f ? 1 : 0) | (input.b ? 2 : 0) | (input.l ? 4 : 0) | (input.r ? 8 : 0) | (input.fire ? 16 : 0);
    }
    const seq = ++seat.seq;
    const mx = seat.lastMouse ? seat.lastMouse[0] : 0, my = seat.lastMouse ? seat.lastMouse[1] : 0;
    if (input.mouse) input.mouse = { x: mx, y: my }; // predict with exactly what the server receives
    seat.pending.push({ seq, input, wire: [seq, bits, mx, my] });
    if (seat.pending.length > 100) seat.pending.shift();
    sendMsg({ t: 'in', id: seat.id, f: seat.pending.slice(-SEND_REDUNDANCY).map(p => p.wire) });
    if (seat.pred && seat.pred.alive && maze && localFrozen <= 0) moveTank(maze, seat.pred, input);
  }
  tapped.clear(); mouse.tapped = false;
  if (latest) localFrozen = latest.frozen;
}
// Use a timer (not rAF) so input keeps flowing in background tabs.
setInterval(() => {
  const now = performance.now();
  let n = 0;
  while (now - lastTick >= FRAME_MS && n < 4) { localTick(); lastTick += FRAME_MS; n++; }
  if (now - lastTick > 500) lastTick = now;
}, 5);
setInterval(() => sendMsg({ t: 'ping', c: performance.now() }), 2000);

// ------------------------------------------------------------- events, audio, particles
const audio = (() => {
  let ac = null;
  function unlock() { if (!ac) { try { ac = new AudioContext(); } catch { /* no audio */ } } else if (ac.state === 'suspended') ac.resume(); }
  function tone(freq, dur, type = 'square', vol = 0.05, slide = 0) {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), ac.currentTime + dur);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  }
  function noise(dur, vol = 0.2) {
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buf; g.gain.value = vol; src.connect(g).connect(ac.destination); src.start();
  }
  return { unlock, fire: () => tone(520, 0.08, 'square', 0.04, 0.5), bounce: () => tone(900, 0.03, 'triangle', 0.025), boom: () => { noise(0.6, 0.25); tone(90, 0.4, 'sawtooth', 0.06, 0.4); }, poof: () => tone(300, 0.06, 'sine', 0.02, 0.6) };
})();
addEventListener('pointerdown', () => audio.unlock());
addEventListener('keydown', () => audio.unlock());

function playerName(id) { const p = latest && latest.players.find(p => p[0] === id); return p ? p[1] : '?'; }
function playerColor(id) { const p = latest && latest.players.find(p => p[0] === id); return p ? p[2] : '#888'; }

function handleEvent(ev) {
  if (ev.type === 'fire') audio.fire();
  else if (ev.type === 'bounce') audio.bounce();
  else if (ev.type === 'poof') { audio.poof(); burst(ev.x, ev.y, '#999', 5, 0.6); }
  else if (ev.type === 'boom') {
    audio.boom();
    burst(ev.x, ev.y, playerColor(ev.victim), 26, 2.2);
    burst(ev.x, ev.y, '#f6a623', 14, 1.6);
  } else if (ev.type === 'win') banner = { text: `${playerName(ev.id)} wins the round!`, color: playerColor(ev.id), until: performance.now() + 2000 };
  else if (ev.type === 'draw') banner = { text: 'Draw!', color: '#555', until: performance.now() + 2000 };
}

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = Math.random() * speed + 0.3;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color, size: 1.5 + Math.random() * 3 });
  }
}

// ------------------------------------------------------------- rendering
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) { return a + angDiff(b, a) * t; }

function interpState() {
  if (!snaps.length || clockOffset == null) return null;
  const renderTick = (performance.now() - clockOffset - INTERP_MS) / FRAME_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].tick <= renderTick) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const span = b.tick - a.tick;
  const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 1;
  const tanks = [];
  for (const tb of b.tanks) {
    const ta = a.tankMap.get(tb[0]) || tb;
    tanks.push({ id: tb[0], x: lerp(ta[1], tb[1], t), y: lerp(ta[2], tb[2], t), rot: lerpAngle(ta[3], tb[3], t), alive: t < 1 ? ta[4] && tb[4] : tb[4] });
  }
  const bullets = [];
  for (const bb of b.bullets) {
    const ba = a.bulletMap.get(bb[0]);
    if (!ba) { if (t > 0.5) bullets.push({ x: bb[1], y: bb[2] }); continue; }
    bullets.push({ x: lerp(ba[1], bb[1], t), y: lerp(ba[2], bb[2], t) });
  }
  return { tanks, bullets };
}

function drawMaze(m) {
  const S = m.S, t = WALL * S;
  ctx.fillStyle = '#3d4350';
  for (let i = 0; i <= m.W; i++) for (let j = 0; j < m.H; j++) if (m.v[i][j]) ctx.fillRect(i * S, j * S, t, S + t);
  for (let i = 0; i < m.W; i++) for (let j = 0; j <= m.H; j++) if (m.h[i][j]) ctx.fillRect(i * S, j * S, S + t, t);
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))));
  return `rgb(${c.join(',')})`;
}

function drawTank(S, x, y, rot, color, isMe) {
  const w = TANK_W * S, l = TANK_L * S;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot * Math.PI / 180);
  // treads
  ctx.fillStyle = shade(color, -0.55);
  ctx.fillRect(-w / 2, -l / 2, w * 0.24, l);
  ctx.fillRect(w / 2 - w * 0.24, -l / 2, w * 0.24, l);
  // tread ridges
  ctx.fillStyle = shade(color, -0.3);
  for (let k = 1; k < 6; k++) {
    const yy = -l / 2 + (l * k) / 6;
    ctx.fillRect(-w / 2, yy - 0.4, w * 0.24, 0.8);
    ctx.fillRect(w / 2 - w * 0.24, yy - 0.4, w * 0.24, 0.8);
  }
  // hull
  ctx.fillStyle = color;
  roundRect(-w * 0.32, -l * 0.42, w * 0.64, l * 0.84, w * 0.12);
  ctx.fill();
  // barrel
  ctx.fillStyle = shade(color, -0.45);
  ctx.fillRect(-w * 0.07, -BULLET_SPAWN * S, w * 0.14, BULLET_SPAWN * S);
  // turret
  ctx.beginPath();
  ctx.arc(0, 0, w * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 0.25);
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = shade(color, -0.45);
  ctx.stroke();
  ctx.restore();
  if (isMe) {
    ctx.beginPath();
    ctx.arc(x, y, l * 0.85, 0, Math.PI * 2);
    ctx.strokeStyle = color + '55';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawScoreboard() {
  const y0 = VIEW_H - BOTTOM_BAR;
  ctx.fillStyle = '#e8e3d8';
  ctx.fillRect(0, y0, VIEW_W, BOTTOM_BAR);
  if (!latest) return;
  const ps = latest.players;
  const slotW = Math.min(170, VIEW_W / Math.max(1, ps.length));
  const x0 = (VIEW_W - slotW * ps.length) / 2;
  const mine = new Set(seats.map(s => s.id));
  ps.forEach(([id, name, color, score], i) => {
    const cx = x0 + slotW * i + slotW / 2;
    drawTank(50, cx - 26, y0 + 40, 0, color, false);
    ctx.fillStyle = '#2a2f38';
    ctx.font = `600 13px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText((mine.has(id) ? '▸ ' : '') + name, cx - 10, y0 + 32, slotW - 30);
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(String(score), cx - 10, y0 + 56);
  });
  ctx.textAlign = 'right';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#8a8f99';
  ctx.fillText(`ping ${Math.round(rtt)} ms`, VIEW_W - 8, VIEW_H - 8);
}

function render() {
  requestAnimationFrame(render);
  ctx.setTransform(canvas.width / VIEW_W, 0, 0, canvas.height / VIEW_H, 0, 0);
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  drawScoreboard();
  if (!maze) {
    ctx.fillStyle = '#555'; ctx.font = '18px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Press "Join" to play. Share the invite link with friends.', VIEW_W / 2, (VIEW_H - BOTTOM_BAR) / 2);
    return;
  }
  ctx.save();
  ctx.translate(maze.ox, maze.oy);
  drawMaze(maze);
  const st = interpState();
  const mine = new Map(seats.filter(s => s.id != null).map(s => [s.id, s]));
  if (st) {
    for (const t of st.tanks) {
      if (mine.has(t.id) || !t.alive) continue;
      drawTank(maze.S, t.x, t.y, t.rot, playerColor(t.id), false);
    }
    for (const seat of mine.values()) {
      if (!seat.pred || !seat.pred.alive) continue;
      seat.off.x *= SMOOTH; seat.off.y *= SMOOTH; seat.off.r *= SMOOTH;
      drawTank(maze.S, seat.pred.x + seat.off.x, seat.pred.y + seat.off.y, seat.pred.rot + seat.off.r, playerColor(seat.id), true);
    }
    ctx.fillStyle = '#222';
    const br = Math.max(1.6, maze.S * 0.05);
    for (const b of st.bullets) { ctx.beginPath(); ctx.arc(b.x, b.y, br, 0, Math.PI * 2); ctx.fill(); }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 0.93; p.vy *= 0.93; p.life -= 0.025;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  const mazeH = VIEW_H - BOTTOM_BAR;
  ctx.textAlign = 'center';
  if (latest && latest.frozen > 0) {
    ctx.fillStyle = '#0007'; ctx.font = '700 28px system-ui';
    ctx.fillText('Get ready…', VIEW_W / 2, mazeH / 2);
  }
  if (banner && performance.now() < banner.until) {
    ctx.font = '700 30px system-ui';
    ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.strokeText(banner.text, VIEW_W / 2, mazeH / 2 - 40);
    ctx.fillStyle = banner.color; ctx.fillText(banner.text, VIEW_W / 2, mazeH / 2 - 40);
  }
  if (!seats.length) {
    ctx.fillStyle = '#0009'; ctx.font = '600 16px system-ui';
    ctx.fillText('Spectating - press Join to play', VIEW_W / 2, mazeH - 12);
  }
}

connect();
requestAnimationFrame(render);
// expose for automated tests
window.__ra = { seats, get latest() { return latest; }, get maze() { return maze; } };
