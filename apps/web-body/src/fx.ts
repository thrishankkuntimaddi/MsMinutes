/**
 * Synthesized room sound: the TV's power-on thump and whine, static, her alarm
 * bells and a little hop. Nothing is loaded from disk; everything is made here.
 */
export class Fx {
  #ctx: AudioContext | null = null;
  #out: GainNode | null = null;
  #noise: AudioBuffer | null = null;

  /** The audio graph, once `init` has run: other sounds (her voice) join the same output. */
  get audio(): { ctx: AudioContext; out: AudioNode } | null {
    return this.#ctx && this.#ctx.destination
      ? { ctx: this.#ctx, out: this.#ctx.destination }
      : null;
  }

  /** Must run inside a user gesture, or the browser keeps audio muted. */
  async init(): Promise<void> {
    if (this.#ctx) return;
    const ctx = new AudioContext();
    await ctx.resume();
    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(ctx.destination);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.#ctx = ctx;
    this.#out = out;
    this.#noise = noise;
    this.#hum();
  }

  /** Relay click, a low thump as the tube charges, and the 15 kHz whine. */
  powerOn(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.#burst(t, 0.03, 3000, 0.5);

    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.frequency.setValueAtTime(90, t + 0.05);
    thump.frequency.exponentialRampToValueAtTime(38, t + 0.5);
    thumpGain.gain.setValueAtTime(0.0001, t + 0.05);
    thumpGain.gain.exponentialRampToValueAtTime(0.9, t + 0.08);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    thump.connect(thumpGain).connect(this.#out!);
    thump.start(t + 0.05);
    thump.stop(t + 0.75);

    const whine = ctx.createOscillator();
    const whineGain = ctx.createGain();
    whine.frequency.setValueAtTime(9000, t + 0.1);
    whine.frequency.exponentialRampToValueAtTime(15600, t + 0.9);
    whineGain.gain.setValueAtTime(0.0001, t + 0.1);
    whineGain.gain.exponentialRampToValueAtTime(0.012, t + 0.6);
    whineGain.gain.exponentialRampToValueAtTime(0.004, t + 2.5);
    whine.connect(whineGain).connect(this.#out!);
    whine.start(t + 0.1);
    whine.stop(t + 2.6);
  }

  /** Tuning-between-channels hiss. */
  static(seconds: number): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#burst(ctx.currentTime, seconds, 4200, 0.22, 0.8);
  }

  /** Two brass bells struck fast by the hammer. Inharmonic partials make it metal. */
  bell(seconds = 0.9): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const start = ctx.currentTime;
    const strikes = Math.floor(seconds / 0.055);
    for (let i = 0; i < strikes; i++) {
      const t = start + i * 0.055;
      const base = i % 2 ? 1870 : 2090;
      for (const [ratio, level] of [
        [1, 0.05],
        [2.76, 0.025],
        [5.4, 0.012],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = base * ratio;
        gain.gain.setValueAtTime(level, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35 / ratio);
        osc.connect(gain).connect(this.#out!);
        osc.start(t);
        osc.stop(t + 0.4);
      }
    }
  }

  /** A soft cartoon boing for a hop. */
  hop(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(260, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(340, t + 0.28);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(this.#out!);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  /** Mains hum and room tone under everything, barely audible. */
  #hum(): void {
    const ctx = this.#ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.012;
    gain.connect(this.#out!);
    for (const [freq, level] of [
      [60, 1],
      [120, 0.5],
      [180, 0.2],
    ] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = freq;
      g.gain.value = level;
      osc.connect(g).connect(gain);
      osc.start();
    }
  }

  #burst(t: number, seconds: number, freq: number, level: number, q = 0.6): void {
    const ctx = this.#ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.setValueAtTime(level, t + seconds * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(filter).connect(gain).connect(this.#out!);
    src.start(t);
    src.stop(t + seconds + 0.05);
  }
}
