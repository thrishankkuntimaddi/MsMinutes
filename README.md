# Ms. Minutes

> **One Brain. Many Bodies.**
> A persistent AI companion that talks naturally and inhabits many bodies, starting with a tiny retro clock on the desk.

The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md), and key decisions are recorded in [docs/adr](docs/adr).

## Status

**Phase 1: Brain.** She talks. A body sends what the user said, the brain asks Claude, and her reply streams back with expressions for her face. The conversation is shared across bodies. Turns are traced at `GET /api/turns`.

**Focus:** the brain + the ESP32 desk companion, built in parallel. See the [hardware list](docs/hardware/desk-companion.md).

## Layout

```
apps/brain          The brain: WebSocket gateway, body registry, event bus
apps/stub-body      A terminal body for exercising the protocol
apps/web-body       The browser body: her animated face, voice and microphone
packages/character  Her face as a parameter rig: presets, springs, idle life, lip-sync
packages/protocol   The Body Protocol: zod schemas, types, codec, JSON Schema
packages/persona    Who she is: persona.md becomes her system prompt
docs/adr            Architecture Decision Records
docs/hardware       Parts lists, wiring and bring-up for physical bodies
```

## Getting started

Requires Node 24 (see `.nvmrc`). pnpm is provided through corepack:

```sh
corepack enable        # once; puts `pnpm` on your PATH
pnpm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

No API key? Run her on a local model with [Ollama](https://ollama.com) instead. The model must support tool calling:

```sh
ollama pull qwen2.5:3b # once
ollama serve           # if it isn't already running
# in .env: LLM_PROVIDER=ollama (and optionally OLLAMA_MODEL=...)
```

Run the brain and talk to her from the terminal body:

```sh
pnpm dev:brain         # terminal 1: brain on ws://127.0.0.1:7700/ws
pnpm stub-body         # terminal 2: type to talk
```

```
you › Good morning
Ms. Minutes › [happy 0.5] Good morning, Thrishank! Coffee first, or straight into it?
```

Or meet her in the browser: she introduces herself, then you talk by mic or keyboard and she answers out loud.

```sh
pnpm dev:brain         # terminal 1
pnpm dev:web           # terminal 2: open http://localhost:5179
```

Her voice: set `TTS_PROVIDER=kokoro` in `.env` and the brain speaks with Kokoro, a local neural voice (~330 MB, downloaded on first run; pick another with `TTS_VOICE`, e.g. `af_bella`). Without it, the browser uses its own voices. Re-render the intro greeting with `pnpm --filter @ms-minutes/brain say "<text>" ../web-body/public/voice/greeting.wav`.

Her poses and moves are on a check sheet at http://localhost:5179/poses.html.

Her personality lives in [packages/persona/persona.md](packages/persona/persona.md). Edit it and restart the brain.

## Scripts

| Script                 | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `pnpm dev:brain`       | Run the brain with reload on change                    |
| `pnpm stub-body`       | Connect a terminal body to the brain                   |
| `pnpm dev:web`         | Serve the browser body (proxies `/ws` to the brain)    |
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
