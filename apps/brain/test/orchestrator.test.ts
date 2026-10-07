import Anthropic from "@anthropic-ai/sdk";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ScriptedLine } from "@ms-minutes/persona";
import type { BrainToBodyMessage, Capability } from "@ms-minutes/protocol";
import { BodyRegistry } from "../src/modules/bodies/registry.js";
import { Orchestrator } from "../src/modules/orchestrator/orchestrator.js";
import { TurnTraces } from "../src/modules/tracing/turn-traces.js";
import { FakeLLM, type ScriptedReply } from "./fake-llm.js";

const FACE: Capability[] = [
  { name: "speak", riskTier: 0 },
  { name: "express", riskTier: 0 },
];

function setup(
  script: ScriptedReply[],
  capabilities: Capability[] = FACE,
  lines: ScriptedLine[] = [],
) {
  const llm = new FakeLLM(script);
  const sent: BrainToBodyMessage[] = [];
  const registry = new BodyRegistry();
  const traces = new TurnTraces();
  const now = new Date();
  registry.add({
    id: "desk-01",
    type: "desk_companion",
    firmware: "0.1.0",
    capabilities,
    sessionId: "s1",
    connectedAt: now,
    lastSeenAt: now,
  });
  const orchestrator = new Orchestrator({
    llm,
    send: (m) => (sent.push(m), true),
    registry,
    traces,
    systemPrompt: "You are a test clock.",
    timezone: "UTC",
    log: Fastify({ logger: false }).log,
    now: () => new Date("2026-10-04T07:30:00Z"),
    lines,
  });
  const say = (text: string) => orchestrator.enqueue("desk-01", text);
  const summary = () =>
    sent.map((m) => {
      switch (m.type) {
        case "state.set":
          return `state:${m.payload.mode}`;
        case "expression.set":
          return `face:${m.payload.affect}:${m.payload.intensity}`;
        case "speech.text.delta":
          return `say:${m.payload.text}`;
        case "error":
          return `error:${m.payload.code}`;
        default:
          return m.type;
      }
    });
  return { llm, sent, traces, say, summary };
}

const smile = { name: "set_expression", input: { affect: "happy", intensity: 0.6 } };

describe("orchestrator", () => {
  it("shows the expression, streams the reply, and ends idle", async () => {
    const { say, summary, llm, traces } = setup([
      { tools: [smile] },
      { text: ["Good ", "morning!"] },
    ]);
    await say("Good morning");

    expect(summary()).toEqual([
      "state:thinking",
      "face:happy:0.6",
      "state:speaking",
      "say:Good ",
      "say:morning!",
      "speech.end",
      "state:idle",
    ]);

    // The second call carries the tool result so she can continue speaking.
    const second = llm.requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", content: "shown" }],
    });

    const [trace] = traces.list();
    expect(trace).toMatchObject({
      llmCalls: 2,
      expressions: ["happy:0.6"],
      stopReason: "end_turn",
    });
    expect(trace!.firstTextMs).not.toBeNull();
    expect(trace!.usage).toEqual({ input: 200, output: 20, cacheRead: 160, cacheWrite: 0 });
  });

  it("says a scripted line word for word when she hears its command", async () => {
    const lines = [{ when: ["what have we always wanted"], say: "[proud 0.8] Yours. No problem." }];
    const { say, summary, llm } = setup([{ text: ["Something else."] }], FACE, lines);
    await say("And what have we always wanted?");

    expect(summary()).toEqual([
      "state:thinking",
      "face:proud:0.8",
      "state:speaking",
      "say:Yours. ",
      "say:No ",
      "say:problem.",
      "speech.end",
      "state:idle",
    ]);
    expect(llm.requests).toHaveLength(0);

    // Anything else still goes to the model, which sees the scripted line in history.
    await say("Ha, thanks");
    expect(llm.requests).toHaveLength(1);
    expect(JSON.stringify(llm.requests[0]!.messages)).toContain("Yours. No problem.");
  });

  it("tells her the local time and which body she is in", async () => {
    const { say, llm } = setup([{ text: ["Hi."] }]);
    await say("hello");

    const [user] = llm.requests[0]!.messages;
    expect(user).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringMatching(/Sunday.*4 October 2026.*07:30.*desk-01 \(desk_companion\)/),
        },
        { type: "text", text: "hello" },
      ],
    });
  });

  it("keeps one append-only conversation across turns", async () => {
    const { say, llm } = setup([{ text: ["One."] }, { text: ["Two."] }]);
    await say("first");
    await say("second");

    const second = llm.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The earlier turns are unchanged, byte for byte.
    expect(second[0]).toEqual(llm.requests[0]!.messages[0]);
  });

  it("speaks a gentle line and forgets the turn when the model refuses", async () => {
    const { say, summary, llm } = setup([
      { stop: "refusal", category: "cyber" },
      { text: ["Sure."] },
    ]);
    await say("something off-limits");
    expect(summary()).toContain("say:Hmm, I'd rather not get into that one.");

    await say("never mind");
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("reports an unreachable LLM and rolls the turn back", async () => {
    const { say, summary, llm, traces } = setup([
      new Anthropic.APIConnectionError({ message: "offline" }),
      { text: ["Back."] },
    ]);
    await say("hello?");
    expect(summary()).toEqual(["state:thinking", "error:llm_unavailable", "state:idle"]);
    expect(traces.list()[0]!.error).toMatch(/Couldn't reach Claude/);

    await say("hello again");
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("returns tool errors to the model instead of failing the turn", async () => {
    const { say, llm, summary } = setup([
      {
        tools: [
          { name: "set_expression", input: { affect: "smug", intensity: 0.5 } },
          { name: "launch_rocket", input: {} },
        ],
      },
      { text: ["Oops."] },
    ]);
    await say("hi");

    const results = llm.requests[1]!.messages.at(-1)!
      .content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(String(results[1]!.content)).toContain("Unknown tool");
    expect(summary().some((s) => s.startsWith("face:"))).toBe(false);
  });

  it("clamps intensity into range", async () => {
    const { say, summary } = setup([
      { tools: [{ name: "set_expression", input: { affect: "excited", intensity: 3 } }] },
      { text: ["Wow!"] },
    ]);
    await say("I got the job!");
    expect(summary()).toContain("face:excited:1");
  });

  it("doesn't send expressions to a body without a face", async () => {
    const { say, summary, llm } = setup(
      [{ tools: [smile] }, { text: ["Hi."] }],
      [{ name: "speak", riskTier: 0 }],
    );
    await say("hi");
    expect(summary().some((s) => s.startsWith("face:"))).toBe(false);
    const results = llm.requests[1]!.messages.at(-1)!
      .content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(String(results[0]!.content)).toContain("no face");
  });

  it("never runs a tool call that was cut off by max_tokens", async () => {
    const { say, summary, llm } = setup([
      { tools: [smile], stop: "max_tokens" },
      { text: ["Hi."] },
    ]);
    await say("hi");
    expect(summary().some((s) => s.startsWith("face:"))).toBe(false);
    await say("hi again");
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("runs turns one at a time", async () => {
    const { say, llm, summary } = setup([{ text: ["First."] }, { text: ["Second."] }]);
    llm.delayMs = 20;
    await Promise.all([say("one"), say("two")]);
    const said = summary().filter((s) => s.startsWith("say:") || s === "state:idle");
    expect(said).toEqual(["say:First.", "state:idle", "say:Second.", "state:idle"]);
  });
});
