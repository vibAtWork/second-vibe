// Sound: synthesized effects and an original chiptune soundtrack (no audio files), with
// Music / Sound switches like the original's options. A skin (see skin.js) can replace any
// effect or the music with your own files. Silent until unlock() runs from a user gesture.
export function createAudio(skin = {}) {
  let ac = null, master = null;
  const state = { sfx: load('sf-sfx', true), music: load('sf-music', true) };
  function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } }
  const buffers = {}; // decoded skin sounds
  let skinLoaded = false;
  function loadSkinSounds() {
    if (!ac || skinLoaded || !skin.ready) return;
    skinLoaded = true;
    for (const [name, url] of Object.entries(skin.sounds || {})) fetch(url).then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b)).then(buf => { buffers[name] = buf; }).catch(() => {});
    if (skin.music && state.music) { music.stop(); music.start(); } // switch to the skin's music
  }
  const unlock = () => {
    if (!ac) {
      try { ac = new AudioContext(); master = ac.createGain(); master.connect(ac.destination); } catch { return; }
      loadSkinSounds();
      if (state.music) music.start();
    } else if (ac.state === 'suspended') ac.resume();
  };
  function tone(freq, dur, type = 'square', vol = 0.04, slide = 0, delay = 0, out = master) {
    if (!ac) return;
    const t0 = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol = 0.2, lowpass = 0, delay = 0, out = master) {
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buf; g.gain.value = vol;
    let node = src;
    if (lowpass) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; node.connect(f); node = f; }
    node.connect(g).connect(out); src.start(ac.currentTime + delay);
  }

  // ---- music: an original loop (A minor, 132 bpm), scheduled a little ahead of time.
  // Bass, an arpeggio, a lead melody and noise percussion; 4 bars, then a variation.
  const music = (() => {
    let bus = null, timer = null, nextAt = 0, step = 0, el = null;
    const BPM = 132, S16 = 60 / BPM / 4;
    const n = m => 440 * 2 ** ((m - 69) / 12);
    // chord roots per bar (MIDI): Am, F, C, G, then Am, F, G, E
    const ROOTS = [45, 41, 48, 43, 45, 41, 43, 40];
    const ARP = { 45: [57, 60, 64], 41: [53, 57, 60], 48: [55, 60, 64], 43: [55, 59, 62], 40: [52, 56, 59] };
    // lead: 16 sixteenths per bar, 0 = rest
    const LEAD = [
      [76, 0, 74, 0, 72, 0, 74, 76, 0, 0, 76, 0, 79, 0, 76, 0],
      [77, 0, 76, 0, 74, 0, 72, 0, 74, 0, 0, 72, 69, 0, 0, 0],
      [72, 0, 74, 0, 76, 0, 79, 0, 81, 0, 79, 0, 76, 0, 74, 0],
      [74, 0, 0, 72, 71, 0, 72, 0, 74, 0, 0, 0, 71, 0, 0, 0],
      [76, 0, 74, 0, 72, 0, 74, 76, 0, 0, 76, 0, 81, 0, 79, 0],
      [77, 0, 79, 0, 81, 0, 77, 0, 76, 0, 74, 0, 72, 0, 0, 0],
      [74, 0, 76, 0, 79, 0, 74, 0, 71, 0, 74, 0, 79, 0, 0, 77],
      [76, 0, 0, 0, 75, 0, 76, 0, 80, 0, 0, 0, 76, 0, 0, 0],
    ];
    function schedule() {
      while (nextAt < ac.currentTime + 0.25) {
        const bar = Math.floor(step / 16) % 8, s = step % 16, root = ROOTS[bar], t = nextAt - ac.currentTime;
        if (s % 4 === 0) tone(n(root), S16 * 3.2, 'square', 0.035, 0, t, bus);           // bass on the beat
        if (s % 4 === 2) tone(n(root + 12), S16 * 1.5, 'square', 0.022, 0, t, bus);      // bass off-beat octave
        tone(n(ARP[root][s % 3] + 12), S16 * 0.9, 'triangle', 0.018, 0, t, bus);          // arpeggio
        const m = LEAD[bar][s]; if (m) tone(n(m), S16 * 1.8, 'square', 0.02, 0, t, bus);  // lead
        if (s % 8 === 4) noise(0.12, 0.06, 2500, t, bus);                                  // snare
        if (s % 2 === 1) noise(0.03, 0.02, 9000, t, bus);                                  // hat
        nextAt += S16; step++;
      }
    }
    return {
      start() {
        if (!ac || timer || el) return;
        if (skin.music) { el = new Audio(skin.music); el.loop = true; el.volume = 0.5; el.play().catch(() => {}); return; }
        bus = ac.createGain(); bus.gain.value = 0.8; bus.connect(master);
        nextAt = ac.currentTime + 0.05; timer = setInterval(schedule, 60); schedule();
      },
      stop() { clearInterval(timer); timer = null; if (bus) { bus.disconnect(); bus = null; } if (el) { el.pause(); el = null; } },
    };
  })();

  const play = (name, synth) => () => {
    if (!state.sfx || !ac) return;
    if (buffers[name]) { const s = ac.createBufferSource(); s.buffer = buffers[name]; s.connect(master); s.start(); return; }
    synth();
  };
  let lastBoom = 0;
  return {
    unlock,
    skinReady() { loadSkinSounds(); }, // call when the skin has loaded
    get sfx() { return state.sfx; }, get musicOn() { return state.music; },
    setSfx(v) { state.sfx = v; save('sf-sfx', v); },
    setMusic(v) { state.music = v; save('sf-music', v); if (v) music.start(); else music.stop(); },
    lay: play('lay', () => tone(180, 0.09, 'triangle', 0.06, 0.6)),
    boom: play('boom', () => { const t = performance.now(); if (t - lastBoom < 40) return; lastBoom = t; noise(0.6, 0.32, 1100); tone(65, 0.45, 'sawtooth', 0.06, 0.45); }),
    crate: play('crate', () => noise(0.12, 0.08, 2500)),
    hit: play('hit', () => { tone(330, 0.14, 'square', 0.05, 0.5); tone(220, 0.2, 'square', 0.04, 0.5, 0.08); }),
    out: play('out', () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.12))),
    pickup: play('pickup', () => { tone(660, 0.07, 'square', 0.035); tone(990, 0.09, 'square', 0.035, 1, 0.07); }),
    kick: play('kick', () => tone(140, 0.08, 'square', 0.05, 1.8)),
    throw: play('throw', () => tone(300, 0.18, 'triangle', 0.04, 2.2)),
    land: play('land', () => tone(120, 0.06, 'triangle', 0.05)),
    teleport: play('teleport', () => { tone(400, 0.25, 'sine', 0.04, 3); tone(800, 0.25, 'sine', 0.02, 0.4, 0.05); }),
    fire: play('fire', () => { noise(0.8, 0.14, 700); tone(90, 0.6, 'sawtooth', 0.03, 1.6); }),
    fill: play('fill', () => tone(90, 0.07, 'square', 0.04, 0.7)),
    heat: play('heat', () => [523, 659, 784].forEach((f, i) => tone(f, 0.13, 'square', 0.04, 1, i * 0.1))),
    win: play('win', () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.045, 1, i * 0.13))),
  };
}
