import { z } from "zod";

/**
 * 0 Info · 1 Reversible · 2 Sensitive · 3 Physical/irreversible.
 * See ARCHITECTURE.md §13.2.
 */
export const RiskTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type RiskTier = z.infer<typeof RiskTier>;

/** Dotted lowercase names, e.g. `express`, `display.mode`, `arm.grab`. */
export const CapabilityName = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, "capability names are dotted lowercase");

export const Capability = z.object({
  name: CapabilityName,
  /** Shown to the LLM when the capability is exposed as a tool. */
  description: z.string().min(1).max(500).optional(),
  /** JSON Schema for the capability's arguments. */
  schema: z.record(z.string(), z.unknown()).optional(),
  riskTier: RiskTier,
});
export type Capability = z.infer<typeof Capability>;

export const Capabilities = z
  .array(Capability)
  .max(128)
  .refine((caps) => new Set(caps.map((c) => c.name)).size === caps.length, {
    message: "capability names must be unique",
  });
