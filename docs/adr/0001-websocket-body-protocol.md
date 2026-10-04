# ADR-0001: WebSocket body protocol with a shared typed envelope

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Every body (web dev console, ESP32 desk companion, mobile app, robots) must talk to the same brain. The brain needs to stream speech and animation while it talks, speak first (proactively), and keep several bodies connected at once. A request/response API (`POST /api/chat`) can't do any of these well.

## Decision

- Bodies connect to the brain over a single **WebSocket** (`/ws`). REST is used only for admin and config.
- Every message uses one **envelope**: `{ v, id, type, bodyId, ts, replyTo?, payload }`.
- Message schemas live in `@ms-minutes/protocol` as **zod** schemas. They are the single source of truth for TypeScript types and for the generated JSON Schema that non-TypeScript bodies use.
- A connection starts with `hello` (body identity + capabilities) and the brain answers with `welcome`. Liveness comes from heartbeats. Application close codes use the range 4000–4003.

## Consequences

- One contract for all bodies. A new body is a new client, not a brain change.
- Both sides validate everything, so malformed input fails loudly and close to its source.
- Audio travels as base64 in JSON for now. Binary frames are a planned optimisation (Phase 3/7) and will be an additive protocol change.
- Changing a schema requires regenerating the JSON Schema (`pnpm schema:generate`).
