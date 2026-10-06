import { Spring } from "./spring.js";

/** Things her body can do on request. Bodies advertise these in their `animate` capability. */
export const ACTIONS = [
  "walk",
  "run",
  "jump",
  "turn_around",
  "spin",
  "sit",
  "stand",
  "dance",
  "wave",
  "bow",
  "come_closer",
  "step_back",
  "peek",
] as const;
export type Action = (typeof ACTIONS)[number];

export const isAction = (name: string): name is Action =>
  (ACTIONS as readonly string[]).includes(name);

/** Her whole-body pose for one frame, in stage terms. */
export type MotionFrame = {
  /** -1 (left edge of where she can walk) … 1 (right edge). */
  x: number;
  /** Height above the floor in body units (her face's radius is 100). */
  lift: number;
  /** Turn about her vertical axis: 0 faces you, ±π/2 side-on, π shows her back. */
  yaw: number;
  /** Depth: 1 normal, >1 closer to the glass. */
  scale: number;
  /** Hip swing per leg in radians, positive toward the direction she's facing. */
  legL: number;
  legR: number;
  /** How far each foot is lifted off the floor (body units). */
  footL: number;
  footR: number;
  /** 0..1 knees bending: anticipation before a jump, landing, a bounce. */
  crouch: number;
  /** 0 standing … 1 sitting on the floor. */
  sit: number;
  /** Extra forward lean (radians), e.g. a bow or peeking over an edge. */
  lean: number;
  /** -1..1 arm swing in step with her legs while walking. */
  swing: number;
  /** True while she is travelling. */
  moving: boolean;
  /** 0 standing, ~1 walking, ~2 running; for speed lines and dust. */
  pace: number;
  /** Which way she's travelling or facing on screen: -1 left, 1 right. */
  heading: number;
};

type Task = (dt: number) => boolean;

const GRAVITY = 2600;
const WALK_SPEED = 0.42; // stage widths per second, roughly
const RUN_SPEED = 1.15;
const TAU = Math.PI * 2;
const REST_YAW = 0.22;

/**
 * Locomotion and full-body actions, renderer-agnostic like the rest of the rig.
 * Tasks run one after another; idle wandering only happens when the queue is empty.
 */
export class Motion {
  readonly #random: () => number;
  #tasks: Task[] = [];
  #t = 0;

  #x = 0;
  #speed = 0;
  #gait: "stand" | "walk" | "run" = "stand";
  #phase = 0;
  #lift = 0;
  #vy = 0;
  #airborne = false;
  #heading = 1;

  readonly #yaw = new Spring(REST_YAW, 60, 0.75);
  readonly #scale = new Spring(1, 40, 0.8);
  readonly #sit = new Spring(0, 45, 0.85);
  readonly #crouch = new Spring(0, 260, 0.45);
  readonly #lean = new Spring(0, 70, 0.7);
  #danceUntil = -1;

  /** Idle wandering: off while she's talking or listening. */
  autopilot = true;
  /** How wide this stage is next to the TV's: her speed across it is divided by it. */
  reach = 1;
  #nextWander = 6;

  constructor(options: { random?: () => number } = {}) {
    this.#random = options.random ?? Math.random;
  }

  get busy(): boolean {
    return this.#tasks.length > 0;
  }

  get sitting(): boolean {
    return this.#sit.target > 0.5;
  }

  /** Queue an action. `now` drops anything queued first. */
  do(action: Action, options: { now?: boolean } = {}): void {
    if (options.now) this.#tasks = [];
    this.#nextWander = this.#t + 8 + this.#random() * 8;
    const r = this.#random;
    switch (action) {
      case "walk": {
        const to =
          Math.abs(this.#x) > 0.3
            ? -Math.sign(this.#x) * (0.2 + r() * 0.5)
            : (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.4);
        this.#queue(this.#standUp(), this.#walkTo(to, "walk"), this.#rest());
        break;
      }
      case "run": {
        const edge = this.#x > 0 ? -0.95 : 0.95;
        this.#queue(
          this.#standUp(),
          this.#walkTo(edge, "run"),
          this.#walkTo(0, "run"),
          this.#rest(),
        );
        break;
      }
      case "jump":
        this.#queue(this.#standUp(), this.#jump(1));
        break;
      case "turn_around":
        this.#queue(this.#face(Math.PI), this.#wait(1.3), this.#rest());
        break;
      case "spin":
        this.#queue(this.#spin());
        break;
      case "sit":
        this.#queue(this.#face(0), () => ((this.#sit.target = 1), true));
        break;
      case "stand":
        this.#queue(this.#standUp());
        break;
      case "dance":
        this.#queue(this.#standUp(), this.#dance(3.2));
        break;
      case "wave":
        // Arms belong to the rig; nothing to do with the legs.
        break;
      case "bow":
        this.#queue(this.#face(0), this.#hold(this.#lean, 0.55, 0.9));
        break;
      case "come_closer":
        this.#queue(this.#walkTo(0, "walk"), this.#face(0), this.#hold(this.#scale, 1.32, 2.6));
        break;
      case "step_back":
        this.#queue(this.#hold(this.#scale, 0.78, 2.2));
        break;
      case "peek": {
        const edge = r() < 0.5 ? -1 : 1;
        this.#queue(
          this.#standUp(),
          this.#walkTo(edge, "walk"),
          this.#face(edge * 1.25),
          this.#hold(this.#lean, 0.35, 1.2),
          this.#walkTo(0, "walk"),
          this.#rest(),
        );
        break;
      }
    }
  }

