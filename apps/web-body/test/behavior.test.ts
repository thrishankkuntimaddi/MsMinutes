import { describe, expect, it, vi, beforeEach } from "vitest";
import { CharacterRig } from "@ms-minutes/character";
import { CharacterEventBus, type CharacterEvent } from "../src/character-events.js";
import { Behavior } from "../src/behavior.js";

function setup() {
  const rig = new CharacterRig();
  const bus = new CharacterEventBus();
  const behavior = new Behavior({ rig, bus });
  const events: CharacterEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { rig, bus, behavior, events };
}

describe("Behavior", () => {
  it("sets expression on acting.intent", () => {
    const { bus, rig } = setup();
    // Spy on setExpression
    const spy = vi.spyOn(rig, "setExpression");
    bus.emit({ type: "acting.intent", mood: "happy", intensity: 0.8 });
    expect(spy).toHaveBeenCalledWith("happy", 0.8);
  });

  it("triggers a hop on excited with high intensity", () => {
    const { bus, rig } = setup();
    const actSpy = vi.spyOn(rig, "act");
    bus.emit({ type: "acting.intent", mood: "excited", intensity: 0.7 });
    expect(actSpy).toHaveBeenCalledWith("jump");
  });

  it("triggers a hop on surprised", () => {
    const { bus, rig } = setup();
    const hopSpy = vi.spyOn(rig, "hop");
    bus.emit({ type: "acting.intent", mood: "surprised", intensity: 0.6 });
    expect(hopSpy).toHaveBeenCalledWith(0.6);
  });

  it("performs gesture from acting.intent when valid", () => {
    const { bus, rig, events } = setup();
    const actSpy = vi.spyOn(rig, "act");
    bus.emit({ type: "acting.intent", mood: "happy", intensity: 0.5, gesture: "dance" });
    expect(actSpy).toHaveBeenCalledWith("dance");
    expect(events.some((e) => e.type === "action.completed" && e.action === "dance")).toBe(true);
  });

  it("looks at the listener on speech.started", () => {
    const { bus, rig } = setup();
    const lookSpy = vi.spyOn(rig, "lookAt");
    bus.emit({ type: "speech.started", text: "Hello" });
    expect(lookSpy).toHaveBeenCalledWith(0, 0.05, 600);
  });

  it("releases gaze on speech.ended", () => {
    const { bus, rig } = setup();
    const lookSpy = vi.spyOn(rig, "lookAt");
    bus.emit({ type: "speech.ended" });
    expect(lookSpy).toHaveBeenCalledWith(0, 0, 0.1);
  });

  it("sets curious expression on listening.changed active", () => {
    const { bus, rig } = setup();
    const exprSpy = vi.spyOn(rig, "setExpression");
    bus.emit({ type: "listening.changed", active: true });
    expect(exprSpy).toHaveBeenCalledWith("curious", 0.4);
  });

  it("triggers alarm reaction on alarm.fired", () => {
    const { bus, rig } = setup();
    const exprSpy = vi.spyOn(rig, "setExpression");
    const ringSpy = vi.spyOn(rig, "ring");
    const actSpy = vi.spyOn(rig, "act");
    bus.emit({ type: "alarm.fired", label: "Tea" });
    expect(exprSpy).toHaveBeenCalledWith("excited", 0.9);
    expect(ringSpy).toHaveBeenCalledWith(2.8);
    expect(actSpy).toHaveBeenCalledWith("jump");
  });

  it("performs animation.requested with valid action", () => {
    const { bus, rig, events } = setup();
    const actSpy = vi.spyOn(rig, "act");
    bus.emit({ type: "animation.requested", action: "walk" });
    expect(actSpy).toHaveBeenCalledWith("walk");
    expect(events.some((e) => e.type === "action.completed" && e.action === "walk")).toBe(true);
  });

  it("emits action.failed for unknown actions", () => {
    const { bus, events } = setup();
    bus.emit({ type: "animation.requested", action: "fly" });
    const failed = events.find(
      (e) => e.type === "action.failed" && e.action === "fly",
    );
    expect(failed).toBeDefined();
    expect(failed?.type === "action.failed" && failed.reason).toContain("unknown action");
  });

  it("does not hop twice on the same affect", () => {
    const { bus, rig } = setup();
    const hopSpy = vi.spyOn(rig, "hop");
    bus.emit({ type: "acting.intent", mood: "surprised", intensity: 0.8 });
    bus.emit({ type: "acting.intent", mood: "surprised", intensity: 0.8 });
    // First call triggers hop, second does not (same affect).
    expect(hopSpy).toHaveBeenCalledTimes(1);
  });

  it("dispose removes all subscriptions", () => {
    const { bus, rig, behavior } = setup();
    behavior.dispose();
    const exprSpy = vi.spyOn(rig, "setExpression");
    bus.emit({ type: "acting.intent", mood: "angry", intensity: 1 });
    expect(exprSpy).not.toHaveBeenCalled();
  });
});
