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
  TTS_SPEED: z.coerce.number().min(0.5).max(2).default(1),
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
  };
}
