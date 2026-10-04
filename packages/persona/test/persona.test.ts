import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/index.js";

describe("buildSystemPrompt", () => {
  it("fills in her name and the user's name", () => {
    const prompt = buildSystemPrompt({ name: "Ms. Minutes", userName: "Thrishank" });
    expect(prompt).toMatch(/^You are Ms\. Minutes,/);
    expect(prompt).toContain("The person you live with is Thrishank.");
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it("omits the editor notes above the prompt marker", () => {
    const prompt = buildSystemPrompt({ name: "Ms. Minutes" });
    expect(prompt).not.toContain("Persona — Ms. Minutes");
    expect(prompt).toContain("don't know the name");
  });
});
