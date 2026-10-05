import type { FastifyBaseLogger } from "fastify";
import type { BrainPayload } from "@ms-minutes/protocol";
import { SentenceChunker } from "./sentences.js";
import { estimateWordMarks, toPcm16Base64, type TTS } from "./tts.js";

type Send = {
  (type: "speech.audio.chunk", payload: BrainPayload<"speech.audio.chunk">): void;
  (type: "speech.marks", payload: BrainPayload<"speech.marks">): void;
};

/** ~4 s of 24 kHz PCM16 per chunk keeps each frame well under the protocol's size limit. */
const MAX_SAMPLES_PER_CHUNK = 96_000;

/**
 * Her voice for one turn: sentences go to TTS as soon as they're complete, and the audio
 * goes out in order, each chunk preceded by word marks for captions.
 */
export class SpeechOut {
  readonly #tts: TTS;
  readonly #turnId: string;
  readonly #send: Send;
  readonly #log: FastifyBaseLogger;
  readonly #chunker = new SentenceChunker();
  #chain: Promise<void> = Promise.resolve();
  #seq = 0;
  #cancelled = false;
  /** ms from the first text to the first audio sent, for the turn trace. */
  firstAudioAt: number | null = null;

  constructor(tts: TTS, turnId: string, send: Send, log: FastifyBaseLogger) {
    this.#tts = tts;
    this.#turnId = turnId;
    this.#send = send;
    this.#log = log;
  }

  push(text: string): void {
    for (const sentence of this.#chunker.push(text)) this.#speak(sentence);
  }

  /** Speaks whatever is left and resolves once all audio has been sent. */
  async finish(): Promise<void> {
    for (const sentence of this.#chunker.flush()) this.#speak(sentence);
    await this.#chain;
  }

  /** Barge-in: drop everything not yet sent. */
  cancel(): void {
    this.#cancelled = true;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  #speak(sentence: string): void {
    if (this.#cancelled) return;
    // Synthesis starts now; sending waits its turn so sentences stay in order.
    const speech = this.#tts.synthesize(sentence);
    speech.catch(() => undefined);
    this.#chain = this.#chain.then(async () => {
      try {
        const { samples, sampleRate } = await speech;
        if (this.#cancelled) return;
        const durationMs = (samples.length / sampleRate) * 1000;
        this.#send("speech.marks", {
          turnId: this.#turnId,
          seq: this.#seq,
          marks: estimateWordMarks(sentence, durationMs).map((m) => ({ ...m, kind: "word" })),
        });
        for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_CHUNK) {
          this.#send("speech.audio.chunk", {
            turnId: this.#turnId,
            seq: this.#seq++,
            codec: "pcm16",
            sampleRate,
            data: toPcm16Base64(samples.subarray(i, i + MAX_SAMPLES_PER_CHUNK)),
          });
        }
        this.firstAudioAt ??= performance.now();
      } catch (err) {
        // One bad sentence shouldn't silence the rest; the text was still sent for captions.
        this.#log.warn({ err, sentence }, "speech synthesis failed");
      }
    });
  }
}
