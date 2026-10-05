import type { Db } from "./db.js";
import { toVector } from "./embedder.js";

export const MEMORY_KINDS = ["fact", "preference", "person", "event", "plan", "routine"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type Memory = {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  recallCount: number;
};

export type Recalled = Memory & { similarity: number };

export type TurnRow = { userText: string; replyText: string; createdAt: string };

export type Conversation = {
  id: string;
  startedAt: string;
  lastTurnAt: string;
  summary: string | null;
};

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  created_at: Date | string;
  updated_at: Date | string;
  recall_count: number;
  similarity?: number;
};

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  importance: Number(r.importance),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  recallCount: Number(r.recall_count),
});

/** Everything she keeps, in Postgres. One user for now; `userId` is on every row. */
export class MemoryStore {
  readonly #db: Db;
  readonly userId: string;

  constructor(db: Db, userId = "me") {
    this.#db = db;
    this.userId = userId;
  }

  async ensureUser(name: string | undefined): Promise<void> {
    await this.#db.query(
      `insert into users (id, name) values ($1, $2)
       on conflict (id) do update set name = coalesce(excluded.name, users.name)`,
      [this.userId, name ?? null],
    );
  }

  // ---------- conversations & turns (episodic) ----------

  async latestConversation(): Promise<Conversation | null> {
    const { rows } = await this.#db.query<{
      id: string;
      started_at: Date;
      last_turn_at: Date;
      summary: string | null;
    }>(
      `select id, started_at, last_turn_at, summary from conversations
       where user_id = $1 order by last_turn_at desc limit 1`,
      [this.userId],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          startedAt: iso(r.started_at),
          lastTurnAt: iso(r.last_turn_at),
          summary: r.summary,
        }
      : null;
  }

  async startConversation(at: Date): Promise<Conversation> {
    const { rows } = await this.#db.query<{ id: string; started_at: Date }>(
      "insert into conversations (user_id, started_at, last_turn_at) values ($1, $2, $2) returning id, started_at",
      [this.userId, at],
    );
    const r = rows[0]!;
    return { id: r.id, startedAt: iso(r.started_at), lastTurnAt: iso(r.started_at), summary: null };
  }

  async addTurn(t: {
    conversationId: string;
    bodyId: string;
    userText: string;
    replyText: string;
    trace?: unknown;
    at: Date;
  }): Promise<string> {
    const { rows } = await this.#db.query<{ id: string }>(
      `insert into turns (conversation_id, body_id, user_text, reply_text, trace, created_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        t.conversationId,
        t.bodyId,
        t.userText,
        t.replyText,
        t.trace ? JSON.stringify(t.trace) : null,
        t.at,
      ],
    );
    await this.#db.query("update conversations set last_turn_at = $2 where id = $1", [
      t.conversationId,
      t.at,
    ]);
    return rows[0]!.id;
  }

  async turns(conversationId: string, limit = 50): Promise<TurnRow[]> {
    const { rows } = await this.#db.query<{
      user_text: string;
      reply_text: string;
      created_at: Date;
    }>(
      `select user_text, reply_text, created_at from
         (select * from turns where conversation_id = $1 order by created_at desc limit $2) t
       order by created_at`,
      [conversationId, limit],
    );
    return rows.map((r) => ({
      userText: r.user_text,
      replyText: r.reply_text,
      createdAt: iso(r.created_at),
    }));
  }

  async setSummary(conversationId: string, summary: string): Promise<void> {
    await this.#db.query("update conversations set summary = $2 where id = $1", [
      conversationId,
      summary,
    ]);
  }

  /** Most recent finished conversation that has a summary, other than `except`. */
  async lastSummary(except?: string): Promise<Conversation | null> {
    const { rows } = await this.#db.query<{
      id: string;
      started_at: Date;
      last_turn_at: Date;
      summary: string;
    }>(
      `select id, started_at, last_turn_at, summary from conversations
       where user_id = $1 and summary is not null and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')
       order by last_turn_at desc limit 1`,
      [this.userId, except ?? null],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          startedAt: iso(r.started_at),
          lastTurnAt: iso(r.last_turn_at),
          summary: r.summary,
        }
      : null;
  }

  async unsummarized(except: string): Promise<Conversation[]> {
    const { rows } = await this.#db.query<{ id: string; started_at: Date; last_turn_at: Date }>(
      `select c.id, c.started_at, c.last_turn_at from conversations c
       where c.user_id = $1 and c.summary is null and c.id <> $2
         and exists (select 1 from turns t where t.conversation_id = c.id)
       order by c.last_turn_at desc limit 3`,
      [this.userId, except],
    );
    return rows.map((r) => ({
      id: r.id,
      startedAt: iso(r.started_at),
      lastTurnAt: iso(r.last_turn_at),
      summary: null,
    }));
  }

  // ---------- memories (semantic) ----------

  async list(): Promise<Memory[]> {
    const { rows } = await this.#db.query<MemoryRow>(
      `select id, kind, content, importance, created_at, updated_at, recall_count
       from memories where user_id = $1 order by importance desc, updated_at desc`,
      [this.userId],
    );
    return rows.map(toMemory);
  }

  async get(id: string): Promise<Memory | null> {
    const { rows } = await this.#db.query<MemoryRow>(
      `select id, kind, content, importance, created_at, updated_at, recall_count
       from memories where user_id = $1 and id = $2`,
      [this.userId, id],
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async add(m: {
    kind: MemoryKind;
    content: string;
    importance: number;
    embedding: number[];
    embedModel: string;
    sourceTurnId?: string | null;
  }): Promise<Memory> {
    const { rows } = await this.#db.query<MemoryRow>(
      `insert into memories (user_id, kind, content, importance, embedding, embed_model, source_turn_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, kind, content, importance, created_at, updated_at, recall_count`,
      [
        this.userId,
        m.kind,
        m.content,
        clamp01(m.importance),
        toVector(m.embedding),
        m.embedModel,
        m.sourceTurnId ?? null,
      ],
    );
    return toMemory(rows[0]!);
  }

  async update(
    id: string,
    patch: {
      kind?: MemoryKind;
      content?: string;
      importance?: number;
      embedding?: number[];
      embedModel?: string;
    },
  ): Promise<Memory | null> {
    const { rows } = await this.#db.query<MemoryRow>(
      `update memories set
         kind = coalesce($3, kind),
         content = coalesce($4, content),
         importance = coalesce($5, importance),
         embedding = coalesce($6::vector, embedding),
         embed_model = coalesce($7, embed_model),
         updated_at = now()
       where user_id = $1 and id = $2
       returning id, kind, content, importance, created_at, updated_at, recall_count`,
      [
        this.userId,
        id,
        patch.kind ?? null,
        patch.content ?? null,
        patch.importance === undefined ? null : clamp01(patch.importance),
        patch.embedding ? toVector(patch.embedding) : null,
        patch.embedModel ?? null,
      ],
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ id: string }>(
      "delete from memories where user_id = $1 and id = $2 returning id",
      [this.userId, id],
    );
    return rows.length > 0;
  }

  async removeAll(): Promise<number> {
    const { rows } = await this.#db.query<{ id: string }>(
      "delete from memories where user_id = $1 returning id",
      [this.userId],
    );
    return rows.length;
  }

  /** Closest memories to a query vector, made by the same embedding model. */
  async search(embedding: number[], embedModel: string, limit: number): Promise<Recalled[]> {
    const { rows } = await this.#db.query<MemoryRow>(
      `select id, kind, content, importance, created_at, updated_at, recall_count,
              1 - (embedding <=> $3) as similarity
       from memories
       where user_id = $1 and embed_model = $2 and embedding is not null
       order by embedding <=> $3
       limit $4`,
      [this.userId, embedModel, toVector(embedding), limit],
    );
    return rows.map((r) => ({ ...toMemory(r), similarity: Number(r.similarity) }));
  }

  /** The most important memories, whatever the topic: who the user is. */
  async core(limit: number, minImportance = 0.8): Promise<Memory[]> {
    const { rows } = await this.#db.query<MemoryRow>(
      `select id, kind, content, importance, created_at, updated_at, recall_count
       from memories where user_id = $1 and importance >= $2
       order by importance desc, updated_at desc limit $3`,
      [this.userId, minImportance, limit],
    );
    return rows.map(toMemory);
  }

  async markRecalled(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#db.query(
      `update memories set recalled_at = now(), recall_count = recall_count + 1
       where user_id = $1 and id = any($2::uuid[])`,
      [this.userId, ids],
    );
  }

  /** Memories that need embedding with the current model (e.g. after switching models). */
  async staleEmbeddings(embedModel: string): Promise<{ id: string; content: string }[]> {
    const { rows } = await this.#db.query<{ id: string; content: string }>(
      `select id, content from memories
       where user_id = $1 and (embed_model is distinct from $2 or embedding is null)`,
      [this.userId, embedModel],
    );
    return rows;
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
