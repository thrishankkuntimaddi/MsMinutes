# ADR-0008: Inline stage tags for moods and body actions

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

ADR-0005 routes structured output through tool calls. In practice small local models almost never call `set_expression`, so her face never changed. Tool calls also cost a model round trip before speech continues, and they can't say _where_ in a sentence a mood shifts or a move happens.

## Decision

- The orchestrator runs every streamed reply through a `TagFilter`. `[mood]` or `[mood 0.4]` (any protocol `Affect`) becomes `expression.set`; `[action]` becomes `capability.call { name: "animate", args: { action } }` when the body declares an `animate` capability whose schema lists that action.
- Tags are stripped before text reaches captions or TTS. Unknown one-word brackets (template slots like `[name]`) are dropped; other brackets pass through as text.
- The per-turn context note lists the current body's actions, so the persona prompt stays cacheable and bodies can differ.
- For Ollama, the system prompt also teaches mood tags with examples. Claude keeps the `set_expression` tool and may use tags too. At most two actions run per reply.

## Consequences

- Moods and moves land in stream order, at the right word, with no extra round trip.
- A new body gets new moves by declaring them in `hello`; the brain needs no change (in the spirit of ADR-0003).
- Tag text is part of the assistant history, which keeps the model consistent about what it did.
