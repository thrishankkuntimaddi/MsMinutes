import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";
import { isCorruptModelError, loadRepairingCache } from "../src/modules/voice/model-cache.js";

const truncated = new Error(
  "Load model from /x/.cache/onnx-community/m/onnx/model.onnx failed:Protobuf parsing failed.",
);

describe("model cache repair", () => {
  it("recognises a damaged download, not other failures", () => {
    expect(isCorruptModelError(truncated)).toBe(true);
    expect(isCorruptModelError(new Error("fetch failed"))).toBe(false);
  });

  it("deletes the damaged model and loads it again", async () => {
    const id = `test-org/broken-${Date.now()}`;
    const dir = join(env.cacheDir!, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "model.onnx"), "half a model");
    let calls = 0;
    const model = await loadRepairingCache(id, async () => {
      calls++;
      if (existsSync(dir)) throw truncated;
      return "loaded";
    });
    expect(model).toBe("loaded");
    expect(calls).toBe(2);
  });

  it("passes other errors straight through", async () => {
    const offline = new Error("fetch failed");
    await expect(loadRepairingCache("test-org/none", () => Promise.reject(offline))).rejects.toBe(
      offline,
    );
  });
});
