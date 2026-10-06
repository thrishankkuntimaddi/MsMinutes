import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { BrainToBodyMessage, Capability } from "@ms-minutes/protocol";
import { BodyRegistry } from "../src/modules/bodies/registry.js";
import { Orchestrator } from "../src/modules/orchestrator/orchestrator.js";
import { TagFilter } from "../src/modules/orchestrator/tags.js";
import { TurnTraces } from "../src/modules/tracing/turn-traces.js";
import { SentenceChunker } from "../src/modules/voice/sentences.js";
import { SpeechOut } from "../src/modules/voice/speech-out.js";
import { estimateWordMarks, type TTS } from "../src/modules/voice/tts.js";
import { FakeLLM, type ScriptedReply } from "./fake-llm.js";

const log = Fastify({ logger: false }).log;

/** 10 ms of silence per character, so lengths are easy to check. */
class FakeTTS implements TTS {
  readonly spoken: string[] = [];
  async warm() {}
  async synthesize(text: string) {
    this.spoken.push(text);
    return { samples: new Float32Array(text.length * 240), sampleRate: 24_000 };
  }
}

describe("TagFilter", () => {
  it("pulls moods and actions out of streamed text, even split across deltas", () => {
    const filter = new TagFilter(["jump", "turn_around"]);
    const parts = ["[hap", "py] Oh", " wow! [ju", "mp] Whee", " [sad 0.4]."];
    const out = parts.map((p) => filter.push(p));
    expect(out.map((o) => o.text).join("") + filter.flush()).toBe(" Oh wow! Whee.");
    expect(out.flatMap((o) => o.tags)).toEqual([
      { kind: "mood", affect: "happy", intensity: 0.6 },
      { kind: "action", action: "jump" },
      { kind: "mood", affect: "sad", intensity: 0.4 },
    ]);
  });

  it("leaves other brackets alone and accepts hyphenated actions", () => {
    const filter = new TagFilter(["turn_around"]);
    const a = filter.push("Item [1] is [turn-around] here [not a tag]");
    expect(a.text + filter.flush()).toBe("Item [1] is here [not a tag]");
    expect(a.tags).toEqual([{ kind: "action", action: "turn_around" }]);
  });

  it("gives up on a bracket that never closes", () => {
    const filter = new TagFilter();
    const text = filter.push("[" + "x".repeat(100)).text;
    expect(text.startsWith("[x")).toBe(true);
  });

  it("takes the inner tag of a nested one and drops the words she wrapped around it", () => {
    const filter = new TagFilter();
    const parts = ["[right now I am ", "[sad 0.7], hearing", " about it. How are you?"];
    const out = parts.map((p) => filter.push(p));
    expect(out.map((o) => o.text).join("") + filter.flush()).toBe(
      " hearing about it. How are you?",
    );
    expect(out.flatMap((o) => o.tags)).toEqual([{ kind: "mood", affect: "sad", intensity: 0.7 }]);
    const doubled = new TagFilter().push("[[happy 0.6]] Let's go.");
    expect(doubled.text).toBe(" Let's go.");
    expect(doubled.tags).toEqual([{ kind: "mood", affect: "happy", intensity: 0.6 }]);
  });

  it("turns a tool call written as text into the mood it meant, and never reads it aloud", () => {
    const filter = new TagFilter();
    const a = filter.push('Sure. [set_expression {"affect": "happy", "intensity": 0.5}] Better?');
    expect(a.text + filter.flush()).toBe("Sure. Better?");
    expect(a.tags).toEqual([{ kind: "mood", affect: "happy", intensity: 0.5 }]);
    const b = new TagFilter().push("[timer_start duration_seconds=240] Tea's on.");
    expect(b.text).toBe(" Tea's on.");
    expect(b.tags).toEqual([]);
  });

  it("drops markup copied from the prompt but keeps real angle brackets", () => {
    const filter = new TagFilter();
    const a = filter.push("<memory> I love you <3, and 2 < 3.</context");
    expect(a.text + filter.flush()).toBe(" I love you <3, and 2 < 3.");
    expect(a.tags).toEqual([]);
    const b = new TagFilter();
    expect((b.push("Fine. [sad 0.").text + b.flush()).trimEnd()).toBe("Fine.");
  });
});

describe("SentenceChunker", () => {
  it("releases whole sentences and keeps decimals together", () => {
    const c = new SentenceChunker();
    expect(c.push("It's 3.")).toEqual([]);
    expect(c.push("5 degrees. Brr! And")).toEqual(["It's 3.5 degrees.", "Brr!"]);
    expect(c.flush()).toEqual(["And"]);
  });
});

