import type { BodyToBrainMessage } from "@ms-minutes/protocol";
import type { BodyRecord } from "../bodies/registry.js";

/**
 * Everything that reaches the brain is an event (ADR-0002).
 * Utterances, timers, sensors and device lifecycle all flow through here.
 */
export type BrainEvent =
  | { type: "body.connected"; body: BodyRecord }
  | { type: "body.disconnected"; bodyId: string; reason: string }
  | { type: "body.message"; bodyId: string; message: BodyToBrainMessage };

export type BrainEventType = BrainEvent["type"];
type Handler<T extends BrainEventType> = (event: Extract<BrainEvent, { type: T }>) => void;
/** Handlers are stored type-erased; `emit` only calls those registered for the event's type. */
type StoredHandler = (event: never) => void;

/** Synchronous in-process event bus. A failing handler never affects the others. */
export class EventBus {
  readonly #handlers = new Map<BrainEventType, Set<StoredHandler>>();
  readonly #onError: (error: unknown, event: BrainEvent) => void;

  constructor(onError: (error: unknown, event: BrainEvent) => void) {
    this.#onError = onError;
  }

  on<T extends BrainEventType>(type: T, handler: Handler<T>): () => void {
    const set = this.#handlers.get(type) ?? new Set<StoredHandler>();
    set.add(handler);
    this.#handlers.set(type, set);
    return () => set.delete(handler);
  }

  emit(event: BrainEvent): void {
    for (const handler of this.#handlers.get(event.type) ?? []) {
      try {
        (handler as (event: BrainEvent) => void)(event);
      } catch (error) {
        this.#onError(error, event);
      }
    }
  }
}
