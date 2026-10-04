import { readFileSync } from "node:fs";

export type PersonaOptions = {
  /** Her name, e.g. "Ms. Minutes". */
  name: string;
  /** The person she lives with. Optional until user accounts exist. */
  userName?: string;
};

const SPEC_URL = new URL("../persona.md", import.meta.url);

/** The section of persona.md that is sent to the model (everything after the marker). */
const PROMPT_MARKER = "<!-- prompt -->";

/**
 * Builds her system prompt from persona.md.
 * The result is stable for the life of the process, so it caches well.
 */
export function buildSystemPrompt(options: PersonaOptions): string {
  const spec = readFileSync(SPEC_URL, "utf8");
  const start = spec.indexOf(PROMPT_MARKER);
  if (start === -1) throw new Error(`persona.md is missing the ${PROMPT_MARKER} marker`);

  const userLine = options.userName
    ? `The person you live with is ${options.userName}.`
    : "You don't know the name of the person you live with yet; if it comes up naturally, ask.";

  return spec
    .slice(start + PROMPT_MARKER.length)
    .replaceAll("{{name}}", options.name)
    .replaceAll("{{userLine}}", userLine)
    .trim();
}
