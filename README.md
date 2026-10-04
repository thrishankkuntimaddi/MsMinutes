# Ms. Minutes

> **One Brain. Many Bodies.**
> A persistent AI companion that talks naturally and inhabits many bodies, starting with a tiny retro clock on the desk.

The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md), and key decisions are recorded in [docs/adr](docs/adr).

## Status

**Phase 0: Architecture.** The Body Protocol is defined, and the brain accepts body connections (hello → welcome → heartbeats). There is no LLM yet; that comes in Phase 1.

**Focus:** the brain + the ESP32 desk companion, built in parallel. See the [hardware list](docs/hardware/desk-companion.md).

## Layout

```
apps/brain          The brain: WebSocket gateway, body registry, event bus
apps/stub-body      A terminal body for exercising the protocol
packages/protocol   The Body Protocol: zod schemas, types, codec, JSON Schema
docs/adr            Architecture Decision Records
docs/hardware       Parts lists, wiring and bring-up for physical bodies
```

## Getting started

Requires Node 24 (see `.nvmrc`). pnpm is provided through corepack:

```sh
corepack enable        # once; puts `pnpm` on your PATH
pnpm install
cp .env.example .env   # optional
```

Run the brain and connect a body:

```sh
pnpm dev:brain         # terminal 1: brain on ws://127.0.0.1:7700/ws
pnpm stub-body         # terminal 2: a body says hello
curl localhost:7700/api/bodies
```

## Scripts

| Script                 | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `pnpm dev:brain`       | Run the brain with reload on change                    |
| `pnpm stub-body`       | Connect a terminal body to the brain                   |
| `pnpm test`            | Run all tests                                          |
| `pnpm typecheck`       | Typecheck the whole monorepo                           |
| `pnpm lint`            | ESLint                                                 |
| `pnpm format`          | Prettier                                               |
| `pnpm check`           | Typecheck + lint + format check + tests (what CI runs) |
| `pnpm schema:generate` | Regenerate JSON Schema for non-TypeScript bodies       |

## Brain endpoints

| Endpoint          | Purpose                     |
| ----------------- | --------------------------- |
| `GET /health`     | Liveness + protocol version |
| `GET /api/bodies` | Currently connected bodies  |
| `WS /ws`          | Body Protocol               |
