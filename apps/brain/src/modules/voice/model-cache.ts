import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * A download cut short (Ctrl+C, a dropped connection) leaves a truncated model in the
 * transformers.js cache, and every later load fails on it. ONNX Runtime reports that as
 * "Load model from … failed: Protobuf parsing failed" and similar.
 */
export function isCorruptModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /protobuf parsing failed|load model from .* failed|invalid (protobuf|model)|unexpected end of (json|data)/i.test(
    message,
  );
}

/**
 * Loads a Hugging Face model; if its cached files are damaged, deletes them and loads once
 * more, which downloads a fresh copy.
 */
export async function loadRepairingCache<T>(modelId: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isCorruptModelError(err)) throw err;
    const { env } = await import("@huggingface/transformers");
    if (!env.cacheDir) throw err;
    const dir = join(env.cacheDir, modelId);
    console.warn(`${modelId}: cached download is damaged; downloading it again`);
    await rm(dir, { recursive: true, force: true });
    return load();
  }
}
