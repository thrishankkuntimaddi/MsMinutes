import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate, openDb, type Db } from "../src/modules/memory/db.js";
import type { Embedder } from "../src/modules/memory/embedder.js";
import type { Extraction, ExtractInput, Extractor } from "../src/modules/memory/extractor.js";
import { MemoryService } from "../src/modules/memory/memory.js";
import { MemoryStore } from "../src/modules/memory/store.js";
import { buildServer } from "../src/server.js";
import { FakeLLM } from "./fake-llm.js";

const log = Fastify({ logger: false }).log;

/** Bag-of-words vectors: texts sharing words are similar. Deterministic and instant. */
class WordEmbedder implements Embedder {
  readonly model = "test:words";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(64).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        if (w.length < 3) continue;
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
        v[h]! += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

class ScriptedExtractor implements Extractor {
  readonly inputs: ExtractInput[] = [];
  readonly summaries: string[] = [];
  constructor(
    public next: (input: ExtractInput) => Extraction = () => ({ add: [], update: [], forget: [] }),
  ) {}
  async extract(input: ExtractInput) {
    this.inputs.push(input);
    return this.next(input);
  }
  async summarize(transcript: string) {
    this.summaries.push(transcript);
    return "They talked about tea.";
  }
}

let db: Db;
let store: MemoryStore;
const embedder = new WordEmbedder();

beforeEach(async () => {
  db = await openDb("memory://");
  await migrate(db);
  await migrate(db); // idempotent
  store = new MemoryStore(db);
  await store.ensureUser("Thrishank");
});
afterEach(() => db.close());

const add = async (content: string, importance = 0.5) =>
  store.add({
    kind: "fact",
    content,
    importance,
    embedding: (await embedder.embed([content]))[0]!,
    embedModel: embedder.model,
  });

describe("memory store", () => {
  it("finds memories by meaning, only among the same embedding model", async () => {
    await add("Thrishank drinks green tea every morning");
    await add("Thrishank has a dog named Bruno");
    await store.add({
      kind: "fact",
      content: "other model",
      importance: 0.5,
      embedding: [1, 0],
      embedModel: "other",
    });
    const [q] = await embedder.embed(["what tea does he drink in the morning"]);
    const found = await store.search(q!, embedder.model, 5);
    expect(found.map((f) => f.content)).toEqual([
      "Thrishank drinks green tea every morning",
      "Thrishank has a dog named Bruno",
    ]);
    expect(found[0]!.similarity).toBeGreaterThan(found[1]!.similarity);
  });

  it("edits, forgets one, and forgets all", async () => {
    const m = await add("likes jazz");
    expect((await store.update(m.id, { content: "likes lo-fi", importance: 2 }))!.importance).toBe(
      1,
    );
    expect((await store.get(m.id))!.content).toBe("likes lo-fi");
    expect(await store.remove(m.id)).toBe(true);
    expect(await store.remove(m.id)).toBe(false);
    await add("a");
    await add("b");
    expect(await store.removeAll()).toBe(2);
    expect(await store.list()).toEqual([]);
  });
});

describe("memory service", () => {
  let clock = new Date("2026-10-05T09:00:00Z");
  beforeEach(() => (clock = new Date("2026-10-05T09:00:00Z")));
  const service = (extractor: Extractor) =>
    new MemoryService({
      store,
      embedder,
      extractor,
      userName: "Thrishank",
      timezone: "UTC",
      log,
      now: () => clock,
    });

  it("learns from an exchange and recalls it later", async () => {
    const extractor = new ScriptedExtractor(() => ({
      add: [
        {
          kind: "preference",
          content: "Thrishank drinks green tea every morning",
          importance: 0.7,
        },
      ],
      update: [],
      forget: [],
    }));
    const memory = service(extractor);
    await memory.start();
    await memory.recall("hello");
    await memory.remember({
      bodyId: "web-01",
      userText: "I always have green tea in the morning",
      replyText: "Lovely.",
    });

    expect(extractor.inputs[0]).toMatchObject({ userName: "Thrishank", replyText: "Lovely." });
    const { note } = await memory.recall("what should I drink this morning, tea?");
    expect(note).toContain("Things you remember about Thrishank");
    expect(note).toContain("- Thrishank drinks green tea every morning");
    expect((await store.list())[0]!.recallCount).toBe(1);
  });

  it("updates and forgets only memories it was shown, and folds duplicates", async () => {
    const jazz = await add("Thrishank likes jazz music");
    const dog = await add("Thrishank has a dog named Bruno");
    const bystander = await add("Thrishank works as an engineer in Hyderabad");
    let step = 0;
    const extractor = new ScriptedExtractor((input) => {
      step++;
      if (step === 1) {
        return {
          add: [],
          update: [
            { id: jazz.id, content: "Thrishank likes jazz music on rainy days", importance: 0.7 },
          ],
          // The dog was shown; an invented id and a memory she wasn't shown must survive.
          forget: input.known.some((k) => k.id === dog.id)
            ? [dog.id, "00000000-0000-0000-0000-000000000000", bystander.id]
            : [],
        };
      }
      return {
        add: [
          { kind: "fact", content: "Thrishank likes jazz music on rainy days", importance: 0.9 },
        ],
        update: [],
        forget: [],
      };
    });
    const memory = service(extractor);
    await memory.start();
    await memory.remember({
      bodyId: "web-01",
      userText: "I like jazz music when it rains, and please forget my dog Bruno",
      replyText: "Noted.",
    });
    await memory.remember({
      bodyId: "web-01",
      userText: "Did I tell you I like jazz music on rainy days?",
      replyText: "You did!",
    });

    expect(extractor.inputs[0]!.known.map((k) => k.id)).toContain(dog.id);
    expect(extractor.inputs[0]!.known.map((k) => k.id)).not.toContain(bystander.id);
    const left = await store.list();
    expect(left.map((m) => m.id).sort()).toEqual([jazz.id, bystander.id].sort());
    expect(left.find((m) => m.id === jazz.id)).toMatchObject({
      content: "Thrishank likes jazz music on rainy days",
    });
    expect(left.find((m) => m.id === jazz.id)!.importance).toBeCloseTo(0.9);
  });

  it("skips tiny exchanges, starts a new conversation after a gap, and recalls last time", async () => {
    const extractor = new ScriptedExtractor();
    const memory = service(extractor);
    await memory.start();
    await memory.recall("hi");
    await memory.remember({ bodyId: "web-01", userText: "hi", replyText: "Hello!" });
    await memory.remember({
      bodyId: "web-01",
      userText: "I'm making some green tea now",
      replyText: "Enjoy.",
    });
    expect(extractor.inputs).toHaveLength(1);

    clock = new Date(clock.getTime() + 3 * 3600_000);
    await memory.recall("morning again");
    await memory.idle();
    expect(extractor.summaries[0]).toContain("Thrishank: I'm making some green tea now");
    const fresh = service(extractor);
    expect(await fresh.start()).toEqual([]); // the new conversation has no turns yet
    expect((await fresh.recall("hey")).note).toContain("Last time you talked");
  });

  it("resumes a conversation in progress after a restart", async () => {
    const memory = service(new ScriptedExtractor());
    await memory.start();
    await memory.recall("x");
    await memory.remember({
      bodyId: "web-01",
      userText: "remember the milk",
      replyText: "Will do.",
    });
    const restarted = service(new ScriptedExtractor());
    expect(await restarted.start()).toMatchObject([
      { userText: "remember the milk", replyText: "Will do." },
    ]);
  });
});

describe("memory API and turns", () => {
  it("lets you list, add, edit and delete memories, and feeds them to her", async () => {
    const llm = new FakeLLM([{ text: ["Green tea, as always."] }]);
    const memory = new MemoryService({
      store,
      embedder,
      extractor: new ScriptedExtractor(),
      userName: "Thrishank",
      timezone: "UTC",
      log,
    });
    const { app, orchestrator } = await buildServer(
      loadConfig({ PORT: "0", LOG_LEVEL: "silent", USER_NAME: "Thrishank" }),
      { llm, memory },
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: {
        kind: "preference",
        content: "Thrishank drinks green tea every morning",
        importance: 0.8,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().memory.id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/memories/${id}`,
      payload: { importance: 0.9 },
    });
    expect(patched.json().memory.importance).toBeCloseTo(0.9);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/memories/${id}`, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/memories" })).json().memories,
    ).toHaveLength(1);

    await orchestrator.enqueue("web-01", "what tea do I drink in the morning?");
    const context = (llm.requests[0]!.messages[0]!.content as { text: string }[])[0]!.text;
    expect(context).toContain("- Thrishank drinks green tea every morning");

    expect((await app.inject({ method: "DELETE", url: "/api/memories" })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/memories/${id}` })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: "DELETE", url: `/api/memories/${id}` })).statusCode).toBe(
      404,
    );
    await memory.idle();
    await app.close();
  });
});

describe("worthLearning", () => {
  it("learns from people talking about themselves, not from questions and small talk", async () => {
    const { worthLearning } = await import("../src/modules/memory/memory.js");
    expect(worthLearning("I'm vegetarian and I love green tea")).toBe(true);
    expect(worthLearning("Please remember the wifi password is on the fridge")).toBe(true);
    expect(worthLearning("Can you suggest something for dinner tonight?")).toBe(false);
    expect(worthLearning("haha nice one")).toBe(false);
    expect(worthLearning("hi")).toBe(false);
  });
});

describe("fixWeekdays", () => {
  it("moves a mismatched date to the nearest date that is that weekday", async () => {
    const { fixWeekdays } = await import("../src/modules/memory/memory.js");
    // 12 October 2026 is a Monday; the nearest Friday is the 9th.
    expect(fixWeekdays("Interview on Friday, 12 October 2026.")).toBe(
      "Interview on Friday, 9 October 2026.",
    );
    expect(fixWeekdays("Exam on Friday 16 October 2026")).toBe("Exam on Friday 16 October 2026");
    expect(fixWeekdays("Party on Saturday 31st October 2026")).toBe(
      "Party on Saturday 31st October 2026", // already right: left as written
    );
    expect(fixWeekdays("No dates here")).toBe("No dates here");
  });
});
