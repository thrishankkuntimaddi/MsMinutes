/** The few things the memory module needs from Postgres; PGlite and node-postgres both fit. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/**
 * Opens her memory database (ARCHITECTURE §11):
 * - `postgres://…` → a Postgres server with pgvector (see infra/docker-compose.yml)
 * - `memory://` → an in-memory PGlite, for tests
 * - anything else → a PGlite directory on disk: real Postgres + pgvector, embedded, no server
 */
export async function openDb(location: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(location)) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: location, max: 4 });
    return {
      query: async <T>(sql: string, params?: unknown[]) => {
        const r = await pool.query(sql, params);
        return { rows: r.rows as T[] };
      },
      close: () => pool.end(),
    };
  }
  if (!location.includes("://")) {
    // PGlite makes its own directory but not the ones above it.
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(location), { recursive: true });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const db = new PGlite(location, { extensions: { vector } });
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await db.query<T>(sql, params);
      return { rows: r.rows };
    },
    close: () => db.close(),
  };
}

/** Ordered, append-only. Each runs once, recorded in schema_migrations. */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      create extension if not exists vector;

      create table users (
        id text primary key,
        name text,
        created_at timestamptz not null default now()
      );

      -- One continuous thread with a user, spanning bodies. A long gap starts a new one.
      create table conversations (
        id uuid primary key default gen_random_uuid(),
        user_id text not null references users(id),
        started_at timestamptz not null default now(),
        last_turn_at timestamptz not null default now(),
        summary text
      );

      -- Episodic memory: every exchange, with its trace.
      create table turns (
        id uuid primary key default gen_random_uuid(),
        conversation_id uuid not null references conversations(id),
        body_id text not null,
        user_text text not null,
        reply_text text not null,
        trace jsonb,
        created_at timestamptz not null default now()
      );
      create index turns_by_time on turns (conversation_id, created_at);

      -- Semantic memory: facts and preferences. Embeddings are untyped so models can change;
      -- searches only compare rows made by the same embedding model.
      create table memories (
        id uuid primary key default gen_random_uuid(),
        user_id text not null references users(id),
        kind text not null,
        content text not null,
        embedding vector,
        embed_model text,
        importance real not null default 0.5,
        source_turn_id uuid references turns(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        recalled_at timestamptz,
        recall_count integer not null default 0
      );
      create index memories_by_user on memories (user_id);
    `,
  },
  {
    id: 2,
    sql: `
      -- Timers and reminders (ARCHITECTURE §11.3 "reminders"), so they survive a restart.
      create table scheduled (
        id uuid primary key default gen_random_uuid(),
        user_id text not null references users(id),
        kind text not null,
        label text not null,
        due_at timestamptz not null,
        duration_sec integer,
        body_id text not null,
        status text not null default 'pending',
        created_at timestamptz not null default now(),
        finished_at timestamptz
      );
      create index scheduled_pending on scheduled (user_id, status, due_at);
    `,
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (id integer primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(
    (await db.query<{ id: number }>("select id from schema_migrations")).rows.map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.query("begin");
    try {
      for (const statement of splitStatements(m.sql)) await db.query(statement);
      await db.query("insert into schema_migrations (id) values ($1)", [m.id]);
      await db.query("commit");
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }
}

/** Parameterless statements, one per query (node-postgres and PGlite both accept that). */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
