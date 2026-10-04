# ADR-0002: Events-in / directives-out brain loop

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

A companion that only answers messages feels "callable", not "present". Later phases need the brain to react to timers, sensors, presence and device lifecycle, and sometimes to speak first.

## Decision

The brain's core loop is **events in → decide → directives out**. Every input (utterance, timer firing, sensor reading, body connecting or disconnecting, skill result) is an event on an in-process **event bus**. A user utterance is just one event type. Outputs are directives (speech, expression, state, capability calls) sent to bodies.

## Consequences

- Proactive behaviour (Phase 6 timers, Phase 9 vision) plugs in as new event producers. The loop itself doesn't change.
- Every module communicates through typed events, which keeps the modular monolith decoupled.
- The bus is synchronous and in-process. If durability or cross-process delivery is ever needed, the bus interface can be backed by a queue without changing callers.
