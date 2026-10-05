/**
 * Damped spring. Everything on her face moves through one, which gives the
 * small overshoot and settle that makes motion read as alive rather than tweened.
 */
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
    const accel = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}
