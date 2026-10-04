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
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
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
  };
}
