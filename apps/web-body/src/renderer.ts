import type { HandPose, RigFrame } from "@ms-minutes/character";

/**
 * Logical stage inside the TV (4:3). She stands on a floor near the bottom and has
 * room to walk, run and jump. Body units: her face has radius R = 100.
 */
const W = 480;
const H = 360;
const FLOOR = 300;
const BASE_SCALE = 0.7;
/** Stage pixels from the middle to where x = ±1 puts her. */
const RANGE = 112;

const R = 100;
const COIN = 24; // thickness of her case
const HIP_Y = R - 16;
const LEG = 58;
const SHOE_H = 33;
/** From the middle of her face down to the soles of her shoes. */
const FEET = HIP_Y + LEG + SHOE_H;
const SHOULDER_Y = 14;
const ARM = 74;

const TAU = Math.PI * 2;
const INK = "#2a0e05";
const TICK = "#4a1709";
const BROWN = "#7b3214";
const BROWN_HI = "#b0582a";
const GLOVE = "#fffaf0";
const GLOVE_SHADE = "#eadcc4";
const SOLE = "#e0ad7c";
const SOLE_DARK = "#a8744a";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Pt = { x: number; y: number };

/** Draws Miss Minutes and her little stage on a 2D canvas, crisp at any pixel density. */
/** A running timer as she shows it: the rim sweeps down as time runs out. */
export type TimerFace = { remaining: number; ringing: boolean };

