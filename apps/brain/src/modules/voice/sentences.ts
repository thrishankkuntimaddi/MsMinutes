/** Longest stretch kept without a sentence end before breaking at a comma. */
const MAX_CHUNK = 180;

/**
 * Splits streamed text into speakable pieces (ARCHITECTURE §10.1, "sentence chunker"),
 * so speech synthesis can start on the first sentence while the model writes the rest.
 */
export class SentenceChunker {
  #buffer = "";
  #first = true;

  push(delta: string): string[] {
    this.#buffer += delta;
    const out: string[] = [];
    let match: RegExpMatchArray | null;
    // A sentence ends at . ! ? … followed by whitespace, so "3.5" isn't split.
    while ((match = this.#buffer.match(/^[\s\S]*?[.!?…]+["')\]]*\s+/))) {
      out.push(match[0]);
      this.#buffer = this.#buffer.slice(match[0].length);
    }
    // Her first words matter most for latency: a reply may start on its first clause.
    if (this.#first && out.length === 0) {
      const comma = this.#buffer.indexOf(", ", 20);
      if (comma > 0 && comma < 90) {
        out.push(this.#buffer.slice(0, comma + 1));
        this.#buffer = this.#buffer.slice(comma + 2);
      }
    }
    if (out.length) this.#first = false;
    if (this.#buffer.length > MAX_CHUNK) {
      const cut = this.#buffer.lastIndexOf(", ", MAX_CHUNK);
      if (cut > 40) {
        out.push(this.#buffer.slice(0, cut + 1));
        this.#buffer = this.#buffer.slice(cut + 2);
      }
    }
    return out.map(clean).filter(Boolean);
  }

  flush(): string[] {
    const rest = clean(this.#buffer);
    this.#buffer = "";
    return rest ? [rest] : [];
  }
}

function clean(text: string): string {
  const t = text
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[A-Za-z0-9]/.test(t) ? t : "";
}
