import type { FastifyBaseLogger } from "fastify";
import type { Embedder } from "./embedder.js";
import type { Extractor } from "./extractor.js";
import type { Conversation, Memory, MemoryKind, MemoryStore, Recalled, TurnRow } from "./store.js";

export type MemoryDeps = {
  store: MemoryStore;
  embedder: Embedder;
  extractor: Extractor;
  userName: string | undefined;
  timezone: string;
  log: FastifyBaseLogger;
  /** A gap longer than this starts a new conversation. */
  gapMinutes?: number;
  /**
   * Learning (extraction, summaries) waits until the conversation has been quiet this long.
   * With a local model it would otherwise queue in front of her next reply.
   */
  learnDelayMs?: number;
  now?: () => Date;
};

export type TurnRecord = {
  bodyId: string;
  userText: string;
  replyText: string;
  trace?: unknown;
};

const RECALL_CANDIDATES = 12;
const RECALL_MAX = 6;
/** Her most important memories always come along, whatever the topic. */
const CORE_MAX = 5;
const CORE_MIN_IMPORTANCE = 0.7;
/** Below this, an extracted "fact" is trivia or noise (small models over-collect). */
const MIN_IMPORTANCE = 0.4;
/** Two memories this close say the same thing; the newer wording replaces the older. */
const DUPLICATE_SIMILARITY = 0.92;

/**
 * Her long-term memory (ARCHITECTURE §11): episodic turns, semantic facts with
 * embeddings, and conversation summaries. Reads happen before a turn, writes after it,
 * off the hot path.
 */
