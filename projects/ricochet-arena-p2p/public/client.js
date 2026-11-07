import {
  FRAME_MS, VIEW_W, VIEW_H, BOTTOM_BAR, WALL, TANK_W, TANK_L, BULLET_SPAWN,
  moveTank, traceAimer, CRATE_HALF,
} from './shared/sim.js';

const INTERP_MS = 90;        // render remote objects this far in the past
const SEND_REDUNDANCY = 4;   // resend last N input frames each packet (loss tolerance)
const SMOOTH = 0.75;         // per-frame decay of prediction-correction offset

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);
const statusEl = $('status');
const Peer = window.Peer;

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

// ------------------------------------------------------------- P2P transport
// Everyone with the same room link tries to connect to peer id "ricochet-arena-<room>".
// If nobody holds that id yet, this browser claims it and becomes the host: it runs
// the authoritative HostRoom and talks to itself through a loopback connection.
const PEER_PREFIX = 'ricochet-arena-v1-';
function peerOptions() {
  const o = { debug: 1 };
  if (params.get('peerhost')) {
    o.host = params.get('peerhost');
    o.port = +(params.get('peerport') || 443);
    o.path = params.get('peerpath') || '/';
    o.secure = params.get('peersecure') !== '0';
  }
  if (params.get('ice')) o.config = { iceServers: JSON.parse(params.get('ice')) };
  return o;
}
let net = null;          // { send(msg) }
let peer = null;
let isHost = false;
let room = null;
let generation = 0;

function setStatus(t) { statusEl.textContent = t; }

function connect() {
  const gen = ++generation;
  net = null;
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
  setStatus('looking for host…');
  const me = new Peer(peerOptions());
  peer = me;
  let settled = false;
  const fail = () => {
    if (settled || gen !== generation) return;
    settled = true;
    try { me.destroy(); } catch { /* ignore */ }
    becomeHost(gen);
  };
  me.on('open', () => {
    const target = PEER_PREFIX + roomName;
    const ctl = me.connect(target, { label: 'ctl', reliable: true, serialization: 'json' });
    const rt = me.connect(target, { label: 'rt', reliable: false, serialization: 'json' });
    let opened = 0;
    const onOpen = () => {
      if (++opened < 2 || gen !== generation) return;
      settled = true;
      isHost = false;
      lastHostMsg = performance.now();
      net = { send: m => { try { (m.t === 'in' ? rt : ctl).send(m); } catch { /* closed */ } } };
      setStatus(`room "${roomName}" · connected to host`);
      afterConnect();
    };
    for (const c of [ctl, rt]) {
      c.on('open', onOpen);
      c.on('data', d => { lastHostMsg = performance.now(); onMessage(d); });
      c.on('close', () => { if (gen === generation && settled) hostLost(); });
      c.on('error', () => {});
    }
    setTimeout(fail, 5000);
  });
  me.on('error', err => {
    if (err.type === 'peer-unavailable') fail();
    else if (!settled) { setStatus(`signalling error (${err.type}) - retrying…`); setTimeout(() => gen === generation && connect(), 2000); settled = true; }
  });
}

// Data-channel 'close' events are unreliable when a tab simply disappears,
// so also treat 2.5 s without any snapshot from the host as the host leaving.
let lastHostMsg = performance.now();
setInterval(() => {
  if (net && !isHost && performance.now() - lastHostMsg > 2500) { net = null; hostLost(); }
}, 500);
addEventListener('pagehide', () => { try { peer && peer.destroy(); } catch { /* ignore */ } });

function hostLost() {
  if (hostLostPending) return;
  hostLostPending = true;
  setStatus('host left - finding a new host…');
  for (const s of seats) { s.id = null; }
  setTimeout(() => { hostLostPending = false; connect(); }, 300 + Math.random() * 1200); // random back-off: one browser wins the id
}
let hostLostPending = false;

