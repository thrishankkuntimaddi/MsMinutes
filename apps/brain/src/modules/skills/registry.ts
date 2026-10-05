import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PolicyGate } from "./policy.js";
import { SkillError, toolName, type Skill, type SkillContext } from "./skill.js";

export type SkillOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Skills registered at startup, presented to the model as tools (§12.1). */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();
  readonly #policy: PolicyGate;

  constructor(policy: PolicyGate) {
    this.#policy = policy;
  }

  register<A, R>(skill: Skill<A, R>): this {
    this.#skills.set(toolName(skill.name), skill as Skill);
    return this;
  }

  has(tool: string): boolean {
    return this.#skills.has(tool);
  }

  /** Fixed for the life of the brain, so the prompt cache stays valid. */
  tools(): Anthropic.Beta.BetaTool[] {
    return [...this.#skills.entries()].map(([name, skill]) => {
      const schema = z.toJSONSchema(skill.schema, { io: "input" }) as Record<string, unknown>;
      delete schema.$schema;
      return {
        name,
        description: skill.description,
        eager_input_streaming: true,
        input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      };
    });
  }

  /** Validate, ask the policy gate, run. Never throws: the model gets the error to work with. */
  async run(tool: string, input: unknown, ctx: SkillContext): Promise<SkillOutcome> {
    const skill = this.#skills.get(tool);
    if (!skill) return { ok: false, error: `Unknown tool "${tool}".` };
    const args = skill.schema.safeParse(input);
    if (!args.success) return { ok: false, error: z.prettifyError(args.error) };
    const decision = this.#policy.decide(skill.name, skill.riskTier, ctx.bodyId);
    if (!decision.allow) return { ok: false, error: decision.reason };
    try {
      return { ok: true, result: await skill.execute(args.data, ctx) };
    } catch (err) {
      if (err instanceof SkillError) return { ok: false, error: err.message };
      ctx.log.warn({ err, skill: skill.name }, "skill failed");
      return { ok: false, error: `${skill.name} failed unexpectedly.` };
    }
  }
}
