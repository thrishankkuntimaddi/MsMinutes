import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { brainMessage, type BrainPayload, type BrainToBodyType } from "@ms-minutes/protocol";
import type { BodyRegistry } from "../bodies/registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { BodySender } from "../gateway/gateway.js";
import type { LLM } from "../llm/llm.js";
import type { TurnTrace, TurnTraces } from "../tracing/turn-traces.js";
import { SET_EXPRESSION, SetExpressionInput, tools } from "./tools.js";

export type OrchestratorDeps = {
  llm: LLM;
  send: BodySender;
  registry: BodyRegistry;
  traces: TurnTraces;
  systemPrompt: string;
  timezone: string;
  log: FastifyBaseLogger;
  now?: () => Date;
};

/** Upper bound on model calls in one turn (each tool round is one call). */
const MAX_LLM_CALLS_PER_TURN = 4;
const EXPRESSION_TRANSITION_MS = 300;
/** Spoken when the model declines and no fallback model could answer. */
const REFUSAL_LINE = "Hmm, I'd rather not get into that one.";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

class TurnAborted extends Error {}

/**
 * Runs turns: event in → Claude → speech and expression directives out (ADR-0002).
 * There is one conversation for the whole brain, whichever body the user talks through.
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  /** Append-only, so prompt caching and preserved thinking stay valid. Failed turns are cut off the tail. */
  readonly #history: Anthropic.Beta.BetaMessageParam[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  attach(bus: EventBus): void {
    bus.on("body.message", ({ bodyId, message }) => {
      if (message.type === "event.utterance.text") void this.enqueue(bodyId, message.payload.text);
    });
  }

  /** Turns run one at a time: one brain, one voice. */
  enqueue(bodyId: string, text: string): Promise<void> {
    const turn = this.#queue.then(() => this.#runTurn(bodyId, text));
    this.#queue = turn;
    return turn;
  }

  async #runTurn(bodyId: string, text: string): Promise<void> {
    const { llm, systemPrompt, traces, log } = this.#deps;
    const turnId = randomUUID();
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const say = <T extends BrainToBodyType>(type: T, payload: BrainPayload<T>) =>
      this.#deps.send(brainMessage(type, bodyId, payload));

    const trace: TurnTrace = {
      turnId,
      bodyId,
      startedAt: new Date().toISOString(),
      firstTextMs: null,
      totalMs: 0,
      llmCalls: 0,
      expressions: [],
      stopReason: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const turnStart = this.#history.length;
    let speaking = false;
    say("state.set", { mode: "thinking" });
    this.#history.push({
      role: "user",
      content: [
        { type: "text", text: this.#contextNote(bodyId) },
        { type: "text", text },
      ],
    });

    try {
      for (let call = 1; ; call++) {
        if (call > MAX_LLM_CALLS_PER_TURN)
          throw new TurnAborted("too many tool rounds in one turn");
        trace.llmCalls = call;

        let firstDeltaOfCall = true;
        const message = await llm.stream(
          { system: systemPrompt, tools, messages: this.#history },
          (delta) => {
            if (!speaking) {
              speaking = true;
              trace.firstTextMs = elapsed();
              say("state.set", { mode: "speaking" });
            } else if (firstDeltaOfCall) {
              // Text from the next model call continues the same spoken reply.
              delta = ` ${delta}`;
            }
            firstDeltaOfCall = false;
            say("speech.text.delta", { turnId, text: delta });
          },
        );

        trace.stopReason = message.stop_reason;
        trace.usage.input += message.usage.input_tokens;
        trace.usage.output += message.usage.output_tokens;
        trace.usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
        trace.usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

        if (message.stop_reason === "refusal") {
          throw new TurnAborted(`refused (${message.stop_details?.category ?? "uncategorised"})`);
        }

        const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
        // Tool input cut off by max_tokens can still look valid; never run it.
        if (toolUses.length > 0 && message.stop_reason !== "tool_use") {
          throw new TurnAborted(`tool call ended with stop_reason ${message.stop_reason}`);
        }

        this.#history.push({ role: "assistant", content: message.content });
        if (toolUses.length === 0) break;

        const results = toolUses.map((tool) => this.#runTool(tool, bodyId, trace));
        this.#history.push({ role: "user", content: results });
      }
    } catch (error) {
      // Drop the failed turn so the next one starts from a valid, cache-friendly history.
      this.#history.length = turnStart;
      trace.error = describe(error);
      log.warn({ err: error, turnId, bodyId }, "turn failed");

      if (error instanceof TurnAborted && trace.stopReason === "refusal") {
        const spokeAlready = speaking;
        if (!speaking) {
          speaking = true;
          say("state.set", { mode: "speaking" });
        }
        say("speech.text.delta", {
          turnId,
          text: spokeAlready ? ` ${REFUSAL_LINE}` : REFUSAL_LINE,
        });
      } else if (error instanceof Anthropic.APIError || isCredentialError(error)) {
        say("error", { code: "llm_unavailable", message: trace.error, fatal: false });
      } else {
        say("error", {
          code: "internal",
          message: "something went wrong in this turn",
          fatal: false,
        });
      }
    } finally {
      if (speaking) say("speech.end", { turnId });
      say("state.set", { mode: "idle" });
      trace.totalMs = elapsed();
      traces.add(trace);
      log.info({ trace }, "turn completed");
    }
  }

  #runTool(tool: ToolUse, bodyId: string, trace: TurnTrace): ToolResult {
    const result = (content: string, isError = false): ToolResult => ({
      type: "tool_result",
      tool_use_id: tool.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });

    if (tool.name !== SET_EXPRESSION) {
      return result(`Unknown tool "${tool.name}". The only tool is ${SET_EXPRESSION}.`, true);
    }
    const parsed = SetExpressionInput.safeParse(tool.input);
    if (!parsed.success) return result(z.prettifyError(parsed.error), true);

    const body = this.#deps.registry.get(bodyId);
    if (!body?.capabilities.some((c) => c.name === "express")) {
      return result("This body has no face, so the expression wasn't shown.");
    }

    const { affect, intensity } = parsed.data;
    this.#deps.send(
      brainMessage("expression.set", bodyId, {
        affect,
        intensity,
        transitionMs: EXPRESSION_TRANSITION_MS,
      }),
    );
    trace.expressions.push(`${affect}:${intensity}`);
    return result("shown");
  }

  /** Per-turn facts she can't know otherwise. Lives in the user turn so the system prompt stays cacheable. */
  #contextNote(bodyId: string): string {
    const now = (this.#deps.now ?? (() => new Date()))();
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.#deps.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now);
    const body = this.#deps.registry.get(bodyId);
    const via = body ? `${body.id} (${body.type})` : bodyId;
    return `<context>Local time: ${time} (${this.#deps.timezone}). Talking through: ${via}.</context>`;
  }
}

function isCredentialError(error: unknown): boolean {
  return error instanceof Anthropic.AnthropicError && /api[_ ]?key|auth/i.test(error.message);
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the credentials. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError)
    return "Claude is rate limiting requests; try again shortly.";
  if (error instanceof Anthropic.APIConnectionError)
    return "Couldn't reach Claude. Check the network.";
  if (error instanceof Anthropic.APIError) return `Claude request failed (${error.status}).`;
  if (isCredentialError(error))
    return "No Claude credentials found. Set ANTHROPIC_API_KEY in .env.";
  return error instanceof Error ? error.message : String(error);
}
