import { z } from "zod";

const Env = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(7700),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PERSONA_NAME: z.string().min(1).default("Ms. Minutes"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  HELLO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  USER_NAME: z.string().min(1).optional(),
  TIMEZONE: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  LLM_PROVIDER: z.enum(["claude", "ollama"]).default("claude"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  OLLAMA_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen2.5:3b"),
  TTS_PROVIDER: z.enum(["none", "kokoro"]).default("none"),
  TTS_VOICE: z.string().min(1).default("af_heart"),
  TTS_SPEED: z.coerce.number().min(0.5).max(2).default(0.95),
  STT_PROVIDER: z.enum(["none", "local"]).default("none"),
  STT_MODEL: z.string().min(1).default("onnx-community/moonshine-base-ONNX"),
  MEMORY_DB: z.string().default("off"),
  WEATHER_PLACE: z.string().min(1).optional(),
  SKILLS_GRANT: z.string().default(""),
  SKILLS_DENY: z.string().default(""),
  MEMORY_MODEL: z.string().min(1).optional(),
  MEMORY_GAP_MINUTES: z.coerce.number().min(0).default(30),
  MEMORY_LEARN_DELAY_SECONDS: z.coerce.number().min(0).optional(),
  EMBED_PROVIDER: z.enum(["ollama", "local"]).optional(),
  EMBED_MODEL: z.string().min(1).optional(),
});

export type Config = {
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  personaName: string;
  heartbeatIntervalMs: number;
  /** A body that stays silent this long is disconnected. */
  heartbeatTimeoutMs: number;
  helloTimeoutMs: number;
  userName: string | undefined;
  timezone: string;
  llm: { model: string; effort: z.infer<typeof Env>["LLM_EFFORT"] };
  /** Which model answers: Claude, or a local Ollama model for development. */
  llmProvider: z.infer<typeof Env>["LLM_PROVIDER"];
  ollama: { url: string; model: string };
  /** Her voice. "none" leaves speech to each body (e.g. the browser's own voices). */
  tts: { provider: z.infer<typeof Env>["TTS_PROVIDER"]; voice: string; speed: number };
  /** Her hearing. "none" leaves speech recognition to each body (e.g. the browser's). */
  stt: { provider: z.infer<typeof Env>["STT_PROVIDER"]; model: string };
  /**
   * Long-term memory. `db` is "off", a PGlite directory, "memory://", or a postgres:// URL.
   * The extraction model defaults to Claude Haiku 4.5 (or the Ollama model when local);
   * embeddings to nomic-embed-text via Ollama when it's the provider, else a local model.
   */
  /** Skills (§12) and the policy gate's grants (§13.2). */
  skills: { weatherPlace: string | undefined; grant: string[]; deny: string[] };
  memory: {
    db: string;
    /** A pause longer than this starts a new conversation. */
    gapMinutes: number;
    /** Quiet time before learning from what was said (0 = right away). */
    learnDelayMs: number;
    model: string;
    embed: { provider: "ollama" | "local"; model: string };
  };
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    personaName: e.PERSONA_NAME,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: e.HEARTBEAT_INTERVAL_MS * 3,
    helloTimeoutMs: e.HELLO_TIMEOUT_MS,
    userName: e.USER_NAME,
    timezone: e.TIMEZONE,
    llm: { model: e.LLM_MODEL, effort: e.LLM_EFFORT },
    llmProvider: e.LLM_PROVIDER,
    ollama: { url: e.OLLAMA_URL, model: e.OLLAMA_MODEL },
    tts: { provider: e.TTS_PROVIDER, voice: e.TTS_VOICE, speed: e.TTS_SPEED },
    stt: { provider: e.STT_PROVIDER, model: e.STT_MODEL },
    memory: memoryConfig(e),
    skills: {
      weatherPlace: e.WEATHER_PLACE,
      grant: list(e.SKILLS_GRANT),
      deny: list(e.SKILLS_DENY),
    },
  };
}

function memoryConfig(e: z.infer<typeof Env>): Config["memory"] {
  const local = e.LLM_PROVIDER === "ollama";
  const provider = e.EMBED_PROVIDER ?? (local ? "ollama" : "local");
  return {
    db: e.MEMORY_DB.trim() || "off",
    gapMinutes: e.MEMORY_GAP_MINUTES,
    // A local model does one thing at a time: learn once the conversation pauses.
    learnDelayMs: (e.MEMORY_LEARN_DELAY_SECONDS ?? (local ? 20 : 0)) * 1000,
    model: e.MEMORY_MODEL ?? (local ? e.OLLAMA_MODEL : "claude-haiku-4-5"),
    embed: {
      provider,
      model:
        e.EMBED_MODEL ?? (provider === "ollama" ? "nomic-embed-text" : "Xenova/all-MiniLM-L6-v2"),
    },
  };
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
