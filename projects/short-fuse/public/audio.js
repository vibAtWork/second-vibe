// Sound: synthesized effects and an original chiptune loop (no audio files), with Music and
// Sound switches like the original's options. A skin can replace any effect or the music.
// Silent until unlock() runs from a key press or click.
export function createAudio(skin) {
  let ac = null, out = null, skinDone = false;
  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };
  const on = { sfx: pref('sf-sfx', true), music: pref('sf-music', true) };
  const samples = {};

  function tone(f, dur, type = 'square', vol = 0.04, slide = 0, delay = 0, dest = out) {
    const t0 = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f * slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function hiss(dur, vol = 0.2, cutoff = 2000, delay = 0, dest = out) {
    const n = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = cutoff; g.gain.value = vol;
    src.connect(f).connect(g).connect(dest); src.start(ac.currentTime + delay);
  }
  const SFX = {
    lay: () => tone(180, 0.09, 'triangle', 0.06, 0.6),
    boom: () => { hiss(0.6, 0.32, 1100); tone(65, 0.45, 'sawtooth', 0.06, 0.45); },
    crate: () => hiss(0.12, 0.08, 2500),
    hit: () => { tone(330, 0.14, 'square', 0.05, 0.5); tone(220, 0.2, 'square', 0.04, 0.5, 0.08); },
    out: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.12)),
    powerup: () => { tone(660, 0.07, 'square', 0.035); tone(990, 0.09, 'square', 0.035, 1, 0.07); },
    kick: () => tone(140, 0.08, 'square', 0.05, 1.8),
    throw: () => tone(300, 0.18, 'triangle', 0.04, 2.2),
    land: () => tone(120, 0.06, 'triangle', 0.05),
    teleport: () => { tone(400, 0.25, 'sine', 0.04, 3); tone(800, 0.25, 'sine', 0.02, 0.4, 0.05); },
    fire: () => { hiss(0.8, 0.14, 700); tone(90, 0.6, 'sawtooth', 0.03, 1.6); },
    wall: () => tone(90, 0.07, 'square', 0.04, 0.7),
    heat: () => [523, 659, 784].forEach((f, i) => tone(f, 0.13, 'square', 0.04, 1, i * 0.1)),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.045, 1, i * 0.13)),
  };
  let lastBoom = 0;

  // an original loop: A minor, 132 bpm, bass + arpeggio + lead + noise drums, 8 bars
  const music = (() => {
    let bus = null, timer = null, at = 0, step = 0, file = null;
    const s16 = 60 / 132 / 4, hz = m => 440 * 2 ** ((m - 69) / 12);
    const roots = [45, 41, 48, 43, 45, 41, 43, 40];
    const arps = { 45: [57, 60, 64], 41: [53, 57, 60], 48: [55, 60, 64], 43: [55, 59, 62], 40: [52, 56, 59] };
    const lead = [[76, 0, 74, 0, 72, 0, 74, 76, 0, 0, 76, 0, 79, 0, 76, 0], [77, 0, 76, 0, 74, 0, 72, 0, 74, 0, 0, 72, 69, 0, 0, 0],
      [72, 0, 74, 0, 76, 0, 79, 0, 81, 0, 79, 0, 76, 0, 74, 0], [74, 0, 0, 72, 71, 0, 72, 0, 74, 0, 0, 0, 71, 0, 0, 0],
      [76, 0, 74, 0, 72, 0, 74, 76, 0, 0, 76, 0, 81, 0, 79, 0], [77, 0, 79, 0, 81, 0, 77, 0, 76, 0, 74, 0, 72, 0, 0, 0],
      [74, 0, 76, 0, 79, 0, 74, 0, 71, 0, 74, 0, 79, 0, 0, 77], [76, 0, 0, 0, 75, 0, 76, 0, 80, 0, 0, 0, 76, 0, 0, 0]];
    function schedule() {
      while (at < ac.currentTime + 0.25) {
        const bar = Math.floor(step / 16) % 8, s = step % 16, r = roots[bar], d = at - ac.currentTime;
        if (s % 4 === 0) tone(hz(r), s16 * 3.2, 'square', 0.035, 0, d, bus);
        if (s % 4 === 2) tone(hz(r + 12), s16 * 1.5, 'square', 0.022, 0, d, bus);
        tone(hz(arps[r][s % 3] + 12), s16 * 0.9, 'triangle', 0.018, 0, d, bus);
        if (lead[bar][s]) tone(hz(lead[bar][s]), s16 * 1.8, 'square', 0.02, 0, d, bus);
        if (s % 8 === 4) hiss(0.12, 0.06, 2500, d, bus);
        if (s % 2) hiss(0.03, 0.02, 9000, d, bus);
        at += s16; step++;
      }
    }
    return {
      start() {
        if (!ac || timer || file) return;
        if (skin.music) { file = new Audio(skin.music); file.loop = true; file.volume = 0.5; file.play().catch(() => {}); return; }
        bus = ac.createGain(); bus.gain.value = 0.8; bus.connect(out);
        at = ac.currentTime + 0.05; timer = setInterval(schedule, 60); schedule();
      },
      stop() { clearInterval(timer); timer = null; bus?.disconnect(); bus = null; file?.pause(); file = null; },
    };
  })();

  function loadSkinSounds() {
    if (!ac || skinDone || !skin.ready) return;
    skinDone = true;
    for (const [name, url] of Object.entries(skin.sounds || {})) fetch(url).then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b)).then(buf => { samples[name] = buf; }).catch(() => {});
    if (skin.music && on.music) { music.stop(); music.start(); }
  }
  return {
    unlock() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      try { ac = new AudioContext(); out = ac.createGain(); out.connect(ac.destination); } catch { return; }
      loadSkinSounds();
      if (on.music) music.start();
    },
    skinReady: loadSkinSounds,
    play(name) {
      if (!ac || !on.sfx) return;
      if (name === 'boom') { const t = performance.now(); if (t - lastBoom < 40) return; lastBoom = t; }
      if (samples[name]) { const s = ac.createBufferSource(); s.buffer = samples[name]; s.connect(out); s.start(); return; }
      SFX[name]?.();
    },
    get musicOn() { return on.music; }, get sfxOn() { return on.sfx; },
    setMusic(v) { on.music = v; keep('sf-music', v); if (v) music.start(); else music.stop(); },
    setSfx(v) { on.sfx = v; keep('sf-sfx', v); },
  };
}
