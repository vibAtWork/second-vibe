// Synthesized sound effects (no audio files). Silent until unlock() runs from a user gesture.
export function createAudio() {
  let ac = null;
  const unlock = () => { if (!ac) { try { ac = new AudioContext(); } catch { /* no audio */ } } else if (ac.state === 'suspended') ac.resume(); };
  function tone(freq, dur, type = 'square', vol = 0.04, slide = 0, delay = 0) {
    if (!ac) return;
    const t0 = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur);
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
  let lastBoom = 0;
  return {
    unlock,
    lay: () => tone(180, 0.09, 'triangle', 0.06, 0.6),
    boom: () => { const t = performance.now(); if (t - lastBoom < 40) return; lastBoom = t; noise(0.6, 0.32, 1100); tone(65, 0.45, 'sawtooth', 0.06, 0.45); },
    crate: () => noise(0.12, 0.08, 2500),
    hit: () => { tone(330, 0.14, 'square', 0.05, 0.5); tone(220, 0.2, 'square', 0.04, 0.5, 0.08); },
    out: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.12)),
    pickup: () => { tone(660, 0.07, 'square', 0.035); tone(990, 0.09, 'square', 0.035, 1, 0.07); },
    kick: () => tone(140, 0.08, 'square', 0.05, 1.8),
    throw: () => tone(300, 0.18, 'triangle', 0.04, 2.2),
    land: () => tone(120, 0.06, 'triangle', 0.05),
    teleport: () => { tone(400, 0.25, 'sine', 0.04, 3); tone(800, 0.25, 'sine', 0.02, 0.4, 0.05); },
    fire: () => { noise(0.8, 0.14, 700); tone(90, 0.6, 'sawtooth', 0.03, 1.6); },
    fill: () => tone(90, 0.07, 'square', 0.04, 0.7),
    heat: () => [523, 659, 784].forEach((f, i) => tone(f, 0.13, 'square', 0.04, 1, i * 0.1)),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.045, 1, i * 0.13)),
  };
}
