import type { Viseme } from "@ms-minutes/character";

export type Mark = { t: number; value: string };

export type AudioVoiceOptions = {
  /** A new stretch of speech starts; these are its words. */
  onSentence?: (words: string[]) => void;
  /** Word `index` of the current stretch is being spoken. */
  onWord?: (index: number) => void;
  onBusy?: (busy: boolean) => void;
};

/** Seconds of lead so back-to-back chunks never gap. */
const LEAD = 0.05;

/**
 * Plays her synthesized voice (PCM16 chunks from the brain, or a file) gap-free, and
 * drives her mouth from the sound itself (ARCHITECTURE §10.2: amplitude mouth sync).
 */
export class AudioVoice {
  readonly #ctx: AudioContext;
  readonly #out: AudioNode;
  readonly #analyser: AnalyserNode;
  readonly #samples: Float32Array<ArrayBuffer>;
  readonly #options: AudioVoiceOptions;
  #sources = new Set<AudioBufferSourceNode>();
  #endAt = 0;
  #marks = new Map<number, Mark[]>();
  #cues: { at: number; run: () => void }[] = [];
  #busy = false;
  #level = 0;

  constructor(ctx: AudioContext, destination: AudioNode, options: AudioVoiceOptions = {}) {
    this.#ctx = ctx;
    this.#options = options;
    this.#analyser = ctx.createAnalyser();
    this.#analyser.fftSize = 1024;
    this.#samples = new Float32Array(this.#analyser.fftSize);
    // Her tone: smooth, rounded and polished. A little lower-mid body so she never sounds
    // thin, clear articulation without edge, a softened top, and light compression so
    // she stays even and composed. Nothing robotic.
    const filter = (type: BiquadFilterType, frequency: number, gain = 0, q = 0.8) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.gain.value = gain;
      f.Q.value = q;
      return f;
    };
    const rumble = filter("highpass", 85, 0, 0.7);
    const body = filter("lowshelf", 240, 2.5);
    const boxy = filter("peaking", 520, -1.5, 1.1);
    const clarity = filter("peaking", 3200, 1.5, 0.9);
    const round = filter("highshelf", 7800, -3);
    const even = ctx.createDynamicsCompressor();
    even.threshold.value = -22;
    even.knee.value = 14;
    even.ratio.value = 2.5;
    even.attack.value = 0.008;
    even.release.value = 0.2;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.25;
    rumble.connect(body).connect(boxy).connect(clarity).connect(round).connect(even);
    even.connect(makeup).connect(this.#analyser).connect(destination);
    this.#out = rumble;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Word timings for the chunk with this `seq`; they arrive just before it. */
  marks(seq: number, marks: Mark[]): void {
    this.#marks.set(seq, marks);
  }

  /** Queues a base64 PCM16 chunk right after whatever is already playing. */
  pcm16(seq: number, sampleRate: number, base64: string): void {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    const buffer = this.#ctx.createBuffer(1, pcm.length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 0x8000;
    this.#play(buffer, this.#marks.get(seq));
    this.#marks.delete(seq);
  }

  /** Plays a recorded file (the greeting), with optional word marks. */
  async file(url: string, words?: string[]): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`couldn't load ${url} (${res.status})`);
    const buffer = await this.#ctx.decodeAudioData(await res.arrayBuffer());
    this.#play(buffer, words ? spread(words, buffer.duration * 1000) : undefined);
    await new Promise<void>((resolve) => {
      const check = () => (this.#busy ? setTimeout(check, 50) : resolve());
      setTimeout(check, 100);
    });
  }

  cancel(): void {
    for (const s of this.#sources) s.stop();
    this.#sources.clear();
    this.#cues = [];
    this.#marks.clear();
    this.#endAt = 0;
    this.#setBusy(false);
  }

  /** Mouth shape right now from how loud and how bright her voice is; null when silent. */
  sample(): Viseme | null {
    const now = this.#ctx.currentTime;
    while (this.#cues.length && this.#cues[0]!.at <= now) this.#cues.shift()!.run();
    if (this.#busy && now > this.#endAt + 0.1) this.#setBusy(false);
    if (!this.#busy) return null;

    this.#analyser.getFloatTimeDomainData(this.#samples);
    let sum = 0;
    let crossings = 0;
    for (let i = 0; i < this.#samples.length; i++) {
      const v = this.#samples[i]!;
      sum += v * v;
      if (i && Math.sign(v) !== Math.sign(this.#samples[i - 1]!)) crossings++;
    }
    const rms = Math.sqrt(sum / this.#samples.length);
    // Fast attack, slower release, like a real jaw.
    const target = Math.min(1, Math.max(0, (rms - 0.012) * 7));
    this.#level += (target - this.#level) * (target > this.#level ? 0.6 : 0.25);
    // Hissy sounds (s, f, t) cross zero often: flatter, wider mouth. Dark vowels: rounder.
    const bright = Math.min(1, crossings / (this.#samples.length * 0.18));
    return {
      open: this.#level * 0.9,
      round: Math.max(0, 0.45 - bright) * this.#level * 1.4,
      width: 0.9 + bright * 0.25,
    };
  }

  #play(buffer: AudioBuffer, marks?: Mark[]): void {
    const now = this.#ctx.currentTime;
    const at = Math.max(now + LEAD, this.#endAt);
    const src = this.#ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.#out);
    src.onended = () => this.#sources.delete(src);
    src.start(at);
    this.#sources.add(src);
    this.#endAt = at + buffer.duration;
    this.#setBusy(true);

    if (marks?.length) {
      const words = marks.map((m) => m.value);
      this.#cues.push({ at, run: () => this.#options.onSentence?.(words) });
      marks.forEach((m, i) =>
        this.#cues.push({ at: at + m.t / 1000, run: () => this.#options.onWord?.(i) }),
      );
      this.#cues.sort((a, b) => a.at - b.at);
    }
  }

  #setBusy(busy: boolean): void {
    if (busy === this.#busy) return;
    this.#busy = busy;
    this.#options.onBusy?.(busy);
  }
}

/** Even-ish word timings for a recording that has none. */
function spread(words: string[], durationMs: number): Mark[] {
  const weights = words.map((w) => 1.5 + w.replace(/[^a-z0-9]/gi, "").length);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = durationMs * 0.04;
  return words.map((value, i) => {
    const mark = { t: at, value };
    at += (weights[i]! / total) * durationMs * 0.9;
    return mark;
  });
}
