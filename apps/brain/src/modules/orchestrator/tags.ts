import { Affect } from "@ms-minutes/protocol";

export type Tag =
  | { kind: "drop" }
  | { kind: "mood"; affect: Affect; intensity: number }
  | { kind: "action"; action: string };

/**
 * Longest text held back while waiting to see whether `[` (or `<`) opens a tag. Long enough
 * for a tool call written out as text, e.g. `[set_expression {"affect": "happy", "intensity": 0.5}]`.
 */
const MAX_TAG = 96;
const DEFAULT_INTENSITY = 0.6;
/** `set_expression`, `timer_start`: a tool name written into the text instead of called. */
const TOOL_NAME = /^[a-z]+(?:[_.][a-z]+)+$/;
/** `<memory>`, `</context>`, `<tool_call>`, `<|im_end|>`: markup a small model copies from its prompt. */
const MARKUP = /^\/?[a-z_|][\w|.-]*\/?$/i;

/**
 * Pulls inline stage tags out of streamed reply text: `[happy]`, `[sad 0.4]`, `[jump]`.
 * Small local models follow tags far more reliably than tool calls, and tags arrive in
 * stream order, so her face and body change at the right moment in the sentence.
 * Anything in brackets that isn't a known mood or action is passed through as text.
 *
 * Small models also get tags wrong in a few predictable ways, and none of it may reach her
 * voice: nesting (`[right now I am [sad 0.7]`), tool calls written as text
 * (`[set_expression {"affect": "happy"}]`), and prompt markup (`</context>`).
 */
export class TagFilter {
  readonly #actions: ReadonlySet<string>;
  #pending = "";
  /** Words between an outer `[` and an inner one; dropped if the inner bracket is a tag. */
  #prefix = "";
  #endsWithSpace = false;
  #heldComma = "";
  /** Whether anything has been said yet: a comma left by a dropped opening tag goes. */
  #started = false;

  constructor(actions: Iterable<string> = []) {
    this.#actions = new Set(actions);
  }

