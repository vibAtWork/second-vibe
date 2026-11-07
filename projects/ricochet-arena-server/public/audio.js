// Small synthesized sound effects (no audio files). Silent until unlock() is
// called from a user gesture, as browsers require.
export function createAudio() {
  let ac = null;
  const unlock = () => {
    if (!ac) { try { ac = new AudioContext(); } catch { /* no audio */ } } else if (ac.state === 'suspended') ac.resume();
  };
  function tone(freq, dur, type = 'square', vol = 0.05, slide = 0) {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), ac.currentTime + dur);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  }
  function noise(dur, vol = 0.2) {
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buf; g.gain.value = vol; src.connect(g).connect(ac.destination); src.start();
  }
  const later = (ms, f) => setTimeout(f, ms);
  return {
    unlock,
    fire: () => tone(520, 0.08, 'square', 0.04, 0.5),
    bounce: () => tone(900, 0.03, 'triangle', 0.025),
    boom: () => { noise(0.6, 0.25); tone(90, 0.4, 'sawtooth', 0.06, 0.4); },
    poof: () => tone(300, 0.06, 'sine', 0.02, 0.6),
    laser: () => tone(1800, 0.35, 'sawtooth', 0.04, 0.15),
    frag: () => { noise(0.5, 0.3); tone(140, 0.3, 'square', 0.05, 0.3); },
    spin: () => tone(120, 0.4, 'sawtooth', 0.025, 3),
    gshot: () => tone(700, 0.04, 'square', 0.03, 0.4),
    missile: () => { noise(0.3, 0.08); tone(260, 0.3, 'triangle', 0.04, 2); },
    lock: () => { tone(1200, 0.06, 'sine', 0.03); later(80, () => tone(1500, 0.06, 'sine', 0.03)); },
    crate: () => tone(200, 0.12, 'triangle', 0.05, 0.6),
    shard: () => tone(2400 + Math.random() * 800, 0.025, 'square', 0.012, 0.5),
    pickup: () => { tone(660, 0.07, 'square', 0.03); later(70, () => tone(990, 0.09, 'square', 0.03)); },
  };
}
