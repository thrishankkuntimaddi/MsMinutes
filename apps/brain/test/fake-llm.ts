import Anthropic from "@anthropic-ai/sdk";
import type { LLM, LLMRequest } from "../src/modules/llm/llm.js";

type Block = Anthropic.Beta.BetaContentBlock;

export type ScriptedReply =
  | {
      text?: string[];
      tools?: { id?: string; name: string; input: unknown }[];
      stop?: Anthropic.Beta.BetaStopReason;
      category?: string;
    }
  | Error;

/** Plays back scripted model replies and records every request it receives. */
export class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  readonly #script: ScriptedReply[];
  delayMs = 0;

  constructor(script: ScriptedReply[]) {
    this.#script = [...script];
  }

  async stream(request: LLMRequest, onText: (delta: string) => void) {
    // Snapshot: the orchestrator keeps appending to the same array.
    this.requests.push(structuredClone(request));
    const reply = this.#script.shift();
    if (!reply) throw new Error("FakeLLM: no scripted reply left");
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (reply instanceof Error) throw reply;

    const content: Block[] = [];
    for (const delta of reply.text ?? []) onText(delta);
    if (reply.text?.length) {
      content.push({ type: "text", text: reply.text.join(""), citations: null } as Block);
    }
    for (const [i, tool] of (reply.tools ?? []).entries()) {
      content.push({
        type: "tool_use",
        id: tool.id ?? `toolu_${this.requests.length}_${i}`,
        name: tool.name,
        input: tool.input,
      } as Block);
    }

    const stop = reply.stop ?? (reply.tools?.length ? "tool_use" : "end_turn");
    return {
      id: `msg_${this.requests.length}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content,
      stop_reason: stop,
      stop_details:
        stop === "refusal" ? { type: "refusal", category: reply.category ?? null } : null,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}
