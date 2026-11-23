// Optional skin: your own images, sound effects and music, loaded from /skin/skin.json on the
// server (the folder in SKIN_DIR, default ./skin next to server.js; not part of this repo).
// Anything the skin leaves out uses Short Fuse's built-in art and sound. Format:
// { "images": { "floor": "floor.png", "wall": "wall.png", "crate": "crate.png", "bomb": "bomb.png",
//     "flameCentre": "...", "flameArm": "...", "flameEnd": "...", "teleporter": "...", "fireTrack": "...",
//     "fireTrackLit": "...", "pickupFlame": "...", "pickupSpeed": "...", "pickupBomb": "...",
//     "pickupKick": "...", "pickupThrow": "...", "player1": "...", "player2": "...", "player3": "...", "player4": "..." },
//   "sounds": { "boom": "boom.mp3", "lay": "...", "pickup": "...", ... any effect name in audio.js },
//   "music": "music.mp3" }
// Images are drawn one cell (30 units) square, centred on the cell; flame arms point up and are rotated.
export async function loadSkin() {
  try {
    const res = await fetch('skin/skin.json', { cache: 'no-cache' });
    if (!res.ok) return { ready: true };
    const def = await res.json(), url = f => 'skin/' + String(f).replace(/^\/+/, '');
    const images = {};
    await Promise.all(Object.entries(def.images || {}).map(([name, file]) => new Promise(done => {
      const im = new Image(); im.onload = () => { images[name] = im; done(); }; im.onerror = done; im.src = url(file);
    })));
    const sounds = Object.fromEntries(Object.entries(def.sounds || {}).map(([k, f]) => [k, url(f)]));
    return { images, sounds, music: def.music ? url(def.music) : null, ready: true };
  } catch { return { ready: true }; }
}
