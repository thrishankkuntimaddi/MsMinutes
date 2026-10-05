/** Speech-to-text boundary (ADR-0005), so providers can be swapped. */
export interface STT {
  /** Loads models ahead of the first utterance. */
  warm(): Promise<void>;
  /** 16 kHz mono samples in, text out. */
  transcribe(samples: Float32Array): Promise<string>;
}

type Recognizer = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>;

/**
 * Local speech recognition with transformers.js. The default, Moonshine, is built for
 * short live utterances: ~0.1 s for a sentence on a laptop CPU, where Whisper spends
 * ~0.8 s padding everything to 30 s. Any transformers.js ASR model id works.
 */
export class LocalSTT implements STT {
  readonly #model: string;
  #recognizer: Promise<Recognizer> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(model: string) {
    this.#model = model;
  }

  async warm(): Promise<void> {
    const recognize = await this.#load();
    // The first inference is slower than the rest; get it out of the way now.
    await recognize(new Float32Array(16_000));
  }

  transcribe(samples: Float32Array): Promise<string> {
    const run = this.#queue.then(async () => {
      const recognize = await this.#load();
      const out = await recognize(samples);
      return (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #load(): Promise<Recognizer> {
    this.#recognizer ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("automatic-speech-recognition", this.#model, {
          dtype: "fp32",
          device: "cpu",
        }) as unknown as Promise<Recognizer>,
    );
    this.#recognizer.catch(() => (this.#recognizer = null));
    return this.#recognizer;
  }
}

/** Linear resampling to 16 kHz, enough for speech recognition. */
export function to16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16_000) return samples;
  const ratio = sampleRate / 16_000;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
  }
  return out;
}

/**
 * True when what was heard is mostly her own recent words: her voice leaking from the
 * speaker back into the mic. Answering it would have her talk to herself.
 */
export function isEcho(heard: string, recentSpeech: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const said = new Set(words(recentSpeech));
  const h = words(heard);
  if (h.length < 2 || said.size === 0) return false;
  return h.filter((w) => said.has(w)).length / h.length >= 0.7;
}
