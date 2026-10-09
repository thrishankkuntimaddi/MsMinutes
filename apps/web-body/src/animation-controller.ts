/**
 * Animation controller (PHASE 0).
 *
 * Sits between the event bus and the CharacterRig: it manages transitions,
 * blending, and safe interruption. Where Behavior decides *what* to do,
 * this controller decides *how* to move — timing, priority, and smooth
 * hand-offs between animations.
 *
 * In Phase 0 this is deliberately thin: it delegates almost everything
 * to the existing CharacterRig + Motion, which already handle springs,
 * locomotion and action queues. The controller adds:
 *
 * 1. A priority system so high-priority animations (alarm, user interrupt)
 *    can preempt low-priority ones (idle wander).
 * 2. Transition state tracking so callers can query what's active.
 * 3. Event emission when transitions complete.
 */

import type { CharacterRig, RigFrame } from "@ms-minutes/character";
import type { Viseme } from "@ms-minutes/character";
import type { CharacterEventBus } from "./character-events.js";

/** From low to high: idle < reaction < speech < alarm < interrupt. */
export type AnimationPriority = 0 | 1 | 2 | 3 | 4;

export const Priority = {
  IDLE: 0 as AnimationPriority,
  REACTION: 1 as AnimationPriority,
  SPEECH: 2 as AnimationPriority,
  ALARM: 3 as AnimationPriority,
  INTERRUPT: 4 as AnimationPriority,
} as const;

export type TransitionRequest = {
  /** A name for debugging/logging, e.g. "walk", "jump", "alarm-ring". */
  name: string;
  priority: AnimationPriority;
  /** Called when this transition becomes active. */
  apply: (rig: CharacterRig) => void;
};

type ActiveTransition = {
  name: string;
  priority: AnimationPriority;
  startedAt: number;
};

export type AnimationControllerOptions = {
  rig: CharacterRig;
  bus: CharacterEventBus;
};

/**
 * Manages animation transitions on the CharacterRig.
 *
 * Usage:
 * ```ts
 * controller.request({
 *   name: "excited-hop",
 *   priority: Priority.REACTION,
 *   apply: (rig) => rig.hop(0.6),
 * });
 * // Each frame:
 * const frame = controller.update(dt);
 * renderer.draw(frame);
 * ```
 */
export class AnimationController {
  readonly #rig: CharacterRig;
  readonly #bus: CharacterEventBus;
  #active: ActiveTransition | null = null;
  #viseme: Viseme | null = null;
  #t = 0;

  constructor(options: AnimationControllerOptions) {
    this.#rig = options.rig;
    this.#bus = options.bus;
  }

  /** What's currently playing, if anything. */
  get active(): Readonly<ActiveTransition> | null {
    return this.#active;
  }

  /** The rig this controller drives. */
  get rig(): CharacterRig {
    return this.#rig;
  }

  /** Set the current mouth shape from speech (forwarded to the rig each frame). */
  setViseme(viseme: Viseme | null): void {
    this.#viseme = viseme;
  }

  /**
   * Request a transition. It runs immediately if nothing higher-priority is active.
   * Returns `true` if the request was accepted.
   */
  request(req: TransitionRequest): boolean {
    if (this.#active && req.priority < this.#active.priority) {
      return false;
    }

    // If something is active, emit completion for it (interrupted).
    if (this.#active) {
      this.#bus.emit({
        type: "action.completed",
        action: this.#active.name,
      });
    }

    req.apply(this.#rig);

    this.#active = {
      name: req.name,
      priority: req.priority,
      startedAt: this.#t,
    };

    return true;
  }

  /**
   * Cancel the current transition. Only succeeds if the caller's priority
   * is >= the active one.
   */
  interrupt(priority: AnimationPriority = Priority.INTERRUPT): boolean {
    if (!this.#active) return true;
    if (priority < this.#active.priority) return false;
    this.#active = null;
    return true;
  }

  /**
   * Advance one frame. Drives the rig with current viseme, returns the frame
   * for the renderer.
   */
  update(dt: number, now?: Date): RigFrame {
    this.#t += dt;
    this.#rig.setViseme(this.#viseme);
    const frame = this.#rig.update(dt, now);

    // Clear the active transition when the rig's motion queue drains.
    if (this.#active && !this.#rig.motion.busy) {
      const finished = this.#active;
      this.#active = null;
      this.#bus.emit({ type: "action.completed", action: finished.name });
    }

    return frame;
  }
}
