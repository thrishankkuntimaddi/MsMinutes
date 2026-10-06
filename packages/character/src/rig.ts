import type { Affect, BodyMode } from "@ms-minutes/protocol";
import { lerp } from "./math.js";
import { Motion, type Action, type MotionFrame } from "./motion.js";
import { NEUTRAL, PARAM_KEYS, type HandPose, type ParamKey, type RigParams } from "./params.js";
import { blendTargets, HAND_POSES, type BlendEntry } from "./presets.js";
import { Spring } from "./spring.js";
import type { Viseme } from "./lipsync.js";

/** Everything a renderer needs for one frame. */
export type RigFrame = RigParams &
  Omit<MotionFrame, "lean"> & {
    /** Glove shapes for the screen-left and screen-right hands. */
    handL: HandPose;
    handR: HandPose;
    /** 0 open → 1 closed, per eye, from blinks and winks. */
    blinkL: number;
    blinkR: number;
    /** Clock hands in radians, 0 = 12 o'clock. */
    hourAngle: number;
    minuteAngle: number;
    /** 0..1 how hard the alarm bells are ringing. */
    ring: number;
    /** Seconds since the rig started. */
    t: number;
  };

type Eye = "both" | "left" | "right";
type Blink = { start: number; eye: Eye; close: number; hold: number; open: number };

/** [stiffness, damping ratio] per parameter. Fast for eyes and mouth, loose for the body. */
export const TUNING: Record<ParamKey, [number, number]> = {
  eyeOpen: [260, 0.75],
  eyeSquint: [200, 0.8],
  pupilX: [520, 0.82],
  pupilY: [520, 0.82],
  pupilSize: [90, 0.8],
  browHeight: [190, 0.62],
  browAngle: [190, 0.7],
  browAsym: [150, 0.7],
  mouthCurve: [170, 0.72],
  mouthOpen: [900, 0.78],
  mouthWidth: [520, 0.8],
  mouthRound: [600, 0.8],
  cheek: [40, 1],
  headTilt: [70, 0.5],
  bounce: [120, 0.38],
  squash: [260, 0.3],
  armL: [95, 0.5],
  armR: [95, 0.5],
  handSpeed: [12, 1],
  bendL: [110, 0.55],
  bendR: [110, 0.55],
  reachL: [120, 0.6],
  reachR: [120, 0.6],
  lean: [60, 0.6],
  tear: [8, 1],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeIn = (x: number) => x * x;
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);

/**
 * The character's brain-stem: takes high-level intent (expression, mode, speech)
 * and produces lifelike motion every frame, adding the involuntary life a face has
 * even when nothing is happening.
 */
export class CharacterRig {
  readonly #random: () => number;
  readonly #springs = {} as Record<ParamKey, Spring>;
  #targets: RigParams = { ...NEUTRAL };
  #hands: [HandPose, HandPose] = HAND_POSES.neutral;
  #laugh = 0;
  readonly motion: Motion;
  #mode: BodyMode = "idle";
  #affect: string = "neutral";
  #viseme: Viseme | null = null;
  #t = 0;

  #blinks: Blink[] = [];
  #nextBlink = 1.2;
  #gaze = { x: 0, y: 0 };
  #nextSaccade = 0.8;
  #look: { x: number; y: number; until: number } | null = null;

  #waveUntil = -1;
  #ringUntil = -1;
  #ring = 0;
  #spin = 0;

