/**
 * Her delivery: how a sentence is performed rather than read. A sentence becomes phrases,
 * each spoken with its own pace and weight, with pauses she chooses between them:
 *
 * - short breaths at commas, longer ones at dashes and ellipses, longest before what matters;
 * - important phrases (numbers, times, warnings, conclusions) slower and a little fuller;
 * - casual asides lighter and quicker;
 * - every pause a little different, so they never sound measured out by a machine.
 *
 * Planning is pure; `perform` stitches the synthesized phrases together.
 */

export type Phrase = {
  /** What's spoken, with its punctuation, so the voice knows whether the thought goes on. */
  text: string;
  /** Multiplier on her base speed. */
  pace: number;
  /** Multiplier on loudness: a little more weight for what matters. */
  weight: number;
  /** Silence after the phrase, ms. */
  pauseMs: number;
};

/** Pause after each kind of break, ms (before jitter). */
const PAUSE = {
  ",": 170,
  ";": 280,
  ":": 280,
  "—": 320,
  "…": 560,
  ".": 360,
  "?": 420,
  "!": 300,
} as const;

/** Words that mark something worth slowing down for. */
const WEIGHTY =
  /\d|\b(important|remember|careful|warning|never|always|only|must|need|exactly|everything|nothing|truth|promise|listen|now)\b/i;
/** Openers of light, throwaway remarks. */
const CASUAL = /^(oh|well|so|anyway|honey|sugar|y'all|now now|alright|okay|ok|hey|ha)\b/i;

/** Splits a sentence into performed phrases. `seed` makes the jitter repeatable. */
export function planDelivery(sentence: string, seed = hash(sentence)): Phrase[] {
  const text = sentence
    .replace(/\.\.\./g, "…")
    .replace(/\s+--?\s+/g, " — ")
    .trim();
  // Break after , ; : (when a space follows, so 3:30 and 3,000 stay whole) and … —;
  // the punctuation stays with its phrase.
  // Several sentences (a pre-rendered line) also break at each end, though not after "Ms.".
  const parts = text
    .split(/(?<=[,;:])\s+|(?<=[…—])\s*|(?<!\b(?:Mr|Ms|Mrs|Dr|St)\.)(?<=[.!?])\s+/)
    .filter(Boolean);
  const phrases: Phrase[] = [];
  let rand = seed;
  const jitter = () => {
    rand = (rand * 1_103_515_245 + 12_345) >>> 0;
    return 0.85 + ((rand >>> 8) / 0xffffff) * 0.3; // 0.85 – 1.15
  };

  for (const raw of parts) {
    const part = raw.trim();
    if (!/[A-Za-z0-9]/.test(part)) {
      // A stray dash or ellipsis on its own just lengthens the last pause.
      const last = phrases.at(-1);
      if (last) last.pauseMs += PAUSE[breakOf(part)] * 0.5;
      continue;
    }
    // A fragment too short to say well on its own rides with the next one.
    const prev = phrases.at(-1);
    if (prev && words(prev.text) < 2 && /,$/.test(prev.text)) {
      prev.text = `${prev.text} ${part}`;
      prev.pauseMs = PAUSE[breakOf(part)];
      continue;
    }
    phrases.push({ text: part, pace: 1, weight: 1, pauseMs: PAUSE[breakOf(part)] });
  }

  phrases.forEach((p, i) => {
    const last = i === phrases.length - 1;
    const isConclusion = last && phrases.length > 1 && words(p.text) <= 7 && /[.!]$/.test(p.text);
    if (WEIGHTY.test(p.text) || isConclusion) {
      p.pace = 0.9;
      p.weight = 1.12;
      // A beat before what matters.
      const before = phrases[i - 1];
      if (before) before.pauseMs *= 1.5;
    } else if (CASUAL.test(p.text) && words(p.text) <= 6) {
      p.pace = 1.06;
      p.weight = 0.95;
    }
    p.pauseMs = Math.round(p.pauseMs * jitter());
  });
  return phrases;
}

export type PerformedSpeech = {
  samples: Float32Array;
  sampleRate: number;
  /** Where each word starts, ms, for captions. */
  marks: { t: number; value: string }[];
};

/**
 * Stitches synthesized phrases into one take: trims each phrase's own edge silence,
 * applies its weight, and places her chosen pauses between them.
 */
export function perform(
  phrases: Phrase[],
  takes: { samples: Float32Array; sampleRate: number }[],
): PerformedSpeech {
  const sampleRate = takes[0]?.sampleRate ?? 24_000;
  const ms = (n: number) => Math.round((n / 1000) * sampleRate);
  const pieces: Float32Array[] = [];
  const marks: PerformedSpeech["marks"] = [];
  let at = ms(60); // a breath in
  pieces.push(new Float32Array(at));

  phrases.forEach((phrase, i) => {
    const voiced = trim(takes[i]!.samples, ms(25));
    const out = new Float32Array(voiced.length);
    const fade = Math.min(ms(8), voiced.length >> 1);
    for (let j = 0; j < voiced.length; j++) {
      const edge = Math.min(1, j / fade, (voiced.length - 1 - j) / fade);
      out[j] = Math.max(-1, Math.min(1, voiced[j]! * phrase.weight * edge));
    }
    for (const m of wordMarks(phrase.text, (out.length / sampleRate) * 1000)) {
      marks.push({ t: Math.round((at / sampleRate) * 1000 + m.t), value: m.value });
    }
    pieces.push(out);
    at += out.length;
    const pause = ms(phrase.pauseMs);
    pieces.push(new Float32Array(pause));
    at += pause;
  });

  const samples = new Float32Array(at);
  let offset = 0;
  for (const p of pieces) {
    samples.set(p, offset);
    offset += p.length;
  }
  return { samples, sampleRate, marks };
}

/** Drops leading and trailing near-silence, keeping `pad` samples either side. */
export function trim(samples: Float32Array, pad: number): Float32Array {
  const threshold = 0.012;
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]!) < threshold) start++;
  while (end > start && Math.abs(samples[end]!) < threshold) end--;
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + 1 + pad));
}

/** Rough word starts within one phrase, proportional to each word's letters. */
function wordMarks(text: string, durationMs: number): { t: number; value: string }[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const weights = ws.map((w) => 1.5 + w.replace(/[^a-z0-9]/gi, "").length);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return ws.map((value, i) => {
    const mark = { t: Math.round(t), value };
    t += (weights[i]! / total) * durationMs;
    return mark;
  });
}

function breakOf(part: string): keyof typeof PAUSE {
  const tail = part.match(/[,;:…—.?!]+["')\]]*$/)?.[0] ?? ".";
  for (const ch of ["…", "—", "?", "!", ";", ":", ",", "."] as const) {
    if (tail.includes(ch)) return ch;
  }
  return ".";
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

function hash(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16_777_619);
  return h >>> 0;
}
