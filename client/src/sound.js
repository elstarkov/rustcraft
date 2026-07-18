// All game audio is synthesized with the Web Audio API when it plays —
// noise bursts through filters, oscillator chirps, envelope decays. Like
// the textures, there are no asset files.

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.stepFlip = false;
  }

  /// Browsers allow audio only after a user gesture — call from click/key
  /// handlers. Safe to call repeatedly.
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /// Gain node enveloped as: (optional attack ramp ->) peak -> exponential
  /// decay to silence, routed to master through an optional stereo pan.
  env(peak, decay, pan = 0, attack = 0, at = 0) {
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime + at;
    g.gain.setValueAtTime(0.001, this.ctx.currentTime);
    if (attack > 0) {
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
    } else {
      g.gain.setValueAtTime(peak, t);
    }
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  /// Filtered white-noise burst — the percussive core of digs and steps.
  noise(dur, cutoff, peak, pan = 0) {
    if (!this.ready) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    src.connect(f).connect(this.env(peak, dur, pan));
    src.start();
  }

  /// Oscillator sweeping f0 -> f1 over dur seconds.
  tone(type, f0, f1, dur, peak, { pan = 0, delay = 0 } = {}) {
    if (!this.ready) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this.ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    o.connect(this.env(peak, dur, pan, 0, delay));
    o.start(t);
    o.stop(t + dur);
  }

  dig() {
    this.noise(0.12, 650 + Math.random() * 300, 0.55);
  }

  place() {
    this.noise(0.07, 1200, 0.3);
    this.tone('sine', 170, 95, 0.08, 0.3);
  }

  step() {
    this.stepFlip = !this.stepFlip;
    this.noise(0.05, this.stepFlip ? 480 : 610, 0.14);
  }

  /// Item pickup: a happy little up-chirp.
  pop() {
    this.tone('sine', 520, 990, 0.09, 0.35);
  }

  /// Crafting: a wooden double knock.
  knock() {
    this.tone('sine', 175, 115, 0.06, 0.4);
    this.tone('sine', 150, 95, 0.07, 0.35, { delay: 0.09 });
  }

  hurt() {
    this.tone('square', 240, 105, 0.18, 0.22);
  }

  /// Biting an apple: crunch, then a little gulp.
  munch() {
    this.noise(0.07, 1100, 0.32);
    this.tone('square', 160, 90, 0.07, 0.12, { delay: 0.13 });
  }

  /// Landing thump; strength in fall blocks scales the boom.
  thump(strength = 1) {
    this.tone('sine', 105, 42, 0.16, Math.min(0.6, 0.2 + strength * 0.05));
    this.noise(0.07, 320, 0.18);
  }

  /// A swing connected with a mob.
  hit(gain = 1) {
    this.noise(0.06, 950, 0.35 * gain);
    this.tone('sine', 210, 130, 0.09, 0.3 * gain);
  }

  /// Skeleton ambience: dry bone clicks.
  rattle(gain, pan = 0) {
    for (let i = 0; i < 4; i++) {
      this.tone('square', 1900 + Math.random() * 500, 1500, 0.03, 0.12 * gain, {
        pan, delay: i * 0.07,
      });
    }
  }

  /// Spider ambience: a thin hiss.
  hiss(gain, pan = 0) {
    this.noise(0.45, 2600, 0.2 * gain, pan);
  }

  /// Sheep ambience.
  baa(gain, pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(230, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.55);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 9;
    const wobble = this.ctx.createGain();
    wobble.gain.value = 28;
    lfo.connect(wobble).connect(o.frequency);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    o.connect(f).connect(this.env(0.32 * gain, 0.55, pan, 0.06));
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.7);
    lfo.stop(t + 0.7);
  }

  /// Zombie ambience: a wobbling, muffled sawtooth. gain/pan set by the
  /// caller from distance and direction.
  groan(gain, pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 0.7 + Math.random() * 0.4;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70 + Math.random() * 30, t);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 4.5 + Math.random() * 2;
    const wobble = this.ctx.createGain();
    wobble.gain.value = 13;
    lfo.connect(wobble).connect(o.frequency);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 340;
    o.connect(f).connect(this.env(0.5 * gain, dur, pan, 0.15));
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.2);
    lfo.stop(t + dur + 0.2);
  }
}
