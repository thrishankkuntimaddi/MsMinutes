import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { buildSystemPrompt, loadLines, type ScriptedLine } from "@ms-minutes/persona";
import { PROTOCOL_VERSION } from "@ms-minutes/protocol";
import type { Config } from "./config.js";
import { BodyRegistry } from "./modules/bodies/registry.js";
import { EventBus } from "./modules/events/event-bus.js";
import { registerBodyGateway } from "./modules/gateway/gateway.js";
import { ClaudeLLM, type LLM } from "./modules/llm/llm.js";
import { OllamaLLM } from "./modules/llm/ollama.js";
import { Orchestrator } from "./modules/orchestrator/orchestrator.js";
import { MOOD_TAG_INSTRUCTIONS } from "./modules/orchestrator/tags.js";
import { migrate, openDb } from "./modules/memory/db.js";
import { LocalEmbedder, OllamaEmbedder } from "./modules/memory/embedder.js";
import { ClaudeExtractor, OllamaExtractor } from "./modules/memory/extractor.js";
import { MemoryService } from "./modules/memory/memory.js";
import { registerMemoryRoutes } from "./modules/memory/routes.js";
import { MemoryStore } from "./modules/memory/store.js";
import { Announcer } from "./modules/skills/announcer.js";
import { timerSkills } from "./modules/skills/builtin/timers.js";
import { weatherSkill } from "./modules/skills/builtin/weather.js";
import { PolicyGate } from "./modules/skills/policy.js";
import { SkillRegistry } from "./modules/skills/registry.js";
import { DbScheduleStore, InMemoryScheduleStore, Schedules } from "./modules/skills/schedule.js";
import type { Db } from "./modules/memory/db.js";
import { Hearing } from "./modules/voice/hearing.js";
import { LocalSTT, type STT } from "./modules/voice/stt.js";
import { KokoroTTS, type TTS } from "./modules/voice/tts.js";
import { TurnTraces } from "./modules/tracing/turn-traces.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;

export type ServerOptions = {
  /** Overrides the Claude adapter (tests use a scripted fake). */
  llm?: LLM;
  /** Overrides the configured voice (tests use a fake). */
  tts?: TTS;
  /** Overrides the configured hearing (tests use a fake). */
  stt?: STT;
  /** Overrides the configured memory (tests use one over an in-memory database). */
  memory?: MemoryService;
  /** Overrides her scripted lines (persona/lines.md). */
  lines?: ScriptedLine[];
};

