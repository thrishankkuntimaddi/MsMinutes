import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  firmwarePresetsHeader,
  firmwarePresetsSource,
} from "../scripts/generate-firmware-presets.js";

const core = new URL("../../../firmware/desk-companion/components/core/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, core), "utf8");

describe("firmware rig tables", () => {
  it("are generated from the current presets (run pnpm firmware:presets)", () => {
    expect(read("include/rig_presets.h")).toBe(firmwarePresetsHeader());
    expect(read("rig_presets.c")).toBe(firmwarePresetsSource());
  });

  it("carry every parameter and affect in order", () => {
    const header = firmwarePresetsHeader();
    expect(header).toContain("RIG_EYE_OPEN = 0,");
    expect(header).toContain("RIG_HAND_SPEED = 24,");
    expect(header).toContain("AFFECT_NEUTRAL = 0,");
    expect(header).toContain("AFFECT_PROUD = 14,");
  });
});
