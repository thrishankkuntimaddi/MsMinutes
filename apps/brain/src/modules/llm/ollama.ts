import type Anthropic from "@anthropic-ai/sdk";
import { LLMUnavailableError, type LLM, type LLMRequest } from "./llm.js";

export type OllamaOptions = {
  /** e.g. http://127.0.0.1:11434 */
  url: string;
  model: string;
  /** Context window. Ollama's default is small; her history grows every turn. */
  contextTokens?: number;
  fetch?: typeof fetch;
};

type OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> } };
type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};
type OllamaChunk = {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

type Block = Anthropic.Beta.BetaContentBlock;

/**
 * A local model through Ollama, for development without an API key (ADR-0005: thin adapter).
 * Speaks the same Anthropic-shaped history as the Claude adapter, so the orchestrator
 * doesn't know which one it's talking to.
 */
export class OllamaLLM implements LLM {
  readonly #options: OllamaOptions;
  #calls = 0;

  constructor(options: OllamaOptions) {
    this.#options = options;
  }

  /**
   * Loads the model and reads her system prompt now, so her first reply doesn't wait
   * for either. Uses the same context size as real turns, or Ollama would reload the model.
   */
  async warm(request: Pick<LLMRequest, "system" | "tools">): Promise<void> {
    const res = await this.#chat({ ...request, messages: [{ role: "user", content: "." }] }, 1);
    await res.body?.cancel();
  }

  async stream(request: LLMRequest, onText: (delta: string) => void) {
    const { model } = this.#options;
    const call = ++this.#calls;

    const response = await this.#chat(request);
    if (!response.body) throw new LLMUnavailableError("Ollama sent an empty response.");

    let text = "";
    const toolCalls: OllamaToolCall[] = [];
    let last: OllamaChunk = {};
    for await (const chunk of readLines(response.body)) {
      if (chunk.error) throw new LLMUnavailableError(`Ollama: ${chunk.error}`);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        // Small models often open with whitespace; don't speak it.
        const spoken = text ? delta : delta.trimStart();
        text += delta;
        if (spoken) onText(spoken);
      }
      toolCalls.push(...(chunk.message?.tool_calls ?? []));
      if (chunk.done) last = chunk;
    }

    const content: Block[] = [];
    if (text.trim()) content.push({ type: "text", text: text.trim(), citations: null } as Block);
    toolCalls.forEach((tc, i) =>
      content.push({
        type: "tool_use",
        id: `toolu_ollama_${call}_${i}`,
        name: tc.function.name,
        input: tc.function.arguments ?? {},
      } as Block),
    );

    const stop: Anthropic.Beta.BetaStopReason = toolCalls.length
      ? "tool_use"
      : last.done_reason === "length"
        ? "max_tokens"
        : "end_turn";
    return {
      id: `msg_ollama_${call}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      stop_details: null,
      usage: {
        input_tokens: last.prompt_eval_count ?? 0,
        output_tokens: last.eval_count ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  }

  /** One /api/chat request. Throws LLMUnavailableError when Ollama can't serve it. */
  async #chat(request: LLMRequest, maxTokens?: number): Promise<Response> {
    const { url, model, contextTokens = 8192 } = this.#options;
    const fetchFn = this.#options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(`${url.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: request.signal ?? null,
        body: JSON.stringify({
          model,
          stream: true,
          keep_alive: "30m",
          options: { num_ctx: contextTokens, ...(maxTokens ? { num_predict: maxTokens } : {}) },
          messages: toOllamaMessages(request),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description ?? "",
              parameters: tool.input_schema,
            },
          })),
        }),
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw new LLMUnavailableError(
        `Couldn't reach Ollama at ${url}. Start it with \`ollama serve\`.`,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const hint = response.status === 404 ? ` Pull the model with \`ollama pull ${model}\`.` : "";
      throw new LLMUnavailableError(
        `Ollama request failed (${response.status}): ${errorText(detail)}.${hint}`,
      );
    }
    return response;
  }
}

/** Anthropic-shaped history → Ollama chat messages. */
export function toOllamaMessages(request: LLMRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: request.system }];
  const toolNames = new Map<string, string>();

  for (const message of request.messages) {
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;

    if (message.role === "assistant") {
      const text = blocks
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      const calls: OllamaToolCall[] = [];
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        toolNames.set(b.id, b.name);
        calls.push({ function: { name: b.name, arguments: b.input as Record<string, unknown> } });
      }
      out.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const text: string[] = [];
    for (const b of blocks) {
      if (b.type === "text") text.push(b.text);
      else if (b.type === "tool_result") {
        const result =
          typeof b.content === "string"
            ? b.content
            : (b.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
        out.push({
          role: "tool",
          content: b.is_error ? `Error: ${result}` : result,
          tool_name: toolNames.get(b.tool_use_id) ?? "",
        });
      }
    }
    if (text.length) out.push({ role: "user", content: text.join("\n\n") });
  }
  return out;
}

/** Ollama streams newline-delimited JSON. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as OllamaChunk;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as OllamaChunk;
}

function errorText(body: string): string {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body || "no details";
  }
}
