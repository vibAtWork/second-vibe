// Browser game client, independent of how it is connected. A transport
// (net-ws.js for the server, net-p2p.js for peer-to-peer) delivers messages;
// this file handles input, client-side prediction, interpolation, events,
// auditing a P2P host, and hands a decoded view to the renderer each frame.
import { FRAME_MS, VIEW_W, VIEW_H, moveTank } from './shared/sim.js';
import { normaliseFrame, frameToInput, cleanName } from './shared/room.js';
import { decodeSnapshot } from './shared/protocol.js';
import { Auditor } from './shared/verify.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';

const INTERP_MS = 90;        // render remote objects this far in the past
const SEND_REDUNDANCY = 4;   // resend last N input frames each packet (loss tolerance)
const SMOOTH = 0.75;         // per-frame decay of prediction-correction offset
const KEYMAPS = {
  arrows: { f: 'ArrowUp', b: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight', fire: 'KeyM' },
  esdf: { f: 'KeyE', b: 'KeyD', l: 'KeyS', r: 'KeyF', fire: 'KeyQ' },
};
const SLOTS = { arrows: 'join', esdf: 'join2', mouse: 'join3' }; // slot -> button id

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const lerp = (a, b, t) => a + (b - a) * t;

// createTransport({ room, params, onMessage, onStatus, onConnected, onDisconnected }) -> { send(msg), stop() }
export function startClient(createTransport) {
  const $ = id => document.getElementById(id);
  const canvas = $('c'), statusEl = $('status');
  const { draw, fx } = createRenderer(canvas);
  const audio = createAudio();

  // ---- room from URL (a fresh random room if none)
  const params = new URLSearchParams(location.search);
  if (!params.get('room')) { params.set('room', Math.random().toString(36).slice(2, 8)); history.replaceState(null, '', '?' + params); }
  const room = params.get('room');
  $('name').value = store.get('ra-name') || '';

  // ---- input
  const keys = new Set(), tapped = new Set(); // tapped: pressed since last tick, so short taps count
  const gameKeys = new Set(Object.values(KEYMAPS).flatMap(Object.values));
  const mouse = { x: 0, y: 0, down: false, tapped: false };
  addEventListener('keydown', e => {
    audio.unlock();
    if (document.activeElement === $('name') || !gameKeys.has(e.code)) return;
    keys.add(e.code); if (!e.repeat) tapped.add(e.code); e.preventDefault();
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  addEventListener('pointerdown', () => audio.unlock());
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) / r.width * VIEW_W; mouse.y = (e.clientY - r.top) / r.height * VIEW_H;
  });
  canvas.addEventListener('pointerdown', e => { mouse.down = mouse.tapped = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { mouse.down = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  function readFrame(seat) {
    if (seat.scheme === 'mouse') {
      return normaliseFrame('mouse', mouse.down || mouse.tapped ? 16 : 0, mouse.x - (maze ? maze.ox : 0), mouse.y - (maze ? maze.oy : 0));
    }
    const k = KEYMAPS[seat.slot], on = c => keys.has(c) || tapped.has(c);
    return normaliseFrame('keys', (on(k.f) ? 1 : 0) | (on(k.b) ? 2 : 0) | (on(k.l) ? 4 : 0) | (on(k.r) ? 8 : 0) | (on(k.fire) ? 16 : 0));
  }

  // ---- state
  let maze = null, latest = null, clockOffset = null, rtt = 0, banner = null, cheat = null;
  const seats = [];            // local players: {slot, scheme, id, seq, pending, pred, off}
  const snaps = [];            // decoded snapshots for interpolation
  const offsets = [];
  const auditor = new Auditor(reason => {
    cheat = reason;
    statusEl.textContent = 'stopped: host cheating detected';
    net.stop();
  });

  const colorOf = id => latest?.playerById.get(id)?.color || '#888';
  const nameOf = id => latest?.playerById.get(id)?.name || '?';

  function join(slot) {
    if (seats.some(s => s.slot === slot)) return;
    const base = $('name').value.trim() || 'Player';
    store.set('ra-name', base);
    const name = cleanName(slot === 'arrows' ? base : `${base} ${slot === 'esdf' ? '2' : '(mouse)'}`);
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
    seats.push({ slot, scheme: slot === 'mouse' ? 'mouse' : 'keys', id: null, seq: 0, pending: [], pred: null, off: { x: 0, y: 0, r: 0 } });
    auditor.noteJoin(name, nonce);
    net.send({ t: 'join', name, slot, nonce });
    audio.unlock();
    updateButtons();
  }
  const updateButtons = () => { for (const [slot, id] of Object.entries(SLOTS)) $(id).disabled = seats.some(s => s.slot === slot); };
  for (const [slot, id] of Object.entries(SLOTS)) $(id).onclick = () => join(slot);
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied!'; } catch { prompt('Copy this link:', location.href); }
    setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 1500);
  };

  // (Re)connected: forget old room state and re-join with the same local players.
  function onConnected() {
    const slots = seats.splice(0).map(s => s.slot);
    auditor.reset();
    snaps.length = offsets.length = 0; clockOffset = latest = maze = null;
    slots.forEach(join);
    updateButtons();
  }

  const handlers = {
    maze(m) { maze = m.maze; snaps.length = 0; for (const s of seats) { s.pred = null; s.off = { x: 0, y: 0, r: 0 }; } },
    joined(m) { const s = seats.find(s => s.slot === m.slot && s.id == null); if (s) { s.id = m.id; auditor.noteSeat(m.id); } },
    full() { seats.pop(); updateButtons(); statusEl.textContent = 'room is full'; },
    sync(m) { auditor.sync(m.state); },
    log(m) { auditor.log(m); },
    pong(m) { rtt = performance.now() - m.c; },
    kicked(m) {
      const i = seats.findIndex(s => s.id === m.id);
      if (i >= 0) seats.splice(i, 1);
      updateButtons();
      banner = { text: `You were removed: ${m.reason}`, color: '#c33', until: performance.now() + 15000 };
      statusEl.textContent = 'removed by anti-cheat';
    },
    banned(m) { seats.length = 0; updateButtons(); statusEl.textContent = `can't join: ${m.reason}`; },
    s(m) { onSnapshot(decodeSnapshot(m)); },
  };
  const onMessage = m => { if (m && handlers[m.t]) handlers[m.t](m); };

  function onSnapshot(s) {
    const now = performance.now();
    latest = s;
    snaps.push(s);
    if (snaps.length > 40) snaps.shift();
    // Clock sync: smallest observed (arrival - tick time) = least-delayed packet.
    offsets.push(now - s.tick * FRAME_MS);
    if (offsets.length > 60) offsets.shift();
    const best = Math.min(...offsets);
    clockOffset = clockOffset == null ? best : clockOffset + (best - clockOffset) * 0.1;
    for (const ev of s.ev) onEvent(ev);
    reconcile(s);
  }

  // Prediction: start from the authoritative tank at the acknowledged input,
  // then re-apply inputs the room hasn't used yet.
  function reconcile(s) {
    if (!maze) return;
    for (const seat of seats) {
      if (seat.id == null) continue;
      const t = s.tankById.get(seat.id);
      if (!t) { seat.pred = null; continue; }
      seat.pending = seat.pending.filter(p => p.seq > (s.ack[seat.id] ?? 0));
      const before = seat.pred;
      const pred = { x: t.x, y: t.y, rot: t.rot, alive: !!t.alive, locked: !!t.locked };
      if (pred.alive && !pred.locked) {
        let frozen = s.frozen;
        for (const p of seat.pending) if (frozen > 0) frozen--; else moveTank(maze, pred, p.input);
      }
      seat.pred = pred;
      if (before?.alive && pred.alive) { // keep the screen continuous; fade the correction out
        seat.off.x += before.x - pred.x; seat.off.y += before.y - pred.y; seat.off.r += angDiff(before.rot, pred.rot);
        if (Math.hypot(seat.off.x, seat.off.y) > maze.S) seat.off = { x: 0, y: 0, r: 0 }; // teleport-sized: snap
      }
    }
  }

  // ---- events -> sound and visual effects
  const SIMPLE_SOUNDS = new Set(['fire', 'bounce', 'laser', 'spin', 'gshot', 'missile', 'lock', 'crate', 'pickup']);
  function onEvent(ev) {
    if (SIMPLE_SOUNDS.has(ev.type)) return audio[ev.type]();
    switch (ev.type) {
      case 'poof': audio.poof(); for (let i = 0; i < 6; i++) fx.smoke(ev.x, ev.y, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, '#bbb', 1.5, 0.12, 0.5); break;
      case 'boom': audio.boom(); fx.shake(4); fx.burst(ev.x, ev.y, colorOf(ev.victim), 26, 2.2); fx.burst(ev.x, ev.y, '#f6a623', 14, 1.6); break;
      case 'frag': audio.frag(); fx.shake(7); fx.burst(ev.x, ev.y, '#f6a623', 10, 1.2); fx.cloud(ev.x, ev.y, 10, 2.2, 4, 60, 70); break;
      case 'shardwall': if (Math.random() < 0.5) audio.shard(); break;
      case 'win': banner = { text: `${nameOf(ev.id)} wins the round!`, color: colorOf(ev.id), until: performance.now() + 2000 }; break;
      case 'draw': banner = { text: 'Draw!', color: '#555', until: performance.now() + 2000 }; break;
      case 'cheater': banner = { text: `${ev.name} was removed (${ev.reason})`, color: '#c33', until: performance.now() + 5000 }; break;
    }
  }

  // ---- local 25 Hz input tick (a timer, not rAF, so input keeps flowing in background tabs)
  let lastTick = performance.now();
  function localTick() {
    for (const seat of seats) {
      if (seat.id == null) continue;
      const frame = readFrame(seat), input = frameToInput(frame), seq = ++seat.seq;
      seat.pending.push({ seq, input, wire: [seq, ...frame] });
      if (seat.pending.length > 100) seat.pending.shift();
      auditor.noteFrame(seat.id, seq, frame);
      net.send({ t: 'in', id: seat.id, f: seat.pending.slice(-SEND_REDUNDANCY).map(p => p.wire) });
      const p = seat.pred;
      if (p?.alive && !p.locked && maze && !(latest?.frozen > 0)) moveTank(maze, p, input);
    }
    tapped.clear(); mouse.tapped = false;
  }
  setInterval(() => {
    const now = performance.now();
    for (let n = 0; now - lastTick >= FRAME_MS && n < 4; n++) { localTick(); lastTick += FRAME_MS; }
    if (now - lastTick > 500) lastTick = now;
  }, 5);
  setInterval(() => net.send({ t: 'ping', c: performance.now() }), 2000);
  setInterval(() => { if (auditor.stale(performance.now())) auditor.fail('host stopped publishing audit data'); }, 1000);

  // ---- interpolation of remote objects between the two snapshots around render time
  function interpolated() {
    if (!snaps.length || clockOffset == null) return null;
    const renderTick = (performance.now() - clockOffset - INTERP_MS) / FRAME_MS;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].tick <= renderTick) { a = snaps[i - 1]; b = snaps[i]; break; }
    const span = b.tick - a.tick, t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 1;
    const tanks = b.tanks.map(tb => {
      const ta = a.tankById.get(tb.id) || tb;
      return { ...tb, x: lerp(ta.x, tb.x, t), y: lerp(ta.y, tb.y, t), rot: ta.rot + angDiff(tb.rot, ta.rot) * t, alive: t < 1 ? ta.alive && tb.alive : tb.alive };
    });
    const bullets = [];
    for (const bb of b.bullets) {
      const ba = a.bulletById.get(bb.id);
      if (ba) bullets.push({ ...bb, x: lerp(ba.x, bb.x, t), y: lerp(ba.y, bb.y, t), dx: bb.x - ba.x, dy: bb.y - ba.y });
      else if (t > 0.5) bullets.push({ ...bb, dx: 0, dy: 0 });
    }
    return { tanks, bullets, lasers: (t < 0.5 ? a : b).lasers, crates: b.crates, spinByOwner: b.spinByOwner };
  }

  function frame() {
    requestAnimationFrame(frame);
    const st = interpolated();
    const mine = new Map(seats.filter(s => s.id != null).map(s => [s.id, s]));
    const poses = [];
    for (const t of st?.tanks || []) { // remote tanks interpolated, own tanks predicted
      if (!t.alive) continue;
      const seat = mine.get(t.id);
      if (!seat) { poses.push(t); continue; }
      if (!seat.pred?.alive) continue;
      seat.off.x *= SMOOTH; seat.off.y *= SMOOTH; seat.off.r *= SMOOTH;
      poses.push({ ...t, x: seat.pred.x + seat.off.x, y: seat.pred.y + seat.off.y, rot: seat.pred.rot + seat.off.r, me: true });
    }
    draw({
      maze, poses, bullets: st?.bullets || [], lasers: st?.lasers || [], crates: st?.crates || [],
      spinOf: id => st?.spinByOwner.get(id) || 0, colorOf, weaponOf: id => latest?.tankById.get(id)?.weapon || 0,
      players: latest?.players || [], mine, rtt, frozen: latest?.frozen || 0, banner, cheat, spectating: !seats.length,
    });
  }

  // Connection lost: nothing to audit until the next host/server syncs us again.
  const onDisconnected = () => auditor.reset();
  const net = createTransport({ room, params, onMessage, onStatus: t => { if (!cheat) statusEl.textContent = t; }, onConnected, onDisconnected });
  requestAnimationFrame(frame);
  // exposed for automated tests
  window.__ra = { seats, net, get latest() { return latest; }, get maze() { return maze; }, get cheat() { return cheat; } };
}
