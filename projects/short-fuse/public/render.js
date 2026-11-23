// Drawing. The art is Short Fuse's own, drawn in code; a skin (skin.js) can replace any piece
// with an image. World units are the game's: 30 per cell, board 450 x 390, HUD 60 below.
import { CELL, COLS, ROWS, FUSE, FLAME, LIVES, POWERUPS, HEATS, SUDDEN_DEATH, ARENAS } from './shared/game.js';

const BOARD_W = COLS * CELL, BOARD_H = ROWS * CELL, HUD = 60;
const POWER_COLORS = { flame: '#ff7043', speed: '#ffee58', bomb: '#90a4ae', kick: '#81c784', glove: '#ba68c8' };
const PAD_COLORS = ['#4dd0e1', '#f06292'];

export function createRenderer(canvas, skin) {
  const ctx = canvas.getContext('2d'), S = canvas.width / BOARD_W, effects = [];
  let shake = 0;
  const fx = {
    boom(x, y) { shake = Math.min(6, shake + 3); for (let i = 0; i < 10; i++) effects.push({ k: 'spark', x, y, vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5, life: 18, max: 18 }); },
    crate(x, y) { for (let i = 0; i < 8; i++) effects.push({ k: 'chip', x, y, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 24, max: 24 }); },
    text(x, y, text, color) { effects.push({ k: 'text', x, y, text, color, life: 50, max: 50 }); },
    ring(x, y, color) { effects.push({ k: 'ring', x, y, color, life: 16, max: 16 }); },
    wall(i, j) { effects.push({ k: 'drop', x: i * CELL, y: j * CELL, life: 8, max: 8 }); shake = Math.min(4, shake + 1); },
  };
  const box = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const disc = (x, y, r, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };
  // a skin image, one cell square, centred on (x, y); returns false if the skin has none
  const image = (name, x, y, rot = 0, alpha = 1) => {
    const im = skin.images?.[name]; if (!im) return false;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha *= alpha; ctx.drawImage(im, -CELL / 2, -CELL / 2, CELL, CELL); ctx.restore();
    return true;
  };

  function wall(x, y) { // x, y: cell centre
    if (image('wall', x, y)) return;
    const g = ctx.createLinearGradient(0, y - 15, 0, y + 15); g.addColorStop(0, '#7b8794'); g.addColorStop(1, '#4a5561');
    ctx.fillStyle = g; box(x - 14.5, y - 14.5, 29, 29, 3); ctx.fill();
    ctx.fillStyle = '#9aa7b4'; ctx.fillRect(x - 12, y - 13, 24, 2);
    for (const [a, b] of [[-10, -9], [10, -9], [-10, 10], [10, 10]]) disc(x + a, y + b, 1.4, '#323b45');
  }
  function crate(x, y, burnt) { // burnt: ticks burning, or -1
    const a = burnt >= 0 ? 1 - burnt / FLAME * 0.8 : 1;
    if (image('crate', x, y, 0, a)) { if (burnt >= 0) { ctx.fillStyle = '#ff8a3d55'; ctx.fillRect(x - 15, y - 15, 30, 30); } return; }
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = burnt >= 0 ? (burnt % 4 < 2 ? '#ff8a3d' : '#d9532c') : '#b9803f'; box(x - 13, y - 13, 26, 26, 3); ctx.fill();
    ctx.strokeStyle = burnt >= 0 ? '#ffd180' : '#7a4f22'; ctx.lineWidth = 2; ctx.strokeRect(x - 11, y - 11, 22, 22);
    ctx.beginPath(); ctx.moveTo(x - 10, y - 10); ctx.lineTo(x + 10, y + 10); ctx.moveTo(x + 10, y - 10); ctx.lineTo(x - 10, y + 10); ctx.stroke();
    ctx.restore();
  }
  // Power-ups are glowing coloured tiles with a white symbol and a "+": nothing about them
  // looks like a bomb (a black ball with a fuse), so a burnt crate never seems to hide one.
  function powerup(x, y, kind, t) {
    if (image('power' + kind[0].toUpperCase() + kind.slice(1), x, y)) return;
    const glow = 0.5 + 0.5 * Math.sin(t / 160 + x * 0.1), c = POWER_COLORS[kind];
    ctx.save();
    ctx.shadowColor = c; ctx.shadowBlur = 4 + 4 * glow;
    ctx.fillStyle = c; box(x - 12, y - 12, 24, 24, 4); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff40'; box(x - 10, y - 10, 20, 9, 3); ctx.fill();          // shine
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; box(x - 12, y - 12, 24, 24, 4); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (kind === 'flame') { ctx.moveTo(x, y - 8); ctx.quadraticCurveTo(x + 8, y + 1, x, y + 8); ctx.quadraticCurveTo(x - 8, y + 1, x, y - 8); ctx.fill(); }
    else if (kind === 'speed') { ctx.moveTo(x + 2, y - 9); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x, y + 1); ctx.lineTo(x - 2, y + 9); ctx.lineTo(x + 5, y - 1); ctx.lineTo(x, y - 1); ctx.closePath(); ctx.fill(); }
    else if (kind === 'bomb') { ctx.font = '800 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('+1', x, y + 1); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y + 6.5, 2.5, 0, 7); ctx.stroke(); }
    else if (kind === 'kick') { ctx.moveTo(x - 6, y - 8); ctx.lineTo(x - 2, y - 8); ctx.lineTo(x - 2, y + 1); ctx.lineTo(x + 7, y + 3); ctx.lineTo(x + 7, y + 7); ctx.lineTo(x - 6, y + 7); ctx.closePath(); ctx.fill(); }
    else { ctx.arc(x, y + 3, 6, Math.PI, 0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + 6, y + 3); ctx.lineTo(x + 3, y - 2); ctx.lineTo(x + 9, y - 1); ctx.closePath(); ctx.fill(); }
    if (kind !== 'bomb') { ctx.font = '800 7px system-ui'; ctx.textAlign = 'center'; ctx.fillText('+', x + 8, y - 5); }
    ctx.restore();
  }
  function bomb(x, y, count, state, t) {
    const lift = state === 'f' ? 10 : state === 'h' ? 16 : 0, by = y - lift, late = count > FUSE - 18;
    ctx.fillStyle = '#0007'; ctx.beginPath(); ctx.ellipse(x, y + 10, 9 - lift / 4, 3, 0, 0, 7); ctx.fill();
    const r = 10 * (1 + Math.max(0, Math.sin(t / (late ? 40 : 110))) * 0.07);
    if (!image('bomb', x, by)) {
      const g = ctx.createRadialGradient(x - 3, by - 4, 1, x, by, r); g.addColorStop(0, '#6b7280'); g.addColorStop(1, '#111318');
      disc(x, by, r, g);
      ctx.strokeStyle = '#c8b28a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 5, by - 7); ctx.quadraticCurveTo(x + 9, by - 12, x + 7, by - 15); ctx.stroke();
      disc(x + 7, by - 15, 2.2 + Math.random() * 1.2, Math.random() < 0.5 ? '#ffe082' : '#ff7043');
    }
    if (late) disc(x, by, r, `rgba(255,80,40,${0.25 + 0.25 * Math.sin(t / 30)})`); // about to go off
  }
  function flame(x, y, dir, end, life) {
    const a = Math.min(1, life / 6), w = 9 + 3 * Math.sin(life), vertical = dir <= 2;
    if (image(end ? 'flameEnd' : 'flameArm', x, y, [0, 0, Math.PI, -Math.PI / 2, Math.PI / 2][dir], a)) return;
    const len = end ? 12 : 15, ox = dir === 3 ? 3 : dir === 4 ? -3 : 0, oy = dir === 1 ? 3 : dir === 2 ? -3 : 0;
    ctx.save(); ctx.globalAlpha = a;
    if (!end) { ctx.fillStyle = '#ff6d00'; if (vertical) ctx.fillRect(x - w, y - 15, w * 2, 30); else ctx.fillRect(x - 15, y - w, 30, w * 2); }
    for (const [k, c] of [[1, '#ff6d00'], [0.62, '#ffca28'], [0.28, '#fffde7']]) { ctx.fillStyle = c; const h = w * k; if (vertical) box(x - h + ox, y - len + oy, h * 2, len * 2, h); else box(x - len + ox, y - h + oy, len * 2, h * 2, h); ctx.fill(); }
    ctx.restore();
  }
  function blast(x, y, life) { // the exploding bomb's own cell
    const a = Math.min(1, life / 6);
    if (image('flameCentre', x, y, 0, a)) return;
    ctx.save(); ctx.globalAlpha = a; const r = 13 + 2 * Math.sin(life);
    disc(x, y, r, '#ff6d00'); disc(x, y, r * 0.7, '#ffca28'); disc(x, y, r * 0.35, '#fffde7');
    ctx.restore();
  }
  function bomber(p, t, me) {
    if (p.inv && Math.floor(t / 125) % 3 === 0) return; // blinks while invincible
    const { x, y, color, dir } = p;
    if (!image('player' + (p.slot + 1), x, y - 3)) {
      ctx.fillStyle = '#0008'; ctx.beginPath(); ctx.ellipse(x, y + 11, 9, 3.2, 0, 0, 7); ctx.fill();
      const step = p.moving ? Math.sin(t / 60) * 1.5 : 0;
      ctx.fillStyle = '#2b2f36'; ctx.fillRect(x - 7, y + 5 + step, 5, 6); ctx.fillRect(x + 2, y + 5 - step, 5, 6);
      const g = ctx.createRadialGradient(x - 3, y - 5, 1, x, y - 1, 12); g.addColorStop(0, '#fff'); g.addColorStop(0.25, color); g.addColorStop(1, shade(color));
      disc(x, y - 1, 10.5, g); ctx.strokeStyle = '#1b1f24'; ctx.lineWidth = 1.5; ctx.stroke();
      const [vx, vy] = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] }[dir] || [0, 1];
      if (vy !== -1) {
        ctx.fillStyle = '#12161c'; box(x - 7 + vx * 3, y - 6 + Math.max(0, vy) * 2, 14, 7, 3.5); ctx.fill();
        ctx.fillStyle = '#7df9ff'; ctx.fillRect(x - 4 + vx * 4, y - 4 + Math.max(0, vy) * 2, 2.5, 3); ctx.fillRect(x + 1.5 + vx * 4, y - 4 + Math.max(0, vy) * 2, 2.5, 3);
      }
      ctx.strokeStyle = '#1b1f24'; ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 2, y - 16); ctx.stroke();
      disc(x + 2, y - 17, 2.2, color);
    }
    ctx.font = '700 7px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#000b';
    const tag = me ? '▼ ' + p.name : p.name;
    ctx.strokeText(tag, x, y - 21); ctx.fillStyle = me ? '#fff' : '#dfe5ec'; ctx.fillText(tag, x, y - 21);
  }

  function draw({ s, floor, players, bombs, mine, rtt, banner, seated }) {
    const t = performance.now();
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.fillStyle = '#0b0e12'; ctx.fillRect(0, 0, BOARD_W, BOARD_H + HUD);
    ctx.save();
    if (shake > 0.1) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.85; }
    ctx.translate(CELL / 2, CELL / 2); // cell (i, j) is centred on (30i, 30j)
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) if (!image('floor', i * CELL, j * CELL)) { ctx.fillStyle = (i + j) % 2 ? '#1c2a33' : '#1f2f39'; ctx.fillRect(i * CELL - 15, j * CELL - 15, CELL, CELL); }
    if (s) {
      for (const f of floor) {
        const x = f.i * CELL, y = f.j * CELL;
        if (f.kind === 'fire') {
          if (image(s.fire ? 'fireLit' : 'fire', x, y)) continue;
          ctx.fillStyle = s.fire ? '#ff7043' : '#30201c'; ctx.fillRect(x - 15, y - 15, CELL, CELL);
          for (let k = 0; k < 3; k++) disc(x - 8 + k * 8, y + (k % 2 ? 4 : -4) + (s.fire ? Math.sin(t / 50 + k) * 3 : 0), s.fire ? 3.5 : 2, s.fire ? '#ffe082' : '#6d3a2a');
        } else if (!image('pad', x, y)) {
          ctx.strokeStyle = PAD_COLORS[f.pair % 2]; ctx.lineWidth = 2;
          for (let k = 0; k < 3; k++) { ctx.globalAlpha = 0.35 + 0.2 * k; ctx.beginPath(); ctx.arc(x, y, 5 + k * 4 + Math.sin(t / 180 + k) * 1.2, t / 400 + k, t / 400 + k + 4.5); ctx.stroke(); }
          ctx.globalAlpha = 1;
        }
      }
      const burning = new Map(s.burning);
      for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
        const v = s.cells[i * ROWS + j], c = i * ROWS + j;
        if (v === 1) wall(i * CELL, j * CELL); else if (v === 2) crate(i * CELL, j * CELL, burning.get(c) ?? -1);
      }
      for (const [c, k] of s.powerups) powerup(Math.floor(c / ROWS) * CELL, (c % ROWS) * CELL, POWERUPS[k], t);
      for (const f of s.flames) flame(f.x, f.y, f.dir, f.end, f.life);
      for (const b of bombs) if (b.count >= FUSE) blast(b.x, b.y, FUSE + FLAME - b.count); else bomb(b.x, b.y, b.count, b.state, t);
      for (const p of players.filter(q => q.fighting && q.alive).sort((a, b) => a.y - b.y)) { bomber(p, t, mine.has(p.id)); if (p.carrying) bomb(p.x, p.y, 0, 'h', t); }
    }
    for (let n = effects.length - 1; n >= 0; n--) {
      const e = effects[n], a = e.life / e.max, k = e.max - e.life;
      ctx.globalAlpha = Math.max(0, a);
      if (e.k === 'spark') { ctx.fillStyle = a > 0.5 ? '#ffe082' : '#ff7043'; ctx.fillRect(e.x + e.vx * k, e.y + e.vy * k, 2, 2); }
      else if (e.k === 'chip') { ctx.fillStyle = '#9a6a33'; ctx.fillRect(e.x + e.vx * k, e.y + e.vy * k + 0.1 * k * k, 3, 3); }
      else if (e.k === 'text') { ctx.font = '700 9px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = e.color; ctx.fillText(e.text, e.x, e.y - 20 - k * 0.4); }
      else if (e.k === 'ring') { ctx.strokeStyle = e.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(e.x, e.y, 18 * (1 - a) + 4, 0, 7); ctx.stroke(); }
      else if (e.k === 'drop') { ctx.fillStyle = '#ffffff55'; ctx.fillRect(e.x - 15, e.y - 15 - e.life * 4, CELL, CELL); }
      ctx.globalAlpha = 1;
      if (--e.life <= 0) effects.splice(n, 1);
    }
    ctx.restore();
    hud(s, players, mine, rtt, t);
    overlay(s, players, banner, seated);
  }

  function hud(s, players, mine, rtt, t) {
    const y0 = BOARD_H;
    ctx.fillStyle = '#12161c'; ctx.fillRect(0, y0, BOARD_W, HUD); ctx.fillStyle = '#2a313b'; ctx.fillRect(0, y0, BOARD_W, 1);
    if (!s) return;
    const left = Math.max(0, s.clock), sudden = s.phase === 'play' && left < SUDDEN_DEATH;
    ctx.textAlign = 'center'; ctx.font = '700 16px system-ui';
    ctx.fillStyle = sudden ? (Math.floor(t / 300) % 2 ? '#ff5252' : '#ffab91') : '#e9ecf1';
    ctx.fillText(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, BOARD_W / 2, y0 + 22);
    ctx.font = '600 8px system-ui'; ctx.fillStyle = '#8f99a8';
    ctx.fillText(sudden ? 'SUDDEN DEATH' : `heat ${Math.max(1, s.heat)}/${HEATS}`, BOARD_W / 2, y0 + 34);
    ctx.fillText(ARENAS[s.arena]?.name ?? '', BOARD_W / 2, y0 + 44);
    ctx.fillText(`ping ${Math.round(rtt)} ms`, BOARD_W / 2, y0 + 54);
    const cards = players.filter(p => p.fighting).sort((a, b) => a.slot - b.slot);
    cards.forEach((p, n) => {
      const x = n < 2 ? 4 + n * 92 : BOARD_W - 4 - (4 - n) * 92, y = y0 + 6;
      ctx.globalAlpha = p.alive ? 1 : 0.4;
      ctx.fillStyle = '#1c222b'; box(x, y, 88, 48, 5); ctx.fill();
      ctx.fillStyle = p.color; box(x, y, 4, 48, 2); ctx.fill();
      ctx.textAlign = 'left'; ctx.font = '700 8px system-ui'; ctx.fillStyle = mine.has(p.id) ? '#fff' : '#cfd6df';
      ctx.fillText((p.bot ? '🤖 ' : '') + p.name.slice(0, 11), x + 8, y + 11);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffd54f'; ctx.fillText('★'.repeat(p.wins), x + 84, y + 11);
      ctx.textAlign = 'left'; ctx.font = '9px system-ui'; ctx.fillStyle = '#ef5350';
      ctx.fillText('♥'.repeat(Math.max(0, p.lives)) + '♡'.repeat(Math.max(0, LIVES - p.lives)), x + 8, y + 23);
      ctx.font = '600 7.5px system-ui'; ctx.fillStyle = '#aab4c0';
      ctx.fillText(`💣${p.bombs}  🔥${p.length}  ⚡${p.speed - 1}${p.kick ? '  👟' : ''}${p.glove >= 0 ? '  🧤' : ''}`, x + 8, y + 35);
      ctx.fillStyle = '#7d8896'; ctx.fillText(`${p.points.toLocaleString()} pts`, x + 8, y + 45);
      ctx.globalAlpha = 1;
    });
    const waiting = players.filter(p => !p.fighting);
    if (waiting.length && s.phase !== 'waiting') { ctx.textAlign = 'center'; ctx.font = '7px system-ui'; ctx.fillStyle = '#8f99a8'; ctx.fillText('next heat: ' + waiting.map(p => p.name).join(', '), BOARD_W / 2, y0 + 62 - 3); }
  }

  function overlay(s, players, banner, seated) {
    const name = id => players.find(p => p.id === id)?.name ?? '?';
    let title = null, sub = null;
    if (!s) title = 'Connecting…';
    else if (s.phase === 'waiting') { title = 'Waiting for players'; sub = seated ? 'Send the invite link to a friend, or pick some bots in the header.' : 'Press Join to play.'; }
    else if (s.phase === 'ready') { title = `Heat ${s.heat} of ${HEATS}`; sub = 'Get ready…'; }
    else if (s.phase === 'result') { title = s.winner != null ? `${name(s.winner)} wins the heat!` : 'Draw!'; sub = s.heat < HEATS ? 'Next heat soon…' : 'Final results soon…'; }
    else if (s.phase === 'matchover') {
      title = s.matchWinner != null ? `${name(s.matchWinner)} wins the match!` : 'The match is a draw!';
      sub = players.filter(p => p.wins || p.points).sort((a, b) => b.wins - a.wins || b.points - a.points).map(p => `${p.name} ${'★'.repeat(p.wins)} ${p.points.toLocaleString()}`).join('   ·   ');
    }
    if (banner && banner.until > performance.now()) { // a small notice at the top
      ctx.font = '600 9px system-ui'; const w = ctx.measureText(banner.text).width + 16;
      ctx.fillStyle = '#000b'; box(BOARD_W / 2 - w / 2, 6, w, 16, 8); ctx.fill();
      ctx.textAlign = 'center'; ctx.fillStyle = '#e9ecf1'; ctx.fillText(banner.text, BOARD_W / 2, 17);
    }
    if (!title) return;
    ctx.fillStyle = '#000a'; ctx.fillRect(0, BOARD_H / 2 - 34, BOARD_W, sub ? 62 : 46);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '800 20px system-ui'; ctx.fillText(title, BOARD_W / 2, BOARD_H / 2 - 6);
    if (sub) { ctx.font = '500 9px system-ui'; ctx.fillStyle = '#cfd6df'; ctx.fillText(sub, BOARD_W / 2, BOARD_H / 2 + 14); }
  }

  return { draw, fx };
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16), f = c => Math.round(c * 0.55);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
