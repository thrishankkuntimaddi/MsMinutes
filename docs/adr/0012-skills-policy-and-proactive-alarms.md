# ADR-0012: Skills behind a policy gate; timers and reminders as her first proactive behaviour

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 6: she should do useful things (timers, reminders, weather) and, for the first time, speak without being spoken to when a timer goes off (ARCHITECTURE §12.2). The model must never run anything directly (ADR-0006).

## Decision

- **Skill interface** (§12.1): name, description, zod schema, risk tier, executor. A `SkillRegistry` presents skills to the model as tools (dots become underscores) next to `set_expression`; the list is fixed for the brain's life, so the prompt cache holds. Every call is validated, then passes the `PolicyGate`: tier 0–1 automatic (unless denied), tier 2 only if granted in `SKILLS_GRANT`, tier 3 refused until bodies can confirm. Failures return as `is_error` tool results she can talk about.
- **Built-in skills:** `timer.start`, `timer.cancel`, `reminder.set` (local wall time in the person's timezone, or minutes from now), `reminder.cancel`, `schedule.list`, `weather.get` (Open-Meteo, no key; only the place name leaves the machine).
- **Schedules** keep timers and reminders in the memory database (`scheduled` table) when memory is on, so they survive restarts: anything that came due while the brain was off fires on start with a "late" note; anything more than 12 h overdue is marked missed.
- **Firing is an event → a turn** (§3.2): the `Announcer` sends `alarm.ring` to the body where it was set (or the most recently active one), then starts a proactive turn whose input is an `<event>` note. No body online → it waits for the next `body.connected`. Running timers are pushed to every body that declares `display.timer` (full list on each change and on connect); the browser body draws them as a countdown on her rim and an LCD readout.
- **Backstop for small models:** if a reply claims a timer or reminder but no tool ran, and the person's words were a plain, standard-form ask ("timer for 20 seconds", "remind me to X in 5 minutes"), the brain runs that skill itself, so her claim is true. It never acts without both the explicit ask and her claim.
- **Local-model contention:** with Ollama, memory learning waits for a 20 s lull (`MEMORY_LEARN_DELAY_SECONDS`), so extraction never queues ahead of a live reply on the single local model.

## Consequences

- Verified live (qwen2.5:3b): timer set by tool call, shown on her face, rang at 0 s with a spoken "Your tea is ready", weather looked up, a reminder held while no body was online and delivered on reconnect.
- Proactivity beyond timers and reminders (significance scoring, quiet hours, §14) is still to come; these two always fire.
- Fixed along the way: stiff animation springs went unstable at low frame rates; springs now integrate in ≤ 1/120 s sub-steps.
