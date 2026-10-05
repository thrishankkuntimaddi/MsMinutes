import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { LLMUnavailableError, type LLMRequest } from "../src/modules/llm/llm.js";
import { OllamaLLM, toOllamaMessages } from "../src/modules/llm/ollama.js";
import { tools } from "../src/modules/orchestrator/tools.js";

/** A fetch that answers with Ollama-style NDJSON, split awkwardly across network chunks. */
function ndjsonFetch(lines: object[], seen: { body?: Record<string, unknown> } = {}) {
  return (async (_url: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body));
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const request = (messages: Anthropic.Beta.BetaMessageParam[]): LLMRequest => ({
  system: "You are a clock.",
  tools,
  messages,
});

describe("OllamaLLM", () => {
  it("streams text and reports it as an Anthropic-shaped message", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const llm = new OllamaLLM({
      url: "http://ollama",
      model: "tiny",
      fetch: ndjsonFetch(
        [
          { message: { content: "\n Good" } },
          { message: { content: " morning!" } },
          {
            message: { content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 42,
            eval_count: 5,
          },
        ],
        seen,
      ),
    });
    const deltas: string[] = [];
    const message = await llm.stream(request([{ role: "user", content: "hi" }]), (d) =>
      deltas.push(d),
    );

    expect(deltas).toEqual(["Good", " morning!"]);
    expect(message.content).toEqual([{ type: "text", text: "Good morning!", citations: null }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage).toMatchObject({ input_tokens: 42, output_tokens: 5 });
    expect(seen.body).toMatchObject({ model: "tiny", stream: true });
    expect((seen.body!.tools as { function: { name: string } }[])[0]!.function.name).toBe(
      "set_expression",
    );
  });

  it("turns tool calls into tool_use blocks", async () => {
    const llm = new OllamaLLM({
      url: "http://ollama",
      model: "tiny",
      fetch: ndjsonFetch([
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "set_expression",
                  arguments: { affect: "happy", intensity: 0.5 },
                },
              },
            ],
          },
        },
        { done: true, done_reason: "stop" },
      ]),
    });
    const message = await llm.stream(request([{ role: "user", content: "yay" }]), () => {});
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        name: "set_expression",
        input: { affect: "happy", intensity: 0.5 },
      }),
    ]);
  });

  it("reports an unreachable server or missing model as unavailable", async () => {
    const down = new OllamaLLM({
      url: "http://ollama",
      model: "tiny",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.stream(request([]), () => {})).rejects.toBeInstanceOf(LLMUnavailableError);

    const missing = new OllamaLLM({
      url: "http://ollama",
      model: "nope",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "model 'nope' not found" }), {
          status: 404,
        })) as typeof fetch,
    });
    await expect(missing.stream(request([]), () => {})).rejects.toThrow(/ollama pull nope/);
  });
});

describe("toOllamaMessages", () => {
  it("translates history, including tool calls and their results", () => {
    const messages = toOllamaMessages(
      request([
        {
          role: "user",
          content: [
            { type: "text", text: "<context>Local time: noon</context>" },
            { type: "text", text: "I passed!" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Oh!" },
            {
              type: "tool_use",
              id: "t1",
              name: "set_expression",
              input: { affect: "happy", intensity: 0.8 },
            },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "shown" }] },
        { role: "assistant", content: [{ type: "text", text: "Congratulations!" }] },
      ]),
    );

    expect(messages).toEqual([
      { role: "system", content: "You are a clock." },
      { role: "user", content: "<context>Local time: noon</context>\n\nI passed!" },
      {
        role: "assistant",
        content: "Oh!",
        tool_calls: [
          { function: { name: "set_expression", arguments: { affect: "happy", intensity: 0.8 } } },
        ],
      },
      { role: "tool", content: "shown", tool_name: "set_expression" },
      { role: "assistant", content: "Congratulations!" },
    ]);
  });
});
