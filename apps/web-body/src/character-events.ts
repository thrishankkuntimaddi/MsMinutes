/**
 * The shared character event contract (PHASE 0).
 *
 * Every subsystem — brain link, voice pipeline, mic/ears, behavior logic,
 * animation controller — speaks through these events. The contract is
 * independent of the rendering technology: switching from the 2D canvas
 * face to a future WebGL/3D renderer should not change any event.
 *
 * Version: 1 — the initial contract. Bump when adding or changing events.
 */

import { z } from "zod";

// ─── Event Version ───────────────────────────────────────────────

export const CHARACTER_EVENT_VERSION = 1;

// ─── Event Schemas ───────────────────────────────────────────────

/** She started speaking a stretch of text. */
export const SpeechStarted = z.object({
  type: z.literal("speech.started"),
  /** The sentence or fragment about to be spoken, when known. */
  text: z.string().optional(),
});

/** She finished speaking (voice pipeline is idle). */
export const SpeechEnded = z.object({
  type: z.literal("speech.ended"),
});

/** A word was reached during speech; for captions and expression cues. */
export const SpeechWord = z.object({
  type: z.literal("speech.word"),
  index: z.number().int().nonnegative(),
  word: z.string(),
});

/** The mic is now on or off. */
export const ListeningChanged = z.object({
  type: z.literal("listening.changed"),
  active: z.boolean(),
});

/** The brain expressed an intent: a mood and optionally a gesture. */
export const ActingIntent = z.object({
  type: z.literal("acting.intent"),
  mood: z.string(),
  intensity: z.number().min(0).max(1).optional(),
  gesture: z.string().optional(),
});

/** A requested action completed normally. */
export const ActionCompleted = z.object({
  type: z.literal("action.completed"),
  action: z.string(),
});

/** A requested action could not be performed. */
export const ActionFailed = z.object({
  type: z.literal("action.failed"),
  action: z.string(),
  reason: z.string(),
});

/** The brain's high-level mode changed (idle / thinking / speaking / listening). */
export const ModeChanged = z.object({
  type: z.literal("mode.changed"),
  mode: z.enum(["idle", "listening", "thinking", "speaking"]),
});

/** The brain link status changed (connecting / online / offline / replaced). */
export const LinkChanged = z.object({
  type: z.literal("link.changed"),
  status: z.enum(["connecting", "online", "offline", "replaced"]),
});

/** A timer or reminder alarm fired. */
export const AlarmFired = z.object({
  type: z.literal("alarm.fired"),
  label: z.string(),
});

/** An animation transition was requested. */
export const AnimationRequested = z.object({
  type: z.literal("animation.requested"),
  action: z.string(),
  /** Whether to interrupt whatever is currently playing. */
  immediate: z.boolean().optional(),
});

// ─── Union ───────────────────────────────────────────────────────

export const CharacterEventSchema = z.discriminatedUnion("type", [
  SpeechStarted,
  SpeechEnded,
  SpeechWord,
  ListeningChanged,
  ActingIntent,
  ActionCompleted,
  ActionFailed,
  ModeChanged,
  LinkChanged,
  AlarmFired,
  AnimationRequested,
]);

export type CharacterEvent = z.infer<typeof CharacterEventSchema>;
export type CharacterEventType = CharacterEvent["type"];

// ─── Event Bus ───────────────────────────────────────────────────

type Handler<T extends CharacterEvent = CharacterEvent> = (event: T) => void;

/**
 * Typed, decoupled event bus for the character system. Subsystems emit here;
 * others subscribe without importing each other.
 *
 * ```ts
 * bus.on("speech.started", (e) => console.log(e.text));
 * bus.emit({ type: "speech.started", text: "Hello!" });
 * ```
 */
export class CharacterEventBus {
  readonly #handlers = new Map<CharacterEventType, Set<Handler<any>>>();
  readonly #wilds = new Set<Handler>();

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<T extends CharacterEventType>(
    type: T,
    handler: Handler<Extract<CharacterEvent, { type: T }>>,
  ): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Subscribe to every event type. */
  onAny(handler: Handler): () => void {
    this.#wilds.add(handler);
    return () => this.#wilds.delete(handler);
  }

  /** Emit an event to all matching subscribers. */
  emit(event: CharacterEvent): void {
    const set = this.#handlers.get(event.type);
    if (set) for (const fn of set) fn(event);
    for (const fn of this.#wilds) fn(event);
  }

  /** Remove all handlers (for teardown / tests). */
  clear(): void {
    this.#handlers.clear();
    this.#wilds.clear();
  }
}
