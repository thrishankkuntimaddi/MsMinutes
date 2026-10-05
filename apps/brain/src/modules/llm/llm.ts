import Anthropic from "@anthropic-ai/sdk";

export type LLMRequest = {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
};

/**
 * Thin LLM boundary (ADR-0005): stream one model response, reporting text as it arrives.
 * Resolves with the complete message so the caller can run tools and append history.
 */
export interface LLM {
  stream(request: LLMRequest, onText: (delta: string) => void): Promise<Anthropic.Beta.BetaMessage>;
}

export type ClaudeOptions = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
};

/** The model can't be reached or used right now (bad credentials, server down, model missing). */
export class LLMUnavailableError extends Error {
  override name = "LLMUnavailableError";
}

/** Replies are spoken, so they're short; this leaves headroom for thinking. */
const MAX_TOKENS = 16_000;

export class ClaudeLLM implements LLM {
  #client: Anthropic | undefined;
  readonly #options: ClaudeOptions;

  constructor(options: ClaudeOptions) {
    this.#client = options.client;
    this.#options = options;
  }

  async stream(request: LLMRequest, onText: (delta: string) => void) {
    // Created on first use so the brain still starts without credentials.
    // They resolve from ANTHROPIC_API_KEY (or an `ant auth login` profile).
    this.#client ??= new Anthropic();
    const stream = this.#client.beta.messages.stream({
      model: this.#options.model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: this.#options.effort },
      // If her model declines on policy grounds, the API retries on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Caches the whole conversation prefix; history is append-only so it keeps hitting.
      cache_control: { type: "ephemeral" },
      system: request.system,
      tools: request.tools,
      messages: request.messages,
    });
    stream.on("text", onText);
    return stream.finalMessage();
  }
}
