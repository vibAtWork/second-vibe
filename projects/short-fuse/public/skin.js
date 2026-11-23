// Optional skin: your own images, sound effects and music. Put them with a skin.json in the
// server's SKIN_DIR (default: skin/ next to server.js; it isn't part of this repository).
// Anything the skin leaves out uses Short Fuse's own art and sound.
// {
//   "images": { "floor", "wall", "crate", "bomb", "flameCentre", "flameArm", "flameEnd", "fire", "fireLit",
//               "pad", "powerFlame", "powerSpeed", "powerBomb", "powerKick", "powerGlove",
//               "player1", "player2", "player3", "player4": "file.png" },
//   "sounds": { "lay", "boom", "crate", "hit", "out", "powerup", "kick", "throw", "land", "teleport",
//               "fire", "wall", "heat", "win": "file.mp3" },
//   "music": "file.mp3"
// }
// Images are drawn one cell square, centred on the cell. Flame arms point up and are rotated.
export async function loadSkin() {
  try {
    const def = await (await fetch('skin/skin.json', { cache: 'no-cache' })).json();
    const url = f => 'skin/' + String(f).replace(/^\/+/, ''), images = {};
    await Promise.all(Object.entries(def.images || {}).map(([k, f]) => new Promise(done => { const im = new Image(); im.onload = () => { images[k] = im; done(); }; im.onerror = done; im.src = url(f); })));
    return { images, sounds: Object.fromEntries(Object.entries(def.sounds || {}).map(([k, f]) => [k, url(f)])), music: def.music ? url(def.music) : null, ready: true };
  } catch { return { ready: true }; }
}