async function becomeHost(gen) {
  const { HostRoom } = await import('./room.js');
  if (gen !== generation) return;
  const me = new Peer(PEER_PREFIX + roomName, peerOptions());
  peer = me;
  me.on('open', () => {
    if (gen !== generation) return;
    isHost = true;
    room = new HostRoom();
    // Loopback connection for this browser's own players (async like a network).
    const local = { seatIds: [], send: m => queueMicrotask(() => onMessage(structuredClone(m))) };
    room.addConn(local);
    net = { send: m => queueMicrotask(() => room.handle(local, m)) };
    startHostTicker();
    setStatus(`room "${roomName}" · you are hosting`);
    afterConnect();
  });
  me.on('connection', c => {
    // Each remote browser opens two channels: 'ctl' (reliable) and 'rt' (unreliable).
    let entry = remotes.get(c.peer);
    if (!entry) {
      entry = { conn: { seatIds: [], send: m => { const ch = m.t === 's' ? entry.rt || entry.ctl : entry.ctl; try { ch && ch.open && ch.send(m); } catch { /* ignore */ } } } };
      remotes.set(c.peer, entry);
    }
    entry[c.label === 'rt' ? 'rt' : 'ctl'] = c;
    entry.seen = performance.now();
    c.on('open', () => { if (entry.ctl && entry.ctl.open && !entry.added && (!entry.rt || entry.rt.open)) { entry.added = true; room.addConn(entry.conn); } });
    c.on('data', d => { entry.seen = performance.now(); room && room.handle(entry.conn, d); });
    c.on('close', () => { if (remotes.get(c.peer) === entry) { remotes.delete(c.peer); room && room.removeConn(entry.conn); } });
    c.on('error', () => {});
  });
  me.on('error', err => {
    if (err.type === 'unavailable-id') { setTimeout(() => gen === generation && connect(), 800); } // someone else won the race
    else setStatus(`host error (${err.type})`);
  });
}
const remotes = new Map();
setInterval(() => { // guests ping every 2 s; drop ones silent for 6 s
  for (const [id, e] of remotes) {
    if (e.added && performance.now() - (e.seen || 0) > 6000) {
      remotes.delete(id); room && room.removeConn(e.conn);
      try { e.ctl && e.ctl.close(); e.rt && e.rt.close(); } catch { /* ignore */ }
    }
  }
}, 1000);

// Tick the host simulation from a Worker timer: browsers heavily throttle
// main-thread timers in background tabs, but keep delivering worker messages.
let hostTicker = null;
function startHostTicker() {
  if (hostTicker) return;
  const src = 'setInterval(() => postMessage(0), 10);';
  hostTicker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  let next = performance.now();
  hostTicker.onmessage = () => {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) { room.tick(); next += FRAME_MS; n++; }
    if (now - next > 1000) next = now;
  };
}

function afterConnect() {
  const prev = seats.splice(0);
  snaps.length = 0; offsets.length = 0; clockOffset = null; latest = null; maze = null;
  for (const s of prev) join(s.slot); // rejoin after host migration
  updateButtons();
}

function sendMsg(m) { if (net) net.send(m); }

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
  s.lasers = s.lasers || []; s.crates = s.crates || []; s.guns = s.guns || [];
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
    const pred = { x: t[1], y: t[2], rot: t[3], alive: !!t[4], locked: !!t[8] };
    if (pred.alive && !pred.locked) {
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
    if (seat.pred && seat.pred.alive && !seat.pred.locked && maze && localFrozen <= 0) moveTank(maze, seat.pred, input);
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
  return { unlock, fire: () => tone(520, 0.08, 'square', 0.04, 0.5), bounce: () => tone(900, 0.03, 'triangle', 0.025), boom: () => { noise(0.6, 0.25); tone(90, 0.4, 'sawtooth', 0.06, 0.4); }, poof: () => tone(300, 0.06, 'sine', 0.02, 0.6),
    laser: () => tone(1800, 0.35, 'sawtooth', 0.04, 0.15),
    frag: () => { noise(0.5, 0.3); tone(140, 0.3, 'square', 0.05, 0.3); },
    spin: () => tone(120, 0.4, 'sawtooth', 0.025, 3),
    gshot: () => tone(700, 0.04, 'square', 0.03, 0.4),
    missile: () => { noise(0.3, 0.08); tone(260, 0.3, 'triangle', 0.04, 2); },
    lock: () => { tone(1200, 0.06, 'sine', 0.03); setTimeout(() => tone(1500, 0.06, 'sine', 0.03), 80); },
    crate: () => tone(200, 0.12, 'triangle', 0.05, 0.6),
    pickup: () => { tone(660, 0.07, 'square', 0.03); setTimeout(() => tone(990, 0.09, 'square', 0.03), 70); } };
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
  else if (['laser', 'spin', 'gshot', 'missile', 'lock', 'crate', 'pickup'].includes(ev.type)) audio[ev.type]();
  else if (ev.type === 'frag') { audio.frag(); burst(ev.x, ev.y, '#555', 18, 1.8); burst(ev.x, ev.y, '#f6a623', 10, 1.2); }
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
    tanks.push({ id: tb[0], x: lerp(ta[1], tb[1], t), y: lerp(ta[2], tb[2], t), rot: lerpAngle(ta[3], tb[3], t), alive: t < 1 ? ta[4] && tb[4] : tb[4], weapon: tb[7] || 0, aiming: !!tb[9] });
  }
  const bullets = [];
  for (const bb of b.bullets) {
    const ba = a.bulletMap.get(bb[0]);
    if (!ba) { if (t > 0.5) bullets.push({ x: bb[1], y: bb[2], kind: bb[3], life: bb[4], dx: 0, dy: 0 }); continue; }
    bullets.push({ x: lerp(ba[1], bb[1], t), y: lerp(ba[2], bb[2], t), kind: bb[3], life: bb[4], dx: bb[1] - ba[1], dy: bb[2] - ba[2] });
  }
  const lasers = (t < 0.5 ? a : b).lasers || [];
  return { tanks, bullets, lasers, crates: b.crates || [], guns: new Map((b.guns || []).map(g => [g[0], g[1]])) };
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