export class ClockRenderer {
  /** Set by the page each frame; null when no timer is running. */
  timer: TimerFace | null = null;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  #view = { x: W / 2, y: FLOOR - FEET * BASE_SCALE, s: BASE_SCALE };
  #dust: { x: number; y: number; r: number; life: number; vx: number }[] = [];
  #lastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d")!;
  }

  /** Maps a client point to face space (-1..1 around her face), for eye tracking. */
  toFaceSpace(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * W;
    const sy = ((clientY - rect.top) / rect.height) * H;
    const { x, y, s } = this.#view;
    return { x: (sx - x) / (R * 2.4 * s), y: (sy - (y - 14 * s)) / (R * 2.4 * s) };
  }

  draw(f: RigFrame): void {
    const ctx = this.#ctx;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.#canvas.getBoundingClientRect();
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (this.#canvas.width !== pw || this.#canvas.height !== ph) {
      this.#canvas.width = pw;
      this.#canvas.height = ph;
    }
    ctx.setTransform(pw / W, 0, 0, ph / H, 0, 0);
    const dt = clamp(f.t - this.#lastT, 0, 0.05);
    this.#lastT = f.t;

    const s = BASE_SCALE * f.scale;
    const cx = W / 2 + f.x * RANGE;
    const drop = f.crouch * 16 + f.squash * 40;
    const cy = FLOOR - s * (FEET - drop + f.lift - f.bounce);
    this.#view = { x: cx, y: cy, s };

    this.#stage(cx);
    this.#speedLines(f, cx, cy, s, dt);
    this.#shadow(f, cx, s);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    // Tilt and squash pivot around her feet, like a real body.
    ctx.translate(0, FEET);
    ctx.rotate(f.headTilt * 0.55 + f.lean * Math.sin(f.yaw) * 0.6);
    ctx.scale(1 + f.squash * 0.8, 1 - f.squash);
    ctx.translate(0, -FEET);

    const c = Math.cos(f.yaw);
    const back = c < 0;
    this.#legs(f);
    if (back) {
      this.#arm(f, -1);
      this.#arm(f, 1);
    }
    this.#body(f);
    if (!back) {
      this.#arm(f, -1);
      this.#arm(f, 1);
    }
    this.#sparkles(f);
    ctx.restore();
  }

  // ---------- Stage ----------

  #stage(cx: number): void {
    const ctx = this.#ctx;
    const wall = ctx.createLinearGradient(0, 0, 0, FLOOR);
    wall.addColorStop(0, "#2a160a");
    wall.addColorStop(1, "#5a3318");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, FLOOR);

    // Wood panelling.
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    for (let x = 20; x < W; x += 48) ctx.fillRect(x, 0, 2, FLOOR - 10);
    ctx.fillStyle = "rgba(255,200,140,0.04)";
    for (let x = 22; x < W; x += 48) ctx.fillRect(x, 0, 1, FLOOR - 10);

    // Spotlight follows her along the wall.
    const spot = ctx.createRadialGradient(cx, FLOOR - 120, 10, cx, FLOOR - 120, 210);
    spot.addColorStop(0, "rgba(255,200,120,0.32)");
    spot.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, W, FLOOR);

    // Floor with a little perspective.
    const floorTop = FLOOR - 14;
    const floor = ctx.createLinearGradient(0, floorTop, 0, H);
    floor.addColorStop(0, "#3a200e");
    floor.addColorStop(1, "#140902");
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorTop, W, H - floorTop);
    ctx.strokeStyle = "rgba(255,190,120,0.07)";
    ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + i * 34, floorTop);
      ctx.lineTo(W / 2 + i * 120, H);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,190,120,0.18)";
    ctx.fillRect(0, floorTop, W, 1.5);

    const pool = ctx.createRadialGradient(cx, FLOOR, 4, cx, FLOOR, 130);
    pool.addColorStop(0, "rgba(255,190,120,0.2)");
    pool.addColorStop(1, "rgba(255,190,120,0)");
    ctx.save();
    ctx.translate(cx, FLOOR);
    ctx.scale(1, 0.18);
    ctx.translate(-cx, -FLOOR);
    ctx.fillStyle = pool;
    ctx.fillRect(cx - 140, FLOOR - 140, 280, 280);
    ctx.restore();
  }

  #shadow(f: RigFrame, cx: number, s: number): void {
    const ctx = this.#ctx;
    const k = 1 - clamp(f.lift / 260, 0, 0.6);
    ctx.save();
    ctx.translate(cx, FLOOR + 1);
    ctx.scale(72 * s * k * (1 + f.sit * 0.3), 10 * s * k);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(0,0,0,${0.55 * k})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Cartoon speed lines and dust puffs when she runs (reference pose 7). */
  #speedLines(f: RigFrame, cx: number, cy: number, s: number, dt: number): void {
    const ctx = this.#ctx;
    const run = clamp(f.pace - 1, 0, 1);
    const behind = -f.heading;
    if (run > 0.05) {
      ctx.save();
      ctx.lineCap = "round";
      for (let i = 0; i < 6; i++) {
        const y = cy - 70 * s + i * 26 * s;
        const len = (40 + ((i * 37) % 50)) * s * run;
        const x0 = cx + behind * (R * s + 14 + ((i * 13) % 20));
        const g = ctx.createLinearGradient(x0, y, x0 + behind * len, y);
        g.addColorStop(0, `rgba(255,214,120,${0.75 * run})`);
        g.addColorStop(1, "rgba(255,214,120,0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 3 * s + 1;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + behind * len, y);
        ctx.stroke();
      }
      ctx.restore();
      if (Math.random() < run * 0.5) {
        this.#dust.push({
          x: cx + behind * 30 * s,
          y: FLOOR - 4,
          r: 6 + Math.random() * 6,
          life: 1,
          vx: behind * (30 + Math.random() * 30),
        });
      }
    }
    this.#dust = this.#dust.filter((d) => (d.life -= dt * 1.6) > 0);
    for (const d of this.#dust) {
      d.x += d.vx * dt;
      d.y -= 12 * dt;
      ctx.fillStyle = `rgba(250,226,180,${0.55 * d.life})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (1.6 - d.life * 0.6) * s * 1.6, 0, TAU);
      ctx.fill();
    }
  }

  // ---------- Body ----------

  /** Her case: a thick coin that turns in 3D, gold rim, orange face (or her back). */
  #body(f: RigFrame): void {
    const ctx = this.#ctx;
    const c = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    const rx = R * Math.max(0.04, Math.abs(c));
    const front = (COIN / 2) * sn;
    const near = c >= 0 ? front : -front;
    const far = -near;

    // The edge: far face, the band between, in shaded gold.
    const edge = ctx.createLinearGradient(Math.min(near, far) - rx, 0, Math.max(near, far) + rx, 0);
    edge.addColorStop(0, "#9a5a08");
    edge.addColorStop(0.5, "#f2b52e");
    edge.addColorStop(1, "#b7740c");
    ctx.fillStyle = edge;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(far, 0, rx, R, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(Math.min(near, far), -R, Math.abs(near - far), R * 2);
    ctx.beginPath();
    ctx.moveTo(Math.min(near, far), -R);
    ctx.lineTo(Math.max(near, far), -R);
    ctx.moveTo(Math.min(near, far), R);
    ctx.lineTo(Math.max(near, far), R);
    ctx.stroke();
    // Bright stripes along the edge, like the reference's coin sheen.
    if (Math.abs(near - far) > 2) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.min(near, far), -R, Math.abs(near - far), R * 2);
      ctx.clip();
      ctx.strokeStyle = "rgba(255,245,200,0.45)";
      ctx.lineWidth = 2;
      for (let y = -R + 8; y < R; y += 16) {
        ctx.beginPath();
        ctx.moveTo(Math.min(near, far), y);
        ctx.lineTo(Math.max(near, far), y + 6);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(near, 0);
    ctx.scale(Math.max(0.04, Math.abs(c)), 1);
    if (c >= 0) this.#face(f);
    else this.#back();
    ctx.restore();
  }

  #rim(): void {
    const ctx = this.#ctx;
    const gold = ctx.createLinearGradient(-R, -R, R, R);
    gold.addColorStop(0, "#fff3a6");
    gold.addColorStop(0.3, "#f8cb3c");
    gold.addColorStop(0.7, "#eaa21b");
    gold.addColorStop(1, "#c77b0b");
    ctx.fillStyle = gold;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.2;
    ctx.stroke();
  }

  #face(f: RigFrame): void {
    const ctx = this.#ctx;
    this.#rim();

    const face = ctx.createRadialGradient(-28, -34, 6, 0, 0, R - 11);
    face.addColorStop(0, "#f9b067");
    face.addColorStop(0.65, "#f08d3f");
    face.addColorStop(1, "#e2712c");
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(0, 0, R - 11, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "#e0441f";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Gold rim glint.
    ctx.strokeStyle = "rgba(255,255,235,0.75)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, R - 5, Math.PI * 1.1, Math.PI * 1.42);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R - 5, Math.PI * 0.1, Math.PI * 0.2);
    ctx.stroke();

    this.#ticks();
    this.#countdown(f);

    // Leaning toward you tips her features down a little.
    ctx.save();
    ctx.translate(0, f.lean * Math.cos(f.yaw) * 22);
    this.#cheeks(f);
    this.#eye(f, -1);
    this.#eye(f, 1);
    this.#brow(f, -1);
    this.#brow(f, 1);
    // Her nose is the clock's centre pin.
    ctx.fillStyle = TICK;
    ctx.beginPath();
    ctx.arc(0, 6, 4.6, 0, TAU);
    ctx.fill();
    this.#mouth(f);
    this.#tear(f);
    ctx.restore();
  }

  /** Remaining time as a glowing arc on her rim, from 12 o'clock clockwise. */
  #countdown(f: RigFrame): void {
    const timer = this.timer;
    if (!timer) return;
    const ctx = this.#ctx;
    ctx.save();
    ctx.lineCap = "round";
    if (timer.ringing) {
      // Ringing: the whole rim flashes.
      const on = Math.sin(f.t * 18) > 0;
      ctx.strokeStyle = on ? "rgba(255,70,30,0.95)" : "rgba(255,230,120,0.9)";
      ctx.shadowColor = "rgba(255,90,30,0.9)";
      ctx.shadowBlur = 14;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(0, 0, R - 5, 0, TAU);
      ctx.stroke();
    } else {
      const start = -Math.PI / 2;
      const end = start + TAU * Math.max(0.002, Math.min(1, timer.remaining));
      ctx.strokeStyle = "rgba(90,20,5,0.35)";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(0, 0, R - 5, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = "#ff4a1c";
      ctx.shadowColor = "rgba(255,80,30,0.85)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, R - 5, start, end);
      ctx.stroke();
      // The moving end, like a second hand's tip.
      ctx.fillStyle = "#fff3c4";
      ctx.beginPath();
      ctx.arc(Math.cos(end) * (R - 5), Math.sin(end) * (R - 5), 3.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  #ticks(): void {
    const ctx = this.#ctx;
    ctx.fillStyle = TICK;
    ctx.strokeStyle = TICK;
    ctx.lineCap = "round";
    for (let i = 0; i < 12; i++) {
      ctx.save();
      ctx.rotate((i / 12) * TAU);
      if (i % 3 === 0) {
        roundRect(ctx, -3.6, -(R - 18), 7.2, 20, 1.5);
        ctx.fill();
      } else {
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(0, -(R - 20));
        ctx.lineTo(0, -(R - 31));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Her back: plain case, a winding crown and a stamped plate. */
  #back(): void {
    const ctx = this.#ctx;
    this.#rim();
    const plate = ctx.createRadialGradient(20, -30, 6, 0, 0, R - 11);
    plate.addColorStop(0, "#f0a25a");
    plate.addColorStop(1, "#c8611f");
    ctx.fillStyle = plate;
    ctx.beginPath();
    ctx.arc(0, 0, R - 11, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(90,30,5,0.35)";
    ctx.lineWidth = 2;
    for (const r of [R - 26, R - 52]) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      ctx.fillStyle = "#f8cb3c";
      ctx.beginPath();
      ctx.arc(Math.cos(a) * (R - 18), Math.sin(a) * (R - 18), 4, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(90,30,5,0.45)";
    ctx.font = "600 22px Oswald, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("TVA", 0, 0);
    ctx.font = "600 8px Oswald, Arial, sans-serif";
    ctx.fillText("FOR ALL TIME · ALWAYS", 0, 18);
  }

  #cheeks(f: RigFrame): void {
    const ctx = this.#ctx;
    for (const side of [-1, 1]) {
      ctx.fillStyle = `rgba(240,96,96,${0.22 + 0.45 * clamp(f.cheek, 0, 1)})`;
      ctx.beginPath();
      ctx.ellipse(side * 52, 18, 15, 9.5, 0, 0, TAU);
      ctx.fill();
      if (f.cheek > 0.85) {
        // Blushing hard: little hatch marks (reference pose 4).
        ctx.strokeStyle = `rgba(200,50,50,${(f.cheek - 0.85) * 4})`;
        ctx.lineWidth = 1.4;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(side * 52 + i * 5 - 2, 22);
          ctx.lineTo(side * 52 + i * 5 + 2, 14);
          ctx.stroke();
        }
      }
    }
  }

  /** side: -1 = screen left. */
  #eye(f: RigFrame, side: -1 | 1): void {
    const ctx = this.#ctx;
    const blink = side === -1 ? f.blinkL : f.blinkR;
    const wide = Math.max(0, f.eyeOpen - 1);
    const rx = 20 * (1 + wide * 0.22);
    const ry = 27 * (1 + wide * 0.4);
    const open = clamp(f.eyeOpen, 0, 1) * (1 - blink);
    const outer = side;
    ctx.save();
    ctx.translate(side * 33, -18);
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Squeezed shut with joy (laughing) reads as a closed arch, as in the reference art.
    if (open < 0.14 || (f.eyeSquint > 0.75 && open < 0.55)) {
      // Closed: a happy arch when smiling (laughing, winking), a soft curve otherwise.
      const happy = f.mouthCurve > 0.4 || f.eyeSquint > 0.5;
      ctx.lineWidth = 3.6;
      ctx.beginPath();
      if (happy) {
        ctx.moveTo(-17, 6);
        ctx.quadraticCurveTo(0, -18, 17, 6);
      } else {
        ctx.moveTo(-17, 2);
        ctx.quadraticCurveTo(0, 14, 17, 2);
      }
      ctx.stroke();
      this.#lashes(outer, happy ? -6 : 0, 16, 8);
      ctx.restore();
      return;
    }

    const sclera = new Path2D();
    sclera.ellipse(0, 0, rx, ry, 0, 0, TAU);
    ctx.save();
    ctx.clip(sclera);
    const white = ctx.createRadialGradient(-4, -8, 2, 0, 0, ry);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "#f2e8d8");
    ctx.fillStyle = white;
    ctx.fill(sclera);

    // Big dark pupils with two catchlights, as on the reference sheet.
    const px = f.pupilX * rx * 0.42;
    const py = f.pupilY * ry * 0.34 + 3;
    const prx = 12.5 * f.pupilSize;
    const pry = 16.5 * f.pupilSize;
    const iris = ctx.createRadialGradient(px - 2, py - 3, 1, px, py, pry);
    iris.addColorStop(0, "#5a2a10");
    iris.addColorStop(0.55, "#2a0f05");
    iris.addColorStop(1, "#120501");
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.ellipse(px, py, prx, pry, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(px + 3.5, py - 6, 3.8, 4.6, 0.3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - 4, py + 5, 1.8, 0, TAU);
    ctx.fill();

    // Upper lid comes down with blinks, sleepiness, and slants with the brows.
    const lidY = -ry + 2 * ry * (1 - open);
    const tilt = f.browAngle * 7 * (1 - blink);
    const yIn = lidY - tilt;
    const yOut = lidY + tilt * 0.6;
    const xIn = -outer * (rx + 3);
    const xOut = outer * (rx + 3);
    ctx.fillStyle = "#f19449";
    ctx.beginPath();
    ctx.moveTo(xOut, -ry - 30);
    ctx.lineTo(xIn, -ry - 30);
    ctx.lineTo(xIn, yIn);
    ctx.quadraticCurveTo(0, (yIn + yOut) / 2 + 8, xOut, yOut);
    ctx.closePath();
    ctx.fill();
    if (open < 0.97 || Math.abs(tilt) > 1) {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(xIn, yIn);
      ctx.quadraticCurveTo(0, (yIn + yOut) / 2 + 8, xOut, yOut);
      ctx.stroke();
    }

    // Lower lid rises when she smiles with her eyes.
    if (f.eyeSquint > 0.05) {
      const lowY = ry - f.eyeSquint * ry * 0.95;
      ctx.fillStyle = "#f19449";
      ctx.beginPath();
      ctx.moveTo(-rx - 3, ry + 30);
      ctx.lineTo(rx + 3, ry + 30);
      ctx.lineTo(rx + 3, lowY);
      ctx.quadraticCurveTo(0, lowY - 9 * f.eyeSquint, -rx - 3, lowY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(42,14,5,${clamp(f.eyeSquint * 2, 0, 1)})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(rx + 3, lowY);
      ctx.quadraticCurveTo(0, lowY - 9 * f.eyeSquint, -rx - 3, lowY);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.2;
    ctx.stroke(sclera);
    this.#lashes(outer, -ry * Math.max(0.45, open) + 6, rx, ry * Math.max(0.45, open));
    ctx.restore();
  }

  /** Three curled lashes at the outer top corner. */
  #lashes(outer: number, baseY: number, rx: number, ry: number): void {
    const ctx = this.#ctx;
    ctx.lineWidth = 2.6;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + outer * (0.55 + i * 0.33);
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry + baseY + ry - 6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + outer * 7, y - 2, x + outer * 7, y - 8 + i * 2);
      ctx.stroke();
    }
  }

  #brow(f: RigFrame, side: -1 | 1): void {
    const ctx = this.#ctx;
    const inner = -side;
    const asym = side === -1 ? f.browAsym : -f.browAsym;
    const wide = Math.max(0, f.eyeOpen - 1) * 10;
    const baseY = -56 - wide - f.browHeight * 9 - asym * 5;
    const xIn = side * 33 + inner * 13;
    const xOut = side * 33 - inner * 16;
    const yIn = baseY - f.browAngle * 8;
    const yOut = baseY + f.browAngle * 3 + 3;
    const arch = 8 - Math.max(0, -f.browAngle) * 7;
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(xOut, yOut);
    ctx.quadraticCurveTo(side * 33, (yIn + yOut) / 2 - arch, xIn, yIn);
    ctx.stroke();
  }

  #mouth(f: RigFrame): void {
    const ctx = this.#ctx;
    const cy = 34;
    const open = Math.max(0, f.mouthOpen);
    const curve = f.mouthCurve;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // "Oh!": a round mouth (reference pose 9).
    if (f.mouthRound > 0.55 && open > 0.2) {
      const w = 10 + open * 6;
      const h = 12 + open * 14;
      const o = new Path2D();
      o.ellipse(0, cy + 4, w, h, 0, 0, TAU);
      ctx.fillStyle = "#3d0e05";
      ctx.fill(o);
      ctx.save();
      ctx.clip(o);
      ctx.fillStyle = "#ee7d7a";
      ctx.beginPath();
      ctx.ellipse(0, cy + 4 + h * 0.75, w * 0.9, h * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.stroke(o);
      ctx.restore();
      return;
    }

    const w = 28 * f.mouthWidth * (1 - 0.35 * f.mouthRound);
    const cornerY = cy - curve * 8;
    const upperMid = cy + curve * 3 - open * 2;
    const lowerMid = upperMid + 4 + open * 34 + Math.max(0, curve) * open * 10;
    const ctrl = (mid: number) => 2 * mid - cornerY;

    if (open < 0.06) {
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(-w, cornerY);
      ctx.quadraticCurveTo(0, ctrl(cy + curve * 9), w, cornerY);
      ctx.stroke();
      if (curve > 0.4) {
        // Dimples at the corners.
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(side * (w - 2), cornerY - 4);
          ctx.quadraticCurveTo(side * (w + 4), cornerY, side * (w - 1), cornerY + 4);
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }

    // Open: a wide "D" — flat top lip, deep rounded bottom, pink tongue.
    const mouth = new Path2D();
    mouth.moveTo(-w, cornerY);
    mouth.quadraticCurveTo(0, ctrl(upperMid), w, cornerY);
    mouth.bezierCurveTo(w * 0.9, lowerMid + 4, -w * 0.9, lowerMid + 4, -w, cornerY);
    mouth.closePath();
    ctx.fillStyle = "#3d0e05";
    ctx.fill(mouth);
    ctx.save();
    ctx.clip(mouth);
    if (open > 0.2 && curve > -0.2) {
      ctx.fillStyle = "#fffaf2";
      ctx.beginPath();
      ctx.moveTo(-w, cornerY - 2);
      ctx.quadraticCurveTo(0, ctrl(upperMid) - 2, w, cornerY - 2);
      ctx.lineTo(w, cornerY + 6);
      ctx.quadraticCurveTo(0, ctrl(upperMid + 6), -w, cornerY + 6);
      ctx.fill();
    }
    ctx.fillStyle = "#ee7d7a";
    ctx.beginPath();
    ctx.ellipse(0, lowerMid + 2, w * 0.6, 6 + open * 10, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.ellipse(-w * 0.15, lowerMid - 4 - open * 2, w * 0.18, 2.5, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 3.2;
    ctx.stroke(mouth);
    // Smile creases.
    if (curve > 0.4) {
      ctx.lineWidth = 2.4;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * (w - 1), cornerY - 5);
        ctx.quadraticCurveTo(side * (w + 5), cornerY - 1, side * (w + 2), cornerY + 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  #tear(f: RigFrame): void {
    if (f.tear < 0.05) return;
    const ctx = this.#ctx;
    const k = clamp(f.tear, 0, 1);
    for (const side of [-1, 1]) {
      const p = (f.t * 0.45 + (side > 0 ? 0.5 : 0)) % 1;
      const x = side * (31 + 10);
      const y = 8 + p * 36;
      ctx.globalAlpha = k * (1 - p * 0.6);
      ctx.fillStyle = "#8fd3ff";
      ctx.strokeStyle = "#2f7fb8";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.bezierCurveTo(x + 6, y - 1, x + 6, y + 6, x, y + 6);
      ctx.bezierCurveTo(x - 6, y + 6, x - 6, y - 1, x, y - 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(x - 1.8, y + 1, 1.5, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** Little "!" ticks around her when her alarm goes (reference poses 3, 14, 18). */
  #sparkles(f: RigFrame): void {
    if (f.ring < 0.05) return;
    const ctx = this.#ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(255,214,60,${f.ring})`;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    const jiggle = Math.sin(f.t * 40) * 3;
    for (const [a, d] of [
      [-0.5, 1.28],
      [-0.25, 1.36],
      [0.0, 1.3],
    ] as const) {
      const ang = -Math.PI / 2 + a + 0.6;
      const x = Math.cos(ang) * R * d + jiggle;
      const y = Math.sin(ang) * R * d;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * 14, y + Math.sin(ang) * 14);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- Limbs ----------

  #legs(f: RigFrame): void {
    const ctx = this.#ctx;
    const c = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    const side3q = Math.abs(sn) > 0.3;
    for (const side of [-1, 1] as const) {
      const swing = side === -1 ? f.legL : f.legR;
      const footLift = side === -1 ? f.footL : f.footR;
      const hip = { x: side * 30 * c, y: HIP_Y };
      const len = LEG * (1 - f.crouch * 0.28);
      // Standing: feet slightly apart, swinging toward where she faces.
      const stand = {
        x: hip.x + side * 10 * Math.abs(c) + Math.sin(swing) * len * sn,
        y: hip.y + Math.cos(swing) * len - footLift,
      };
      // Sitting: legs stick out toward you, soles showing (reference pose 4).
      const sit = { x: side * 42, y: hip.y + 26 };
      const foot = lerpPt(stand, sit, f.sit);
      const knee = {
        x: (hip.x + foot.x) / 2 + side * (6 + f.crouch * 18),
        y: (hip.y + foot.y) / 2,
      };
      hose(ctx, hip, knee, foot);

      ctx.save();
      ctx.translate(foot.x, foot.y);
      if (f.sit > 0.5) {
        this.#sole(side);
      } else {
        const toe = side3q ? Math.sign(sn) : side;
        ctx.rotate(-toe * clamp(footLift / 60, 0, 0.5));
        this.#shoe(toe);
      }
      ctx.restore();
    }
  }

  /** Big white sneaker, side view, toe pointing `toe` (-1 left, 1 right). */
  #shoe(toe: number): void {
    const ctx = this.#ctx;
    ctx.save();
    ctx.scale(toe * 1.6, 1.6);
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = INK;

    const shoe = new Path2D();
    shoe.moveTo(-13, 19);
    shoe.lineTo(26, 19);
    shoe.quadraticCurveTo(38, 19, 36, 8);
    shoe.bezierCurveTo(34, -4, 20, -6, 11, -1);
    shoe.quadraticCurveTo(5, 1, 0, -2);
    shoe.bezierCurveTo(-14, -4, -18, 8, -13, 19);
    shoe.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, 20);
    g.addColorStop(0, GLOVE);
    g.addColorStop(1, GLOVE_SHADE);
    ctx.fillStyle = g;
    ctx.fill(shoe);
    ctx.stroke(shoe);

    // Sole.
    ctx.fillStyle = SOLE;
    ctx.beginPath();
    ctx.moveTo(-14, 15);
    ctx.lineTo(33, 15);
    ctx.quadraticCurveTo(36, 18, 30, 21);
    ctx.lineTo(-11, 21);
    ctx.quadraticCurveTo(-16, 19, -14, 15);
    ctx.fill();
    ctx.stroke();

    // Fluffy sock cuff.
    ctx.fillStyle = GLOVE;
    ctx.beginPath();
    ctx.ellipse(1, -3, 12.5, 7, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Shoe seen from below, for sitting. */
  #sole(side: number): void {
    const ctx = this.#ctx;
    ctx.save();
    ctx.translate(0, 20);
    ctx.rotate(side * 0.25);
    ctx.scale(1.45, 1.45);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = INK;
    ctx.fillStyle = GLOVE;
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 24, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = SOLE;
    ctx.beginPath();
    ctx.ellipse(0, 2, 14, 20, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = SOLE_DARK;
    ctx.lineWidth = 1.6;
    for (let y = -14; y <= 18; y += 6) {
      ctx.beginPath();
      ctx.moveTo(-14, y);
      ctx.lineTo(14, y - 3);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = GLOVE;
    ctx.beginPath();
    ctx.ellipse(0, -24, 11, 6, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  #arm(f: RigFrame, side: -1 | 1): void {
    const ctx = this.#ctx;
    const c = Math.cos(f.yaw);
    const angle = side === -1 ? f.armL : f.armR;
    const bend = side === -1 ? f.bendL : f.bendR;
    const reach = side === -1 ? f.reachL : f.reachR;
    const pose = side === -1 ? f.handL : f.handR;

    const shoulder = { x: side * (R - 4) * c, y: SHOULDER_Y };
    const dir = { x: side * Math.sin(angle) * c, y: Math.cos(angle) };
    const len = ARM * reach;
    const hand = { x: shoulder.x + dir.x * len, y: shoulder.y + dir.y * len };
    // Rubber-hose elbow: bow away from the body (or up) for positive bend.
    let n = { x: -dir.y, y: dir.x };
    if (n.x * side - n.y * 0.5 < 0) n = { x: -n.x, y: -n.y };
    const elbow = {
      x: (shoulder.x + hand.x) / 2 + n.x * bend * 26,
      y: (shoulder.y + hand.y) / 2 + n.y * bend * 26,
    };
    hose(ctx, shoulder, elbow, hand);

    ctx.save();
    ctx.translate(hand.x, hand.y);
    if (pose === "thumb") {
      // Thumbs up stays upright whatever the arm is doing.
      ctx.scale(-side, 1);
      this.#glove("thumb");
    } else {
      ctx.rotate(Math.atan2(hand.y - elbow.y, hand.x - elbow.x));
      // Keep the thumb on top for both hands.
      ctx.scale(1, side * (dir.x * side >= 0 ? 1 : -1) * (Math.cos(angle) > 0.2 ? -1 : 1));
      this.#glove(pose);
    }
    ctx.restore();
  }

  /** White cartoon glove; local +x points away from the wrist, thumb toward -y. */
  #glove(pose: HandPose): void {
    const ctx = this.#ctx;
    ctx.scale(1.55, 1.55);
    const parts: Path2D[] = [];
    const lines: [number, number, number, number][] = [];
    const cuff = new Path2D();
    cuff.ellipse(-3, 0, 6, 11.5, 0, 0, TAU);
    parts.push(cuff);

    if (pose === "open") {
      parts.push(ellipse(10, 0, 12, 11.5));
      for (const a of [-0.42, -0.06, 0.3]) {
        parts.push(capsule(12, a * 6, 12 + Math.cos(a) * 21, Math.sin(a) * 21 + a * 4, 4.8));
      }
      parts.push(capsule(8, -6, 12, -21, 4.8));
    } else if (pose === "thumb") {
      parts.push(roundRectPath(-11, -10, 22, 24, 9));
      for (const y of [-6, 1, 8]) parts.push(capsule(-4, y, 10, y, 4.4));
      parts.push(capsule(-6, -8, -6, -27, 5.2));
      lines.push([-2, -2.5, 8, -2.5], [-2, 4.5, 8, 4.5]);
    } else {
      // Fist; "point" adds the index finger.
      parts.push(ellipse(9, 0, 13, 13));
      const knuckles = pose === "point" ? [1, 8] : [-7, 0, 7];
      for (const y of knuckles) parts.push(ellipse(19, y, 5.4, 4.8));
      if (pose === "point") parts.push(capsule(14, -6, 38, -6, 4.8));
      parts.push(capsule(5, -10, 15, -9, 4.4));
      lines.push([14, -3.5, 20, -3.5], [14, 3.5, 20, 3.5]);
    }

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Outline everything, then fill on top: overlapping parts read as one glove.
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    for (const p of parts) ctx.stroke(p);
    const g = ctx.createRadialGradient(4, -6, 2, 6, 0, 26);
    g.addColorStop(0, GLOVE);
    g.addColorStop(1, GLOVE_SHADE);
    ctx.fillStyle = g;
    for (const p of parts) ctx.fill(p);
    ctx.lineWidth = 1.6;
    for (const [x1, y1, x2, y2] of lines) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    // Cuff seam.
    ctx.beginPath();
    ctx.ellipse(-3, 0, 2.5, 9, 0, -1.2, 1.2);
    ctx.stroke();
  }
}

/** A rubber-hose limb: dark outline, brown fill, a highlight. */
function hose(ctx: CanvasRenderingContext2D, a: Pt, ctrl: Pt, b: Pt): void {
  ctx.lineCap = "round";
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y);
  };
  ctx.strokeStyle = INK;
  ctx.lineWidth = 16;
  path();
  ctx.stroke();
  ctx.strokeStyle = BROWN;
  ctx.lineWidth = 11;
  path();
  ctx.stroke();
  ctx.save();
  ctx.translate(-1.5, -1.5);
  ctx.strokeStyle = BROWN_HI;
  ctx.lineWidth = 2.8;
  path();
  ctx.stroke();
  ctx.restore();
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function ellipse(x: number, y: number, rx: number, ry: number): Path2D {
  const p = new Path2D();
  p.ellipse(x, y, rx, ry, 0, 0, TAU);
  return p;
}

/** A rounded finger from (x1,y1) to (x2,y2). */
function capsule(x1: number, y1: number, x2: number, y2: number, r: number): Path2D {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = new Path2D();
  p.arc(x1, y1, r, a + Math.PI / 2, a + (Math.PI * 3) / 2);
  p.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  p.closePath();
  return p;
}

function roundRectPath(x: number, y: number, w: number, h: number, r: number): Path2D {
  const p = new Path2D();
  p.roundRect(x, y, w, h, r);
  return p;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