export class MemoryService {
  readonly #deps: MemoryDeps;
  #conversation: Conversation | null = null;
  #turnsInConversation = 0;
  #queue: Promise<void> = Promise.resolve();
  /** Model work waiting for a quiet moment. */
  #later: (() => Promise<void>)[] = [];
  #laterTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: MemoryDeps) {
    this.#deps = deps;
  }

  get #now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  /**
   * Opens the store and picks up where she left off. Returns the exchanges of a
   * conversation still in progress, so a restarted brain continues it.
   */
  async start(): Promise<TurnRow[]> {
    const { store, embedder, log, userName } = this.#deps;
    await store.ensureUser(userName);

    // Memories embedded by another model (or added without one) get re-embedded.
    const stale = await store.staleEmbeddings(embedder.model);
    if (stale.length) {
      const vectors = await embedder.embed(
        stale.map((s) => s.content),
        "document",
      );
      for (const [i, s] of stale.entries()) {
        await store.update(s.id, { embedding: vectors[i]!, embedModel: embedder.model });
      }
      log.info({ count: stale.length, model: embedder.model }, "re-embedded memories");
    }

    const latest = await store.latestConversation();
    if (latest && !this.#isStale(latest)) {
      this.#conversation = latest;
      const turns = await store.turns(latest.id, 20);
      this.#turnsInConversation = turns.length;
      return turns;
    }
    return [];
  }

  /**
   * Context for her next reply: what she remembers that bears on `text`. `fresh` means a
   * new conversation began (after a long gap): her working context should start over.
   */
  async recall(text: string): Promise<{ note: string; fresh: boolean }> {
    this.#postpone();
    const { store, embedder, log } = this.#deps;
    const started = !this.#conversation || this.#isStale(this.#conversation);
    if (started) await this.#newConversation();

    let relevant: Recalled[] = [];
    try {
      const [query] = await embedder.embed([text], "query");
      relevant = pickRelevant(await store.search(query!, embedder.model, RECALL_CANDIDATES));
    } catch (err) {
      log.warn({ err }, "memory search failed; answering without it");
    }
    const core = (await store.core(CORE_MAX, CORE_MIN_IMPORTANCE)).filter(
      (c) => !relevant.some((r) => r.id === c.id),
    );
    const memories: Memory[] = [...core, ...relevant];
    void store.markRecalled(memories.map((m) => m.id)).catch(() => {});

    const lines: string[] = [];
    if (memories.length) {
      const who = this.#deps.userName ?? "them";
      lines.push(
        `Things you remember about ${who} (use them when they help; never recite the list):`,
        ...memories.map((m) => `- ${m.content}`),
      );
    }
    // At the start of a conversation, what you talked about last time.
    if (this.#turnsInConversation === 0) {
      const last = await store.lastSummary(this.#conversation?.id);
      // Background only: a small model otherwise keeps steering back to it.
      if (last?.summary)
        lines.push(
          `Last time you talked (${this.#when(last.lastTurnAt)}): ${last.summary}`,
          "That was then. Don't bring it up or ask about it unless they do; talk about what they say now.",
        );
    }
    return { note: lines.length ? `<memory>\n${lines.join("\n")}\n</memory>` : "", fresh: started };
  }

  /** Stores the exchange and, in the background, learns from it. */
  /** Resolves when the turn is stored and anything it queued right away has run. */
  async remember(turn: TurnRecord): Promise<void> {
    this.#run(() => this.#learn(turn));
    await this.#settle();
  }

  /** Runs everything waiting, now, and resolves when memory work is done (shutdown, tests). */
  async idle(): Promise<void> {
    clearTimeout(this.#laterTimer);
    this.#flush();
    await this.#settle();
  }

  /** Jobs can queue more jobs; wait until the queue stops growing. */
  async #settle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#queue;
      await seen;
    } while (seen !== this.#queue);
  }

  #run(job: () => Promise<void>): void {
    this.#queue = this.#queue
      .then(job)
      .catch((err) => this.#deps.log.warn({ err }, "memory write failed"));
  }

  /** Model work: now, or once things have been quiet for `learnDelayMs`. */
  #defer(job: () => Promise<void>): void {
    if (!this.#deps.learnDelayMs) return this.#run(job);
    this.#later.push(job);
    this.#postpone();
  }

  /** Someone's talking: push waiting model work back. */
  #postpone(): void {
    if (!this.#later.length) return;
    clearTimeout(this.#laterTimer);
    this.#laterTimer = setTimeout(() => this.#flush(), this.#deps.learnDelayMs);
    this.#laterTimer.unref?.();
  }

  #flush(): void {
    const jobs = this.#later;
    this.#later = [];
    for (const job of jobs) this.#run(job);
  }

  // ---------- user control (§11.2: viewable, editable, deletable) ----------

  list(): Promise<Memory[]> {
    return this.#deps.store.list();
  }

  async add(m: { kind: MemoryKind; content: string; importance?: number }): Promise<Memory> {
    const [embedding] = await this.#deps.embedder.embed([m.content], "document");
    return this.#deps.store.add({
      ...m,
      importance: m.importance ?? 0.7,
      embedding: embedding!,
      embedModel: this.#deps.embedder.model,
    });
  }

  async edit(
    id: string,
    patch: { kind?: MemoryKind; content?: string; importance?: number },
  ): Promise<Memory | null> {
    const embedding = patch.content
      ? (await this.#deps.embedder.embed([patch.content], "document"))[0]
      : undefined;
    return this.#deps.store.update(id, {
      ...patch,
      ...(embedding ? { embedding, embedModel: this.#deps.embedder.model } : {}),
    });
  }

  forget(id: string): Promise<boolean> {
    return this.#deps.store.remove(id);
  }

  forgetAll(): Promise<number> {
    return this.#deps.store.removeAll();
  }

  // ---------- internals ----------

  async #learn(turn: TurnRecord): Promise<void> {
    const { store } = this.#deps;
    if (!this.#conversation || this.#isStale(this.#conversation)) await this.#newConversation();
    const conversation = this.#conversation!;
    const at = this.#now;
    const turnId = await store.addTurn({ conversationId: conversation.id, ...turn, at });
    this.#conversation = { ...conversation, lastTurnAt: at.toISOString() };
    this.#turnsInConversation++;

    if (worthLearning(turn.userText)) this.#defer(() => this.#extract(turn, turnId));
  }

  async #extract(turn: TurnRecord, turnId: string): Promise<void> {
    const { store, embedder, extractor, log, userName } = this.#deps;
    const [about] = await embedder.embed([`${turn.userText}\n${turn.replyText}`], "query");
    const known = (await store.search(about!, embedder.model, 8)).filter((m) => m.similarity > 0.2);
    const change = await extractor.extract({
      userName,
      now: this.#format(this.#now, { dateStyle: "full", timeStyle: "short" }),
      calendar: this.#calendar(),
      userText: turn.userText,
      replyText: turn.replyText,
      known,
    });
    const knownIds = new Set(known.map((k) => k.id));

    for (const id of change.forget) {
      // Only ids she was shown: a model can't invent an id and wipe something else.
      if (knownIds.has(id) && (await store.remove(id))) log.info({ id }, "forgot a memory");
    }
    for (const u of change.update) {
      if (!knownIds.has(u.id) || !u.content.trim()) continue;
      const content = fixWeekdays(u.content.trim());
      const [embedding] = await embedder.embed([content], "document");
      await store.update(u.id, {
        content,
        importance: u.importance,
        embedding: embedding!,
        embedModel: embedder.model,
      });
      log.info({ id: u.id, content: u.content }, "updated a memory");
    }
    for (const a of change.add) {
      const content = fixWeekdays(a.content.trim());
      if (!content || a.importance < MIN_IMPORTANCE) continue;
      const [embedding] = await embedder.embed([content], "document");
      const [nearest] = await store.search(embedding!, embedder.model, 1);
      if (nearest && nearest.similarity >= DUPLICATE_SIMILARITY) {
        await store.update(nearest.id, {
          content,
          importance: Math.max(nearest.importance, a.importance),
          embedding: embedding!,
          embedModel: embedder.model,
        });
        log.info({ id: nearest.id, content }, "refreshed a memory");
        continue;
      }
      const m = await store.add({
        kind: a.kind,
        content,
        importance: a.importance,
        embedding: embedding!,
        embedModel: embedder.model,
        sourceTurnId: turnId,
      });
      log.info({ id: m.id, kind: m.kind, content }, "remembered");
    }
  }

  async #newConversation(): Promise<void> {
    const { store } = this.#deps;
    this.#conversation = await store.startConversation(this.#now);
    this.#turnsInConversation = 0;
    // Summarize the ones that ended, in the background, for "last time we talked".
    const ended = await store.unsummarized(this.#conversation.id);
    for (const c of ended) this.#defer(() => this.#summarize(c));
  }

  async #summarize(c: Conversation): Promise<void> {
    const { store, extractor, userName, log } = this.#deps;
    const turns = await store.turns(c.id, 40);
    if (!turns.length) return;
    const who = userName ?? "Person";
    const transcript = turns
      .map((t) => `${who}: ${t.userText}\nMs. Minutes: ${t.replyText}`)
      .join("\n");
    const summary = await extractor.summarize(transcript, userName);
    if (summary) {
      await store.setSummary(c.id, summary);
      log.info({ conversationId: c.id, summary }, "summarized a conversation");
    }
  }

  /** "Mon 6 Oct, Tue 7 Oct, …" for the next 14 days. */
  #calendar(): string {
    const days: string[] = [];
    for (let i = 1; i <= 14; i++) {
      const d = new Date(this.#now.getTime() + i * 86_400_000);
      days.push(this.#format(d, { weekday: "short", day: "numeric", month: "short" }));
    }
    return days.join(", ");
  }

  #isStale(c: Conversation): boolean {
    const gap = this.#now.getTime() - new Date(c.lastTurnAt).getTime();
    return gap > (this.#deps.gapMinutes ?? 30) * 60_000;
  }

  #when(iso: string): string {
    return this.#format(new Date(iso), {
      weekday: "long",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  #format(d: Date, options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone: this.#deps.timezone, ...options }).format(
      d,
    );
  }
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Small models get weekdays wrong ("Friday 12 October 2026" is a Monday). When a memory
 * names both and they disagree, trust the weekday and move to the nearest such date.
 */
