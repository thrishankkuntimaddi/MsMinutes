import { z } from "zod";

export const AudioCodec = z.enum(["pcm16", "opus", "mp3"]);
export type AudioCodec = z.infer<typeof AudioCodec>;

export const AudioChunkFields = {
  seq: z.number().int().nonnegative(),
  codec: AudioCodec,
  sampleRate: z.number().int().positive(),
  /** Base64-encoded audio. Binary frames will replace this later. */
  data: z.string().max(512 * 1024),
};