function drawTank(S, x, y, rot, color, isMe, weapon = 0, spin = 0) {
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
  drawTurret(S, w, color, weapon, spin);
  ctx.restore();
  if (isMe) {
    ctx.beginPath();
    ctx.arc(x, y, l * 0.85, 0, Math.PI * 2);
    ctx.strokeStyle = color + '55';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

// Turret per weapon: 0 cannon, 1 laser, 2 frag, 3 gatling, 4 homing
function drawTurret(S, w, color, weapon, spin) {
  const dark = shade(color, -0.45), light = shade(color, 0.25), len = BULLET_SPAWN * S;
  ctx.lineWidth = 0.8;
  if (weapon === 3) { // three rotating barrels
    const off = (performance.now() / 1000 * spin * 6) % 1;
    ctx.fillStyle = dark;
    for (let k = -1; k <= 1; k++) ctx.fillRect(k * w * 0.1 - w * 0.035 + Math.sin((k + off) * 2.1) * w * 0.02, -len, w * 0.07, len);
    ctx.fillStyle = '#666';
    ctx.fillRect(-w * 0.17, -len * 0.55, w * 0.34, w * 0.08);
  } else if (weapon === 1) { // slim emitter with glowing tip
    ctx.fillStyle = dark;
    ctx.fillRect(-w * 0.05, -len, w * 0.1, len);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, -len, w * 0.08, 0, Math.PI * 2); ctx.fill();
  } else if (weapon === 2) { // short wide mortar
    ctx.fillStyle = dark;
    ctx.fillRect(-w * 0.13, -len * 0.85, w * 0.26, len * 0.85);
    ctx.fillStyle = '#333';
    ctx.fillRect(-w * 0.09, -len * 0.85, w * 0.18, w * 0.06);
  } else if (weapon === 4) { // twin missile rails
    ctx.fillStyle = dark;
    ctx.fillRect(-w * 0.16, -len * 0.9, w * 0.1, len * 0.9);
    ctx.fillRect(w * 0.06, -len * 0.9, w * 0.1, len * 0.9);
    ctx.fillStyle = '#d33';
    ctx.fillRect(-w * 0.05, -len * 0.8, w * 0.1, w * 0.18);
  } else {
    ctx.fillStyle = dark;
    ctx.fillRect(-w * 0.07, -len, w * 0.14, len);
  }
  ctx.beginPath();
  ctx.arc(0, 0, w * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = light;
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.stroke();
}

// Crate: wooden box with an icon for its weapon.
function drawCrate(S, c, now) {
  const [id, x, y, rot, wcode] = c;
  let born = crateBorn.get(id);
  if (born == null) { born = now; crateBorn.set(id, now); }
  const grow = Math.min(1, (now - born) / 300);
  const h = CRATE_HALF * S * (grow < 1 ? 1.5 - 0.5 * grow : 1) * Math.min(1, grow * 2);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot * Math.PI / 180);
  ctx.fillStyle = '#c8a26a'; ctx.strokeStyle = '#7a5a2e'; ctx.lineWidth = Math.max(0.8, S * 0.02);
  ctx.fillRect(-h, -h, 2 * h, 2 * h); ctx.strokeRect(-h, -h, 2 * h, 2 * h);
  ctx.strokeStyle = '#2b2f36'; ctx.fillStyle = '#2b2f36'; ctx.lineWidth = Math.max(0.8, S * 0.018);
  const k = h * 0.6;
  ctx.beginPath();
  if (wcode === 1) { ctx.moveTo(-k, k); ctx.lineTo(-k * 0.2, -k * 0.2); ctx.lineTo(k * 0.2, k * 0.2); ctx.lineTo(k, -k); ctx.stroke(); }
  else if (wcode === 2) { for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.moveTo(Math.cos(a) * k * 0.3, Math.sin(a) * k * 0.3); ctx.lineTo(Math.cos(a) * k, Math.sin(a) * k); } ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, k * 0.3, 0, Math.PI * 2); ctx.fill(); }
  else if (wcode === 3) { for (let i = -1; i <= 1; i++) ctx.fillRect(i * k * 0.55 - k * 0.12, -k, k * 0.24, k * 2); }
  else if (wcode === 4) { ctx.arc(0, 0, k * 0.85, 0, Math.PI * 2); ctx.moveTo(k * 0.35, 0); ctx.arc(0, 0, k * 0.35, 0, Math.PI * 2); ctx.moveTo(-k, 0); ctx.lineTo(k, 0); ctx.moveTo(0, -k); ctx.lineTo(0, k); ctx.stroke(); }
  ctx.restore();
}
const crateBorn = new Map();

