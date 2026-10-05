import { Affect } from "@ms-minutes/protocol";

export type Tag =
  | { kind: "drop" }
  | { kind: "mood"; affect: Affect; intensity: number }
  | { kind: "action"; action: string };

/** Longest text held back while waiting to see whether `[` opens a tag. */
const MAX_TAG = 32;
const DEFAULT_INTENSITY = 0.6;

/**
 * Pulls inline stage tags out of streamed reply text: `[happy]`, `[sad 0.4]`, `[jump]`.
 * Small local models follow tags far more reliably than tool calls, and tags arrive in
 * stream order, so her face and body change at the right moment in the sentence.
 * Anything in brackets that isn't a known mood or action is passed through as text.
 */
export class TagFilter {
  readonly #actions: ReadonlySet<string>;
  #pending = "";
  #endsWithSpace = false;
  #heldComma = "";

  constructor(actions: Iterable<string> = []) {
    this.#actions = new Set(actions);
  }

  push(delta: string): { text: string; tags: Tag[] } {
    this.#pending += delta;
    let text = "";
    const tags: Tag[] = [];

    for (;;) {
      const open = this.#pending.indexOf("[");
      if (open < 0) {
        text += this.#pending;
        this.#pending = "";
        break;
      }
      text += this.#pending.slice(0, open);
      this.#pending = this.#pending.slice(open);
      const close = this.#pending.indexOf("]");
      if (close < 0) {
        if (this.#pending.length > MAX_TAG) {
          // Not a tag after all: release the bracket and keep scanning.
          text += this.#pending[0];
          this.#pending = this.#pending.slice(1);
          continue;
        }
        break; // wait for more text
      }
      const body = this.#pending.slice(1, close);
      const tag = this.#parse(body);
      if (tag) {
        if (tag.kind !== "drop") tags.push(tag);
      } else text += this.#pending.slice(0, close + 1);
      this.#pending = this.#pending.slice(close + 1);
    }
    // A trailing comma waits for the next delta: if a dropped tag left it hanging
    // before punctuation ("fantastic, [name]!"), it goes.
    text = this.#heldComma + text;
    this.#heldComma = "";
    text = tidy(text);
    const comma = text.match(/,\s*$/);
    if (comma) {
      this.#heldComma = comma[0];
      text = text.slice(0, -comma[0].length);
    }
    // A removed tag can also leave a double space across two deltas.
    if (this.#endsWithSpace && text.startsWith(" ")) text = text.slice(1);
    if (text) this.#endsWithSpace = text.endsWith(" ");
    return { text, tags };
  }

  /** The reply is over: release anything held back. */
  flush(): string {
    const rest = this.#heldComma + this.#pending;
    this.#pending = "";
    this.#heldComma = "";
    return rest;
  }

  #parse(body: string): Tag | null {
    const [rawName = "", rawLevel] = body
      .trim()
      .toLowerCase()
      .split(/[\s:,=]+/);
    const name = rawName.replace(/-/g, "_");
    const mood = Affect.safeParse(name);
    if (mood.success) {
      const level = Number(rawLevel);
      const intensity = Number.isFinite(level)
        ? Math.min(1, Math.max(0, level))
        : DEFAULT_INTENSITY;
      return { kind: "mood", affect: mood.data, intensity };
    }
    if (this.#actions.has(name)) return { kind: "action", action: name };
    // Small models sometimes leave template slots like [name]; never read those aloud.
    if (/^[a-z_]{2,20}$/.test(name) && rawLevel === undefined) return { kind: "drop" };
    return null;
  }
}

/** Removing a tag can leave doubled spaces or a space before punctuation. */
function tidy(text: string): string {
  return text
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.!?])/g, "$1")
    .replace(/,([.!?])/g, "$1");
}

/** Appended to her system prompt for models that handle tags better than tools. */
export const MOOD_TAG_INSTRUCTIONS = `

How to show your mood (important):

- Begin every reply with your mood in square brackets, then speak. Example: "[happy] Oh, that's lovely news!"
- Moods: ${Affect.options.map((a) => `[${a}]`).join(" ")}. Add a number for strength if you like: [sad 0.4].
- Pick the mood that truly fits. Examples: someone shares a loss → [sad 0.7]; good news → [excited 0.8]; a joke → [laughing]; a question to puzzle over → [thinking]; teasing → [playful]; a compliment → [shy]; they did well → [proud]; something worrying → [concerned].
- If your mood changes partway through, put a new tag where it changes. Tags are never spoken aloud.
- Use the person's real name only if you know it; never write placeholders.`;

/** Per-turn note telling her how the current body can move. */
export function actionNote(actions: readonly string[]): string {
  if (actions.length === 0) return "";
  return ` This body can move: put one of ${actions.map((a) => `[${a}]`).join(" ")} in your reply where it fits and the body does it (not spoken). Use them now and then, not every reply.`;
}