describe("SpeechOut", () => {
  it("sends marks then audio for each sentence, in order", async () => {
    const tts = new FakeTTS();
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const out = new SpeechOut(
      tts,
      "t1",
      ((type: string, payload: Record<string, unknown>) => sent.push({ type, payload })) as never,
      log,
    );
    out.push("Hello there. How are");
    out.push(" you?");
    await out.finish();
    expect(tts.spoken).toEqual(["Hello there.", "How are you?"]);
    expect(sent.map((m) => `${m.type}:${m.payload.seq}`)).toEqual([
      "speech.marks:0",
      "speech.audio.chunk:0",
      "speech.marks:1",
      "speech.audio.chunk:1",
    ]);
    expect(sent[1]!.payload).toMatchObject({ codec: "pcm16", sampleRate: 24_000 });
  });

  it("stops sending once cancelled", async () => {
    const tts = new FakeTTS();
    const sent: string[] = [];
    const out = new SpeechOut(tts, "t1", ((type: string) => sent.push(type)) as never, log);
    out.push("One. Two. ");
    out.cancel();
    await out.finish();
    expect(sent).toEqual([]);
  });

  it("estimates word marks across the sentence", () => {
    const marks = estimateWordMarks("Hi there friend", 1000);
    expect(marks.map((m) => m.value)).toEqual(["Hi", "there", "friend"]);
    expect(marks[0]!.t).toBeLessThan(marks[1]!.t);
    expect(marks[2]!.t).toBeLessThan(1000);
  });
});

describe("orchestrator with tags and a voice", () => {
  const BODY: Capability[] = [
    { name: "express", riskTier: 0 },
    { name: "speak.audio", riskTier: 0 },
    {
      name: "animate",
      riskTier: 0,
      schema: { properties: { action: { type: "string", enum: ["jump", "spin"] } } },
    },
  ];

  function setup(script: ScriptedReply[]) {
    const llm = new FakeLLM(script);
    const tts = new FakeTTS();
    const sent: BrainToBodyMessage[] = [];
    const registry = new BodyRegistry();
    const now = new Date();
    registry.add({
      id: "web-01",
      type: "web_body",
      firmware: "0",
      capabilities: BODY,
      sessionId: "s",
      connectedAt: now,
      lastSeenAt: now,
    });
    const traces = new TurnTraces();
    const orchestrator = new Orchestrator({
      llm,
      tts,
      send: (m) => (sent.push(m), true),
      registry,
      traces,
      systemPrompt: "test",
      timezone: "UTC",
      log,
    });
    return { llm, tts, sent, traces, say: (t: string) => orchestrator.enqueue("web-01", t) };
  }

  it("turns tags into directives, speaks the rest, and ends after the audio", async () => {
    const { sent, tts, traces, llm, say } = setup([
      { text: ["[excited] Yes! [ju", "mp] Up I go."] },
    ]);
    await say("jump!");

    const kinds = sent.map((m) =>
      m.type === "capability.call"
        ? `call:${String(m.payload.args.action)}`
        : m.type === "expression.set"
          ? `face:${m.payload.affect}`
          : m.type === "speech.text.delta"
            ? `say:${m.payload.text}`
            : m.type,
    );
    expect(kinds.slice(0, 5)).toEqual([
      "state.set",
      "face:excited",
      "state.set",
      "say:Yes! ",
      "call:jump",
    ]);
    expect(kinds.join("|")).not.toContain("[");
    expect(tts.spoken).toEqual(["Yes!", "Up I go."]);
    // Audio is all out before the turn ends.
    expect(kinds.lastIndexOf("speech.audio.chunk")).toBeLessThan(kinds.indexOf("speech.end"));
    expect(traces.list()[0]).toMatchObject({ actions: ["jump"], expressions: ["excited:0.6"] });
    // She's told which moves this body has.
    const note = (llm.requests[0]!.messages[0]!.content as { text: string }[])[0]!.text;
    expect(note).toContain("[jump] [spin]");
  });
});

describe("KokoroTTS queue", () => {
  it("skips a sentence whose turn was cancelled, without touching the model", async () => {
    const { KokoroTTS } = await import("../src/modules/voice/tts.js");
    const abort = new AbortController();
    abort.abort();
    await expect(new KokoroTTS({ voice: "x" }).synthesize("never", abort.signal)).rejects.toThrow(
      /cancelled/,
    );
  });
});

describe("TagFilter commas", () => {
  it("drops a comma left before punctuation by a dropped placeholder", () => {
    const f = new TagFilter();
    const text = ["That's fantastic, ", "[name]!", " Well, ", "done."]
      .map((d) => f.push(d).text)
      .join("");
    expect(text + f.flush()).toBe("That's fantastic! Well, done.");
  });
});

describe("TagFilter commas across a split tag", () => {
  it("still drops the comma when the tag itself is split", () => {
    const f = new TagFilter();
    const text = ["That's fantastic, [na", "me]!"].map((d) => f.push(d).text).join("");
    expect(text + f.flush()).toBe("That's fantastic!");
  });
});
