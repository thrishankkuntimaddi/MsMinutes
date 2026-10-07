import { describe, expect, it } from "vitest";
import { perform, planDelivery, trim } from "../src/modules/voice/delivery.js";

const texts = (s: string) => planDelivery(s, 1).map((p) => p.text);

describe("her delivery", () => {
  it("breaks at clauses and keeps the punctuation with each phrase", () => {
    expect(
      texts("Now, the big moment, you versus all of them… how would you like to win?"),
    ).toEqual(["Now, the big moment,", "you versus all of them…", "how would you like to win?"]);
  });

  it("leaves times, numbers and titles whole", () => {
    expect(texts("Your timer ends at 3:30, and that's 3,000 seconds.")).toEqual([
      "Your timer ends at 3:30,",
      "and that's 3,000 seconds.",
    ]);
    expect(texts("Hi! My name is Ms. Minutes.")).toEqual(["Hi!", "My name is Ms. Minutes."]);
  });

  it("pauses longer at an ellipsis than at a comma", () => {
    const [comma] = planDelivery("Well, that's fine.", 7);
    const [dots] = planDelivery("And then… nothing at all.", 7);
    expect(dots!.pauseMs).toBeGreaterThan(comma!.pauseMs * 2);
  });

  it("slows down for what matters, with a beat before it", () => {
    const [lead, key] = planDelivery("Before you go, remember to take your keys.", 3);
    expect(key!.pace).toBeLessThan(1);
    expect(key!.weight).toBeGreaterThan(1);
    expect(lead!.pauseMs).toBeGreaterThan(200);
  });

  it("varies its pauses, but repeatably", () => {
    const a = planDelivery("One, two, three, four, five.", 1).map((p) => p.pauseMs);
    expect(new Set(a.slice(0, -1)).size).toBeGreaterThan(1);
    expect(planDelivery("One, two, three, four, five.", 1).map((p) => p.pauseMs)).toEqual(a);
  });

  it("stitches phrases with her pauses and timed captions", () => {
    const rate = 1000;
    const tone = (n: number) => {
      const s = new Float32Array(n + 40);
      s.fill(0.5, 20, 20 + n);
      return { samples: s, sampleRate: rate };
    };
    const phrases = [
      { text: "Well, hello", pace: 1, weight: 1, pauseMs: 300 },
      { text: "there.", pace: 1, weight: 1, pauseMs: 100 },
    ];
    const out = perform(phrases, [tone(200), tone(100)]);
    const second = out.marks.find((m) => m.value === "there.")!;
    // breath in (60) + first phrase (~200 + padding) + its pause (300)
    expect(second.t).toBeGreaterThan(560);
    expect(out.samples.length).toBeGreaterThan(60 + 200 + 300 + 100 + 100);
  });

  it("trims a take's own edge silence", () => {
    const s = new Float32Array(100);
    s.fill(0.3, 40, 60);
    expect(trim(s, 5).length).toBe(30);
  });
});
