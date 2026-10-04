# ADR-0006: Risk-tiered policy gate; body-side safety for physical bodies

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The system will eventually control cameras, microphones, home devices, a robot arm and an RC car. An LLM must never have unrestricted control over any of them.

## Decision

- Every skill and capability has a **risk tier**: 0 Info, 1 Reversible, 2 Sensitive, 3 Physical/irreversible.
- Every tool call passes through a **policy gate** (permission + tier + confirmation for tier 3) before it runs.
- Physical bodies enforce their own safety. A deterministic local controller, a **watchdog** that halts motion if the brain disconnects, a hardware e-stop, and local limits apply regardless of what the brain asks.
- The brain sends high-level intents only, never motor signals.

## Consequences

- Phase 0 grants every declared capability (`welcome.permissions`). The policy gate replaces this before any tier-2 or tier-3 capability is used.
- Body firmware must implement the watchdog, which is part of the definition of done for physical bodies.
