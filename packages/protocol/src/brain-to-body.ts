import { z } from "zod";
import { Affect, BodyMode, Intensity } from "./affect.js";
import { AudioChunkFields } from "./audio.js";
import { CapabilityName } from "./capability.js";
import { defineMessage } from "./envelope.js";

const TurnId = z.string().min(1).max(64);

export const Welcome = defineMessage(
  "welcome",
  z.object({
    sessionId: z.string().min(1),
    persona: z.object({ name: z.string().min(1) }),
    /** Capability names this body is currently permitted to have invoked. */
    permissions: z.array(CapabilityName),
    /** Body must send a heartbeat (or any message) at least this often. */
    heartbeatIntervalMs: z.number().int().positive(),
  }),
);

export const StateSet = defineMessage("state.set", z.object({ mode: BodyMode }));

export const ExpressionSet = defineMessage(
  "expression.set",
  z.object({
    affect: Affect,
    intensity: Intensity,
    transitionMs: z.number().int().nonnegative().max(10_000),
    /** Optional secondary affects blended on top, e.g. happy + sleepy. */
    blend: z
      .array(z.object({ affect: Affect, weight: Intensity }))
      .max(4)
      .optional(),
  }),
);

export const SpeechTextDelta = defineMessage(
  "speech.text.delta",
  z.object({ turnId: TurnId, text: z.string() }),
);

export const SpeechAudioChunk = defineMessage(
  "speech.audio.chunk",
  z.object({ turnId: TurnId, ...AudioChunkFields }),
);

export const SpeechMarks = defineMessage(
  "speech.marks",
  z.object({
    turnId: TurnId,
    marks: z.array(
      z.object({
        t: z.number().nonnegative(),
        kind: z.enum(["word", "viseme"]),
        value: z.string(),
      }),
    ),
  }),
);

export const SpeechEnd = defineMessage("speech.end", z.object({ turnId: TurnId }));

export const SpeechCancel = defineMessage("speech.cancel", z.object({ turnId: TurnId }));

export const CapabilityCall = defineMessage(
  "capability.call",
  z.object({
    callId: z.string().min(1).max(64),
    name: CapabilityName,
    args: z.record(z.string(), z.unknown()),
  }),
);

export const ErrorCode = z.enum([
  "invalid_message",
  "unsupported_version",
  "hello_required",
  "duplicate_hello",
  "body_id_mismatch",
  "replaced",
  "heartbeat_timeout",
  "not_implemented",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = defineMessage(
  "error",
  z.object({
    code: ErrorCode,
    message: z.string(),
    /** When true the brain closes the connection right after sending this. */
    fatal: z.boolean(),
  }),
);

export const BrainToBodyMessage = z.discriminatedUnion("type", [
  Welcome,
  StateSet,
  ExpressionSet,
  SpeechTextDelta,
  SpeechAudioChunk,
  SpeechMarks,
  SpeechEnd,
  SpeechCancel,
  CapabilityCall,
  ErrorMessage,
]);
export type BrainToBodyMessage = z.infer<typeof BrainToBodyMessage>;
export type BrainToBodyType = BrainToBodyMessage["type"];
