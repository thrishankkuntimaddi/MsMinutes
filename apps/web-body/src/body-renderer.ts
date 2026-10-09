/**
 * Body renderer interface (PHASE 0).
 *
 * Abstracts the rendering surface so the 2D canvas face (ClockRenderer) and
 * a future 3D/WebGL renderer can be swapped without changing anything above.
 *
 * The current ClockRenderer already fulfils this interface — this module
 * just formalises the contract and provides a factory for it.
 */

import type { RigFrame } from "@ms-minutes/character";
import { ClockRenderer, roomStage, TV_STAGE, type Stage, type TimerFace } from "./renderer.js";

// ─── Renderer Interface ──────────────────────────────────────────

/**
 * Anything that can render a character frame. The existing 2D canvas renderer
 * and any future 3D renderer implement this.
 */
export interface BodyRenderer {
  /** The stage geometry (canvas dimensions, floor line, etc.). */
  readonly stage: Stage;

  /** Set the timer overlay shown on her face. */
  set timer(face: TimerFace | null);

  /** Map a screen point to face-space coordinates (-1..1 around her face). */
  toFaceSpace(clientX: number, clientY: number): { x: number; y: number };

  /** Draw a frame with a character on stage. */
  draw(frame: RigFrame): void;

  /** Draw an empty stage (she's away, e.g. out of the TV). */
  drawEmpty(): void;
}

// ─── Renderer Kind ───────────────────────────────────────────────

export type RendererKind = "canvas2d";
// Future: | "webgl" | "three"

// ─── Canvas 2D Adapter ──────────────────────────────────────────

/**
 * Wraps ClockRenderer to satisfy the BodyRenderer interface.
 * This is zero-overhead: ClockRenderer already has these methods.
 */
export class Canvas2DBodyRenderer implements BodyRenderer {
  readonly #inner: ClockRenderer;

  constructor(canvas: HTMLCanvasElement, options: { room?: boolean } = {}) {
    this.#inner = new ClockRenderer(canvas, options);
  }

  get stage(): Stage {
    return this.#inner.stage;
  }

  set timer(face: TimerFace | null) {
    this.#inner.timer = face;
  }

  toFaceSpace(clientX: number, clientY: number): { x: number; y: number } {
    return this.#inner.toFaceSpace(clientX, clientY);
  }

  draw(frame: RigFrame): void {
    this.#inner.draw(frame);
  }

  drawEmpty(): void {
    this.#inner.drawEmpty();
  }
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a body renderer. Today only `"canvas2d"` is available;
 * when a 3D renderer ships, this function will pick it by kind.
 */
export function createBodyRenderer(
  kind: RendererKind,
  canvas: HTMLCanvasElement,
  options: { room?: boolean } = {},
): BodyRenderer {
  switch (kind) {
    case "canvas2d":
      return new Canvas2DBodyRenderer(canvas, options);
    default:
      throw new Error(`Unknown renderer kind: ${kind}`);
  }
}

// Re-export the stage helpers so callers don't also need renderer.ts directly.
export { TV_STAGE, roomStage, type Stage, type TimerFace };
