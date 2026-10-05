/** Turns text into vectors for semantic recall. */
export interface Embedder {
  /** Stored with each memory; vectors from different models are never compared. */
  readonly model: string;
  /** "document" for things to remember, "query" for what to look them up by. */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/** nomic-embed-text through Ollama (768 dims). It expects a task prefix on every text. */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly #url: string;

  constructor(url: string, model = "nomic-embed-text") {
    this.#url = url.replace(/\/$/, "");
    this.model = `ollama:${model}`;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const prefix = this.model.includes("nomic") ? `search_${kind}: ` : "";
    const res = await fetch(`${this.#url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model.slice("ollama:".length),
        input: texts.map((t) => prefix + t),
        keep_alive: "30m",
      }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** A small sentence-embedding model in-process (transformers.js), for when Ollama isn't there. */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly #id: string;
  #extract: Promise<FeatureExtractor> | null = null;

  constructor(model = "Xenova/all-MiniLM-L6-v2") {
    this.#id = model;
    this.model = `local:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.#extract ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", this.#id, {
          dtype: "fp32",
          device: "cpu",
        }) as unknown as Promise<FeatureExtractor>,
    );
    this.#extract.catch(() => (this.#extract = null));
    const out = await (await this.#extract)(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}

/** pgvector's text form. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;
