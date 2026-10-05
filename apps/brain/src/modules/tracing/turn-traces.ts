export type TurnTrace = {
  turnId: string;
  bodyId: string;
  startedAt: string;
  /** Time from the start of the turn until her first word. */
  firstTextMs: number | null;
  totalMs: number;
  llmCalls: number;
  expressions: string[];
  /** Body actions asked for with tags, e.g. "jump". */
  actions: string[];
  /** Time from the start of the turn until her first audio, when the brain speaks. */
  firstAudioMs?: number | null;
  /** Speech recognition time, when the turn came from her hearing you. */
  sttMs?: number;
  /** The user talked over her and the turn was cut short. */
  interrupted?: boolean;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  error?: string;
};

/** Keeps the most recent turns in memory for debugging. Persisted with turns in Phase 5. */
export class TurnTraces {
  readonly #traces: TurnTrace[] = [];
  readonly #limit: number;

  constructor(limit = 50) {
    this.#limit = limit;
  }

  add(trace: TurnTrace): void {
    this.#traces.push(trace);
    if (this.#traces.length > this.#limit) this.#traces.shift();
  }

  /** Newest first. */
  list(): TurnTrace[] {
    return [...this.#traces].reverse();
  }
}
