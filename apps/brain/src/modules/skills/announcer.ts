import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { brainMessage } from "@ms-minutes/protocol";
import type { BodyRegistry } from "../bodies/registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { BodySender } from "../gateway/gateway.js";
import type { Scheduled } from "./schedule.js";
import { duration, spoken } from "./time.js";

/** Bodies that can show timers declare this; args are the full list of what's running. */
export const DISPLAY_TIMER = "display.timer";
/** Bodies that can ring declare this; it comes just before she speaks about it. */
export const ALARM_RING = "alarm.ring";

export type AnnouncerDeps = {
  registry: BodyRegistry;
  send: BodySender;
  /** Starts her proactive turn. */
  speak: (bodyId: string, event: string) => void;
  timezone: string;
  log: FastifyBaseLogger;
  now?: () => Date;
};

/**
 * Gets timers onto faces and alarms to the person (§12.2, §7.3): shows running timers on
 * every body that can display them, and when one fires, rings and speaks on the body where
 * it was set, or the one used most recently. Timers and reminders always fire (§14); if no
 * body is online, they wait for the next one to connect.
 */
export class Announcer {
  readonly #deps: AnnouncerDeps;
  #showing: Scheduled[] = [];
  #pending: { item: Scheduled; lateMs: number }[] = [];

  constructor(deps: AnnouncerDeps) {
    this.#deps = deps;
  }

  attach(bus: EventBus): void {
    bus.on("body.connected", ({ body }) => {
      this.#show(body.id);
      const waiting = this.#pending;
      this.#pending = [];
      for (const { item, lateMs } of waiting) this.fire(item, lateMs);
    });
  }

  /** The running set changed: update every face. */
  show(items: Scheduled[]): void {
    this.#showing = items;
    for (const body of this.#deps.registry.list()) this.#show(body.id);
  }

  fire(item: Scheduled, lateMs: number): void {
    const { registry, send, speak, log } = this.#deps;
    const bodies = registry.list();
    const target =
      bodies.find((b) => b.id === item.bodyId) ??
      [...bodies].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    if (!target) {
      log.info({ id: item.id, label: item.label }, "nobody online; holding the alarm");
      this.#pending.push({ item, lateMs });
      return;
    }
    if (target.capabilities.some((c) => c.name === ALARM_RING)) {
      send(
        brainMessage("capability.call", target.id, {
          callId: randomUUID(),
          name: ALARM_RING,
          args: { id: item.id, kind: item.kind, label: item.label },
        }),
      );
    }
    log.info(
      { id: item.id, kind: item.kind, label: item.label, bodyId: target.id, lateMs },
      "alarm",
    );
    speak(target.id, this.#describe(item, lateMs));
  }

  #describe(item: Scheduled, lateMs: number): string {
    const { timezone } = this.#deps;
    const now = (this.#deps.now ?? (() => new Date()))();
    const late =
      lateMs > 60_000
        ? ` It actually came due ${duration(Math.round(lateMs / 60_000) * 60)} ago, while you were switched off; say so.`
        : "";
    if (item.kind === "timer") {
      return `Your "${item.label}" timer (${duration(item.durationSec ?? 0)}) just went off.${late} Tell the person, briefly.`;
    }
    return `A reminder is due: "${item.label}" (they asked for it at ${spoken(item.createdAt, timezone, now)}).${late} Remind them now, briefly and kindly.`;
  }

  #show(bodyId: string): void {
    const body = this.#deps.registry.get(bodyId);
    if (!body?.capabilities.some((c) => c.name === DISPLAY_TIMER)) return;
    this.#deps.send(
      brainMessage("capability.call", bodyId, {
        callId: randomUUID(),
        name: DISPLAY_TIMER,
        args: {
          timers: this.#showing.map((i) => ({
            id: i.id,
            kind: i.kind,
            label: i.label,
            endsAt: i.dueAt.getTime(),
            durationSec: i.durationSec,
          })),
        },
      }),
    );
  }
}
