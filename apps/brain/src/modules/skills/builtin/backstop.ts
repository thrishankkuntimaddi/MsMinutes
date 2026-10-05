/**
 * Small local models sometimes *say* "timer set!" without calling the tool. For the two
 * requests that matter most for a clock, an explicit, standard-form ask is also read here,
 * so that when she claims it's done, it is. This never invents a request: it only reads
 * plain asks like "set a timer for 20 seconds" or "remind me to stretch in 5 minutes".
 */

const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  "forty five": 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};
const UNITS: [RegExp, number][] = [
  [/^(hours?|hrs?|h)$/, 3600],
  [/^(minutes?|mins?|m)$/, 60],
  [/^(seconds?|secs?|s)$/, 1],
];
const NUMBER = String.raw`(\d+(?:\.\d+)?|forty[- ]five|${Object.keys(WORDS).join("|")})`;
const UNIT = String.raw`(hours?|hrs?|minutes?|mins?|seconds?|secs?)`;

/** "20 seconds", "an hour and a half", "half an hour", "1 hour 30 minutes" → seconds. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bhalf an? hour\b/.test(t)) return 1800;
  let total = 0;
  for (const m of t.matchAll(new RegExp(String.raw`\b${NUMBER}[ -]?${UNIT}\b`, "g"))) {
    const n = WORDS[m[1]!] ?? Number(m[1]);
    const unit = UNITS.find(([re]) => re.test(m[2]!))![1];
    total += n * unit;
  }
  if (total && /\band a half\b/.test(t)) {
    if (/\bhours?\b.*\band a half\b/.test(t)) total += 1800;
    else if (/\bminutes?\b.*\band a half\b/.test(t)) total += 30;
  }
  return total > 0 ? Math.round(total) : null;
}

export type Backstop =
  | { tool: "timer_start"; input: { duration_seconds: number; label?: string } }
  | { tool: "reminder_set"; input: { text: string; in_minutes: number } };

export function backstop(userText: string): Backstop | null {
  const t = userText.toLowerCase().replace(/[.!?]+$/, "");

  // "remind me to X in 5 minutes" / "in 5 minutes, remind me to X"
  const after = t.match(/remind me (?:to |about )?(.+?) in (.+)$/);
  const before = t.match(/^in (.+?),? remind me (?:to |about )?(.+)$/);
  const [what, when] = before ? [before[2]!, before[1]!] : after ? [after[1]!, after[2]!] : [];
  const reminderSeconds = when ? parseDuration(when) : null;
  if (what && reminderSeconds) {
    return { tool: "reminder_set", input: { text: what.trim(), in_minutes: reminderSeconds / 60 } };
  }

  if (
    new RegExp(String.raw`\b(timer|countdown)\b|\btime (me|my|it|this|the|${NUMBER})\b`).test(t)
  ) {
    const seconds = parseDuration(t);
    if (!seconds) return null;
    const label =
      t.match(/\bfor (?:my |the |a )?([a-z][a-z ]{1,24}?)(?: please)?$/)?.[1] ??
      t.match(/\b(?:my |the )?([a-z]+) timer\b/)?.[1];
    const notALabel = new RegExp(
      String.raw`^(${NUMBER}|${UNIT}|set|start|new|another|quick|my|the)\b`,
    );
    const clean = label && !notALabel.test(label.trim()) ? label.trim() : undefined;
    return {
      tool: "timer_start",
      input: { duration_seconds: seconds, ...(clean ? { label: clean } : {}) },
    };
  }
  return null;
}