function drawProjectile(S, b) {
  const br = Math.max(1.6, S * 0.05);
  if (b.kind === 3) { // frag shard: small spinning sliver, fades out
    ctx.globalAlpha = Math.max(0, b.life / 20);
    ctx.fillStyle = '#333';
    ctx.fillRect(b.x - br * 0.6, b.y - br * 0.6, br * 1.2, br * 1.2);
    ctx.globalAlpha = 1;
  } else if (b.kind === 2) { // frag bomb
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(b.x, b.y, br * 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = (performance.now() / 150 | 0) % 2 ? '#e33' : '#fa3';
    ctx.beginPath(); ctx.arc(b.x, b.y, br * 0.7, 0, Math.PI * 2); ctx.fill();
  } else if (b.kind === 4) { // homing missile, pointing along its motion
    const a = Math.atan2(b.dy, b.dx);
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(a);
    ctx.fillStyle = '#444'; ctx.fillRect(-br * 2.2, -br * 0.7, br * 3.4, br * 1.4);
    ctx.fillStyle = '#d33'; ctx.beginPath(); ctx.moveTo(br * 1.2, -br * 0.7); ctx.lineTo(br * 2.4, 0); ctx.lineTo(br * 1.2, br * 0.7); ctx.fill();
    ctx.restore();
    if (Math.random() < 0.6) particles.push({ x: b.x - Math.cos(a) * br * 2, y: b.y - Math.sin(a) * br * 2, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, life: 0.6, color: '#aaa', size: br * 1.2 });
  } else { // cannon ball / gatling round
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.kind === 1 ? br * 0.75 : br, 0, Math.PI * 2); ctx.fill();
  }
}

function drawLaser(S, L) {
  const pts = L[2];
  if (pts.length < 4) return;
  const path = () => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  path(); ctx.strokeStyle = playerColor(L[1]) + '55'; ctx.lineWidth = Math.max(2, S * 0.12); ctx.stroke();
  path(); ctx.strokeStyle = playerColor(L[1]); ctx.lineWidth = Math.max(1, S * 0.04); ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawAimer(S, tank, all) {
  const pts = traceAimer(maze, tank, all);
  ctx.save();
  ctx.setLineDash([S * 0.06, S * 0.06]);
  ctx.strokeStyle = playerColor(tank.id) + 'aa';
  ctx.lineWidth = Math.max(0.8, S * 0.02);
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  ctx.restore();
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
    const tk = latest.tankMap && latest.tankMap.get(id);
    drawTank(50, cx - 26, y0 + 40, 0, color, false, tk ? tk[7] : 0);
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
    const now = performance.now();
    const live = new Set(st.crates.map(c => c[0]));
    for (const id of crateBorn.keys()) if (!live.has(id)) crateBorn.delete(id);
    for (const c of st.crates) drawCrate(maze.S, c, now);
    // Poses to draw: remote tanks interpolated, own tanks predicted.
    const poses = [];
    for (const t of st.tanks) {
      if (!t.alive) continue;
      const seat = mine.get(t.id);
      if (seat) {
        if (!seat.pred || !seat.pred.alive) continue;
        seat.off.x *= SMOOTH; seat.off.y *= SMOOTH; seat.off.r *= SMOOTH;
        poses.push({ ...t, x: seat.pred.x + seat.off.x, y: seat.pred.y + seat.off.y, rot: seat.pred.rot + seat.off.r, me: true });
      } else poses.push(t);
    }
    for (const p of poses) if (p.weapon === 1 && p.aiming) drawAimer(maze.S, p, poses);
    for (const p of poses) drawTank(maze.S, p.x, p.y, p.rot, playerColor(p.id), !!p.me, p.weapon, st.guns.get(p.id) || 0);
    for (const b of st.bullets) drawProjectile(maze.S, b);
    for (const L of st.lasers) drawLaser(maze.S, L);
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
window.__ra = { seats, get latest() { return latest; }, get maze() { return maze; }, get isHost() { return isHost; } };
