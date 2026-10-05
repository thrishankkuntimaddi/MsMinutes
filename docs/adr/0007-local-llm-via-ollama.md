# ADR-0007: Local development model through an Ollama adapter

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Developing without a Claude API key should still give a talking companion. Ollama runs open models locally and supports tool calling, but its chat format differs from the Anthropic-shaped history the orchestrator keeps (ADR-0005).

## Decision

- `LLM_PROVIDER=ollama` selects `OllamaLLM`, a second implementation of the thin `LLM` interface. It translates the Anthropic-shaped request (system, tools, `tool_use`/`tool_result` blocks) to Ollama's `/api/chat` and maps the streamed reply back to a `BetaMessage`, so the orchestrator is unchanged.
- Failures (server down, model not pulled) raise `LLMUnavailableError` and reach the body as `llm_unavailable` with a hint.
- At startup the brain loads the model and reads her system prompt with the same context size as real turns, so the first reply is as fast as the rest.
- Claude stays the default and the target for real use.

## Consequences

- Local turns start in ~0.3 s once loaded; no key or network needed.
- Small models (the default `qwen2.5:3b`) rarely call tools, so moods arrive as inline tags instead (ADR-0008). A 7B+ model is noticeably better at both.
