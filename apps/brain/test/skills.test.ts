import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrainToBodyMessage, Capability } from "@ms-minutes/protocol";
import { BodyRegistry } from "../src/modules/bodies/registry.js";
import { EventBus } from "../src/modules/events/event-bus.js";
import { migrate, openDb } from "../src/modules/memory/db.js";
import { MemoryStore } from "../src/modules/memory/store.js";
import { Orchestrator } from "../src/modules/orchestrator/orchestrator.js";
import { Announcer, ALARM_RING, DISPLAY_TIMER } from "../src/modules/skills/announcer.js";
import { timerSkills } from "../src/modules/skills/builtin/timers.js";
import { weatherSkill } from "../src/modules/skills/builtin/weather.js";
import { PolicyGate } from "../src/modules/skills/policy.js";
import { SkillRegistry } from "../src/modules/skills/registry.js";
import {
  DbScheduleStore,
  InMemoryScheduleStore,
  Schedules,
  type Scheduled,
  type ScheduleStore,
} from "../src/modules/skills/schedule.js";
import { SkillError, type Skill } from "../src/modules/skills/skill.js";
import { duration, spoken, zonedToUtc } from "../src/modules/skills/time.js";
import { TurnTraces } from "../src/modules/tracing/turn-traces.js";
import { FakeLLM } from "./fake-llm.js";

const log = Fastify({ logger: false }).log;
const TZ = "Asia/Kolkata";

