import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Affect } from "@ms-minutes/protocol";

export const SET_EXPRESSION = "set_expression";

/** Validated input of set_expression. Out-of-range intensity is clamped rather than rejected. */
export const SetExpressionInput = z.object({
  affect: Affect,
  intensity: z.number().transform((n) => Math.min(1, Math.max(0, n))),
});

/**
 * Her face, exposed as a tool (ADR-0003). The tool list stays fixed for the whole
 * conversation so the prompt cache and thinking blocks stay valid.
 */
export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: SET_EXPRESSION,
    description:
      "Change the expression on your face. Call it when your mood fits the moment or shifts. " +
      "intensity is 0 to 1: 0.3–0.6 for most moments, higher only when it is really warranted.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        affect: { type: "string", enum: [...Affect.options] },
        intensity: { type: "number" },
      },
      required: ["affect", "intensity"],
      additionalProperties: false,
    },
  },
];
