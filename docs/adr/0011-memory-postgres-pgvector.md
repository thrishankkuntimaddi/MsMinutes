# ADR-0011: Long-term memory in Postgres + pgvector, embedded by default

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 5: she should remember the person across conversations and restarts (ARCHITECTURE §11), and the person must be able to see, edit and delete what she keeps. The roadmap names Postgres + pgvector; a local setup shouldn't need a database server.

## Decision

- **Storage:** Postgres with pgvector. `MEMORY_DB` picks the engine: a folder path runs **PGlite** (real Postgres compiled to WASM, with pgvector) inside the brain and saves to that folder; a `postgres://` URL uses a server (`infra/docker-compose.yml`); `memory://` is in-memory for tests. Plain SQL over a two-method `Db` interface, with ordered migrations in code, instead of Drizzle: the schema is small and the same SQL runs on both engines.
- **Tiers** (§11.1): `turns` (episodic, every exchange with its trace), `memories` (semantic: one short third-person sentence each, with kind, importance and an embedding), `conversations` (with summaries). A pause longer than `MEMORY_GAP_MINUTES` (30) starts a new conversation: her working context resets, and the last conversation's summary carries over.
- **Read before a turn:** embed the user's words, take memories close to the best match (similarity ≥ max(0.3, best − 0.2)), plus her five most important memories, into a `<memory>` note in the user turn (the system prompt stays cacheable). A recall that takes over 1.5 s is skipped.
- **Write after a turn**, queued off the hot path: store the turn; if the person spoke about themselves (or said remember/forget), a small model proposes `add`/`update`/`forget`. Claude Haiku 4.5 with structured output, or the Ollama model with a JSON-schema `format`. Updates and forgets are only accepted for memories the model was shown; near-duplicates (similarity ≥ 0.92) refresh instead of adding; importance below 0.4 is dropped; mismatched weekday/date pairs are corrected.
- **Embeddings:** nomic-embed-text via Ollama, or all-MiniLM-L6-v2 in-process. Vectors are untyped and tagged with their model; changing models re-embeds at startup.
- **User control:** `GET/POST/PATCH/DELETE /api/memories` (forgetting everything needs `?confirm=forget-everything`) and a "Her memories" case-file viewer in the browser body.

## Consequences

- Verified locally (qwen2.5:3b): after a restart into a new conversation she recalled the dog's name, an upcoming interview, and offered a vegetarian dinner.
- A 3B extraction model misses some facts, merges others, and adds corrections as new memories rather than updating. Claude Haiku 4.5, or a 7B+ model via `MEMORY_MODEL`, does noticeably better.
- Only one user (`me`) so far; `user_id` is on every row for when that changes. The memory API has no auth yet; the brain listens on localhost by default.
