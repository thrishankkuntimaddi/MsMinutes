import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  CharacterEventBus,
  CHARACTER_EVENT_VERSION,
  CharacterEventSchema,
  type CharacterEvent,
} from "../src/character-events.js";

describe("CharacterEvent contract", () => {
  it("has version 1", () => {
    expect(CHARACTER_EVENT_VERSION).toBe(1);
  });

  it("validates speech.started with text", () => {
    const event = { type: "speech.started" as const, text: "Hello!" };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates speech.started without text", () => {
    const event = { type: "speech.started" as const };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates speech.ended", () => {
    const event = { type: "speech.ended" as const };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates speech.word", () => {
    const event = { type: "speech.word" as const, index: 2, word: "hello" };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates listening.changed", () => {
    const event = { type: "listening.changed" as const, active: true };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates acting.intent with all fields", () => {
    const event = {
      type: "acting.intent" as const,
      mood: "happy",
      intensity: 0.7,
      gesture: "wave",
    };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates acting.intent with only mood", () => {
    const event = { type: "acting.intent" as const, mood: "sad" };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates action.completed", () => {
    const event = { type: "action.completed" as const, action: "jump" };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates action.failed", () => {
    const event = {
      type: "action.failed" as const,
      action: "fly",
      reason: "unknown action: fly",
    };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates mode.changed", () => {
    for (const mode of ["idle", "listening", "thinking", "speaking"] as const) {
      expect(CharacterEventSchema.parse({ type: "mode.changed", mode })).toEqual({
        type: "mode.changed",
        mode,
      });
    }
  });

  it("validates link.changed", () => {
    for (const status of ["connecting", "online", "offline", "replaced"] as const) {
      expect(CharacterEventSchema.parse({ type: "link.changed", status })).toEqual({
        type: "link.changed",
        status,
      });
    }
  });

  it("validates alarm.fired", () => {
    const event = { type: "alarm.fired" as const, label: "Tea time" };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("validates animation.requested", () => {
    const event = {
      type: "animation.requested" as const,
      action: "dance",
      immediate: true,
    };
    expect(CharacterEventSchema.parse(event)).toEqual(event);
  });

  it("rejects unknown event types", () => {
    expect(() =>
      CharacterEventSchema.parse({ type: "unknown.event" }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      CharacterEventSchema.parse({ type: "action.failed", action: "walk" }),
    ).toThrow(); // missing `reason`
  });
});

describe("CharacterEventBus", () => {
  let bus: CharacterEventBus;

  beforeEach(() => {
    bus = new CharacterEventBus();
  });

  it("delivers events to typed subscribers", () => {
    const handler = vi.fn();
    bus.on("speech.started", handler);
    bus.emit({ type: "speech.started", text: "Hi" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: "speech.started", text: "Hi" });
  });

  it("does not deliver events to wrong type", () => {
    const handler = vi.fn();
    bus.on("speech.ended", handler);
    bus.emit({ type: "speech.started", text: "Hi" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to onAny subscribers for every event", () => {
    const handler = vi.fn();
    bus.onAny(handler);
    bus.emit({ type: "speech.started" });
    bus.emit({ type: "speech.ended" });
    bus.emit({ type: "mode.changed", mode: "idle" });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes cleanly", () => {
    const handler = vi.fn();
    const unsub = bus.on("speech.started", handler);
    bus.emit({ type: "speech.started" });
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    bus.emit({ type: "speech.started" });
    expect(handler).toHaveBeenCalledOnce(); // still 1
  });

  it("unsubscribes onAny cleanly", () => {
    const handler = vi.fn();
    const unsub = bus.onAny(handler);
    bus.emit({ type: "speech.ended" });
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    bus.emit({ type: "speech.ended" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("clear removes all handlers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("speech.started", h1);
    bus.onAny(h2);
    bus.clear();
    bus.emit({ type: "speech.started" });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers for the same type", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("alarm.fired", h1);
    bus.on("alarm.fired", h2);
    bus.emit({ type: "alarm.fired", label: "Tea" });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("emits events with correct payload shape", () => {
    const events: CharacterEvent[] = [];
    bus.onAny((e) => events.push(e));

    bus.emit({ type: "acting.intent", mood: "excited", intensity: 0.9, gesture: "jump" });
    bus.emit({ type: "action.completed", action: "jump" });
    bus.emit({ type: "link.changed", status: "online" });

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("acting.intent");
    expect(events[1]!.type).toBe("action.completed");
    expect(events[2]!.type).toBe("link.changed");
  });
});
