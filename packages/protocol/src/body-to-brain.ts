import { z } from "zod";
import { AudioChunkFields } from "./audio.js";
import { Capabilities } from "./capability.js";
import { defineMessage } from "./envelope.js";

const Empty = z.object({});

export const Hello = defineMessage(
  "hello",
  z.object({
    bodyType: z.string().min(1).max(64),
    firmware: z.string().min(1).max(64),
    capabilities: Capabilities,
  }),
);

export const Heartbeat = defineMessage("heartbeat", Empty);

export const UtteranceText = defineMessage(
  "event.utterance.text",
  z.object({ text: z.string().min(1).max(4000) }),
);

export const AudioChunk = defineMessage("event.audio.chunk", z.object(AudioChunkFields));

export const AudioEnd = defineMessage("event.audio.end", Empty);

export const Interrupt = defineMessage("event.interrupt", Empty);

export const Sensor = defineMessage(
  "event.sensor",
  z.object({
    kind: z.string().min(1).max(64),
    data: z.record(z.string(), z.unknown()),
  }),
);

export const CapabilityResult = defineMessage(
  "capability.result",
  z.object({
    callId: z.string().min(1).max(64),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
);

export const BodyToBrainMessage = z.discriminatedUnion("type", [
  Hello,
  Heartbeat,
  UtteranceText,
  AudioChunk,
  AudioEnd,
  Interrupt,
  Sensor,
  CapabilityResult,
]);
export type BodyToBrainMessage = z.infer<typeof BodyToBrainMessage>;
export type BodyToBrainType = BodyToBrainMessage["type"];
