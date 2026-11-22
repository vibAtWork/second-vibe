// Synthesized sound effects (no audio files). Silent until unlock() runs from a user gesture.
export function createAudio() {
  let ac = null;
  const unlock = () => { if (!ac) { try { ac = new AudioContext(); } catch { /* no audio */ } } else if (ac.state === 'suspended') ac.resume(); };
  function tone(freq, dur, type = 'square', vol = 0.04, slide = 0) {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), ac.currentTime + dur);
    g.gain.setValueAtTime(vol, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + dur);
  }
  function noise(dur, vol = 0.2, lowpass = 0) {
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buf; g.gain.value = vol;
    let node = src;
    if (lowpass) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; node.connect(f); node = f; }
    node.connect(g).connect(ac.destination); src.start();
  }
  let lastShot = 0;
  const throttled = f => () => { const t = performance.now(); if (t - lastShot > 45) { lastShot = t; f(); } };
  return {
    unlock,
    shot: [throttled(() => { noise(0.08, 0.12, 3000); tone(300, 0.06, 'square', 0.03, 0.5); }), throttled(() => noise(0.05, 0.08, 4000)),
      () => { noise(0.18, 0.2, 2000); tone(120, 0.15, 'sawtooth', 0.04, 0.4); }, null, null, null, null, null, null,
      () => { tone(1800, 0.35, 'sawtooth', 0.05, 0.1); noise(0.2, 0.1, 6000); }],
    boom: () => { noise(0.7, 0.35, 900); tone(70, 0.5, 'sawtooth', 0.07, 0.4); },
    kill: () => tone(160 + Math.random() * 60, 0.12, 'triangle', 0.03, 0.5),
    hurt: () => tone(110, 0.12, 'square', 0.05, 0.6),
    cast: () => tone(520, 0.25, 'sine', 0.03, 2.2),
    place: () => tone(240, 0.08, 'triangle', 0.05),
    throw: () => tone(400, 0.12, 'triangle', 0.03, 0.6),
    rocketfire: () => { noise(0.4, 0.12, 1500); tone(200, 0.3, 'sawtooth', 0.03, 2); },
    pickup: () => { tone(660, 0.07, 'square', 0.03); setTimeout(() => tone(990, 0.09, 'square', 0.03), 70); },
    unlockWeapon: () => [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'square', 0.04), i * 90)),
    wave: () => [196, 185, 175].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'sawtooth', 0.04), i * 220)),
    revive: () => tone(880, 0.2, 'sine', 0.04, 1.5),
  };
}
