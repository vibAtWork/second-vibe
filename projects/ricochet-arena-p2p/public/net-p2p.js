// Peer-to-peer transport (WebRTC via PeerJS). Same interface as net-ws.js.
//
// Everyone with the same room link tries to reach peer id PREFIX+room. If no
// one holds it, this browser claims it and becomes the host: it runs the shared
// authoritative HostRoom (with audit logging on, so every guest can verify it)
// and plays through a loopback connection. Guests open two channels to the
// host: 'ctl' (reliable, ordered: joins, mazes, audit log) and 'rt'
// (unreliable: inputs and snapshots, so a lost packet never stalls play).
import { FRAME_MS } from './shared/sim.js';
import { HostRoom } from './shared/room.js';

const PREFIX = 'ricochet-arena-v2-';
const HOST_SILENT_MS = 2500;   // guest: no message from host for this long -> host gone
const GUEST_SILENT_MS = 6000;  // host: guest pings every 2 s; silent this long -> drop

export function p2pTransport({ room, params, onMessage, onStatus, onConnected, onDisconnected }) {
  const Peer = window.Peer;
  const peerOptions = () => {
    const o = { debug: 1 };
    if (params.get('peerhost')) {
      Object.assign(o, { host: params.get('peerhost'), port: +(params.get('peerport') || 443), path: params.get('peerpath') || '/', secure: params.get('peersecure') !== '0' });
    }
    if (params.get('ice')) o.config = { iceServers: JSON.parse(params.get('ice')) };
    return o;
  };
  let peer = null, send = () => {}, isHost = false, guest = false, stopped = false, generation = 0, lastHostMsg = 0, hostRoom = null;
  const remotes = new Map(); // host side: peer id -> {conn, ctl, rt, added, seen}
  const destroyPeer = () => { try { peer?.destroy(); } catch { /* already gone */ } };

  function connect() {
    if (stopped) return;
    const gen = ++generation;
    send = () => {}; isHost = false; guest = false;
    destroyPeer();
    onStatus('looking for host…');
    const me = peer = new Peer(peerOptions());
    let settled = false;
    const host = () => { if (settled || gen !== generation) return; settled = true; destroyPeer(); becomeHost(gen); };
    me.on('open', () => {
      const target = PREFIX + room;
      const ctl = me.connect(target, { label: 'ctl', reliable: true, serialization: 'json' });
      const rt = me.connect(target, { label: 'rt', reliable: false, serialization: 'json' });
      const early = []; // messages that arrive before both channels are open
      let opened = 0, ready = false;
      for (const c of [ctl, rt]) {
        c.on('open', () => {
          if (++opened < 2 || gen !== generation) return;
          settled = true; guest = true; lastHostMsg = performance.now();
          send = m => { try { (m.t === 'in' ? rt : ctl).send(m); } catch { /* closed */ } };
          onStatus(`room "${room}" · connected to host`);
          onConnected();
          ready = true;
          early.splice(0).forEach(onMessage);
        });
        c.on('data', d => { lastHostMsg = performance.now(); if (ready) onMessage(d); else early.push(d); });
        c.on('close', () => { if (gen === generation && settled) hostLost(); });
        c.on('error', () => {});
      }
      setTimeout(host, 5000);
    });
    me.on('error', err => {
      if (err.type === 'peer-unavailable') host();
      else if (!settled) { settled = true; onStatus(`signalling error (${err.type}) - retrying…`); setTimeout(() => gen === generation && connect(), 2000); }
    });
  }

  let hostLostPending = false;
  function hostLost() {
    if (hostLostPending || stopped) return;
    hostLostPending = true; guest = false; send = () => {};
    onDisconnected();
    onStatus('host left - finding a new host…');
    // random back-off so exactly one remaining browser wins the host id
    setTimeout(() => { hostLostPending = false; connect(); }, 300 + Math.random() * 1200);
  }

  function becomeHost(gen) {
    const me = peer = new Peer(PREFIX + room, peerOptions());
    me.on('open', () => {
      if (gen !== generation) return;
      isHost = true;
      hostRoom = new HostRoom({ verifiable: true });
      // Loopback for this browser's own players: async like a network, nothing to audit.
      const local = { noAudit: true, send: m => queueMicrotask(() => onMessage(structuredClone(m))) };
      hostRoom.addConn(local);
      send = m => queueMicrotask(() => hostRoom.handle(local, m));
      startTicker(hostRoom);
      onStatus(`room "${room}" · you are hosting`);
      onConnected();
    });
    me.on('connection', c => {
      let e = remotes.get(c.peer);
      if (!e) {
        e = { added: false, seen: performance.now() };
        e.conn = {
          send: m => { const ch = m.t === 's' ? e.rt || e.ctl : e.ctl; try { if (ch?.open) ch.send(m); } catch { /* closed */ } },
          kick: () => { try { e.ctl?.close(); e.rt?.close(); } catch { /* closed */ } },
        };
        remotes.set(c.peer, e);
      }
      e[c.label === 'rt' ? 'rt' : 'ctl'] = c;
      c.on('open', () => { if (!e.added && e.ctl?.open && e.rt?.open) { e.added = true; hostRoom.addConn(e.conn); } });
      c.on('data', d => { e.seen = performance.now(); hostRoom.handle(e.conn, d); });
      c.on('close', () => dropRemote(c.peer, e));
      c.on('error', () => {});
    });
    me.on('error', err => {
      if (err.type === 'unavailable-id') setTimeout(() => gen === generation && connect(), 800); // someone else won the race
      else onStatus(`host error (${err.type})`);
    });
  }
  function dropRemote(id, e) {
    if (remotes.get(id) !== e) return;
    remotes.delete(id);
    if (e.added) hostRoom?.removeConn(e.conn);
    e.conn.kick();
  }

  // Tick the host from a Worker timer: browsers throttle main-thread timers in
  // background tabs, but keep delivering worker messages.
  let ticker = null;
  function startTicker(r) {
    ticker?.terminate();
    ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 10);'], { type: 'text/javascript' })));
    let next = performance.now();
    ticker.onmessage = () => {
      const now = performance.now();
      for (let n = 0; now >= next && n < 5; n++) { r.tick(); next += FRAME_MS; }
      if (now - next > 1000) next = now;
    };
  }

  // Data-channel 'close' isn't reliable when a tab just disappears; use silence too.
  setInterval(() => {
    const now = performance.now();
    if (guest && now - lastHostMsg > HOST_SILENT_MS) hostLost();
    if (isHost) for (const [id, e] of remotes) if (e.added && now - e.seen > GUEST_SILENT_MS) dropRemote(id, e);
  }, 500);
  addEventListener('pagehide', destroyPeer);

  connect();
  return {
    send: m => send(m),
    stop: () => { stopped = true; ticker?.terminate(); destroyPeer(); },
    get isHost() { return isHost; },
    get hostRoom() { return hostRoom; }, // for tests
  };
}
