import { describe, expect, it, vi, beforeEach } from "vitest";
import { CharacterRig } from "@ms-minutes/character";
import { CharacterEventBus } from "../src/character-events.js";
import {
  AnimationController,
  Priority,
  type TransitionRequest,
} from "../src/animation-controller.js";

function setup() {
  const rig = new CharacterRig();
  const bus = new CharacterEventBus();
  const controller = new AnimationController({ rig, bus });
  return { rig, bus, controller };
}

describe("AnimationController", () => {
  it("accepts a transition request and reports it active", () => {
    const { controller, rig } = setup();
    const apply = vi.fn();
    const accepted = controller.request({
      name: "hop",
      priority: Priority.REACTION,
      apply,
    });
    expect(accepted).toBe(true);
    expect(apply).toHaveBeenCalledWith(rig);
    expect(controller.active?.name).toBe("hop");
    expect(controller.active?.priority).toBe(Priority.REACTION);
  });

  it("rejects lower-priority requests while something is active", () => {
    const { controller } = setup();
    controller.request({
      name: "alarm",
      priority: Priority.ALARM,
      apply: () => {},
    });
    const lowApply = vi.fn();
    const accepted = controller.request({
      name: "idle-wander",
      priority: Priority.IDLE,
      apply: lowApply,
    });
    expect(accepted).toBe(false);
    expect(lowApply).not.toHaveBeenCalled();
    expect(controller.active?.name).toBe("alarm");
  });

  it("allows higher-priority requests to preempt", () => {
    const { controller, bus } = setup();
    const events: string[] = [];
    bus.on("action.completed", (e) => events.push(e.action));

    controller.request({
      name: "walk",
      priority: Priority.REACTION,
      apply: () => {},
    });
    controller.request({
      name: "alarm-ring",
      priority: Priority.ALARM,
      apply: () => {},
    });

    expect(controller.active?.name).toBe("alarm-ring");
    // The preempted "walk" should have emitted completion.
    expect(events).toContain("walk");
  });

  it("allows equal-priority requests to replace", () => {
    const { controller } = setup();
    controller.request({
      name: "walk-left",
      priority: Priority.REACTION,
      apply: () => {},
    });
    const accepted = controller.request({
      name: "walk-right",
      priority: Priority.REACTION,
      apply: () => {},
    });
    expect(accepted).toBe(true);
    expect(controller.active?.name).toBe("walk-right");
  });

  it("interrupt clears the active transition", () => {
    const { controller } = setup();
    controller.request({
      name: "dance",
      priority: Priority.REACTION,
      apply: () => {},
    });
    expect(controller.active).not.toBeNull();
    controller.interrupt(Priority.INTERRUPT);
    expect(controller.active).toBeNull();
  });

  it("interrupt fails if priority is too low", () => {
    const { controller } = setup();
    controller.request({
      name: "alarm",
      priority: Priority.ALARM,
      apply: () => {},
    });
    const success = controller.interrupt(Priority.IDLE);
    expect(success).toBe(false);
    expect(controller.active?.name).toBe("alarm");
  });

  it("update drives the rig and returns a frame", () => {
    const { controller } = setup();
    const frame = controller.update(1 / 60);
    expect(frame).toBeDefined();
    expect(typeof frame.t).toBe("number");
    expect(typeof frame.mouthOpen).toBe("number");
    expect(typeof frame.x).toBe("number");
  });

  it("update clears active when rig motion finishes", () => {
    const { controller, bus } = setup();
    const completed: string[] = [];
    bus.on("action.completed", (e) => completed.push(e.action));

    controller.request({
      name: "stand-still",
      priority: Priority.IDLE,
      apply: () => {}, // No motion queued, so motion.busy = false immediately.
    });

    controller.update(1 / 60);
    // Motion was never busy → should clear immediately.
    expect(controller.active).toBeNull();
    expect(completed).toContain("stand-still");
  });

  it("setViseme forwards to the rig via update", () => {
    const { controller, rig } = setup();
    const viseme = { open: 0.5, round: 0.2, width: 1.0 };
    controller.setViseme(viseme);
    const frame = controller.update(1 / 60);
    // The rig should have applied the viseme to the mouth.
    // mouthOpen should be influenced (not necessarily equal, since the rig blends).
    expect(frame.mouthOpen).toBeGreaterThan(0);
  });

  it("exposes the rig for direct queries", () => {
    const { controller, rig } = setup();
    expect(controller.rig).toBe(rig);
  });
});
