import { z } from "zod";

/** Emotions the persona can express. Bodies decide how to render each one. */
export const Affect = z.enum([
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "curious",
  "confused",
  "sleepy",
  "excited",
  "concerned",
  "laughing",
  "thinking",
]);
export type Affect = z.infer<typeof Affect>;

/** High-level body state. Listening/speaking are modes, not emotions. */
export const BodyMode = z.enum(["idle", "listening", "thinking", "speaking", "timer_running"]);
export type BodyMode = z.infer<typeof BodyMode>;

export const Intensity = z.number().min(0).max(1);
