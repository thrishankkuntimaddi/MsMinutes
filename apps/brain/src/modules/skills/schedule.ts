import { randomUUID } from "node:crypto";
import type { Db } from "../memory/db.js";

export type ScheduledKind = "timer" | "reminder";

export type Scheduled = {
  id: string;
  kind: ScheduledKind;
  /** What it's for: "tea", "call mom". */
  label: string;
  dueAt: Date;
  /** Timers only: the length that was asked for. */
  durationSec: number | null;
  /** Where it was set; it fires there if that body is still around. */
  bodyId: string;
  createdAt: Date;
};

type Finish = "fired" | "cancelled" | "missed";

export interface ScheduleStore {
  pending(): Promise<Scheduled[]>;
  add(item: Scheduled): Promise<void>;
  finish(id: string, status: Finish): Promise<void>;
}

/** For when memory (and its database) is off: timers last until the brain stops. */
export class InMemoryScheduleStore implements ScheduleStore {
  readonly #items = new Map<string, Scheduled>();
  async pending() {
    return [...this.#items.values()];
  }
  async add(item: Scheduled) {
    this.#items.set(item.id, item);
  }
  async finish(id: string) {
    this.#items.delete(id);
  }
}

/** Timers and reminders kept in her database, so a restart doesn't lose them. */
export class DbScheduleStore implements ScheduleStore {
  readonly #db: Db;
  readonly #userId: string;

  constructor(db: Db, userId = "me") {
    this.#db = db;
    this.#userId = userId;
  }

  async pending(): Promise<Scheduled[]> {
    const { rows } = await this.#db.query<{
      id: string;
      kind: ScheduledKind;
      label: string;
      due_at: Date | string;
      duration_sec: number | null;
      body_id: string;
      created_at: Date | string;
    }>(
      `select id, kind, label, due_at, duration_sec, body_id, created_at from scheduled
       where user_id = $1 and status = 'pending' order by due_at`,
      [this.#userId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      dueAt: new Date(r.due_at),
      durationSec: r.duration_sec,
      bodyId: r.body_id,
      createdAt: new Date(r.created_at),
    }));
  }

  async add(item: Scheduled): Promise<void> {
    await this.#db.query(
      `insert into scheduled (id, user_id, kind, label, due_at, duration_sec, body_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        item.id,
        this.#userId,
        item.kind,
        item.label,
        item.dueAt,
        item.durationSec,
        item.bodyId,
        item.createdAt,
      ],
    );
  }

  async finish(id: string, status: Finish): Promise<void> {
    await this.#db.query("update scheduled set status = $2, finished_at = now() where id = $1", [
      id,
      status,
    ]);
  }
}

export type SchedulesOptions = {
  store: ScheduleStore;
  /** It's time. `lateMs` > 0 when it came due while the brain was off. */
  onFire: (item: Scheduled, lateMs: number) => void;
  /** The set of active timers and reminders changed (for bodies' displays). */
  onChange?: (items: Scheduled[]) => void;
  now?: () => Date;
  onError?: (err: unknown) => void;
  /** Due longer ago than this when the brain starts: missed, not announced. */
  staleAfterMs?: number;
};

/**
 * Her timers and reminders. Long-running state that fires events back into the brain
 * (§12.1): the first thing that makes her speak without being spoken to (§12.2).
 */
export class Schedules {
  readonly #o: SchedulesOptions;
  #items: Scheduled[] = [];
  #tick: ReturnType<typeof setInterval> | undefined;

  constructor(options: SchedulesOptions) {
    this.#o = options;
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))();
  }

  async start(tickMs = 250): Promise<void> {
    const now = this.#now().getTime();
    const stale = this.#o.staleAfterMs ?? 12 * 3600_000;
    for (const item of await this.#o.store.pending()) {
      if (now - item.dueAt.getTime() > stale) await this.#o.store.finish(item.id, "missed");
      else this.#items.push(item);
    }
    this.#sort();
    this.#tick = setInterval(() => this.#safeCheck(), tickMs);
    this.#tick.unref?.();
    // Anything that came due while the brain was off goes now, before start() returns.
    await this.check().catch((err) => this.#o.onError?.(err));
  }

  stop(): void {
    clearInterval(this.#tick);
  }

  list(kind?: ScheduledKind): Scheduled[] {
    return this.#items.filter((i) => !kind || i.kind === kind);
  }

  async add(item: Omit<Scheduled, "id" | "createdAt">): Promise<Scheduled> {
    const full: Scheduled = { ...item, id: randomUUID(), createdAt: this.#now() };
    await this.#o.store.add(full);
    this.#items.push(full);
    this.#sort();
    this.#changed();
    return full;
  }

  /** Cancel by id, or by label (case-insensitive, soonest first). */
  async cancel(kind: ScheduledKind, idOrLabel?: string): Promise<Scheduled | null> {
    const candidates = this.list(kind);
    const q = idOrLabel?.toLowerCase().trim();
    const item = !q
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : (candidates.find((i) => i.id === idOrLabel) ??
        candidates.find((i) => i.label.toLowerCase() === q) ??
        candidates.find((i) => i.label.toLowerCase().includes(q)));
    if (!item) return null;
    this.#items = this.#items.filter((i) => i.id !== item.id);
    await this.#o.store.finish(item.id, "cancelled");
    this.#changed();
    return item;
  }

  #safeCheck(): void {
    this.check().catch((err) => this.#o.onError?.(err));
  }

  /** Fire whatever is due. Called on a tick; tests call it directly. */
  async check(): Promise<void> {
    const now = this.#now().getTime();
    const due = this.#items.filter((i) => i.dueAt.getTime() <= now);
    if (!due.length) return;
    this.#items = this.#items.filter((i) => !due.includes(i));
    this.#changed();
    for (const item of due) {
      await this.#o.store.finish(item.id, "fired");
      this.#o.onFire(item, Math.max(0, now - item.dueAt.getTime() - 2000));
    }
  }

  #sort(): void {
    this.#items.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  }

  #changed(): void {
    this.#o.onChange?.(this.list());
  }
}
