import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";

export const BodyId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "bodyId must be lowercase alphanumeric, '-' or '_', max 64");

/** Fields shared by every message, in both directions. */
export const envelopeFields = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  bodyId: BodyId,
  ts: z.number().int().nonnegative(),
  replyTo: z.string().min(1).max(64).optional(),
};

/** Defines one message type: the shared envelope plus a typed payload. */
export function defineMessage<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelopeFields, type: z.literal(type), payload });
}