export function fixWeekdays(text: string): string {
  return text.replace(
    /\b(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day(,?\s+)(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi,
    (whole, day: string, sep: string, date: string, month: string, year: string) => {
      const wanted = WEEKDAYS.findIndex((w) => w.startsWith(day.toLowerCase()));
      const d = new Date(Date.UTC(+year, MONTHS.indexOf(month.toLowerCase()), +date));
      const off = (wanted - d.getUTCDay() + 7) % 7;
      if (off === 0) return whole;
      const fixed = new Date(d.getTime() + (off <= 3 ? off : off - 7) * 86_400_000);
      const name = WEEKDAYS[wanted]!;
      const m = MONTHS[fixed.getUTCMonth()]!;
      return `${name[0]!.toUpperCase()}${name.slice(1)}${sep}${fixed.getUTCDate()} ${m[0]!.toUpperCase()}${m.slice(1)} ${fixed.getUTCFullYear()}`;
    },
  );
}

/**
 * Facts about someone come from them talking about themselves (or asking her to remember
 * or forget). "hi", "thanks" and "what's for dinner?" teach nothing, and skipping them keeps
 * a small model from rewriting good memories out of her own reply.
 */
export function worthLearning(userText: string): boolean {
  const text = userText.toLowerCase();
  if (text.trim().split(/\s+/).length < 3) return false;
  return /\b(i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|our|us)\b|\b(remember|forget)\b/.test(
    text,
  );
}

/** The clearly relevant few: close to the best match, and not just noise. */
export function pickRelevant(candidates: Recalled[]): Recalled[] {
  if (!candidates.length) return [];
  const best = candidates[0]!.similarity;
  return candidates
    .filter((c) => c.similarity >= Math.max(0.3, best - 0.2))
    .sort((a, b) => b.similarity + 0.1 * b.importance - (a.similarity + 0.1 * a.importance))
    .slice(0, RECALL_MAX);
}
