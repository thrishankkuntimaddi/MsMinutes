/**
 * Damped spring. Everything on her face moves through one, which gives the
 * small overshoot and settle that makes motion read as alive rather than tweened.
 */
/** Longest integration step, in seconds. */
const MAX_STEP = 1 / 120;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  readonly stiffness: number;
  readonly damping: number;

  /** dampingRatio < 1 overshoots, 1 is critically damped. */
  constructor(value: number, stiffness: number, dampingRatio: number) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = 2 * dampingRatio * Math.sqrt(stiffness);
  }

  step(dt: number): number {
    // Stiff springs (her mouth) go unstable if one step is too long, e.g. when frames slow
    // to 30 fps on a busy machine. Small fixed sub-steps keep every spring stable.
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}