function clock(start = "2026-10-05T04:30:00Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const ctx = (now: Date) => ({ bodyId: "web-01", now, timezone: TZ, log });

describe("policy gate", () => {
  const gate = new PolicyGate({ granted: ["camera.view"], denied: ["weather.get"], log });

  it("runs tiers 0 and 1, tier 2 only when granted, and never tier 3 yet", () => {
    expect(gate.decide("timer.start", 1, "b")).toEqual({ allow: true });
    expect(gate.decide("camera.view", 2, "b")).toEqual({ allow: true });
    expect(gate.decide("door.state", 2, "b")).toMatchObject({ allow: false });
    expect(gate.decide("arm.grab", 3, "b")).toMatchObject({ allow: false });
    expect(gate.decide("weather.get", 0, "b")).toMatchObject({ allow: false });
  });
});

describe("skill registry", () => {
  const echo: Skill<{ n: number }> = {
    name: "echo.twice",
    description: "test",
    riskTier: 0,
    schema: z.object({ n: z.number().int() }),
    execute: async ({ n }) => {
      if (n < 0) throw new SkillError("no negatives");
      if (n === 13) throw new Error("boom");
      return { twice: n * 2 };
    },
  };
  const secret: Skill<Record<string, never>> = {
    name: "camera.view",
    description: "test",
    riskTier: 2,
    schema: z.object({}),
    execute: async () => "pixels",
  };
  const skills = new SkillRegistry(new PolicyGate({ log }))
    .register(echo as Skill)
    .register(secret as Skill);
  const c = ctx(new Date());

  it("exposes skills as tools with dot-free names and JSON schemas", () => {
    const [tool] = skills.tools();
    expect(tool).toMatchObject({
      name: "echo_twice",
      input_schema: { type: "object", required: ["n"] },
    });
  });

  it("validates, gates and runs, turning every failure into something she can say", async () => {
    expect(await skills.run("echo_twice", { n: 2 }, c)).toEqual({ ok: true, result: { twice: 4 } });
    expect(await skills.run("echo_twice", { n: "two" }, c)).toMatchObject({ ok: false });
    expect(await skills.run("echo_twice", { n: -1 }, c)).toEqual({
      ok: false,
      error: "no negatives",
    });
    expect(await skills.run("echo_twice", { n: 13 }, c)).toEqual({
      ok: false,
      error: "echo.twice failed unexpectedly.",
    });
    expect(await skills.run("camera_view", {}, c)).toMatchObject({ ok: false });
    expect(await skills.run("nope", {}, c)).toMatchObject({ ok: false });
  });
});

describe("time", () => {
  it("reads local wall times in the person's timezone", () => {
    expect(zonedToUtc("2026-10-05T18:30", "Asia/Kolkata")!.toISOString()).toBe(
      "2026-10-05T13:00:00.000Z",
    );
    // London is on summer time in July, not in December.
    expect(zonedToUtc("2026-07-01 09:00", "Europe/London")!.toISOString()).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(zonedToUtc("2026-12-01T09:00", "Europe/London")!.toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
    expect(zonedToUtc("six thirty", TZ)).toBeNull();
  });

  it("says times and durations the way she would", () => {
    const now = new Date("2026-10-05T04:30:00Z"); // 10:00 in Kolkata
    expect(spoken(new Date("2026-10-05T13:00:00Z"), TZ, now)).toBe("18:30 today");
    expect(spoken(new Date("2026-10-06T03:00:00Z"), TZ, now)).toBe("8:30 tomorrow");
    expect(duration(330)).toBe("5 minutes 30 seconds");
    expect(duration(3600)).toBe("1 hour");
  });
});

describe("timers and reminders", () => {
  function setup(store: ScheduleStore = new InMemoryScheduleStore()) {
    const t = clock();
    const fired: { item: Scheduled; lateMs: number }[] = [];
    const shown: number[] = [];
    const schedules = new Schedules({
      store,
      now: t.now,
      onFire: (item, lateMs) => fired.push({ item, lateMs }),
      onChange: (items) => shown.push(items.length),
    });
    const skills = new SkillRegistry(new PolicyGate({ log }));
    for (const s of timerSkills(schedules)) skills.register(s);
    const run = (tool: string, input: unknown) => skills.run(tool, input, ctx(t.now()));
    return { t, schedules, skills, run, fired, shown };
  }

  it("starts a timer, shows it, and fires it on time", async () => {
    const { t, schedules, run, fired, shown } = setup();
    await schedules.start(60_000);
    const r = await run("timer_start", { duration_seconds: 300, label: "tea" });
    expect(r).toEqual({
      ok: true,
      result: { started: "tea", length: "5 minutes", goes_off: "10:05 today" },
    });
    expect(shown.at(-1)).toBe(1);

    t.advance(299_000);
    await schedules.check();
    expect(fired).toEqual([]);
    t.advance(1_000);
    await schedules.check();
    expect(fired.map((f) => f.item.label)).toEqual(["tea"]);
    expect(shown.at(-1)).toBe(0);
    schedules.stop();
  });

  it("lists, cancels by label, and asks which when it's ambiguous", async () => {
    const { schedules, run } = setup();
    await schedules.start(60_000);
    await run("timer_start", { duration_seconds: 60, label: "eggs" });
    await run("timer_start", { duration_seconds: 600, label: "pasta" });
    await run("reminder_set", { text: "call mom", at: "2026-10-05T18:30" });
    expect(await run("schedule_list", {})).toMatchObject({
      ok: true,
      result: {
        timers: [{ label: "eggs" }, { label: "pasta" }],
        reminders: [{ text: "call mom", when: "18:30 today" }],
      },
    });
    expect(await run("timer_cancel", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining('"eggs"'),
    });
    expect(await run("timer_cancel", { label: "pasta" })).toEqual({
      ok: true,
      result: { cancelled: "pasta" },
    });
    expect(await run("reminder_cancel", { text: "mom" })).toEqual({
      ok: true,
      result: { cancelled: "call mom" },
    });
    schedules.stop();
  });

  it("refuses reminders in the past and needs a time", async () => {
    const { schedules, run } = setup();
    await schedules.start(60_000);
    expect(await run("reminder_set", { text: "x", at: "2026-10-05T08:00" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already passed"),
    });
    expect(await run("reminder_set", { text: "x" })).toMatchObject({ ok: false });
    expect(await run("reminder_set", { text: "stretch", in_minutes: 20 })).toMatchObject({
      ok: true,
      result: { when: "10:20 today" },
    });
    schedules.stop();
  });

  it("survives a restart: fires late if it came due while off, drops it if long gone", async () => {
    const db = await openDb("memory://");
    await migrate(db);
    await new MemoryStore(db).ensureUser(undefined);
    const first = setup(new DbScheduleStore(db));
    await first.schedules.start(60_000);
    await first.run("timer_start", { duration_seconds: 60, label: "soon" });
    await first.run("reminder_set", { text: "much later", in_minutes: 600 });
    first.schedules.stop();

    // Back after 10 minutes: the timer fires (late), the reminder is still pending.
    const t = clock("2026-10-05T04:40:00Z");
    const fired: { item: Scheduled; lateMs: number }[] = [];
    const again = new Schedules({
      store: new DbScheduleStore(db),
      now: t.now,
      onFire: (item, lateMs) => fired.push({ item, lateMs }),
    });
    await again.start(60_000);
    expect(fired.map((f) => f.item.label)).toEqual(["soon"]);
    expect(fired[0]!.lateMs).toBeGreaterThan(8 * 60_000);
    expect(again.list().map((i) => i.label)).toEqual(["much later"]);
    again.stop();

    // A day later, the reminder is long gone: missed, not announced.
    const late = clock("2026-10-06T12:00:00Z");
    const lateFired: Scheduled[] = [];
    const third = new Schedules({
      store: new DbScheduleStore(db),
      now: late.now,
      onFire: (i) => lateFired.push(i),
    });
    await third.start(60_000);
    expect(lateFired).toEqual([]);
    expect(third.list()).toEqual([]);
    third.stop();
    await db.close();
  });
});

describe("weather", () => {
  const fakeFetch = (async (url: string) => {
    if (url.includes("geocoding")) {
      return Response.json(
        url.includes("Atlantis")
          ? {}
          : {
              results: [{ name: "Hyderabad", country: "India", latitude: 17.38, longitude: 78.46 }],
            },
      );
    }
    return Response.json({
      current: {
        temperature_2m: 27.4,
        apparent_temperature: 30.1,
        relative_humidity_2m: 70,
        weather_code: 63,
        wind_speed_10m: 11,
      },
      daily: {
        temperature_2m_max: [31.2, 30],
        temperature_2m_min: [22.6, 22],
        precipitation_probability_max: [80, 40],
        weather_code: [63, 2],
      },
    });
  }) as typeof fetch;

  it("reports now, today and tomorrow, defaulting to home", async () => {
    const skill = weatherSkill({ defaultPlace: "Hyderabad", fetch: fakeFetch });
    const result = await skill.execute({}, ctx(new Date()));
    expect(result).toMatchObject({
      place: "Hyderabad, India",
      now: { conditions: "rain", temperature_c: 27, feels_like_c: 30 },
      today: { high_c: 31, low_c: 23, chance_of_rain_percent: 80 },
      tomorrow: { conditions: "partly cloudy" },
    });
  });

  it("asks where when it doesn't know, and says when a place doesn't exist", async () => {
    await expect(weatherSkill({ fetch: fakeFetch }).execute({}, ctx(new Date()))).rejects.toThrow(
      /Ask which city/,
    );
    await expect(
      weatherSkill({ fetch: fakeFetch }).execute({ place: "Atlantis" }, ctx(new Date())),
    ).rejects.toThrow(/Couldn't find/);
  });
});

describe("from 'set a timer' to her speaking when it fires", () => {
  it("runs the tool, shows the timer, rings and speaks proactively", async () => {
    const t = clock();
    const llm = new FakeLLM([
      { tools: [{ name: "timer_start", input: { duration_seconds: 60, label: "eggs" } }] },
      { text: ["One minute, starting now."] },
      { text: ["Your eggs are done!"] },
    ]);
    const sent: BrainToBodyMessage[] = [];
    const registry = new BodyRegistry();
    const caps: Capability[] = [
      { name: "express", riskTier: 0 },
      { name: DISPLAY_TIMER, riskTier: 0 },
      { name: ALARM_RING, riskTier: 0 },
    ];
    const bus = new EventBus((err) => {
      throw err;
    });

    const announcer: Announcer = new Announcer({
      registry,
      send: (m) => (sent.push(m), true),
      speak: (bodyId, event) => void orchestrator.enqueueEvent(bodyId, event),
      timezone: TZ,
      log,
    });
    const schedules = new Schedules({
      store: new InMemoryScheduleStore(),
      now: t.now,
      onFire: (item, lateMs) => announcer.fire(item, lateMs),
      onChange: (items) => announcer.show(items),
    });
    const skills = new SkillRegistry(new PolicyGate({ log }));
    for (const s of timerSkills(schedules)) skills.register(s);
    const orchestrator = new Orchestrator({
      llm,
      skills,
      send: (m) => (sent.push(m), true),
      registry,
      traces: new TurnTraces(),
      systemPrompt: "t",
      timezone: TZ,
      log,
      now: t.now,
    });
    announcer.attach(bus);
    const body = {
      id: "web-01",
      type: "web",
      firmware: "0",
      capabilities: caps,
      sessionId: "s",
      connectedAt: t.now(),
      lastSeenAt: t.now(),
    };
    registry.add(body);
    bus.emit({ type: "body.connected", body });
    await schedules.start(60_000);

    expect(orchestrator.tools.map((x) => x.name)).toContain("timer_start");
    await orchestrator.enqueue("web-01", "time my eggs, one minute");
    const display = sent.filter(
      (m) => m.type === "capability.call" && m.payload.name === DISPLAY_TIMER,
    );
    expect(display.at(-1)).toMatchObject({
      payload: { args: { timers: [{ label: "eggs", durationSec: 60 }] } },
    });

    t.advance(60_000);
    await schedules.check();
    await orchestrator.enqueue("web-01", "noop").catch(() => {}); // wait for the queue
    expect(sent.some((m) => m.type === "capability.call" && m.payload.name === ALARM_RING)).toBe(
      true,
    );
    const eventTurn = llm.requests[2]!.messages.at(-1)!;
    expect(JSON.stringify(eventTurn.content)).toContain(
      'Your \\"eggs\\" timer (1 minute) just went off',
    );
    schedules.stop();
  });
});

describe("backstop for timers and reminders she claims but doesn't call", () => {
  it("reads plain asks", async () => {
    const { backstop, parseDuration } = await import("../src/modules/skills/builtin/backstop.js");
    expect(parseDuration("an hour and a half")).toBe(5400);
    expect(parseDuration("half an hour")).toBe(1800);
    expect(parseDuration("1 hour 30 minutes")).toBe(5400);
    expect(parseDuration("twenty seconds")).toBe(20);
    expect(backstop("Set a timer for 20 seconds for my tea please.")).toEqual({
      tool: "timer_start",
      input: { duration_seconds: 20, label: "tea" },
    });
    expect(backstop("Can you time 5 minutes for the pasta?")).toEqual({
      tool: "timer_start",
      input: { duration_seconds: 300, label: "pasta" },
    });
    expect(backstop("start a 10 minute timer")).toEqual({
      tool: "timer_start",
      input: { duration_seconds: 600 },
    });
    expect(backstop("Remind me to stretch in 1 minute.")).toEqual({
      tool: "reminder_set",
      input: { text: "stretch", in_minutes: 1 },
    });
    expect(backstop("In 2 hours, remind me to call mom")).toEqual({
      tool: "reminder_set",
      input: { text: "call mom", in_minutes: 120 },
    });
    expect(backstop("How long should I boil an egg?")).toBeNull();
    expect(backstop("set a timer")).toBeNull();
    expect(backstop("Set timer for 10 seconds")).toEqual({
      tool: "timer_start",
      input: { duration_seconds: 10 },
    });
    expect(backstop("start a new timer for 3 minutes")).toEqual({
      tool: "timer_start",
      input: { duration_seconds: 180 },
    });
  });

  it("sets the timer when she claims it without the tool, and not twice", async () => {
    const run = async (script: ConstructorParameters<typeof FakeLLM>[0]) => {
      const t = clock();
      const schedules = new Schedules({
        store: new InMemoryScheduleStore(),
        now: t.now,
        onFire() {},
      });
      const skills = new SkillRegistry(new PolicyGate({ log }));
      for (const s of timerSkills(schedules)) skills.register(s);
      const o = new Orchestrator({
        llm: new FakeLLM(script),
        skills,
        send: () => true,
        registry: new BodyRegistry(),
        traces: new TurnTraces(),
        systemPrompt: "t",
        timezone: TZ,
        log,
        now: t.now,
      });
      await o.enqueue("web-01", "Set a timer for 20 seconds for my tea please.");
      return schedules.list().map((i) => `${i.label}:${i.durationSec}`);
    };
    // Claimed, no tool: the brain does it.
    expect(await run([{ text: ["Timer set for 20 seconds!"] }])).toEqual(["tea:20"]);
    // Called the tool properly: nothing extra.
    expect(
      await run([
        { tools: [{ name: "timer_start", input: { duration_seconds: 20, label: "tea" } }] },
        { text: ["Twenty seconds, go."] },
      ]),
    ).toEqual(["tea:20"]);
    // Didn't claim (asked instead): nothing.
    expect(await run([{ text: ["What should I call it?"] }])).toEqual([]);
  });
});
