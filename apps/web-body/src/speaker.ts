import {
  estimateWordMs,
  sampleTimeline,
  VISEMES,
  wordTimeline,
  type TimelineEntry,
  type Viseme,
} from "@ms-minutes/character";

type Word = { text: string; start: number; timeline: TimelineEntry[] };
type Scheduled = { index: number; startMs: number; durMs: number };

export type SpeakOptions = {
  rate?: number;
  pitch?: number;
  volume?: number;
  /** Called as each word starts, for subtitles and expression cues. */
  onWord?: (index: number, word: string) => void;
};

/** Voices that sound warm and natural, best first. Falls back to any English voice. */
const PREFERRED_VOICES = [
  "Samantha",
  "Ava",
  "Allison",
  "Google US English",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Karen",
  "Victoria",
  "Microsoft Zira",
];

/** How long to wait for the browser's word timings before estimating them ourselves. */
const BOUNDARY_GRACE_MS = 350;

/**
 * Speaks with the browser's speech synthesis and turns it into mouth shapes.
 * Uses word-boundary events when the voice provides them; otherwise estimates timing.
 */
export class Speaker {
  #words: Word[] = [];
  #schedule: Scheduled[] = [];
  #fired = -1;
  #onWord: SpeakOptions["onWord"];
  #utterance: SpeechSynthesisUtterance | null = null;

  get supported(): boolean {
    return "speechSynthesis" in window;
  }

  voice(): SpeechSynthesisVoice | null {
    if (!this.supported) return null;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    for (const name of PREFERRED_VOICES) {
      const match = voices.find((v) => v.name.includes(name));
      if (match) return match;
    }
    return voices.find((v) => v.lang === "en-US") ?? voices[0] ?? null;
  }

  speak(text: string, options: SpeakOptions = {}): Promise<void> {
    this.stop();
    const rate = options.rate ?? 1;
    this.#words = [...text.matchAll(/[A-Za-z0-9']+/g)].map((m) => ({
      text: m[0],
      start: m.index,
      timeline: wordTimeline(m[0]),
    }));
    this.#schedule = [];
    this.#fired = -1;
    this.#onWord = options.onWord;
    const estimatedMs = this.#estimateAll(0, rate).reduce(
      (end, s) => Math.max(end, s.startMs + s.durMs),
      0,
    );

    if (!this.supported) {
      this.#schedule = this.#estimateAll(performance.now(), rate);
      return new Promise((resolve) => setTimeout(resolve, estimatedMs + 200));
    }

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      // Kept on the instance: Chrome can garbage-collect an utterance mid-speech and never fire onend.
      this.#utterance = u;
      const voice = this.voice();
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = rate;
      u.pitch = options.pitch ?? 1.15;
      u.volume = options.volume ?? 1;

      let sawBoundary = false;
      let estimated = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(graceTimer);
        clearTimeout(safety);
        this.#utterance = null;
        this.#schedule = [];
        resolve();
      };
      // Some engines never report the end; don't hang the UI.
      const safety = setTimeout(finish, estimatedMs / rate + 4000);

      u.onstart = () => {
        const startedAt = performance.now();
        graceTimer = setTimeout(() => {
          if (sawBoundary) return;
          estimated = true;
          this.#schedule = this.#estimateAll(startedAt, rate);
        }, BOUNDARY_GRACE_MS);
      };
      u.onboundary = (e) => {
        if (e.name && e.name !== "word") return;
        const index = this.#wordAt(e.charIndex);
        if (index < 0) return;
        const now = performance.now();
        if (estimated) {
          // Real timings arrived late: keep what already played, follow the engine from here.
          this.#schedule = this.#schedule.filter((s) => s.index < index && s.startMs <= now);
          estimated = false;
        }
        sawBoundary = true;
        this.#schedule.push({
          index,
          startMs: now,
          durMs: estimateWordMs(this.#words[index]!.text, rate),
        });
      };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    });
  }

  stop(): void {
    if (this.supported) speechSynthesis.cancel();
    this.#schedule = [];
    this.#utterance = null;
  }

  /** Mouth shape right now, or null when silent. Also fires word callbacks. */
  sample(nowMs: number): Viseme | null {
    let current: Scheduled | undefined;
    for (const s of this.#schedule) {
      if (s.startMs > nowMs) break;
      current = s;
      if (s.index > this.#fired) {
        this.#fired = s.index;
        this.#onWord?.(s.index, this.#words[s.index]!.text);
      }
    }
    if (!current) return this.#utterance ? VISEMES.rest : null;
    const progress = (nowMs - current.startMs) / current.durMs;
    if (progress >= 1) return VISEMES.rest;
    return sampleTimeline(this.#words[current.index]!.timeline, progress);
  }

  #wordAt(charIndex: number): number {
    let found = -1;
    this.#words.forEach((w, i) => {
      if (w.start <= charIndex) found = i;
    });
    return found;
  }

  /** Timing for every word, with natural pauses at punctuation. */
  #estimateAll(startMs: number, rate: number): Scheduled[] {
    const text = this.#words.length ? this.#textSpan() : "";
    let at = startMs;
    return this.#words.map((w, index) => {
      const durMs = estimateWordMs(w.text, rate);
      const slot = { index, startMs: at, durMs };
      const after = text[w.start + w.text.length] ?? " ";
      at += durMs + (after === "," ? 220 : /[.!?]/.test(after) ? 380 : 40) / rate;
      return slot;
    });
  }

  #textSpan(): string {
    return this.#utterance?.text ?? "";
  }
}
