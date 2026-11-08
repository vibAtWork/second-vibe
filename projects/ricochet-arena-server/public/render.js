// All drawing and purely visual effects. Knows nothing about networking:
// it is handed a decoded "view" each frame (see game-client.js).
import { VIEW_W, VIEW_H, BOTTOM_BAR, WALL, TANK_W, TANK_L, BULLET_SPAWN, CRATE_HALF, traceAimer } from './shared/sim.js';

const TAU = Math.PI * 2;
const rnd = (a = 1) => (Math.random() - 0.5) * a;
const grey = (lo, span) => { const g = lo + (Math.random() * span | 0); return `rgb(${g},${g},${g})`; };

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))));
  return `rgb(${c.join(',')})`;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const smokes = [];     // soft puffs drawn under everything
  const sparks = [];     // debris drawn on top
  const crateBorn = new Map();
  let shake = 0;

  // ---------------------------------------------------------------- effects
  const fx = {
    smoke(x, y, vx, vy, color, size, grow, alpha) {
      if (smokes.length > 600) smokes.shift();
      smokes.push({ x, y, vx, vy, color, size, grow, a: alpha, fade: alpha / (10 + Math.random() * 8) });
    },
    burst(x, y, color, n, speed) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, v = Math.random() * speed + 0.3;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color, size: 1.5 + Math.random() * 3 });
      }
    },
    cloud(x, y, n, spread, size, lo, span) {
      for (let i = 0; i < n; i++) fx.smoke(x + rnd(6), y + rnd(6), rnd(spread), rnd(spread), grey(lo, span), size + Math.random() * 3, 0.25, 0.7);
    },
    shake(n) { shake = Math.min(8, shake + n); },
  };

  function stepAndDraw(list, update, draw) {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.x += p.vx; p.y += p.vy; p.vx *= 0.93; p.vy *= 0.93;
      if (!update(p)) { list.splice(i, 1); continue; }
      draw(p);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- shapes
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const disc = (x, y, r, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };
  const polyline = pts => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); };

  function drawMaze(m) {
    const S = m.S, t = WALL * S;
    ctx.fillStyle = '#3d4350';
    for (let i = 0; i <= m.W; i++) for (let j = 0; j < m.H; j++) if (m.v[i][j]) ctx.fillRect(i * S, j * S, t, S + t);
    for (let i = 0; i < m.W; i++) for (let j = 0; j <= m.H; j++) if (m.h[i][j]) ctx.fillRect(i * S, j * S, S + t, t);
  }

  // Turret per weapon code: 0 cannon, 1 laser, 2 frag, 3 gatling, 4 homing
  const TURRETS = {
    0: (w, len, c) => { ctx.fillStyle = c.dark; ctx.fillRect(-w * 0.07, -len, w * 0.14, len); },
    1: (w, len, c) => { ctx.fillStyle = c.dark; ctx.fillRect(-w * 0.05, -len, w * 0.1, len); disc(0, -len, w * 0.08, c.base); },
    2: (w, len, c) => {
      ctx.fillStyle = c.dark; ctx.fillRect(-w * 0.13, -len * 0.85, w * 0.26, len * 0.85);
      ctx.fillStyle = '#333'; ctx.fillRect(-w * 0.09, -len * 0.85, w * 0.18, w * 0.06);
    },
    3: (w, len, c, spin) => {
      const off = (performance.now() / 1000 * spin * 6) % 1;
      ctx.fillStyle = c.dark;
      for (let k = -1; k <= 1; k++) ctx.fillRect(k * w * 0.1 - w * 0.035 + Math.sin((k + off) * 2.1) * w * 0.02, -len, w * 0.07, len);
      ctx.fillStyle = '#666'; ctx.fillRect(-w * 0.17, -len * 0.55, w * 0.34, w * 0.08);
    },
    4: (w, len, c) => {
      ctx.fillStyle = c.dark; ctx.fillRect(-w * 0.16, -len * 0.9, w * 0.1, len * 0.9); ctx.fillRect(w * 0.06, -len * 0.9, w * 0.1, len * 0.9);
      ctx.fillStyle = '#d33'; ctx.fillRect(-w * 0.05, -len * 0.8, w * 0.1, w * 0.18);
    },
  };

  function drawTank(S, x, y, rot, color, { me = false, weapon = 0, spin = 0 } = {}) {
    const w = TANK_W * S, l = TANK_L * S, tw = w * 0.24;
    const c = { base: color, dark: shade(color, -0.45) };
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot * Math.PI / 180);
    ctx.fillStyle = shade(color, -0.55);
    ctx.fillRect(-w / 2, -l / 2, tw, l); ctx.fillRect(w / 2 - tw, -l / 2, tw, l);
    ctx.fillStyle = shade(color, -0.3);
    for (let k = 1; k < 6; k++) { const yy = -l / 2 + l * k / 6; ctx.fillRect(-w / 2, yy - 0.4, tw, 0.8); ctx.fillRect(w / 2 - tw, yy - 0.4, tw, 0.8); }
    ctx.fillStyle = color;
    roundRect(-w * 0.32, -l * 0.42, w * 0.64, l * 0.84, w * 0.12); ctx.fill();
    ctx.lineWidth = 0.8;
    (TURRETS[weapon] || TURRETS[0])(w, BULLET_SPAWN * S, c, spin);
    disc(0, 0, w * 0.22, shade(color, 0.25)); ctx.strokeStyle = c.dark; ctx.stroke();
    ctx.restore();
    if (me) { ctx.beginPath(); ctx.arc(x, y, l * 0.85, 0, TAU); ctx.strokeStyle = color + '55'; ctx.lineWidth = 1.2; ctx.stroke(); }
  }

  // Crate icons by weapon code (drawn in a k-sized box).
  const ICONS = {
    1: k => { ctx.moveTo(-k, k); ctx.lineTo(-k * 0.2, -k * 0.2); ctx.lineTo(k * 0.2, k * 0.2); ctx.lineTo(k, -k); ctx.stroke(); },
    2: k => { for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.moveTo(Math.cos(a) * k * 0.3, Math.sin(a) * k * 0.3); ctx.lineTo(Math.cos(a) * k, Math.sin(a) * k); } ctx.stroke(); disc(0, 0, k * 0.3, '#2b2f36'); },
    3: k => { for (let i = -1; i <= 1; i++) ctx.fillRect(i * k * 0.55 - k * 0.12, -k, k * 0.24, k * 2); },
    4: k => { ctx.arc(0, 0, k * 0.85, 0, TAU); ctx.moveTo(k * 0.35, 0); ctx.arc(0, 0, k * 0.35, 0, TAU); ctx.moveTo(-k, 0); ctx.lineTo(k, 0); ctx.moveTo(0, -k); ctx.lineTo(0, k); ctx.stroke(); },
  };
  function drawCrate(S, c, now) {
    if (!crateBorn.has(c.id)) crateBorn.set(c.id, now);
    const grow = Math.min(1, (now - crateBorn.get(c.id)) / 300); // drops in slightly oversized
    const h = CRATE_HALF * S * (1.5 - 0.5 * grow) * Math.min(1, grow * 2);
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(c.rot * Math.PI / 180);
    ctx.fillStyle = '#c8a26a'; ctx.strokeStyle = '#7a5a2e'; ctx.lineWidth = Math.max(0.8, S * 0.02);
    ctx.fillRect(-h, -h, 2 * h, 2 * h); ctx.strokeRect(-h, -h, 2 * h, 2 * h);
    ctx.strokeStyle = ctx.fillStyle = '#2b2f36'; ctx.lineWidth = Math.max(0.8, S * 0.018);
    ctx.beginPath();
    ICONS[c.weapon]?.(h * 0.6);
    ctx.restore();
  }

  function drawProjectile(S, b, colorOf) {
    const br = Math.max(1.6, S * 0.05);
    if (b.kind === 3) { // frag shard: jagged sliver, spins, fades, passes through walls
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, b.life / 20));
      ctx.translate(b.x, b.y); ctx.rotate(((b.id * 47) % 360 + performance.now() * (b.id % 2 ? 0.6 : -0.6)) * Math.PI / 180);
      ctx.fillStyle = '#3a3a3a';
      ctx.beginPath(); ctx.moveTo(-br * 1.4, -br * 0.3); ctx.lineTo(br * 0.2, -br * 0.8); ctx.lineTo(br * 1.3, br * 0.2); ctx.lineTo(-br * 0.3, br * 0.6); ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if (b.kind === 2) { // frag bomb with blinking fuse
      disc(b.x, b.y, br * 1.8, '#222');
      disc(b.x, b.y, br * 0.7, (performance.now() / 150 | 0) % 2 ? '#e33' : '#fa3');
    } else if (b.kind === 4) { // homing missile pointing along its motion
      const a = Math.atan2(b.dy, b.dx), ca = Math.cos(a), sa = Math.sin(a);
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(a);
      ctx.fillStyle = '#444'; ctx.fillRect(-br * 2.2, -br * 0.7, br * 3.4, br * 1.4);
      ctx.fillStyle = '#d33'; ctx.beginPath(); ctx.moveTo(br * 1.2, -br * 0.7); ctx.lineTo(br * 2.4, 0); ctx.lineTo(br * 1.2, br * 0.7); ctx.fill();
      ctx.restore();
      // grey smoke while flying blind; once locked on, ~half the puffs take the hunted tank's colour
      for (let k = 0; k < 2; k++) {
        const tinted = b.target && Math.random() < 0.5;
        fx.smoke(b.x - ca * br * 2.2, b.y - sa * br * 2.2, -ca * 0.5 + rnd(0.5), -sa * 0.5 + rnd(0.5),
          tinted ? colorOf(b.target) : grey(150, 60), br * (tinted ? 1.3 : 1.1), 0.05, tinted ? 0.75 : 0.55);
      }
    } else disc(b.x, b.y, b.kind === 1 ? br * 0.75 : br, '#222'); // cannon ball / gatling round
  }

  function drawLaser(S, L, color) {
    if (L.pts.length < 4) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    polyline(L.pts); ctx.strokeStyle = color + '55'; ctx.lineWidth = Math.max(2, S * 0.12); ctx.stroke();
    polyline(L.pts); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, S * 0.04); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // Laser sight: redrawn each frame in short pieces, each shown ~70% of the time, so it shimmers.
  function drawAimer(maze, tank, all, color) {
    const S = maze.S, pts = traceAimer(maze, tank, all), piece = Math.max(2, S * 0.08);
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / piece));
      for (let k = 0; k < n; k++) {
        if (Math.random() > 0.7) continue;
        const seg = [x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, x0 + (x1 - x0) * (k + 1) / n, y0 + (y1 - y0) * (k + 1) / n];
        polyline(seg); ctx.strokeStyle = color + '40'; ctx.lineWidth = Math.max(2, S * 0.07); ctx.stroke();
        polyline(seg); ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, S * 0.025); ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  function drawScoreboard(v) {
    const y0 = VIEW_H - BOTTOM_BAR;
    ctx.fillStyle = '#e8e3d8'; ctx.fillRect(0, y0, VIEW_W, BOTTOM_BAR);
    const slotW = Math.min(170, VIEW_W / Math.max(1, v.players.length));
    const x0 = (VIEW_W - slotW * v.players.length) / 2;
    v.players.forEach((p, i) => {
      const cx = x0 + slotW * i + slotW / 2;
      drawTank(50, cx - 26, y0 + 40, 0, p.color, { weapon: v.weaponOf(p.id) });
      ctx.fillStyle = '#2a2f38'; ctx.textAlign = 'left';
      ctx.font = '600 13px system-ui, sans-serif'; ctx.fillText((v.mine.has(p.id) ? '▸ ' : '') + (v.flagged?.has(p.id) ? '⚠ ' : '') + p.name, cx - 10, y0 + 32, slotW - 30);
      ctx.font = '700 22px system-ui, sans-serif'; ctx.fillText(String(p.score), cx - 10, y0 + 56);
    });
    ctx.textAlign = 'right'; ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#8a8f99';
    ctx.fillText(`ping ${Math.round(v.rtt)} ms`, VIEW_W - 8, VIEW_H - 8);
  }

  function centerText(text, y, font, color, outline) {
    ctx.textAlign = 'center'; ctx.font = font;
    const max = VIEW_W - 40; // long messages shrink to fit instead of running off the edges
    if (outline) { ctx.lineWidth = 5; ctx.strokeStyle = outline; ctx.strokeText(text, VIEW_W / 2, y, max); }
    ctx.fillStyle = color; ctx.fillText(text, VIEW_W / 2, y, max);
  }

  // v: { maze, poses, bullets, lasers, crates, spinOf, colorOf, weaponOf, players, mine, rtt, frozen, banner, cheat, spectating }
  function draw(v) {
    ctx.setTransform(canvas.width / VIEW_W, 0, 0, canvas.height / VIEW_H, 0, 0);
    ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawScoreboard(v);
    const mazeH = VIEW_H - BOTTOM_BAR;
    if (!v.maze) return centerText('Press "Join" to play. Share the invite link with friends.', mazeH / 2, '18px system-ui', '#555');
    const m = v.maze, S = m.S, now = performance.now();
    ctx.save();
    if (shake > 0.05) { ctx.translate(rnd(shake), rnd(shake)); shake *= 0.9; } else shake = 0;
    ctx.translate(m.ox, m.oy);
    drawMaze(m);
    stepAndDraw(smokes, p => { p.size += p.grow; p.a -= p.fade; return p.a > 0; },
      p => { ctx.globalAlpha = p.a; disc(p.x, p.y, p.size, p.color); });
    const live = new Set(v.crates.map(c => c.id));
    for (const id of crateBorn.keys()) if (!live.has(id)) crateBorn.delete(id);
    for (const c of v.crates) drawCrate(S, c, now);
    for (const p of v.poses) if (p.weapon === 1 && p.aiming) drawAimer(m, p, v.poses, v.colorOf(p.id));
    for (const p of v.poses) drawTank(S, p.x, p.y, p.rot, v.colorOf(p.id), { me: p.me, weapon: p.weapon, spin: v.spinOf(p.id) });
    for (const b of v.bullets) drawProjectile(S, b, v.colorOf);
    for (const L of v.lasers) drawLaser(S, L, v.colorOf(L.owner));
    stepAndDraw(sparks, p => (p.life -= 0.025) > 0,
      p => { ctx.globalAlpha = p.life; ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); });
    ctx.restore();

    if (v.frozen > 0) centerText('Get ready…', mazeH / 2, '700 28px system-ui', '#0007');
    if (v.banner && now < v.banner.until) centerText(v.banner.text, mazeH / 2 - 40, '700 30px system-ui', v.banner.color, '#fff');
    if (v.cheat) {
      ctx.fillStyle = '#000b'; ctx.fillRect(0, mazeH / 2 - 50, VIEW_W, 90);
      centerText('Cheating detected - game stopped', mazeH / 2 - 15, '700 22px system-ui', '#ffcf33');
      centerText(v.cheat, mazeH / 2 + 12, '14px system-ui', '#fff');
    }
    if (v.spectating) centerText('Spectating - press Join to play', mazeH - 12, '600 16px system-ui', '#0009');
  }

  return { draw, fx };
}