export async function buildServer(config: Config, options: ServerOptions = {}) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const registry = new BodyRegistry();
  const traces = new TurnTraces();
  const bus = new EventBus((err, event) =>
    app.log.error({ err, event: event.type }, "event handler failed"),
  );

  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get("/health", async () => ({ status: "ok", protocolVersion: PROTOCOL_VERSION }));

  app.get("/api/bodies", async () => ({
    bodies: registry.list().map((b) => ({
      id: b.id,
      type: b.type,
      firmware: b.firmware,
      capabilities: b.capabilities,
      connectedAt: b.connectedAt.toISOString(),
      lastSeenAt: b.lastSeenAt.toISOString(),
    })),
  }));

  app.get("/api/turns", async () => ({ turns: traces.list() }));

  const llm = options.llm ?? createLLM(config);
  // Small local models show moods with inline tags far more reliably than with tools.
  const systemPrompt =
    buildSystemPrompt({ name: config.personaName, userName: config.userName }) +
    (llm instanceof OllamaLLM ? MOOD_TAG_INSTRUCTIONS : "");
  const tts = options.tts ?? createTTS(config);
  const stt = options.stt ?? createSTT(config);
  if (stt && !options.stt) {
    const started = performance.now();
    stt.warm().then(
      () =>
        app.log.info(
          `hearing ${config.stt.model} is ready (${Math.round(performance.now() - started)} ms)`,
        ),
      (err) => app.log.warn({ err }, "couldn't load her hearing; bodies will transcribe"),
    );
  }
  const { send } = registerBodyGateway(app, {
    config,
    registry,
    bus,
    speaks: tts !== undefined,
    hears: stt !== undefined,
  });
  if (tts && !options.tts) {
    const started = performance.now();
    tts.warm().then(
      () =>
        app.log.info(
          `voice ${config.tts.voice} is ready (${Math.round(performance.now() - started)} ms)`,
        ),
      (err) => app.log.warn({ err }, "couldn't load her voice; bodies will use their own"),
    );
  }
  const created = options.memory ? undefined : await createMemory(config, app);
  const memory = options.memory ?? created?.memory;
  const resumed = memory ? await memory.start() : [];
  if (memory) registerMemoryRoutes(app, memory);

  // Skills (§12): timers and reminders on her own clock, and the weather.
  // The orchestrator exists by the time anything fires.
  const announcer = new Announcer({
    registry,
    send,
    speak: (bodyId, event) => void orchestrator.enqueueEvent(bodyId, event),
    timezone: config.timezone,
    log: app.log,
  });
  const schedules = new Schedules({
    store: created?.db ? new DbScheduleStore(created.db) : new InMemoryScheduleStore(),
    onFire: (item, lateMs) => announcer.fire(item, lateMs),
    onChange: (items) => announcer.show(items),
    onError: (err) => app.log.warn({ err }, "timer check failed"),
  });
  const skills = new SkillRegistry(
    new PolicyGate({ granted: config.skills.grant, denied: config.skills.deny, log: app.log }),
  );
  for (const skill of timerSkills(schedules)) skills.register(skill);
  skills.register(weatherSkill({ defaultPlace: config.skills.weatherPlace }));

  const orchestrator = new Orchestrator({
    llm,
    send,
    registry,
    traces,
    systemPrompt,
    tts,
    skills,
    ...(memory ? { memory } : {}),
    timezone: config.timezone,
    log: app.log,
    lines: options.lines ?? loadLines(),
  });
  orchestrator.attach(bus);
  announcer.attach(bus);
  await schedules.start();
  app.addHook("onClose", async () => schedules.stop());
  if (llm instanceof OllamaLLM) {
    llm.warm({ system: systemPrompt, tools: orchestrator.tools }).then(
      () => app.log.info(`${config.ollama.model} is loaded and ready`),
      (err) => app.log.warn({ err }, "couldn't preload the Ollama model"),
    );
  }
  if (resumed.length) {
    orchestrator.preload(resumed);
    app.log.info({ turns: resumed.length }, "continuing the conversation from before the restart");
  }
  if (stt) {
    new Hearing({
      stt,
      send,
      log: app.log,
      onUtterance: (bodyId, text, sttMs) => void orchestrator.enqueue(bodyId, text, { sttMs }),
      recentSpeech: (bodyId) => orchestrator.recentSpeech(bodyId),
    }).attach(bus);
  }

  return { app, registry, bus, orchestrator, traces, schedules };
}

function createLLM(config: Config): LLM {
  return config.llmProvider === "ollama" ? new OllamaLLM(config.ollama) : new ClaudeLLM(config.llm);
}

function createTTS(config: Config): TTS | undefined {
  if (config.tts.provider === "kokoro") {
    return new KokoroTTS({ voice: config.tts.voice, speed: config.tts.speed });
  }
  return undefined;
}

function createSTT(config: Config): STT | undefined {
  return config.stt.provider === "local" ? new LocalSTT(config.stt.model) : undefined;
}

async function createMemory(
  config: Config,
  app: { log: FastifyBaseLogger; addHook: FastifyInstance["addHook"] },
): Promise<{ memory: MemoryService; db: Db } | undefined> {
  const m = config.memory;
  if (m.db === "off") return undefined;
  const db = await openDb(m.db);
  await migrate(db);
  const embedder =
    m.embed.provider === "ollama"
      ? new OllamaEmbedder(config.ollama.url, m.embed.model)
      : new LocalEmbedder(m.embed.model);
  const extractor =
    config.llmProvider === "ollama"
      ? new OllamaExtractor(config.ollama.url, m.model)
      : new ClaudeExtractor(m.model);
  const memory = new MemoryService({
    store: new MemoryStore(db),
    embedder,
    extractor,
    userName: config.userName,
    timezone: config.timezone,
    log: app.log,
    gapMinutes: m.gapMinutes,
    learnDelayMs: m.learnDelayMs,
  });
  app.addHook("onClose", async () => {
    // Let in-flight memory writes land, but don't hang shutdown on a slow model.
    await Promise.race([memory.idle(), new Promise((r) => setTimeout(r, 5000))]);
    await db.close();
  });
  app.log.info(
    { db: m.db.replace(/:[^:@/]+@/, ":***@"), extractor: m.model, embedder: embedder.model },
    "memory is on",
  );
  return { memory, db };
}
