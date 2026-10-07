import { readFileSync } from "node:fs";

/** A line she says word for word when she hears one of its commands (lines.md). */
export type ScriptedLine = { when: string[]; say: string };

const LINES_URL = new URL("../lines.md", import.meta.url);
const LINES_MARKER = "<!-- lines -->";

/** Parses lines.md (or the given text in the same format). */
export function loadLines(source = readFileSync(LINES_URL, "utf8")): ScriptedLine[] {
  const start = source.indexOf(LINES_MARKER);
  const body = start === -1 ? source : source.slice(start + LINES_MARKER.length);
  const lines: ScriptedLine[] = [];
  for (const block of body.split(/^##\s+when:/m).slice(1)) {
    const [head = "", ...rest] = block.split("\n");
    const when = head
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const say = rest.join("\n").replace(/\s+/g, " ").trim();
    if (when.length && say) lines.push({ when, say });
  }
  return lines;
}

/**
 * The line whose command was heard, if any. The command has to be most of what was said
 * (so it never fires in the middle of ordinary conversation), but a missing or misheard
 * word from speech recognition is forgiven.
 */
export function matchLine(lines: ScriptedLine[], heard: string): ScriptedLine | undefined {
  const said = words(heard);
  if (said.length === 0) return undefined;
  for (const line of lines) {
    for (const command of line.when) {
      const want = words(command);
      if (want.length === 0) continue;
      if (said.join(" ") === want.join(" ")) return line;
      const hits = inOrder(want, said);
      const enough = want.length <= 3 ? hits === want.length : hits >= want.length - 1;
      if (enough && said.length <= want.length + 2) return line;
    }
  }
  return undefined;
}

/** Lowercase words, without punctuation or her name. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b(miss|ms|mrs|misses)\.?\s+minutes\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** How many of `want` appear in `said`, in order. */
function inOrder(want: string[], said: string[]): number {
  let hits = 0;
  let from = 0;
  for (const w of want) {
    const at = said.indexOf(w, from);
    if (at !== -1) {
      hits++;
      from = at + 1;
    }
  }
  return hits;
}
