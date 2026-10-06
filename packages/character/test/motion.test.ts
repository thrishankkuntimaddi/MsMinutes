import { describe, expect, it } from "vitest";
import { CharacterRig, HAND_POSES, Motion, type MotionFrame } from "../src/index.js";

function run(m: Motion, seconds: number): MotionFrame[] {
  const frames: MotionFrame[] = [];
  for (let i = 0; i < seconds * 60; i++) frames.push(m.update(1 / 60));
  return frames;
}

const quiet = () => {
  const m = new Motion({ random: () => 0.9 });
  m.autopilot = false;
  return m;
};

describe("motion", () => {
  it("walks somewhere and stops, stepping as it goes", () => {
    const m = quiet();
    m.do("walk");
    const frames = run(m, 6);
    expect(Math.abs(frames.at(-1)!.x)).toBeGreaterThan(0.3);
    expect(frames.some((f) => f.footL > 2) && frames.some((f) => f.footR > 2)).toBe(true);
    expect(frames.at(-1)!.moving).toBe(false);
  });

  it("jumps up and lands again", () => {
    const m = quiet();
    m.do("jump");
    const frames = run(m, 2);
    expect(Math.max(...frames.map((f) => f.lift))).toBeGreaterThan(30);
    expect(frames.at(-1)!.lift).toBeCloseTo(0, 1);
    expect(m.busy).toBe(false);
  });

  it("turns its back and turns round again", () => {
    const m = quiet();
    m.do("turn_around");
    const frames = run(m, 5);
    expect(Math.max(...frames.map((f) => Math.cos(f.yaw)))).toBeGreaterThan(0.9);
    expect(Math.min(...frames.map((f) => Math.cos(f.yaw)))).toBeLessThan(-0.9);
    expect(Math.cos(frames.at(-1)!.yaw)).toBeGreaterThan(0.9);
  });

  it("sits and stands", () => {
    const m = quiet();
    m.do("sit");
    expect(run(m, 2).at(-1)!.sit).toBeGreaterThan(0.9);
    m.do("stand");
    expect(run(m, 2).at(-1)!.sit).toBeLessThan(0.1);
  });

  it("runs in from off screen to the middle", () => {
    const m = quiet();
    m.enter(-1);
    const frames = run(m, 5);
    expect(frames[0]!.x).toBeLessThan(-1.5);
    expect(Math.max(...frames.map((f) => f.pace))).toBeGreaterThan(1.5);
    expect(frames.at(-1)!.x).toBeCloseTo(0, 2);
  });

  it("drops in from the air, lands, and leaves by the side", () => {
    const m = new Motion({ random: () => 0.5 });
    m.autopilot = false;
    m.appear(0.3, 120, -1);
    expect(m.update(0.016).lift).toBeGreaterThan(100);
    for (let i = 0; i < 120; i++) m.update(1 / 60);
    const landed = m.update(1 / 60);
    expect(landed.lift).toBe(0);
    expect(landed.x).toBeCloseTo(0.3);
    m.exit(1);
    for (let i = 0; i < 240; i++) m.update(1 / 60);
    expect(m.update(1 / 60).x).toBeGreaterThan(1.5);
  });

  it("covers a wider stage at the same pace when its reach is larger", () => {
    const near = new Motion({ random: () => 0.5 });
    const far = new Motion({ random: () => 0.5 });
    near.autopilot = far.autopilot = false;
    far.reach = 3;
    near.leap(0.9, 0);
    far.leap(0.9, 0);
    for (let i = 0; i < 30; i++) {
      near.update(1 / 60);
      far.update(1 / 60);
    }
    expect(far.update(1 / 60).x).toBeLessThan(near.update(1 / 60).x);
  });

  it("wanders on its own when idle", () => {
    const m = new Motion({ random: () => 0.1 });
    const frames = run(m, 20);
    expect(frames.some((f) => f.moving)).toBe(true);
  });
});

describe("rig gestures", () => {
  it("gives proud a thumbs up and comes to the front to listen", () => {
    const rig = new CharacterRig({ random: () => 0.5 });
    rig.setExpression("proud", 1);
    const f = rig.update(1 / 60);
    expect([f.handL, f.handR]).toEqual(HAND_POSES.proud);
    rig.act("run");
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    rig.setMode("listening");
    let last = rig.update(1 / 60);
    for (let i = 0; i < 400; i++) last = rig.update(1 / 60);
    expect(last.x).toBeCloseTo(0, 2);
  });
});
