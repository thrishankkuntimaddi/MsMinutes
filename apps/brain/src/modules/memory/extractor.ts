import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MEMORY_KINDS, type Memory } from "./store.js";

/** What changed in her long-term memory after one exchange. */
export const Extraction = z.object({
  add: z.array(
    z.object({
      kind: z.enum(MEMORY_KINDS),
      content: z.string(),
      importance: z.number(),
    }),
  ),
  update: z.array(z.object({ id: z.string(), content: z.string(), importance: z.number() })),
  forget: z.array(z.string()),
});
export type Extraction = z.infer<typeof Extraction>;

export type ExtractInput = {
  userName: string | undefined;
  /** Local date and time, so "tomorrow" can become a date. */
  now: string;
  /** The next two weeks, day by day, so small models needn't do date arithmetic. */
  calendar?: string;
  userText: string;
  replyText: string;
  /** Possibly related things she already remembers, with ids for updates. */
  known: Pick<Memory, "id" | "kind" | "content" | "importance">[];
};

/** A small, fast model reads each exchange afterwards and keeps what's worth keeping (§11.2). */
export interface Extractor {
  extract(input: ExtractInput): Promise<Extraction>;
  /** A few sentences about a finished conversation, for next time. */
  summarize(transcript: string, userName: string | undefined): Promise<string>;
}

const EXTRACT_SYSTEM = `You maintain the long-term memory of Ms. Minutes, a companion who lives with one person.

After each exchange, decide what is worth remembering about the person for weeks or months: who they are, people and pets in their life, preferences, routines, plans with dates, important events, what they're working on. Skip small talk, passing moods, questions they asked, and anything about Ms. Minutes herself.

Rules:
- Write each memory as one short third-person sentence about the person, using their name if known. Resolve relative dates ("tomorrow") to real dates.
- If something they said corrects or extends a known memory, put it in "update" with that memory's id and the full new sentence about that same thing. Never merge different facts into one memory. Don't add a duplicate.
- If they ask her to forget something, or a known memory is now plainly false, put its id in "forget".
- If they explicitly ask her to remember something, add it with importance 0.9.
- Importance: 0.9 identity and close people, 0.7 strong preferences, plans and big events, 0.5 ordinary facts, 0.3 trivia.
- Facts come only from what the person says. Her reply is context, never a source.
- Each separate fact is its own memory, even when one sentence holds several.
- Most exchanges contain nothing to remember. Then return empty lists.

Examples (today is Monday 2 June 2025):
- "I'm Sam, my cat Miso is 3." → add "Sam has a 3-year-old cat named Miso." (person, 0.9)
- "I hate coffee but I could drink green tea all day." → add "Sam dislikes coffee." (preference, 0.7) and "Sam loves green tea." (preference, 0.7)
- "Big exam on Thursday, wish me luck!" → add "Sam has a big exam on Thursday 5 June 2025." (plan, 0.7)
- "What time is it?" or "haha nice" → nothing.`;

const SUMMARY_SYSTEM = `Summarize this conversation between a person and Ms. Minutes, their companion, in two or three plain sentences for her to recall next time: what they talked about, anything left open, how the person seemed. Use the person's name if known. No preamble.`;

function extractPrompt(input: ExtractInput): string {
  const known = input.known.length
    ? input.known.map((m) => `- [${m.id}] (${m.kind}, ${m.importance}) ${m.content}`).join("\n")
    : "(nothing yet)";
  return `Now: ${input.now}
${
  input.calendar
    ? `Coming days: ${input.calendar}
`
    : ""
}Person: ${input.userName ?? "unknown"}

Already remembered (possibly related):
${known}

What the person said:
${input.userText}

(Her reply, for context only: ${input.replyText})`;
}

/** Claude Haiku with structured output: the JSON always matches the schema. */
export class ClaudeExtractor implements Extractor {
  readonly #model: string;
  #client: Anthropic | undefined;

  constructor(model: string, client?: Anthropic) {
    this.#model = model;
    this.#client = client;
  }

  async extract(input: ExtractInput): Promise<Extraction> {
    this.#client ??= new Anthropic();
    const response = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: 2000,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: extractPrompt(input) }],
      output_config: { format: zodOutputFormat(Extraction) },
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return { add: [], update: [], forget: [] };
    }
    return response.parsed_output;
  }

  async summarize(transcript: string, userName: string | undefined): Promise<string> {
    this.#client ??= new Anthropic();
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 400,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: `Person: ${userName ?? "unknown"}\n\n${transcript}` }],
    });
    return response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join(" ")
      .trim();
  }
}

/** A local model through Ollama, constrained to the same JSON schema. */
export class OllamaExtractor implements Extractor {
  readonly #url: string;
  readonly #model: string;

  constructor(url: string, model: string) {
    this.#url = url.replace(/\/$/, "");
    this.#model = model;
  }

  async extract(input: ExtractInput): Promise<Extraction> {
    const raw = await this.#chat(EXTRACT_SYSTEM, extractPrompt(input), z.toJSONSchema(Extraction));
    const parsed = Extraction.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { add: [], update: [], forget: [] };
  }

  async summarize(transcript: string, userName: string | undefined): Promise<string> {
    return (
      await this.#chat(SUMMARY_SYSTEM, `Person: ${userName ?? "unknown"}\n\n${transcript}`)
    ).trim();
  }

  async #chat(system: string, user: string, format?: unknown): Promise<string> {
    const res = await fetch(`${this.#url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#model,
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0, num_ctx: 8192 },
        ...(format ? { format } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama memory call failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { message: { content: string } }).message.content;
  }
}
