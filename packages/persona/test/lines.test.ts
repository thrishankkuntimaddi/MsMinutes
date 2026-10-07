import { describe, expect, it } from "vitest";
import { loadLines, matchLine } from "../src/index.js";

describe("her scripted lines", () => {
  const lines = loadLines();

  it("loads lines.md", () => {
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.when.length).toBeGreaterThan(0);
      expect(line.say).not.toMatch(/##|<!--/);
    }
  });

  it("answers the command, however it's typed or heard", () => {
    const yours = lines.find((l) => l.say.includes("Infinity Gauntlet"));
    expect(matchLine(lines, "And what have we always wanted?")).toBe(yours);
    expect(matchLine(lines, "and what have we always wanted")).toBe(yours);
    // A dropped word from speech recognition, and her name in front.
    expect(matchLine(lines, "Miss Minutes, what have we ever wanted?")).toBe(yours);
    expect(matchLine(lines, "Ms. Minutes, make us an offer.")?.say).toContain("always wanted");
  });

  it("stays out of ordinary conversation", () => {
    expect(matchLine(lines, "What have you got for dinner?")).toBeUndefined();
    expect(
      matchLine(lines, "I read that people want what they have always wanted, isn't that funny"),
    ).toBeUndefined();
    expect(matchLine(lines, "")).toBeUndefined();
  });

  it("parses the format", () => {
    const parsed = loadLines(
      "notes\n<!-- lines -->\n## when: a | b c\n\nHello… there.\n\n## when: d\nBye.\n",
    );
    expect(parsed).toEqual([
      { when: ["a", "b c"], say: "Hello… there." },
      { when: ["d"], say: "Bye." },
    ]);
  });
});
