import { describe, expect, it } from "vitest";
import { toPcm16Chunks } from "../src/ears.js";

describe("toPcm16Chunks", () => {
  it("splits audio into ~1 s base64 PCM16 chunks", () => {
    const samples = new Float32Array(40_000).fill(0.5);
    const chunks = toPcm16Chunks(samples);
    expect(chunks).toHaveLength(3);
    const bytes = Uint8Array.from(atob(chunks[0]!), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(32_000);
    expect(new Int16Array(bytes.buffer)[0]).toBe(Math.trunc(0.5 * 0x7fff));
  });
});
