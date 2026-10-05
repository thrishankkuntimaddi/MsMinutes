import { z } from "zod";
import type { Schedules } from "../schedule.js";
import { SkillError, type Skill } from "../skill.js";
import { duration, spoken, zonedToUtc } from "../time.js";

const MAX_TIMER_SEC = 48 * 3600;

/** Timers and reminders (§12.2): tier 1, reversible, run on her own clock. */
export function timerSkills(schedules: Schedules): Skill[] {
  const timerStart: Skill<{ duration_seconds: number; label?: string | undefined }> = {
    name: "timer.start",
    description:
      "Start a countdown timer. Use it whenever the person asks for a timer or to time something. It shows on your clock face and you'll be told when it goes off.",
    riskTier: 1,
    schema: z.object({
      duration_seconds: z.number().int().min(1).max(MAX_TIMER_SEC).describe("Length in seconds"),
      label: z.string().max(60).optional().describe('What it\'s for, e.g. "tea"'),
    }),
    async execute(args, ctx) {
      const label = args.label?.trim() || duration(args.duration_seconds);
      const item = await schedules.add({
        kind: "timer",
        label,
        dueAt: new Date(ctx.now.getTime() + args.duration_seconds * 1000),
        durationSec: args.duration_seconds,
        bodyId: ctx.bodyId,
      });
      return {
        started: label,
        length: duration(args.duration_seconds),
        goes_off: spoken(item.dueAt, ctx.timezone, ctx.now),
      };
    },
  };

  const timerCancel: Skill<{ label?: string | undefined }> = {
    name: "timer.cancel",
    description: "Stop a running timer. Give its label, or leave it out if there's only one.",
    riskTier: 1,
    schema: z.object({ label: z.string().max(60).optional() }),
    async execute(args) {
      const item = await schedules.cancel("timer", args.label);
      if (!item)
        throw new SkillError(
          noMatch(
            "timer",
            schedules.list("timer").map((t) => t.label),
          ),
        );
      return { cancelled: item.label };
    },
  };

  const reminderSet: Skill<{
    text: string;
    at?: string | undefined;
    in_minutes?: number | undefined;
  }> = {
    name: "reminder.set",
    description:
      "Remind the person about something later. Give either `at` (local date-time) or `in_minutes`. You'll be told when it's due, and should remind them then.",
    riskTier: 1,
    schema: z
      .object({
        text: z.string().min(1).max(200).describe('What to remind them of, e.g. "call mom"'),
        at: z.string().optional().describe("Local date and time, YYYY-MM-DDTHH:MM"),
        in_minutes: z
          .number()
          .positive()
          .max(60 * 24 * 60)
          .optional(),
      })
      .refine((a) => a.at !== undefined || a.in_minutes !== undefined, "give `at` or `in_minutes`"),
    async execute(args, ctx) {
      const due =
        args.in_minutes !== undefined
          ? new Date(ctx.now.getTime() + args.in_minutes * 60_000)
          : zonedToUtc(args.at!, ctx.timezone);
      if (!due) throw new SkillError(`Couldn't read the time "${args.at}". Use YYYY-MM-DDTHH:MM.`);
      if (due.getTime() <= ctx.now.getTime()) {
        throw new SkillError(
          `${spoken(due, ctx.timezone, ctx.now)} has already passed. Ask when they meant.`,
        );
      }
      const item = await schedules.add({
        kind: "reminder",
        label: args.text.trim(),
        dueAt: due,
        durationSec: null,
        bodyId: ctx.bodyId,
      });
      return { reminder: item.label, when: spoken(item.dueAt, ctx.timezone, ctx.now) };
    },
  };

  const reminderCancel: Skill<{ text?: string | undefined }> = {
    name: "reminder.cancel",
    description:
      "Cancel a reminder, by (part of) what it says, or leave it out if there's only one.",
    riskTier: 1,
    schema: z.object({ text: z.string().max(200).optional() }),
    async execute(args) {
      const item = await schedules.cancel("reminder", args.text);
      if (!item)
        throw new SkillError(
          noMatch(
            "reminder",
            schedules.list("reminder").map((r) => r.label),
          ),
        );
      return { cancelled: item.label };
    },
  };

  const list: Skill<Record<string, never>> = {
    name: "schedule.list",
    description: "List the running timers and upcoming reminders.",
    riskTier: 0,
    schema: z.object({}),
    async execute(_args, ctx) {
      return {
        timers: schedules.list("timer").map((t) => ({
          label: t.label,
          remaining: duration(Math.max(0, (t.dueAt.getTime() - ctx.now.getTime()) / 1000)),
        })),
        reminders: schedules.list("reminder").map((r) => ({
          text: r.label,
          when: spoken(r.dueAt, ctx.timezone, ctx.now),
        })),
      };
    },
  };

  return [timerStart, timerCancel, reminderSet, reminderCancel, list] as Skill[];
}

function noMatch(kind: string, labels: string[]): string {
  if (labels.length === 0) return `There are no ${kind}s running.`;
  return `Which ${kind}? There are: ${labels.map((l) => `"${l}"`).join(", ")}.`;
}
