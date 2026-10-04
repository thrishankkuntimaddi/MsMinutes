import { z } from "zod";
import { BodyToBrainMessage, type BodyToBrainType } from "./body-to-brain.js";
import { BrainToBodyMessage, type BrainToBodyType } from "./brain-to-body.js";
import { PROTOCOL_VERSION } from "./version.js";

export type DecodeErrorCode = "invalid_json" | "unsupported_version" | "invalid_message";

export type DecodeResult<M> =
  | { ok: true; message: M }
  | { ok: false; code: DecodeErrorCode; error: string; id?: string; bodyId?: string };

type MessageOf<U, T> = Extract<U, { type: T }>;
type PayloadOf<U, T> = MessageOf<U, T> extends { payload: infer P } ? P : never;

function decodeWith<S extends z.ZodType>(schema: S, raw: string): DecodeResult<z.infer<S>> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json", error: "message is not valid JSON" };
  }

  // Keep id/bodyId when present so error replies can still be correlated.
  const loose = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const id = typeof loose.id === "string" ? loose.id : undefined;
  const bodyId = typeof loose.bodyId === "string" ? loose.bodyId : undefined;

  if ("v" in loose && loose.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "unsupported_version",
      error: `unsupported protocol version ${String(loose.v)}; brain speaks v${PROTOCOL_VERSION}`,
      id,
      bodyId,
    };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, code: "invalid_message", error: z.prettifyError(result.error), id, bodyId };
  }
  return { ok: true, message: result.data };
}

export const decodeBodyMessage = (raw: string) => decodeWith(BodyToBrainMessage, raw);
export const decodeBrainMessage = (raw: string) => decodeWith(BrainToBodyMessage, raw);

export const encode = (message: BodyToBrainMessage | BrainToBodyMessage): string =>
  JSON.stringify(message);

function envelope(type: string, bodyId: string, payload: unknown, replyTo?: string) {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    type,
    bodyId,
    ts: Date.now(),
    ...(replyTo === undefined ? {} : { replyTo }),
    payload,
  };
}

/** Builds a brain → body message with a fresh id and timestamp. */
export function brainMessage<T extends BrainToBodyType>(
  type: T,
  bodyId: string,
  payload: PayloadOf<BrainToBodyMessage, T>,
  replyTo?: string,
): MessageOf<BrainToBodyMessage, T> {
  return envelope(type, bodyId, payload, replyTo) as MessageOf<BrainToBodyMessage, T>;
}

/** Builds a body → brain message with a fresh id and timestamp. */
export function bodyMessage<T extends BodyToBrainType>(
  type: T,
  bodyId: string,
  payload: PayloadOf<BodyToBrainMessage, T>,
  replyTo?: string,
): MessageOf<BodyToBrainMessage, T> {
  return envelope(type, bodyId, payload, replyTo) as MessageOf<BodyToBrainMessage, T>;
}
