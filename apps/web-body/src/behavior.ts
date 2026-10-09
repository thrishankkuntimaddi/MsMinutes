/**
 * Behavior layer (PHASE 0).
 *
 * Subscribes to CharacterEvents and decides which reaction fits the context.
 * This is pure logic — no rendering, no DOM, no audio. It translates
 * high-level intents (the brain said something, the user is speaking,
 * an alarm fired) into concrete rig commands and new events.
 *
 * The existing intro.ts has this logic inlined. This module extracts it so
 * future behavior (gestures, idle fidgets, context-aware reactions) can be
 * added here without touching the renderer or the orchestrator.
 */

import type { Affect } from "@ms-minutes/protocol";
import type { CharacterRig, Action } from "@ms-minutes/character";
import { isAction } from "@ms-minutes/character";
import { type CharacterEvent, type CharacterEventBus } from "./character-events.js";

export type BehaviorOptions = {
  rig: CharacterRig;
  bus: CharacterEventBus;
};

/**
 * Decides which rig actions and expressions to apply in response to events.
 *
 * Keep this class small in Phase 0 — it mirrors what intro.ts already does
 * so the logic can be tested and extended independently.
 */
export class Behavior {
  readonly #rig: CharacterRig;
  readonly #bus: CharacterEventBus;
  readonly #unsubs: (() => void)[] = [];

  /** The last affect set from the brain, used to avoid duplicate body actions. */
  #lastAffect: Affect = "neutral";

  constructor(options: BehaviorOptions) {
    this.#rig = options.rig;
    this.#bus = options.bus;
    this.#subscribe();
  }

  /** Tear down all subscriptions. */
  dispose(): void {
    for (const unsub of this.#unsubs) unsub();
    this.#unsubs.length = 0;
  }

  #subscribe(): void {
    this.#unsubs.push(
      this.#bus.on("acting.intent", (e) => this.#onActingIntent(e)),
      this.#bus.on("speech.started", () => this.#onSpeechStarted()),
      this.#bus.on("speech.ended", () => this.#onSpeechEnded()),
      this.#bus.on("listening.changed", (e) => this.#onListeningChanged(e)),
      this.#bus.on("alarm.fired", () => this.#onAlarm()),
      this.#bus.on("animation.requested", (e) => this.#onAnimationRequested(e)),
    );
  }

  // ─── Reactions ───────────────────────────────────────────────

  #onActingIntent(e: Extract<CharacterEvent, { type: "acting.intent" }>): void {
    const affect = e.mood as Affect;
    const intensity = e.intensity ?? 0.6;

    // Apply the expression to the rig.
    this.#rig.setExpression(affect, intensity);

    // Big feelings move her whole body, not just her face.
    if (affect !== this.#lastAffect) {
      this.#lastAffect = affect;
      if (intensity >= 0.45) {
        if (affect === "excited") this.#rig.act("jump");
        else if (affect === "laughing" || affect === "surprised") this.#rig.hop(0.6);
        else if (affect === "happy" && intensity > 0.8) this.#rig.hop(0.4);
      }
    }

    // If the brain also said a gesture, perform it.
    if (e.gesture && isAction(e.gesture)) {
      this.#rig.act(e.gesture);
      this.#bus.emit({ type: "action.completed", action: e.gesture });
    }
  }

  #onSpeechStarted(): void {
    // When she speaks she looks forward at the listener.
    this.#rig.lookAt(0, 0.05, 600);
  }

  #onSpeechEnded(): void {
    // Release the gaze lock slowly.
    this.#rig.lookAt(0, 0, 0.1);
  }

  #onListeningChanged(e: Extract<CharacterEvent, { type: "listening.changed" }>): void {
    if (e.active) {
      this.#rig.setExpression("curious", 0.4);
      this.#rig.lookAt(0, 0.05, 30);
    }
  }

  #onAlarm(): void {
    this.#rig.setExpression("excited", 0.9);
    this.#rig.ring(2.8);
    this.#rig.act("jump");
  }

  #onAnimationRequested(
    e: Extract<CharacterEvent, { type: "animation.requested" }>,
  ): void {
    if (!isAction(e.action)) {
      this.#bus.emit({
        type: "action.failed",
        action: e.action,
        reason: `unknown action: ${e.action}`,
      });
      return;
    }
    this.#rig.act(e.action);
    this.#bus.emit({ type: "action.completed", action: e.action });
  }
}
