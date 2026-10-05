/** Mouth shape for one sound. */
export type Viseme = { open: number; round: number; width: number };

export const VISEMES = {
  rest: { open: 0, round: 0, width: 1 },
  closed: { open: 0, round: 0.1, width: 0.95 }, // m b p
  wide: { open: 0.78, round: 0.05, width: 1.12 }, // a
  mid: { open: 0.5, round: 0.12, width: 1.05 }, // e i y
  round: { open: 0.55, round: 0.95, width: 0.7 }, // o u w
  teeth: { open: 0.15, round: 0, width: 1.05 }, // f v
  small: { open: 0.3, round: 0.2, width: 0.95 }, // other consonants
} satisfies Record<string, Viseme>;

type VisemeName = keyof typeof VISEMES;

function letterViseme(ch: string): VisemeName {
  if (ch === "a") return "wide";
  if ("eiy".includes(ch)) return "mid";
  if ("ouw".includes(ch)) return "round";
  if ("mbp".includes(ch)) return "closed";
  if ("fv".includes(ch)) return "teeth";
  return "small";
}

/** Short all-caps words are spelled out: "TVA" → tee-vee-ay. */
export function isAcronym(word: string): boolean {
  return word.length >= 2 && word.length <= 5 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

function namesFor(word: string): VisemeName[] {
  if (isAcronym(word)) {
    return [...word.toLowerCase()].flatMap((ch) =>
      "aeiou".includes(ch) ? [letterViseme(ch)] : [letterViseme(ch), "mid"],
    );
  }
  const names = [...word.toLowerCase()].filter((ch) => /[a-z]/.test(ch)).map(letterViseme);
  // Repeated shapes merge into one longer shape.
  return names.filter((n, i) => n !== names[i - 1]);
}

/** Rough spoken length of a word, used when the browser doesn't report timings. */
export function estimateWordMs(word: string, rate = 1): number {
  const letters = word.replace(/[^a-z0-9]/gi, "").length;
  const ms = isAcronym(word) ? letters * 260 : 110 + letters * 62;
  return Math.min(1100, Math.max(160, ms)) / rate;
}

export type TimelineEntry = { at: number; viseme: Viseme };

/** Mouth shapes for a word, spread over 0..1 of its duration, ending relaxed. */
export function wordTimeline(word: string): TimelineEntry[] {
  const names = namesFor(word);
  if (names.length === 0) return [{ at: 0, viseme: VISEMES.small }];
  const span = 0.88 / names.length;
  const entries = names.map((name, i) => ({ at: i * span, viseme: VISEMES[name] }));
  entries.push({ at: 0.88, viseme: VISEMES.small });
  return entries;
}

export function sampleTimeline(timeline: TimelineEntry[], progress: number): Viseme {
  let current = timeline[0]!.viseme;
  for (const entry of timeline) {
    if (entry.at <= progress) current = entry.viseme;
    else break;
  }
  return current;
}
