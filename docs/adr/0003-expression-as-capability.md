# ADR-0003: Expression is a body capability; capabilities are exposed as LLM tools

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The desk clock shows emotions on a screen, a phone might show them differently, and an RC car has no face at all. Hard-wiring "emotion → display" into the brain would tie it to one body.

## Decision

- The brain emits **abstract affect** (`expression.set { affect, intensity, transitionMs, blend? }`). Each body decides how to render it.
- Bodies declare what they can do (`express`, `speak`, `move`, …) as **capabilities** in `hello`. These are presented to the LLM as **tools**, the same way server-side skills are.

## Consequences

- Skills, devices and animation share one model: the LLM calls a tool, the policy gate checks it, and deterministic code executes it.
- Adding a body extends what the brain can do without any brain code changes.
- The LLM never generates frames or motor signals.
