import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { RiskTier } from "@ms-minutes/protocol";

/** What a skill can know about the turn that called it. */
export type SkillContext = {
  /** The body the request came through. */
  bodyId: string;
  now: Date;
  timezone: string;
  log: FastifyBaseLogger;
};

/**
 * A server-side tool with a deterministic executor (ARCHITECTURE §12.1). The model only
 * proposes a call; the arguments are validated and the policy gate decides before it runs.
 */
export type Skill<A = unknown, R = unknown> = {
  /** Dotted name, e.g. "timer.start". Exposed to the model as "timer_start". */
  name: string;
  /** Shown to the model. Say when to use it. */
  description: string;
  schema: z.ZodType<A>;
  riskTier: RiskTier;
  execute(args: A, ctx: SkillContext): Promise<R>;
};

/** Tool names may not contain dots. */
export const toolName = (skillName: string) => skillName.replace(/\./g, "_");

/** A failure the model should see and can recover from (bad place name, unknown timer…). */
export class SkillError extends Error {
  override name = "SkillError";
}
