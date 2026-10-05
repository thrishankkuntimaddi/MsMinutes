import type Anthropic from "@anthropic-ai/sdk";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { bodyMessage, type BrainToBodyMessage } from "@ms-minutes/protocol";
import { BodyRegistry } from "../src/modules/bodies/registry.js";
import { EventBus } from "../src/modules/events/event-bus.js";
import type { LLM, LLMRequest } from "../src/modules/llm/llm.js";
import { Orchestrator } from "../src/modules/orchestrator/orchestrator.js";
import { TurnTraces } from "../src/modules/tracing/turn-traces.js";
import { cleanTranscript, Hearing } from "../src/modules/voice/hearing.js";
import { isEcho, to16k, type STT } from "../src/modules/voice/stt.js";

const log = Fastify({ logger: false }).log;

/** A tone loud enough to count as speech. */
function pcm16(seconds: number, rate = 16_000, level = 0.2): string {
  const pcm = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 8) * level * 0x7fff;
  return Buffer.from(pcm.buffer).toString("base64");
}

function setup(heardText = "what time is it", recent = "") {
  const bus = new EventBus((err) => {
    throw err;
  });
  const sent: BrainToBodyMessage[] = [];
  const turns: { text: string; sttMs: number }[] = [];
  const lengths: number[] = [];
  const stt: STT = {
    warm: async () => {},
    transcribe: async (samples) => (lengths.push(samples.length), heardText),
  };
  new Hearing({
    stt,
    send: (m) => (sent.push(m), true),
    log,
    onUtterance: (_b, text, sttMs) => turns.push({ text, sttMs }),
    recentSpeech: () => recent,
  }).attach(bus);
  const audio = (seq: number, data: string, sampleRate = 16_000) =>
    bus.emit({
      type: "body.message",
      bodyId: "web-01",
      message: bodyMessage("event.audio.chunk", "web-01", {
        seq,
        codec: "pcm16",
        sampleRate,
        data,
      }),
    });
  const end = async () => {
    bus.emit({
      type: "body.message",
      bodyId: "web-01",
      message: bodyMessage("event.audio.end", "web-01", {}),
    });
    await new Promise((r) => setTimeout(r, 0));
  };
  const transcripts = () => sent.flatMap((m) => (m.type === "transcript" ? [m.payload.text] : []));
  return { audio, end, turns, transcripts, lengths };
}

describe("hearing", () => {
  it("joins an utterance's chunks, transcribes it and starts a turn", async () => {
    const h = setup();
    h.audio(0, pcm16(1));
    h.audio(1, pcm16(0.5));
    await h.end();
    expect(h.lengths).toEqual([24_000]);
    expect(h.transcripts()).toEqual(["what time is it"]);
    expect(h.turns.map((t) => t.text)).toEqual(["what time is it"]);
  });

  it("resamples other rates to 16 kHz", async () => {
    const h = setup();
    h.audio(0, pcm16(1, 48_000), 48_000);
    await h.end();
    expect(h.lengths).toEqual([16_000]);
  });

  it("ignores blips and silence without starting a turn", async () => {
    const short = setup();
    short.audio(0, pcm16(0.1));
    await short.end();
    const quiet = setup();
    quiet.audio(0, pcm16(1, 16_000, 0.001));
    await quiet.end();
    expect(short.transcripts()).toEqual([""]);
    expect(quiet.transcripts()).toEqual([""]);
    expect([...short.turns, ...quiet.turns]).toEqual([]);
  });

  it("doesn't answer her own voice echoing back", async () => {
    const h = setup("welcome to the TVA", "Hi! Welcome to the TVA. My name is Miss Minutes.");
    h.audio(0, pcm16(1));
    await h.end();
    expect(h.transcripts()).toEqual([""]);
    expect(h.turns).toEqual([]);
  });

  it("recognises echo and noise in transcripts", () => {
    expect(isEcho("my name is miss minutes", "Hi! My name is Miss Minutes.")).toBe(true);
    expect(isEcho("what's your name", "Hi! My name is Miss Minutes.")).toBe(false);
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("Thank you.")).toBe("");
    expect(cleanTranscript("(music) Hello there")).toBe("Hello there");
    expect(to16k(new Float32Array(48), 48_000)).toHaveLength(16);
  });
});

/** Streams words slowly and stops when aborted, like a real model call. */
class SlowLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  async stream(request: LLMRequest, onText: (d: string) => void) {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    for (const word of ["Well, ", "let me ", "tell you ", "a long ", "story."]) {
      if (request.signal?.aborted) throw new DOMException("aborted", "AbortError");
      onText(word);
      await new Promise((r) => setTimeout(r, 15));
    }
    return {
      content: [{ type: "text", text: "Well, let me tell you a long story." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

describe("barge-in", () => {
  it("cuts the turn short, keeps what she said, and sends no error", async () => {
    const llm = new SlowLLM();
    const sent: BrainToBodyMessage[] = [];
    const registry = new BodyRegistry();
    const now = new Date();
    registry.add({
      id: "web-01",
      type: "web",
      firmware: "0",
      capabilities: [],
      sessionId: "s",
      connectedAt: now,
      lastSeenAt: now,
    });
    const traces = new TurnTraces();
    const o = new Orchestrator({
      llm,
      send: (m) => (sent.push(m), true),
      registry,
      traces,
      systemPrompt: "t",
      timezone: "UTC",
      log,
    });

    const turn = o.enqueue("web-01", "tell me a story");
    await new Promise((r) => setTimeout(r, 25));
    expect(o.recentSpeech("web-01")).toContain("Well");
    o.interrupt("web-01");
    await turn;

    expect(traces.list()[0]).toMatchObject({ interrupted: true });
    expect(sent.some((m) => m.type === "error")).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: "state.set", payload: { mode: "idle" } });

    await o.enqueue("web-01", "sorry, go on");
    const history = llm.requests[1]!.messages;
    const cut = history[1]!.content as { text: string }[];
    expect(cut[0]!.text).toMatch(/^Well,.*—$/);
  });
});
