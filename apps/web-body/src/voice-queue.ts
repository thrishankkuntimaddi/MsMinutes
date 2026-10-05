import type { Speaker, SpeakOptions } from "./speaker.js";

export type VoiceQueueOptions = Omit<SpeakOptions, "onWord"> & {
  /** A sentence is about to be spoken. */
  onSentence?: (sentence: string) => void;
  onWord?: (index: number, word: string) => void;
  /** Busy changed: true while anything is queued or playing. */
  onBusy?: (busy: boolean) => void;
};

/** Longest stretch spoken without a sentence end before breaking at a comma. */
const MAX_CHUNK = 160;

/**
 * Turns streamed reply text into speech as it arrives (ARCHITECTURE §10.2):
 * whole sentences are spoken while the rest of the reply is still being written.
 */
export class VoiceQueue {
  readonly #speaker: Speaker;
  readonly #options: VoiceQueueOptions;
  #buffer = "";
  #sentences: string[] = [];
  #playing = false;
  #generation = 0;

  constructor(speaker: Speaker, options: VoiceQueueOptions = {}) {
    this.#speaker = speaker;
    this.#options = options;
  }

  get busy(): boolean {
    return this.#playing || this.#sentences.length > 0;
  }

  /** Adds streamed text; any complete sentences start speaking. */
  push(delta: string): void {
    this.#buffer += delta;
    let match: RegExpMatchArray | null;
    while ((match = this.#buffer.match(/^[\s\S]*?[.!?…]+["')\]]*(\s+|$)/)) && match[1]) {
      this.#enqueue(match[0]);
      this.#buffer = this.#buffer.slice(match[0].length);
    }
    if (this.#buffer.length > MAX_CHUNK) {
      const cut = this.#buffer.lastIndexOf(", ", MAX_CHUNK);
      if (cut > 40) {
        this.#enqueue(this.#buffer.slice(0, cut + 1));
        this.#buffer = this.#buffer.slice(cut + 2);
      }
    }
  }

  /** The reply is complete: speak whatever is left. */
  flush(): void {
    this.#enqueue(this.#buffer);
    this.#buffer = "";
  }

  /** Speak one line now, after anything already queued. */
  say(text: string): void {
    this.#enqueue(text);
  }

  cancel(): void {
    this.#generation++;
    this.#buffer = "";
    this.#sentences = [];
    this.#speaker.stop();
    if (this.#playing) {
      this.#playing = false;
      this.#options.onBusy?.(false);
    }
  }

  #enqueue(text: string): void {
    const clean = text
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[A-Za-z0-9]/.test(clean)) return;
    this.#sentences.push(clean);
    if (!this.#playing) void this.#drain();
  }

  async #drain(): Promise<void> {
    const generation = this.#generation;
    this.#playing = true;
    this.#options.onBusy?.(true);
    while (this.#sentences.length && generation === this.#generation) {
      const sentence = this.#sentences.shift()!;
      this.#options.onSentence?.(sentence);
      const { rate, pitch, volume, onWord } = this.#options;
      await this.#speaker.speak(sentence, { rate, pitch, volume, onWord });
    }
    if (generation !== this.#generation) return;
    this.#playing = false;
    this.#options.onBusy?.(false);
  }
}