  constructor(options: { random?: () => number } = {}) {
    this.#random = options.random ?? Math.random;
    this.motion = new Motion({ random: this.#random });
    for (const key of PARAM_KEYS) {
      const [stiffness, ratio] = TUNING[key];
      this.#springs[key] = new Spring(NEUTRAL[key], stiffness, ratio);
    }
  }

  setExpression(affect: Affect, intensity = 1, blend: BlendEntry[] = []): void {
    const changed = affect !== this.#affect;
    this.#affect = affect;
    this.#targets = blendTargets([{ affect, weight: intensity }, ...blend]);
    this.#hands = HAND_POSES[affect];
    this.#laugh = affect === "laughing" ? intensity : 0;
    // A wink belongs with these, as in her reference poses.
    if (changed && (affect === "playful" || affect === "proud")) this.wink("left", 0.5);
  }

  setMode(mode: BodyMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    // Wander when left alone; come to the front when someone's talking with her.
    this.motion.autopilot = mode === "idle";
    if (
      mode === "listening" ||
      (mode === "speaking" && (this.motion.sitting || this.motion.busy))
    ) {
      this.motion.attend();
    }
  }

  /** A whole-body action: walk, jump, turn around, wave… */
  act(action: Action): void {
    if (action === "wave") this.wave();
    else this.motion.do(action, { now: true });
  }

  /** Current mouth shape from speech, or null when not speaking. */
  setViseme(viseme: Viseme | null): void {
    this.#viseme = viseme;
  }

  /** Look at a point in face space (-1..1), e.g. the user's cursor. */
  lookAt(x: number, y: number, holdSeconds = 1.5): void {
    this.#look = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), until: this.#t + holdSeconds };
  }

  blink(eye: Eye = "both"): void {
    this.#blinks.push({ start: this.#t, eye, close: 0.07, hold: 0.025, open: 0.11 });
  }

  wink(eye: Exclude<Eye, "both"> = "right", holdSeconds = 0.35): void {
    this.#blinks.push({ start: this.#t, eye, close: 0.09, hold: holdSeconds, open: 0.16 });
  }

  wave(seconds = 1.6): void {
    this.#waveUntil = this.#t + seconds;
  }

  ring(seconds = 0.9): void {
    this.#ringUntil = this.#t + seconds;
  }

  /** A little jump: up, then squash on landing. */
  hop(strength = 1): void {
    this.#springs.bounce.velocity -= 150 * strength;
    this.#springs.squash.velocity -= 2.2 * strength;
  }

  update(dt: number, now = new Date()): RigFrame {
    dt = clamp(dt, 0, 1 / 30);
    const t = (this.#t += dt);
    const target: RigParams = { ...this.#targets };

    this.#applyMode(target, t);
    this.#applySpeech(target, t);
    this.#applyGaze(target, t);
    const waving = t < this.#waveUntil;
    if (waving) {
      target.armR = 2.55 + Math.sin(t * Math.PI * 2 * 2.6) * 0.38;
      target.bendR = 0.5;
      target.reachR = 1;
    }
    const m = this.motion.update(dt);
    // Arms swing with her stride when they're not busy with a gesture.
    for (const side of ["L", "R"] as const) {
      const arm = `arm${side}` as const;
      if (target[arm] < 1 && target[arm] > -0.2) {
        target[arm] += (side === "L" ? m.swing : -m.swing) * 0.55;
      }
    }

    const values = {} as RigParams;
    for (const key of PARAM_KEYS) {
      const spring = this.#springs[key];
      spring.target = target[key];
      values[key] = spring.step(dt);
    }

    // Involuntary life layered on top of the springs.
    const breath = Math.sin((t * Math.PI * 2) / 3.4);
    values.bounce += breath * 1.4 + Math.sin(t * 16) * 2.6 * this.#laugh;
    values.squash += breath * 0.012 + Math.sin(t * 16) * 0.035 * this.#laugh;
    values.pupilX += Math.sin(t * 7.3) * 0.012;
    values.pupilY += Math.sin(t * 5.1 + 1) * 0.012;

    const [blinkL, blinkR] = this.#blinkAmounts(t);
    this.#ring = t < this.#ringUntil ? 1 : Math.max(0, this.#ring - dt * 3);
    this.#spin += values.handSpeed * dt * Math.PI;

    const hours = (now.getHours() % 12) + now.getMinutes() / 60;
    const minutes = now.getMinutes() + now.getSeconds() / 60;
    return {
      ...values,
      ...m,
      lean: values.lean + m.lean,
      handL: this.#hands[0],
      handR: waving ? "open" : this.#hands[1],
      blinkL,
      blinkR,
      hourAngle: (hours / 12) * Math.PI * 2 + this.#spin / 12,
      minuteAngle: (minutes / 60) * Math.PI * 2 + this.#spin,
      ring: this.#ring,
      t,
    };
  }

  #applyMode(target: RigParams, t: number): void {
    switch (this.#mode) {
      case "listening":
        target.eyeOpen += 0.08;
        target.browHeight += 0.15;
        target.headTilt += 0.06;
        break;
      case "thinking":
        target.pupilX = 0.55;
        target.pupilY = -0.55;
        target.browAsym += 0.3;
        target.handSpeed += 1.5;
        target.headTilt += Math.sin(t * 1.3) * 0.04;
        break;
      default:
        break;
    }
  }

  #applySpeech(target: RigParams, t: number): void {
    const v = this.#viseme;
    if (!v) return;
    target.mouthOpen = Math.max(target.mouthOpen * 0.4, v.open * (0.9 + 0.1 * Math.sin(t * 31)));
    target.mouthRound = v.round;
    target.mouthWidth = lerp(target.mouthWidth, v.width, 0.6);
    target.mouthCurve *= 0.75;
    // Talking moves the whole face a little.
    target.browHeight += v.open * 0.14;
    target.headTilt += Math.sin(t * 2.1) * 0.035;
    target.bounce -= v.open * 1.5;
  }

  #applyGaze(target: RigParams, t: number): void {
    if (this.#look && t < this.#look.until) {
      this.#gaze = { x: this.#look.x, y: this.#look.y };
    } else if (this.#mode !== "thinking" && t >= this.#nextSaccade) {
      const r = this.#random;
      const big = r() < 0.3;
      const next = {
        x: (r() * 2 - 1) * (big ? 0.75 : 0.32),
        y: (r() * 2 - 1) * (big ? 0.5 : 0.22) - 0.05,
      };
      // People often blink with a large eye movement.
      if (Math.hypot(next.x - this.#gaze.x, next.y - this.#gaze.y) > 0.5 && r() < 0.4) this.blink();
      this.#gaze = next;
      this.#nextSaccade = t + 0.45 + r() * 2.3;
    }
    target.pupilX = clamp(target.pupilX + this.#gaze.x, -1, 1);
    target.pupilY = clamp(target.pupilY + this.#gaze.y, -1, 1);
  }

  #blinkAmounts(t: number): [number, number] {
    if (t >= this.#nextBlink) {
      this.blink();
      if (this.#random() < 0.18) {
        this.#blinks.push({ start: t + 0.24, eye: "both", close: 0.07, hold: 0.025, open: 0.11 });
      }
      this.#nextBlink = t + 2 + this.#random() * 3.8;
    }

    let left = 0;
    let right = 0;
    this.#blinks = this.#blinks.filter((b) => {
      const p = t - b.start;
      const total = b.close + b.hold + b.open;
      if (p > total) return false;
      let amount = 0;
      if (p >= 0) {
        if (p < b.close) amount = easeIn(p / b.close);
        else if (p < b.close + b.hold) amount = 1;
        else amount = 1 - easeOut((p - b.close - b.hold) / b.open);
      }
      if (b.eye !== "right") left = Math.max(left, amount);
      if (b.eye !== "left") right = Math.max(right, amount);
      return true;
    });
    return [left, right];
  }
}