  /** Start just off screen on `side` and run in to the middle (her entrance). */
  enter(side: -1 | 1 = -1): void {
    this.#tasks = [];
    this.#x = side * 1.75;
    this.#heading = -side;
    this.#yaw.value = this.#yaw.target = -side * 0.75;
    this.#queue(this.#walkTo(0, "run"), this.#rest());
  }

  /** Come to the middle, face the viewer and stand: someone is talking to her. */
  attend(): void {
    this.#tasks = [];
    this.#danceUntil = -1;
    this.#queue(
      this.#standUp(),
      this.#walkTo(0, Math.abs(this.#x) > 0.6 ? "run" : "walk"),
      this.#rest(),
    );
  }

  /** Run off one side of the stage (-1 left, 1 right) until she's out of view. */
  exit(side: -1 | 1 = 1): void {
    this.#tasks = [];
    this.#danceUntil = -1;
    this.#sit.target = 0;
    this.#queue(this.#walkTo(side * 1.9, "run"));
  }

  /** Put her at `x`, `lift` body units up in the air: she drops from there and lands. */
  appear(x: number, lift: number, heading: -1 | 1 = 1): void {
    this.#tasks = [];
    this.#danceUntil = -1;
    this.#x = x;
    this.#heading = heading;
    this.#gait = "stand";
    this.#sit.value = this.#sit.target = 0;
    this.#lift = Math.max(0, lift);
    this.#vy = 0;
    this.#airborne = this.#lift > 0;
    this.#yaw.value = this.#yaw.target = 0;
    this.#queue(this.#rest());
  }

  /** Run to `x`, face you and jump with upward speed `vy` (body units per second). */
  leap(x: number, vy: number): void {
    this.#tasks = [];
    this.#danceUntil = -1;
    this.#queue(this.#standUp(), this.#walkTo(x, "run"), this.#face(0), this.#jump(vy / 520));
  }

  update(dt: number): MotionFrame {
    const t = (this.#t += dt);

    if (this.#tasks.length && this.#tasks[0]!(dt)) this.#tasks.shift();
    if (!this.#tasks.length && this.autopilot && t >= this.#nextWander) this.#wander();

    // Gait: ease speed toward the task's demand, advance the step cycle with it.
    const moving = this.#gait !== "stand";
    const cadence = this.#gait === "run" ? 1.6 : 1; // full step cycles per second
    this.#speed += ((moving ? 1 : 0) - this.#speed) * Math.min(1, dt * 6);
    this.#phase += dt * TAU * cadence * this.#speed;
    if (!moving) {
      // Settle the feet together rather than freezing mid-stride.
      const rest = Math.round(this.#phase / Math.PI) * Math.PI;
      this.#phase += (rest - this.#phase) * Math.min(1, dt * 8);
    }

    // Jumping.
    if (this.#airborne) {
      this.#vy -= GRAVITY * dt;
      this.#lift += this.#vy * dt;
      if (this.#lift <= 0) {
        this.#lift = 0;
        this.#airborne = false;
        this.#crouch.velocity += 9 * Math.min(1.5, -this.#vy / 900);
      }
    }

    // Dancing: little hops side to side.
    let danceSway = 0;
    if (t < this.#danceUntil) {
      danceSway = Math.sin(t * Math.PI * 2.4);
      if (!this.#airborne && Math.abs(Math.cos(t * Math.PI * 2.4)) > 0.96) this.#launch(180);
      this.#yaw.target = danceSway * 0.45;
    }

    for (const spring of [this.#yaw, this.#scale, this.#sit, this.#crouch, this.#lean])
      spring.step(dt);

    const run = this.#gait === "run";
    const stride = (run ? 0.75 : 0.45) * Math.min(1, this.#speed * 1.4);
    const s = Math.sin(this.#phase);
    const c = Math.cos(this.#phase);
    const lift = run ? 26 : 14;
    const airTuck = this.#airborne ? Math.min(1, this.#lift / 60) : 0;

    return {
      x: this.#x,
      lift: this.#lift + (moving ? (1 - Math.abs(s)) * (run ? 10 : 5) : 0) - this.#sit.value * 62,
      yaw: this.#yaw.value,
      scale: this.#scale.value,
      legL: s * stride + airTuck * 0.5,
      legR: -s * stride - airTuck * 0.35,
      footL: Math.max(0, c) * lift * stride * 2 + airTuck * 22,
      footR: Math.max(0, -c) * lift * stride * 2 + airTuck * 10,
      crouch: Math.max(0, this.#crouch.value),
      sit: Math.min(1, Math.max(0, this.#sit.value)),
      lean: this.#lean.value + (run ? 0.12 : 0) * this.#speed,
      swing: moving ? s * Math.min(1, this.#speed) : danceSway * 0.6,
      moving,
      pace: this.#speed * (run ? 2 : 1),
      heading: this.#heading,
    };
  }

  // ---------- tasks ----------

  #queue(...tasks: Task[]): void {
    this.#tasks.push(...tasks);
  }

  #wander(): void {
    const r = this.#random();
    if (this.sitting) this.do(r < 0.6 ? "stand" : "turn_around");
    else if (r < 0.55) this.do("walk");
    else if (r < 0.65) this.do("turn_around");
    else if (r < 0.75) this.do("peek");
    else if (r < 0.85) this.do("sit");
    else this.do("jump");
    this.#nextWander = this.#t + 7 + this.#random() * 9;
  }

  #walkTo(x: number, gait: "walk" | "run"): Task {
    let started = false;
    return (dt) => {
      const dir = Math.sign(x - this.#x);
      if (!started) {
        started = true;
        if (Math.abs(x - this.#x) < 0.02) return true;
        this.#gait = gait;
      }
      if (dir) this.#heading = dir;
      // Three-quarter view toward where she's going, like the reference poses.
      this.#yaw.target = dir * (gait === "run" ? 0.75 : 0.55);
      const speed =
        ((gait === "run" ? RUN_SPEED : WALK_SPEED) / this.reach) * Math.max(0.15, this.#speed);
      const step = Math.min(Math.abs(x - this.#x), speed * dt);
      this.#x += dir * step;
      if (Math.abs(x - this.#x) < 0.005) {
        this.#x = x;
        this.#gait = "stand";
        return true;
      }
      return false;
    };
  }

  /** At rest she stands slightly turned, so her case's edge shows, as in the reference art. */
  #rest(): Task {
    return () => {
      this.#yaw.target = REST_YAW * this.#heading;
      return true;
    };
  }

  #face(yaw: number): Task {
    return () => {
      this.#yaw.target = yaw;
      return Math.abs(this.#yaw.value - yaw) < 0.08;
    };
  }

  #spin(): Task {
    let set = false;
    return () => {
      if (!set) {
        set = true;
        this.#yaw.target = this.#yaw.value + TAU;
      }
      if (Math.abs(this.#yaw.value - this.#yaw.target) < 0.05) {
        // Back to the same angle, without unwinding.
        const wrapped = this.#yaw.target - TAU * Math.round(this.#yaw.target / TAU);
        this.#yaw.value -= this.#yaw.target - wrapped;
        this.#yaw.target = wrapped;
        return true;
      }
      return false;
    };
  }

  #jump(strength: number): Task {
    let at = -1;
    return () => {
      if (at < 0) {
        at = this.#t;
        this.#crouch.target = 0.7; // anticipation
        return false;
      }
      if (!this.#airborne && this.#t - at > 0.16 && this.#crouch.target > 0) {
        this.#crouch.target = 0;
        this.#launch(520 * strength);
        return false;
      }
      return !this.#airborne && this.#crouch.target === 0 && this.#t - at > 0.3;
    };
  }

  #launch(vy: number): void {
    this.#vy = vy;
    this.#airborne = true;
    this.#crouch.velocity -= 4;
  }

  #dance(seconds: number): Task {
    let set = false;
    return () => {
      if (!set) {
        set = true;
        this.#danceUntil = this.#t + seconds;
      }
      if (this.#t < this.#danceUntil || this.#airborne) return false;
      this.#yaw.target = 0;
      return true;
    };
  }

  #standUp(): Task {
    return () => {
      this.#sit.target = 0;
      return this.#sit.value < 0.1;
    };
  }

  #wait(seconds: number): Task {
    let left = seconds;
    return (dt) => (left -= dt) <= 0;
  }

  #hold(spring: Spring, value: number, seconds: number): Task {
    let left = seconds;
    const rest = spring === this.#scale ? 1 : 0;
    return (dt) => {
      spring.target = value;
      left -= dt;
      if (left > 0) return false;
      spring.target = rest;
      return true;
    };
  }
}
