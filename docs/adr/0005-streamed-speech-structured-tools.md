# ADR-0005: Spoken text is streamed; structured outputs come via tool calls

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Asking an LLM to answer with a single JSON blob such as `{ reply, emotion, action }` is brittle, and it prevents streaming text into TTS. For a voice-first companion, that streaming is what keeps latency low.

## Decision

- What she says is streamed as normal assistant text, split at sentence boundaries, and sent to TTS as each sentence completes.
- Expression, skills and body actions are **tool calls** (`set_expression`, `timer_start`, `desk_display_mode`, …).
- The main conversation uses a strong model. Background jobs (memory extraction, summarisation, interruption scoring) use a small, fast model.
- LLM, STT and TTS each sit behind a thin adapter interface.

## Consequences

- First audio can start before the model has finished its reply.
- Tool schemas are validated, so bad structured output is caught rather than spoken.
- The persona prompt must teach her when to call `set_expression`. This is covered by personality evals.
- An expression call costs one extra model round trip per turn: the model stops for the `set_expression` result before it continues speaking. The face changes immediately (the directive goes out as soon as the call arrives), but first audio waits for the second call. Turn traces record `firstTextMs` so this can be measured against the voice budget in Phase 3.
- History is append-only. A failed or refused turn is cut off the tail, never edited in place, so prompt caching and preserved thinking stay valid.
- The main model is configurable (`LLM_MODEL`, default `claude-sonnet-5-5`; `LLM_EFFORT`, default `low` for conversational latency). Requests opt into server-side refusal fallback (`fallbacks: "default"`).
