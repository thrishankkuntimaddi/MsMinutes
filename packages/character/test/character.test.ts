import { describe, expect, it } from "vitest";
import { Affect } from "@ms-minutes/protocol";
import {
  blendTargets,
  CharacterRig,
  estimateWordMs,
  NEUTRAL,
  PARAM_KEYS,
  PRESETS,
  sampleTimeline,
  Spring,
  VISEMES,
  wordTimeline,
} from "../src/index.js";

/** Deterministic random for repeatable idle behaviour. */
function seeded(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function run(rig: CharacterRig, seconds: number, fps = 60) {
  const frames = [];
  for (let i = 0; i < seconds * fps; i++) frames.push(rig.update(1 / fps, new Date(0)));
  return frames;
}

describe("presets", () => {
  it("cover every affect in the protocol", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...Affect.options].sort());
  });

  it("scale with intensity and blend additively", () => {
    const half = blendTargets([{ affect: "happy", weight: 0.5 }]);
    expect(half.mouthCurve).toBeCloseTo((NEUTRAL.mouthCurve + 1) / 2);
    const mixed = blendTargets([
      { affect: "happy", weight: 1 },
      { affect: "sleepy", weight: 1 },
    ]);
    expect(mixed.eyeOpen).toBeLessThan(NEUTRAL.eyeOpen);
    expect(mixed.cheek).toBeGreaterThan(NEUTRAL.cheek);
  });
});

describe("spring", () => {
  it("overshoots slightly, then settles on the target", () => {
    const s = new Spring(0, 200, 0.5);
    s.target = 1;
    let peak = 0;
    for (let i = 0; i < 240; i++) peak = Math.max(peak, s.step(1 / 60));
    expect(peak).toBeGreaterThan(1);
    expect(s.value).toBeCloseTo(1, 3);
  });
});

describe("rig", () => {
  it("produces finite values for every expression", () => {
    for (const affect of Affect.options) {
      const rig = new CharacterRig({ random: seeded() });
      rig.setExpression(affect, 1);
      rig.setViseme(VISEMES.wide);
      const last = run(rig, 2).at(-1)!;
      for (const key of PARAM_KEYS)
        expect(Number.isFinite(last[key]), `${affect}.${key}`).toBe(true);
    }
  });

  it("moves toward the expression's targets", () => {
    const rig = new CharacterRig({ random: seeded() });
    rig.setExpression("sad", 1);
    const last = run(rig, 3).at(-1)!;
    expect(last.mouthCurve).toBeLessThan(-0.5);
    expect(last.browAngle).toBeGreaterThan(0.6);
  });

  it("blinks on its own", () => {
    const frames = run(new CharacterRig({ random: seeded(7) }), 8);
    expect(frames.some((f) => f.blinkL > 0.95 && f.blinkR > 0.95)).toBe(true);
  });

  it("winks one eye", () => {
    const rig = new CharacterRig({ random: () => 0.99 });
    run(rig, 0.1);
    rig.wink("right");
    const frames = run(rig, 0.3);
    expect(Math.max(...frames.map((f) => f.blinkR))).toBe(1);
    expect(Math.max(...frames.map((f) => f.blinkL))).toBe(0);
  });

  it("opens the mouth while speaking", () => {
    const rig = new CharacterRig({ random: seeded() });
    rig.setViseme(VISEMES.wide);
    expect(run(rig, 0.3).at(-1)!.mouthOpen).toBeGreaterThan(0.5);
    rig.setViseme(null);
    expect(run(rig, 0.5).at(-1)!.mouthOpen).toBeLessThan(0.1);
  });

  it("shows the real time on its hands", () => {
    const rig = new CharacterRig({ random: seeded() });
    const frame = rig.update(1 / 60, new Date(2026, 9, 4, 3, 0, 0));
    expect(frame.hourAngle).toBeCloseTo(Math.PI / 2, 2);
    expect(frame.minuteAngle).toBeCloseTo(0, 2);
  });
});

describe("lip-sync", () => {
  it("maps letters to mouth shapes", () => {
    const shapes = wordTimeline("mom").map((e) => e.viseme);
    expect(shapes.slice(0, 3)).toEqual([VISEMES.closed, VISEMES.round, VISEMES.closed]);
  });

  it("spells out acronyms and gives them more time", () => {
    expect(wordTimeline("TVA").length).toBeGreaterThan(wordTimeline("tva").length);
    expect(estimateWordMs("TVA")).toBeGreaterThan(estimateWordMs("tva"));
  });

  it("samples the shape active at a point in the word", () => {
    const timeline = wordTimeline("ah");
    expect(sampleTimeline(timeline, 0)).toEqual(VISEMES.wide);
    expect(sampleTimeline(timeline, 0.95)).toEqual(VISEMES.small);
  });
});
