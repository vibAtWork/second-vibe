// Canvas renderer: all art is drawn in code (original to Short Fuse). World units are the
// simulation's (30 per cell); the board is 450 x 390 with a 60-unit HUD underneath.
import { CELL, COLS, ROWS, FUSE, FLAME_TICKS, PICKUPS, LIVES, SUDDEN_DEATH_SECONDS, HEATS, ARENAS } from './shared/sim.js';

export const BOARD_W = COLS * CELL, BOARD_H = ROWS * CELL, HUD_H = 60;
const PAIR_COLORS = ['#4dd0e1', '#f06292'];
const PICKUP_COLORS = { flame: '#ff7043', speed: '#ffee58', bomb: '#90a4ae', kick: '#81c784', throw: '#ba68c8' };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width / BOARD_W; // pixels per world unit
  const effects = [];
  let shake = 0;
  const fx = {
    boom(x, y) { shake = Math.min(6, shake + 3); for (let i = 0; i < 10; i++) effects.push({ k: 'spark', x, y, vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5, life: 18, max: 18 }); },
    crate(x, y) { for (let i = 0; i < 8; i++) effects.push({ k: 'chip', x, y, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 24, max: 24, r: Math.random() * 6 }); },
    text(x, y, text, color) { effects.push({ k: 'text', x, y, text, color, life: 50, max: 50 }); },
    ring(x, y, color) { effects.push({ k: 'ring', x, y, color, life: 16, max: 16 }); },
    fill(i, j) { effects.push({ k: 'drop', x: i * CELL, y: j * CELL, life: 8, max: 8 }); shake = Math.min(4, shake + 1); },
  };

  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  function wall(x, y) {
    const g = ctx.createLinearGradient(x, y, x, y + CELL);
    g.addColorStop(0, '#7b8794'); g.addColorStop(1, '#4a5561');
    ctx.fillStyle = g; rr(x + 0.5, y + 0.5, CELL - 1, CELL - 1, 3); ctx.fill();
    ctx.fillStyle = '#9aa7b4'; ctx.fillRect(x + 3, y + 2, CELL - 6, 2);
    ctx.fillStyle = '#323b45';
    for (const [a, b] of [[5, 6], [CELL - 5, 6], [5, CELL - 5], [CELL - 5, CELL - 5]]) { ctx.beginPath(); ctx.arc(x + a, y + b, 1.4, 0, 7); ctx.fill(); }
  }
  function crate(x, y, burn) {
    ctx.save();
    if (burn >= 0) { ctx.globalAlpha = 1 - burn / FLAME_TICKS * 0.8; }
    ctx.fillStyle = burn >= 0 ? (burn % 4 < 2 ? '#ff8a3d' : '#d9532c') : '#b9803f';
    rr(x + 2, y + 2, CELL - 4, CELL - 4, 3); ctx.fill();
    ctx.strokeStyle = burn >= 0 ? '#ffd180' : '#7a4f22'; ctx.lineWidth = 2;
    ctx.strokeRect(x + 4, y + 4, CELL - 8, CELL - 8);
    ctx.beginPath(); ctx.moveTo(x + 5, y + 5); ctx.lineTo(x + CELL - 5, y + CELL - 5); ctx.moveTo(x + CELL - 5, y + 5); ctx.lineTo(x + 5, y + CELL - 5); ctx.stroke();
    ctx.restore();
  }
  function pickup(x, y, kind, t) {
    const bob = Math.sin(t / 200 + x) * 1.2, cx = x, cy = y + bob;
    ctx.fillStyle = '#0008'; ctx.beginPath(); ctx.ellipse(cx, y + 11, 8, 3, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PICKUP_COLORS[kind]; rr(cx - 10, cy - 10, 20, 20, 5); ctx.fill();
    ctx.strokeStyle = '#fff8'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#1b1f24'; ctx.strokeStyle = '#1b1f24'; ctx.lineWidth = 2;
    if (kind === 'flame') { ctx.beginPath(); ctx.moveTo(cx, cy - 7); ctx.quadraticCurveTo(cx + 7, cy + 1, cx, cy + 7); ctx.quadraticCurveTo(cx - 7, cy + 1, cx, cy - 7); ctx.fill(); }
    else if (kind === 'speed') { ctx.beginPath(); ctx.moveTo(cx + 2, cy - 8); ctx.lineTo(cx - 5, cy + 1); ctx.lineTo(cx, cy + 1); ctx.lineTo(cx - 2, cy + 8); ctx.lineTo(cx + 5, cy - 1); ctx.lineTo(cx, cy - 1); ctx.closePath(); ctx.fill(); }
    else if (kind === 'bomb') { ctx.beginPath(); ctx.arc(cx - 1, cy + 1, 5.5, 0, 7); ctx.fill(); ctx.fillRect(cx + 4, cy - 6, 2, 2); ctx.fillStyle = '#fff'; ctx.fillRect(cx + 4, cy - 9, 4, 1.5); ctx.fillRect(cx + 5.2, cy - 10.2, 1.5, 4); }
    else if (kind === 'kick') { ctx.beginPath(); ctx.moveTo(cx - 6, cy - 7); ctx.lineTo(cx - 2, cy - 7); ctx.lineTo(cx - 2, cy + 1); ctx.lineTo(cx + 7, cy + 3); ctx.lineTo(cx + 7, cy + 7); ctx.lineTo(cx - 6, cy + 7); ctx.closePath(); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(cx, cy + 3, 6, Math.PI, 0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx + 6, cy + 3); ctx.lineTo(cx + 3, cy - 1); ctx.lineTo(cx + 8, cy - 1); ctx.closePath(); ctx.fill(); }
  }
  function bomb(x, y, count, state, t) {
    const lift = state === 2 ? 10 : state === 3 ? 16 : 0;
    ctx.fillStyle = '#0007'; ctx.beginPath(); ctx.ellipse(x, y + 10, 9 - lift / 4, 3, 0, 0, 7); ctx.fill();
    const pulse = 1 + Math.max(0, Math.sin(t / (count > FUSE - 18 ? 40 : 110))) * 0.07;
    const r = 10 * pulse, by = y - lift;
    const g = ctx.createRadialGradient(x - 3, by - 4, 1, x, by, r);
    g.addColorStop(0, '#6b7280'); g.addColorStop(1, '#111318');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, by, r, 0, 7); ctx.fill();
    if (count > FUSE - 18) { ctx.fillStyle = `rgba(255,80,40,${0.25 + 0.25 * Math.sin(t / 30)})`; ctx.beginPath(); ctx.arc(x, by, r, 0, 7); ctx.fill(); }
    ctx.strokeStyle = '#c8b28a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 5, by - 7); ctx.quadraticCurveTo(x + 9, by - 12, x + 7, by - 15); ctx.stroke();
    ctx.fillStyle = Math.random() < 0.5 ? '#ffe082' : '#ff7043'; ctx.beginPath(); ctx.arc(x + 7, by - 15, 2.2 + Math.random() * 1.2, 0, 7); ctx.fill();
  }
  function flame(x, y, dir, end, life) {
    const a = Math.min(1, life / 6), w = 9 + 3 * Math.sin(life), vertical = dir <= 2;
    const len = end ? 12 : 15, ox = dir === 3 ? 3 : dir === 4 ? -3 : 0, oy = dir === 1 ? 3 : dir === 2 ? -3 : 0;
    ctx.save(); ctx.globalAlpha = a;
    const draw = (half, color) => { ctx.fillStyle = color; if (vertical) rr(x - half + ox, y - len + oy, half * 2, len * 2, half); else rr(x - len + ox, y - half + oy, len * 2, half * 2, half); ctx.fill(); };
    if (!end) { ctx.fillStyle = '#ff6d00'; if (vertical) ctx.fillRect(x - w, y - 15, w * 2, 30); else ctx.fillRect(x - 15, y - w, 30, w * 2); }
    draw(w, '#ff6d00'); draw(w * 0.62, '#ffca28'); draw(w * 0.28, '#fffde7');
    ctx.restore();
  }
  function centreFlame(x, y, life) {
    const a = Math.min(1, life / 6), r = 13 + 2 * Math.sin(life);
    ctx.save(); ctx.globalAlpha = a;
    for (const [rad, c] of [[r, '#ff6d00'], [r * 0.7, '#ffca28'], [r * 0.35, '#fffde7']]) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill(); }
    ctx.restore();
  }
  function robot(p, t, me) {
    const { x, y, color, dir } = p;
    if (p.inv && Math.floor(t / 125) % 3 === 0) return; // blink while invincible
    ctx.fillStyle = '#0008'; ctx.beginPath(); ctx.ellipse(x, y + 11, 9, 3.2, 0, 0, 7); ctx.fill();
    const step = p.moving ? Math.sin(t / 60) * 1.5 : 0;
    ctx.fillStyle = '#2b2f36'; ctx.fillRect(x - 7, y + 5 + step, 5, 6); ctx.fillRect(x + 2, y + 5 - step, 5, 6); // feet
    const g = ctx.createRadialGradient(x - 3, y - 5, 1, x, y - 1, 12);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, color); g.addColorStop(1, shade(color, -0.45));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 1, 10.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#1b1f24'; ctx.lineWidth = 1.5; ctx.stroke();
    // visor faces the move direction
    const [vx, vy] = dir === 1 ? [0, -1] : dir === 3 ? [-1, 0] : dir === 4 ? [1, 0] : [0, 1];
    if (vy !== -1) {
      ctx.fillStyle = '#12161c'; rr(x - 7 + vx * 3, y - 6 + Math.max(0, vy) * 2, 14, 7, 3.5); ctx.fill();
      ctx.fillStyle = '#7df9ff'; ctx.fillRect(x - 4 + vx * 4, y - 4 + Math.max(0, vy) * 2, 2.5, 3); ctx.fillRect(x + 1.5 + vx * 4, y - 4 + Math.max(0, vy) * 2, 2.5, 3);
    }
    ctx.strokeStyle = '#1b1f24'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 2, y - 16); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 2, y - 17, 2.2, 0, 7); ctx.fill();
    ctx.font = '700 7px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#000b';
    const tag = me ? '▼ ' + p.name : p.name;
    ctx.strokeText(tag, x, y - 21); ctx.fillStyle = me ? '#fff' : '#e0e6ee'; ctx.fillText(tag, x, y - 21);
  }

  function draw(v) {
    const t = performance.now();
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.fillStyle = '#0b0e12'; ctx.fillRect(0, 0, BOARD_W, BOARD_H + HUD_H);
    ctx.save();
    if (shake > 0.1) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.85; }
    ctx.translate(CELL / 2, CELL / 2); // cell (i, j) is centred on (30i, 30j)
    // floor
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#1c2a33' : '#1f2f39';
      ctx.fillRect(i * CELL - 15, j * CELL - 15, CELL, CELL);
    }
    if (v.grid) {
      for (const f of v.floor) {
        const x = f.i * CELL, y = f.j * CELL;
        if (f.kind === 'fire') {
          ctx.fillStyle = v.fire ? '#ff7043' : '#30201c'; ctx.fillRect(x - 15, y - 15, CELL, CELL);
          ctx.fillStyle = v.fire ? '#ffe082' : '#6d3a2a';
          for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x - 8 + k * 8, y + (k % 2 ? 4 : -4) + (v.fire ? Math.sin(t / 50 + k) * 3 : 0), v.fire ? 3.5 : 2, 0, 7); ctx.fill(); }
        } else if (f.kind === 'tele') {
          const c = PAIR_COLORS[f.pair % 2];
          ctx.strokeStyle = c; ctx.lineWidth = 2;
          for (let k = 0; k < 3; k++) { ctx.globalAlpha = 0.35 + 0.2 * k; ctx.beginPath(); ctx.arc(x, y, 5 + k * 4 + Math.sin(t / 180 + k) * 1.2, t / 400 + k, t / 400 + k + 4.5); ctx.stroke(); }
          ctx.globalAlpha = 1;
        }
      }
      const burning = new Map(v.burning.map(([k, n]) => [k, n]));
      for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
        const c = v.grid[i * ROWS + j], x = i * CELL - 15, y = j * CELL - 15;
        if (c === 1) wall(x, y);
        else if (c === 2) crate(x, y, burning.has(i * ROWS + j) ? burning.get(i * ROWS + j) : -1);
      }
      for (const [i, j, k] of v.pickups) pickup(i * CELL, j * CELL, PICKUPS[k], t);
      for (const f of v.flames) flame(f.x, f.y, f.dir, f.end, f.life);
      for (const b of v.bombs) { if (b.count >= FUSE) centreFlame(b.x, b.y, FUSE + FLAME_TICKS - b.count); else if (b.state !== 3) bomb(b.x, b.y, b.count, b.state, t); }
      const ps = [...v.players].filter(p => p.fighting && p.alive).sort((a, b) => a.y - b.y);
      for (const p of ps) { robot(p, t, v.mine.has(p.id)); if (p.holding) bomb(p.x, p.y, 0, 3, t); }
    }
    // effects
    for (let n = effects.length - 1; n >= 0; n--) {
      const e = effects[n], a = e.life / e.max;
      ctx.globalAlpha = Math.max(0, a);
      if (e.k === 'spark') { ctx.fillStyle = a > 0.5 ? '#ffe082' : '#ff7043'; ctx.fillRect(e.x + (e.vx * (e.max - e.life)), e.y + (e.vy * (e.max - e.life)), 2, 2); }
      else if (e.k === 'chip') { ctx.fillStyle = '#9a6a33'; ctx.fillRect(e.x + e.vx * (e.max - e.life), e.y + e.vy * (e.max - e.life) + 0.1 * (e.max - e.life) ** 2, 3, 3); }
      else if (e.k === 'text') { ctx.font = '700 9px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = e.color; ctx.fillText(e.text, e.x, e.y - 20 - (e.max - e.life) * 0.4); }
      else if (e.k === 'ring') { ctx.strokeStyle = e.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(e.x, e.y, 18 * (1 - a) + 4, 0, 7); ctx.stroke(); }
      else if (e.k === 'drop') { ctx.fillStyle = '#ffffff55'; ctx.fillRect(e.x - 15, e.y - 15 - e.life * 4, CELL, CELL); }
      ctx.globalAlpha = 1;
      if (--e.life <= 0) effects.splice(n, 1);
    }
    ctx.restore();
    hud(v, t);
    overlay(v);
  }

  function hud(v, t) {
    const y0 = BOARD_H;
    ctx.fillStyle = '#12161c'; ctx.fillRect(0, y0, BOARD_W, HUD_H);
    ctx.fillStyle = '#2a313b'; ctx.fillRect(0, y0, BOARD_W, 1);
    // clock and heat
    const left = Math.max(0, v.clock ?? 0), m = Math.floor(left / 60), s = left % 60;
    const sudden = v.phase === 'play' && left < SUDDEN_DEATH_SECONDS;
    ctx.textAlign = 'center'; ctx.fillStyle = sudden ? (Math.floor(t / 300) % 2 ? '#ff5252' : '#ffab91') : '#e9ecf1';
    ctx.font = '700 16px system-ui'; ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, BOARD_W / 2, y0 + 22);
    ctx.font = '600 8px system-ui'; ctx.fillStyle = '#8f99a8';
    ctx.fillText(sudden ? 'SUDDEN DEATH' : `${ARENAS[v.arena]?.name ?? ''} · heat ${Math.max(1, v.heat)}/${HEATS}`, BOARD_W / 2, y0 + 34);
    ctx.fillText(`ping ${Math.round(v.rtt)} ms`, BOARD_W / 2, y0 + 50);
    // up to 4 player cards, two each side of the clock
    const cards = [...v.players].filter(p => p.fighting).sort((a, b) => a.slot - b.slot);
    const waiting = [...v.players].filter(p => !p.fighting);
    cards.forEach((p, n) => {
      const x = n < 2 ? 4 + n * 92 : BOARD_W - 4 - (4 - n) * 92, y = y0 + 6;
      ctx.globalAlpha = p.alive ? 1 : 0.4;
      ctx.fillStyle = '#1c222b'; rr(x, y, 88, 48, 5); ctx.fill();
      ctx.fillStyle = p.color; rr(x, y, 4, 48, 2); ctx.fill();
      ctx.textAlign = 'left'; ctx.font = '700 8px system-ui'; ctx.fillStyle = v.mine.has(p.id) ? '#fff' : '#cfd6df';
      ctx.fillText((p.bot ? '🤖 ' : '') + p.name.slice(0, 11), x + 8, y + 11);
      ctx.fillStyle = '#ffd54f'; ctx.textAlign = 'right'; ctx.fillText('★'.repeat(p.wins) || '', x + 84, y + 11);
      ctx.textAlign = 'left'; ctx.font = '9px system-ui';
      ctx.fillStyle = '#ef5350'; ctx.fillText('♥'.repeat(Math.max(0, p.lives)) + '♡'.repeat(Math.max(0, LIVES - p.lives)), x + 8, y + 23);
      ctx.font = '600 7.5px system-ui'; ctx.fillStyle = '#aab4c0';
      ctx.fillText(`💣${p.bombs}  🔥${p.length}  ⚡${p.speed - 1}${p.kick ? '  👟' : ''}${p.canThrow >= 0 ? '  🧤' : ''}`, x + 8, y + 35);
      ctx.fillStyle = '#7d8896'; ctx.fillText(`${p.points.toLocaleString()} pts`, x + 8, y + 45);
      ctx.globalAlpha = 1;
    });
    if (waiting.length) { ctx.textAlign = 'center'; ctx.font = '7px system-ui'; ctx.fillStyle = '#8f99a8'; ctx.fillText('next heat: ' + waiting.map(p => p.name).join(', '), BOARD_W / 2, y0 + 58); }
  }

  function overlay(v) {
    let title = null, sub = null;
    const name = id => [...v.players].find(p => p.id === id)?.name ?? '?';
    if (!v.grid) title = 'Connecting…';
    else if (v.phase === 'waiting') { title = 'Waiting for players'; sub = v.seated ? 'Send the invite link to a friend, or pick some bots in the header.' : 'Press Join to play.'; }
    else if (v.phase === 'ready') { title = `Heat ${v.heat} of ${HEATS}`; sub = 'Get ready…'; }
    else if (v.phase === 'result') { title = v.winner != null ? `${name(v.winner)} wins the heat!` : 'Draw!'; sub = v.heat < HEATS ? 'Next heat soon…' : 'Final results soon…'; }
    else if (v.phase === 'matchover') {
      title = v.matchWinner != null ? `${name(v.matchWinner)} wins the match!` : 'The match is a draw!';
      sub = [...v.players].filter(p => p.wins || p.points).sort((a, b) => b.wins - a.wins || b.points - a.points).map(p => `${p.name} ${'★'.repeat(p.wins)} ${p.points.toLocaleString()}`).join('   ·   ');
    }
    if (v.banner && v.banner.until > performance.now() && !title) { title = v.banner.text; }
    if (!title) return;
    ctx.fillStyle = '#000a'; ctx.fillRect(0, BOARD_H / 2 - 34, BOARD_W, sub ? 62 : 46);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '800 20px system-ui';
    ctx.fillText(title, BOARD_W / 2, BOARD_H / 2 - 6);
    if (sub) { ctx.font = '500 9px system-ui'; ctx.fillStyle = '#cfd6df'; ctx.fillText(sub, BOARD_W / 2, BOARD_H / 2 + 14); }
  }

  return { draw, fx };
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16), f = c => Math.max(0, Math.min(255, Math.round(c + (k < 0 ? c : 255 - c) * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
