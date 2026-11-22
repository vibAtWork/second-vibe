// Drawing and visual effects (original art, all drawn with canvas shapes).
import { TILE, MAP_W, MAP_H, WORLD_W, WORLD_H, VIEW_W, VIEW_H, HUD_H, WEAPONS, PLAYER_HP } from './shared/sim.js';

const TAU = Math.PI * 2;
const rnd = (a = 1) => (Math.random() - 0.5) * a;

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const effects = [];   // short-lived: tracers, flashes, sparks, rings
  const decals = [];    // long-lived floor marks: goo and scorch
  const texts = [];     // floating texts
  let shake = 0, floor = null, floorSeed = null;

  const fx = {
    tracer(x1, y1, x2, y2, rail) { effects.push({ k: 'tracer', x1, y1, x2, y2, rail, life: rail ? 14 : 5, max: rail ? 14 : 5 }); },
    flash(x, y) { effects.push({ k: 'flash', x, y, life: 3, max: 3 }); },
    boom(x, y, r) {
      shake = Math.min(10, shake + r / 14);
      effects.push({ k: 'ring', x, y, r, life: 18, max: 18 });
      for (let i = 0; i < 26; i++) { const a = Math.random() * TAU, v = Math.random() * r / 9; effects.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 20 + Math.random() * 15, max: 35, c: Math.random() < 0.5 ? '#ffb347' : '#ff6a3d' }); }
      decals.push({ k: 'scorch', x, y, r: r * 0.55, a: 0.55 });
    },
    goo(x, y, hexer) {
      decals.push({ k: 'goo', x: x + rnd(6), y: y + rnd(6), r: 8 + Math.random() * 8, c: hexer ? '#6a2c8a' : '#4f6b2a', a: 0.7 });
      for (let i = 0; i < 8; i++) { const a = Math.random() * TAU, v = 1 + Math.random() * 2; effects.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 14, max: 14, c: hexer ? '#9b4dca' : '#7a9a3a' }); }
      if (decals.length > 260) decals.shift();
    },
    text(x, y, s, c = '#fff') { texts.push({ x, y, s, c, life: 60 }); },
    shake(n) { shake = Math.min(10, shake + n); },
  };

  // Floor: dark soil with a faint grid, rendered once per map.
  function buildFloor(map) {
    const c = document.createElement('canvas');
    c.width = WORLD_W; c.height = WORLD_H;
    const g = c.getContext('2d');
    g.fillStyle = '#23262b'; g.fillRect(0, 0, WORLD_W, WORLD_H);
    let s = map.seed >>> 0;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(255,255,255,${0.015 + r() * 0.03})`; g.fillRect(r() * WORLD_W, r() * WORLD_H, 2, 2); }
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    for (let x = 0; x <= MAP_W; x++) { g.beginPath(); g.moveTo(x * TILE, 0); g.lineTo(x * TILE, WORLD_H); g.stroke(); }
    for (let y = 0; y <= MAP_H; y++) { g.beginPath(); g.moveTo(0, y * TILE); g.lineTo(WORLD_W, y * TILE); g.stroke(); }
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
      if (!map.tiles[y][x]) continue;
      const px = x * TILE, py = y * TILE, edge = x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
      if (edge) { // iron fence
        g.fillStyle = '#15171a'; g.fillRect(px, py, TILE, TILE);
        g.fillStyle = '#3a3f47'; for (let k = 4; k < TILE; k += 7) g.fillRect(px + k, py + 3, 2, TILE - 6);
        g.fillRect(px, py + 8, TILE, 2); g.fillRect(px, py + TILE - 10, TILE, 2);
      } else { // gravestone block
        g.fillStyle = '#4b5059'; g.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
        g.fillStyle = '#5c626c'; g.fillRect(px + 2, py + 2, TILE - 4, 6);
        g.fillStyle = '#353940'; g.fillRect(px + 12, py + 12, 8, 2); g.fillRect(px + 15, py + 9, 2, 10);
      }
    }
    for (const [sx, sy] of map.spawns) { g.fillStyle = 'rgba(120,200,90,0.10)'; g.beginPath(); g.arc(sx, sy, 24, 0, TAU); g.fill(); }
    return c;
  }

  const disc = (x, y, r, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };

  // Survivor seen from above: shoulders + jacket in the player's colour, head, gun.
  function drawPlayer(p, me) {
    const a = Math.atan2(p.fy, p.fx);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a);
    if (!p.alive) ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#111'; ctx.fillRect(8, -2, 12, 4);                 // gun
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.ellipse(0, 0, 9, 12, 0, 0, TAU); ctx.fill(); // shoulders
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(-3, 0, 4, 9, 0, 0, TAU); ctx.fill(); // backpack
    disc(1, 0, 6, '#e8c9a0');                                              // head
    ctx.fillStyle = '#3b2a1e'; ctx.beginPath(); ctx.arc(0, 0, 6, Math.PI * 0.55, Math.PI * 1.45); ctx.fill(); // hair
    ctx.restore();
    ctx.globalAlpha = 1;
    if (me) { ctx.strokeStyle = p.color + '88'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, TAU); ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - 20);
    if (!p.alive && p.revive > 0) {
      ctx.strokeStyle = '#7dff9a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 16, -Math.PI / 2, -Math.PI / 2 + TAU * p.revive / 60); ctx.stroke();
    }
  }

  // Shambler: hunched grey-green ghoul reaching forward. Hexer: purple hooded caster with a glowing orb.
  function drawEnemy(e, t) {
    const a = Math.atan2(e.dy, e.dx), wob = Math.sin(t / 120 + e.id) * 2;
    ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(a);
    if (e.hexer) {
      ctx.fillStyle = '#4a2266'; ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-10, 10); ctx.lineTo(-6, 0); ctx.lineTo(-10, -10); ctx.closePath(); ctx.fill();
      disc(0, 0, 7, '#5e2d82');
      disc(10, 4 + wob * 0.5, 3.5, '#d27bff'); disc(10, 4 + wob * 0.5, 6, 'rgba(210,123,255,0.25)');
      disc(3, -2, 1.3, '#ffdd55'); disc(3, 2, 1.3, '#ffdd55');
    } else {
      ctx.fillStyle = '#5d6b4b'; ctx.fillRect(4, -9 + wob * 0.3, 11, 3); ctx.fillRect(4, 6 - wob * 0.3, 11, 3); // arms
      ctx.fillStyle = '#6f7d58'; ctx.beginPath(); ctx.ellipse(-1, 0, 8, 10, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4c5a3a'; ctx.beginPath(); ctx.ellipse(-3, 0, 3, 7, 0, 0, TAU); ctx.fill();
      disc(3, 0, 5.5, '#8fa070');
      disc(6, -2, 1.2, '#d6262b'); disc(6, 2, 1.2, '#d6262b');
    }
    ctx.restore();
    if (e.hp < 100) { ctx.fillStyle = '#000a'; ctx.fillRect(e.x - 10, e.y - 17, 20, 3); ctx.fillStyle = e.hexer ? '#c070ff' : '#9ccc65'; ctx.fillRect(e.x - 10, e.y - 17, 20 * e.hp / 100, 3); }
  }

  function drawObject(o, t) {
    const { x, y } = o;
    if (o.kind === 'barrel') {
      disc(x, y, 13, '#8b1e1e'); disc(x, y, 10, '#b02a2a');
      ctx.strokeStyle = '#5e1414'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#ffd54f'; ctx.font = '700 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('!', x, y + 3);
    } else if (o.kind === 'barricade') {
      ctx.fillStyle = '#7a5532'; ctx.fillRect(x - 15, y - 15, 30, 30);
      ctx.fillStyle = '#93693f'; for (let k = -12; k <= 8; k += 10) ctx.fillRect(x - 15, y + k, 30, 6);
      ctx.strokeStyle = '#4e3520'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 13, y - 13); ctx.lineTo(x + 13, y + 13); ctx.stroke();
      if (o.hp < 160) { ctx.fillStyle = '#000a'; ctx.fillRect(x - 14, y - 19, 28, 3); ctx.fillStyle = '#d4a24c'; ctx.fillRect(x - 14, y - 19, 28 * o.hp / 160, 3); }
    } else if (o.kind === 'mine') {
      disc(x, y, 7, '#2f3a2f'); disc(x, y, 2.5, (t / 300 | 0) % 2 ? '#ff3b3b' : '#5a1010');
    } else if (o.kind === 'charge') {
      ctx.fillStyle = '#c9b458'; ctx.fillRect(x - 8, y - 5, 16, 10);
      ctx.fillStyle = '#333'; ctx.fillRect(x - 6, y - 3, 12, 6);
      disc(x + 5, y - 6, 2, (t / 200 | 0) % 2 ? '#3bff6a' : '#145a26');
    }
  }

  function drawShot(s) {
    if (s.kind === 'fireball') { disc(s.x, s.y, 8, 'rgba(200,90,255,0.3)'); disc(s.x, s.y, 4.5, '#e2a6ff'); }
    else if (s.kind === 'rocket') { disc(s.x, s.y, 4, '#ddd'); disc(s.x - s.dx * 1.5, s.y - s.dy * 1.5, 3, '#ff9a3c'); effects.push({ k: 'spark', x: s.x, y: s.y, vx: rnd(0.6), vy: rnd(0.6), life: 16, max: 16, c: '#777' }); }
    else { disc(s.x, s.y, 5, '#3d4a2f'); disc(s.x + 1, s.y - 1, 1.5, '#9c9'); }
  }

  function drawPickup(k, t) {
    const bob = Math.sin(t / 200 + k.id) * 2;
    ctx.save(); ctx.translate(k.x, k.y + bob);
    if (k.kind === 'health') { ctx.fillStyle = '#eee'; ctx.fillRect(-8, -8, 16, 16); ctx.fillStyle = '#e53935'; ctx.fillRect(-2, -6, 4, 12); ctx.fillRect(-6, -2, 12, 4); }
    else { ctx.fillStyle = '#556b2f'; ctx.fillRect(-9, -6, 18, 12); ctx.fillStyle = '#ffd54f'; ctx.fillRect(-6, -3, 3, 6); ctx.fillRect(-1, -3, 3, 6); ctx.fillRect(4, -3, 3, 6); }
    ctx.restore();
  }

  function drawHud(v) {
    const y0 = WORLD_H;
    ctx.fillStyle = '#121418'; ctx.fillRect(0, y0, VIEW_W, HUD_H);
    const slot = Math.min(240, VIEW_W / Math.max(1, v.players.length));
    v.players.forEach((p, i) => {
      const x = 12 + i * slot, w = WEAPONS[p.weapon], ammo = p.ammo[p.weapon];
      ctx.textAlign = 'left';
      ctx.fillStyle = p.color; ctx.font = '700 13px system-ui'; ctx.fillText((v.mine.has(p.id) ? '▸ ' : '') + p.name, x, y0 + 17, slot - 70);
      ctx.fillStyle = '#333'; ctx.fillRect(x, y0 + 24, 120, 8);
      ctx.fillStyle = p.hp > 35 ? '#66bb6a' : '#ef5350'; ctx.fillRect(x, y0 + 24, 120 * p.hp / PLAYER_HP, 8);
      ctx.fillStyle = '#ddd'; ctx.font = '12px system-ui';
      ctx.fillText(`${w.key} ${w.name}${ammo >= 0 ? ` · ${ammo}` : ''}`, x, y0 + 48);
      ctx.textAlign = 'right'; ctx.font = '700 15px system-ui'; ctx.fillStyle = '#fff';
      ctx.fillText(String(p.score), x + slot - 22, y0 + 20);
      if (p.mult > 1) { ctx.fillStyle = '#ffca28'; ctx.font = '700 13px system-ui'; ctx.fillText(`x${p.mult}`, x + slot - 22, y0 + 38); }
    });
    ctx.textAlign = 'right'; ctx.fillStyle = '#9aa'; ctx.font = '11px system-ui';
    ctx.fillText(`wave ${v.wave} · ${v.left} left · ping ${Math.round(v.rtt)} ms`, VIEW_W - 8, VIEW_H - 8);
  }

  function centre(text, y, font, color) {
    ctx.textAlign = 'center'; ctx.font = font; ctx.lineWidth = 5; ctx.strokeStyle = '#000a';
    ctx.strokeText(text, WORLD_W / 2, y, WORLD_W - 40); ctx.fillStyle = color; ctx.fillText(text, WORLD_W / 2, y, WORLD_W - 40);
  }

  // v: { map, players, enemies, shots, objects, pickups, mine, wave, left, phase, timer, banner, rtt, spectating }
  function draw(v) {
    const t = performance.now();
    ctx.setTransform(canvas.width / VIEW_W, 0, 0, canvas.height / VIEW_H, 0, 0);
    ctx.fillStyle = '#0d0f12'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (!v.map) { centre('Connecting…', WORLD_H / 2, '20px system-ui', '#aaa'); return; }
    if (floorSeed !== v.map.seed) { floor = buildFloor(v.map); floorSeed = v.map.seed; decals.length = 0; }
    ctx.save();
    if (shake > 0.1) { ctx.translate(rnd(shake), rnd(shake)); shake *= 0.88; } else shake = 0;
    ctx.drawImage(floor, 0, 0);
    for (const d of decals) {
      ctx.globalAlpha = d.a; ctx.fillStyle = d.k === 'goo' ? d.c : '#000';
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill();
      d.a = Math.max(0.12, d.a - 0.0004);
    }
    ctx.globalAlpha = 1;
    for (const k of v.pickups) drawPickup(k, t);
    for (const o of v.objects) drawObject(o, t);
    for (const e of v.enemies) drawEnemy(e, t);
    for (const p of v.players) drawPlayer(p, v.mine.has(p.id));
    for (const s of v.shots) drawShot(s);
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (--e.life <= 0) { effects.splice(i, 1); continue; }
      const a = e.life / e.max;
      if (e.k === 'tracer') { ctx.strokeStyle = e.rail ? `rgba(120,220,255,${a})` : `rgba(255,236,150,${a})`; ctx.lineWidth = e.rail ? 4 * a + 1 : 1.5; ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke(); }
      else if (e.k === 'flash') disc(e.x, e.y, 7 * a + 3, `rgba(255,220,120,${a})`);
      else if (e.k === 'ring') { ctx.strokeStyle = `rgba(255,170,60,${a})`; ctx.lineWidth = 6 * a; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 - a * 0.6), 0, TAU); ctx.stroke(); disc(e.x, e.y, e.r * 0.5 * a, `rgba(255,220,140,${a * 0.6})`); }
      else if (e.k === 'spark') { e.x += e.vx; e.y += e.vy; e.vx *= 0.92; e.vy *= 0.92; ctx.globalAlpha = a; ctx.fillStyle = e.c; ctx.fillRect(e.x - 1.5, e.y - 1.5, 3, 3); ctx.globalAlpha = 1; }
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const s = texts[i];
      if (--s.life <= 0) { texts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, s.life / 20); ctx.fillStyle = s.c; ctx.font = '700 12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(s.s, s.x, s.y - (60 - s.life) * 0.4); ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (v.phase === 'break' && v.timer > 0) centre(v.wave === 0 ? 'Get ready…' : `Wave ${v.wave} cleared - next wave in ${Math.ceil(v.timer / 30)}`, WORLD_H / 2 - 60, '700 26px system-ui', '#cfe8ff');
    if (v.phase === 'over') centre(`Overrun on wave ${v.wave} - restarting…`, WORLD_H / 2 - 60, '700 28px system-ui', '#ff8a80');
    if (v.banner && t < v.banner.until) centre(v.banner.text, 90, '700 24px system-ui', v.banner.color);
    if (v.spectating) centre('Press Join to play', WORLD_H - 24, '600 16px system-ui', '#ddd');
    drawHud(v);
  }

  return { draw, fx };
}