  push(delta: string): { text: string; tags: Tag[] } {
    this.#pending += delta;
    let text = "";
    const tags: Tag[] = [];

    for (;;) {
      const open = this.#prefix ? 0 : indexOfOpen(this.#pending);
      if (open < 0) {
        text += this.#pending;
        this.#pending = "";
        break;
      }
      text += this.#pending.slice(0, open);
      this.#pending = this.#pending.slice(open);
      const bracket = this.#pending[0] === "[";
      if (!bracket && this.#pending.length > 1 && !/[a-z_|/]/i.test(this.#pending[1]!)) {
        // `<3`, `2 < 3`: not markup, say it.
        text += "<";
        this.#pending = this.#pending.slice(1);
        continue;
      }
      let close = this.#pending.indexOf(bracket ? "]" : ">");
      if (bracket) {
        // `[right now I am [sad 0.7]`: the inner bracket is the tag.
        const inner = this.#pending.lastIndexOf("[", close < 0 ? this.#pending.length : close);
        if (inner > 0) {
          this.#prefix += this.#pending.slice(0, inner);
          this.#pending = this.#pending.slice(inner);
          close = this.#pending.indexOf("]");
        }
      }
      if (close < 0) {
        if (this.#pending.length > MAX_TAG) {
          // Not a tag after all: release the bracket and keep scanning.
          text += this.#prefix + this.#pending[0];
          this.#prefix = "";
          this.#pending = this.#pending.slice(1);
          continue;
        }
        break; // wait for more text
      }
      const body = this.#pending.slice(1, close);
      const tag = bracket ? this.#parse(body) : parseMarkup(body);
      if (tag) {
        if (tag.kind !== "drop") tags.push(tag);
        // "[right now I am [sad 0.7]": the words were her trying to write the tag, not speech.
        this.#prefix = "";
        // "[[happy]]": the extra closing bracket isn't speech either.
        if (this.#pending[close + 1] === "]") close++;
      } else {
        text += this.#prefix + this.#pending.slice(0, close + 1);
        this.#prefix = "";
      }
      this.#pending = this.#pending.slice(close + 1);
    }
    // A trailing comma waits for the next delta: if a dropped tag left it hanging
    // before punctuation ("fantastic, [name]!"), it goes.
    text = this.#heldComma + text;
    this.#heldComma = "";
    if (!this.#started) text = text.replace(/^\s*,\s*/, " ");
    text = tidy(text);
    if (text.trim()) this.#started = true;
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
    // An unfinished `</context` or `[sad 0.` at the very end is a broken tag, not speech.
    const broken = /^<\/?[\w|.-]*$/.test(this.#pending) || this.#parse(this.#pending.slice(1));
    const rest = this.#heldComma + (broken ? "" : this.#prefix + this.#pending);
    this.#pending = "";
    this.#prefix = "";
    this.#heldComma = "";
    return tidy(rest);
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
    // A tool call written as text: `[set_expression {"affect": "happy", "intensity": 0.5}]`.
    // Her face still gets the mood; anything else is never read aloud.
    if (TOOL_NAME.test(name) || name === "expression") return moodIn(body) ?? { kind: "drop" };
    // Small models sometimes leave template slots like [name]; never read those aloud.
    if (/^[a-z_]{2,20}$/.test(name) && rawLevel === undefined) return { kind: "drop" };
    return null;
  }
}

/** The first `[` or `<` in the text, whichever comes first. */
function indexOfOpen(text: string): number {
  const a = text.indexOf("[");
  const b = text.indexOf("<");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** `<memory>` and friends are dropped; `<3` or `a < b` stay text. */
function parseMarkup(body: string): Tag | null {
  return MARKUP.test(body.trim()) ? { kind: "drop" } : null;
}

/** A mood named anywhere in a body, e.g. a fake tool call's JSON, with its intensity if any. */
function moodIn(body: string): Tag | null {
  const words = body.toLowerCase().match(/[a-z_]+|\d*\.?\d+/g) ?? [];
  for (const [i, word] of words.entries()) {
    const mood = Affect.safeParse(word);
    if (!mood.success) continue;
    const level = words
      .slice(i + 1)
      .map(Number)
      .find(Number.isFinite);
    const intensity = level === undefined ? DEFAULT_INTENSITY : Math.min(1, Math.max(0, level));
    return { kind: "mood", affect: mood.data, intensity };
  }
  return null;
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

- You have no set_expression tool. Your face is set by a tag: begin every reply with your mood in square brackets, then speak. Example: "[happy] Oh, that's lovely news!"
- Moods: ${Affect.options.map((a) => `[${a}]`).join(" ")}. Add a number for strength if you like: [sad 0.4].
- A tag is only the mood word (and a number), nothing else inside the brackets, never a bracket inside a bracket. Right: "[sad 0.7] I'm sorry to hear that." Wrong: "[right now I am [sad 0.7]".
- Pick the mood that truly fits. Examples: someone shares a loss → [sad 0.7]; good news → [excited 0.8]; a joke → [laughing]; a question to puzzle over → [thinking]; teasing → [playful]; a compliment → [shy]; they did well → [proud]; something worrying → [concerned].
- If your mood changes partway through, put a new tag where it changes. Tags are never spoken aloud.
- Never say in words that you are changing your expression or setting your mood, and never write a tool name, JSON, or anything in angle brackets (like <context>) in your reply. Just talk.
- Use the person's real name only if you know it; never write placeholders.`;

/** Per-turn note telling her how the current body can move. */
export function actionNote(actions: readonly string[]): string {
  if (actions.length === 0) return "";
  return ` This body can move: put one of ${actions.map((a) => `[${a}]`).join(" ")} in your reply where it fits and the body does it (not spoken). Use them now and then, not every reply.`;
}
