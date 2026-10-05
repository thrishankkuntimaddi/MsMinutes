/** Synthesized speech for one piece of text. */
export type Speech = { samples: Float32Array; sampleRate: number };

/** Thin TTS boundary (ADR-0005), so providers can be swapped. */
export interface TTS {
  /** Loads models ahead of the first sentence. */
  warm(): Promise<void>;
  /** Queued work for an aborted signal is skipped, so a barge-in frees the voice at once. */
  synthesize(text: string, signal?: AbortSignal): Promise<Speech>;
}

export type KokoroOptions = {
  /** e.g. af_heart, af_bella, af_nicole. */
  voice: string;
  /** 1 is natural pace. */
  speed?: number;
};

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

type KokoroModel = {
  generate(
    text: string,
    options: { voice: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

/**
 * Kokoro-82M: a small neural voice that runs locally on the CPU, faster than real time.
 * The model (~330 MB) downloads from Hugging Face on first use and is cached after that.
 */
export class KokoroTTS implements TTS {
  readonly #options: KokoroOptions;
  #model: Promise<KokoroModel> | null = null;
  /** One sentence at a time: the model isn't re-entrant, and order matters anyway. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: KokoroOptions) {
    this.#options = options;
  }

  async warm(): Promise<void> {
    await this.#load();
    // The first inference is much slower than the rest; get it out of the way now.
    await this.synthesize("Hello.");
  }

  synthesize(text: string, signal?: AbortSignal): Promise<Speech> {
    const run = this.#queue.then(async () => {
      if (signal?.aborted) throw new DOMException("speech cancelled", "AbortError");
      const model = await this.#load();
      const { voice, speed } = this.#options;
      const out = await model.generate(text, { voice, ...(speed ? { speed } : {}) });
      return { samples: out.audio, sampleRate: out.sampling_rate };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #load(): Promise<KokoroModel> {
    this.#model ??= import("kokoro-js").then(({ KokoroTTS: Kokoro }) =>
      // fp32 is ~2.5× faster than q8 on CPU (dequantising costs more than it saves).
      Kokoro.from_pretrained(KOKORO_MODEL, { dtype: "fp32", device: "cpu" }),
    ) as Promise<KokoroModel>;
    // A failed load (offline, say) can be retried on the next sentence.
    this.#model.catch(() => (this.#model = null));
    return this.#model;
  }
}

/** Float samples → little-endian PCM16, base64-encoded for `speech.audio.chunk`. */
export function toPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

/**
 * Rough word timings for a sentence of the given length, proportional to each word's
 * letters. Kokoro doesn't report timings; this is close enough for captions.
 */
export function estimateWordMarks(
  text: string,
  durationMs: number,
): { t: number; value: string }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => 1.5 + w.replace(/[^a-z0-9]/gi, "").length);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  // Kokoro leaves a little silence at each end.
  const usable = durationMs * 0.92;
  let at = durationMs * 0.03;
  return words.map((value, i) => {
    const mark = { t: Math.round(at), value };
    at += (weights[i]! / total) * usable;
    return mark;
  });
}
