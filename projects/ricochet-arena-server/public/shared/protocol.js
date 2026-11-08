// Snapshot wire format, defined once. Each entity is sent as a compact array
// whose positions are given by these field lists; encode/decode are derived
// from them, so the sender and receiver can't disagree about indices.
export const FIELDS = {
  tanks: ['id', 'x', 'y', 'rot', 'alive', 'trigger', 'bulletsFired', 'weapon', 'locked', 'aiming'],
  bullets: ['id', 'x', 'y', 'kind', 'life', 'target'],
  lasers: ['id', 'owner', 'pts'],
  crates: ['id', 'x', 'y', 'rot', 'weapon'],
  guns: ['owner', 'spin'],
  players: ['id', 'name', 'color', 'score'],
};

const r2 = v => Math.round(v * 100) / 100;
// Optional per-field rounding applied when encoding (keeps packets small).
const ROUND = { x: r2, y: r2, rot: v => Math.round(v * 1000) / 1000, pts: a => a.map(r2) };

export function encodeList(kind, objects) {
  const f = FIELDS[kind];
  return objects.map(o => f.map(k => {
    const v = o[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : ROUND[k] && v != null ? ROUND[k](v) : v;
  }));
}

export function decodeList(kind, rows = []) {
  const f = FIELDS[kind];
  return rows.map(row => { const o = {}; f.forEach((k, i) => { o[k] = row[i]; }); return o; });
}

// Decode a whole snapshot message into plain objects (with id lookups).
export function decodeSnapshot(s) {
  const out = { tick: s.tick, frozen: s.frozen, end: s.end, ack: s.ack || {}, ev: s.ev || [] };
  // anti-cheat suspicions: [{ id, reasons, votes, needed }]
  out.flags = (s.flags || []).map(([id, reasons, votes, needed]) => ({ id, reasons, votes, needed }));
  for (const kind of Object.keys(FIELDS)) out[kind] = decodeList(kind, s[kind]);
  out.tankById = new Map(out.tanks.map(t => [t.id, t]));
  out.bulletById = new Map(out.bullets.map(b => [b.id, b]));
  out.playerById = new Map(out.players.map(p => [p.id, p]));
  out.spinByOwner = new Map(out.guns.map(g => [g.owner, g.spin]));
  return out;
}
